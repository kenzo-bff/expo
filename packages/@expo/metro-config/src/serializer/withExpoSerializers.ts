/**
 * Copyright © 2022 650 Industries.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import { isJscSafeUrl, toNormalUrl } from 'jsc-safe-url';
import { Module, MixedOutput, MetroConfig, AssetData } from 'metro';
import getMetroAssets from 'metro/src/DeltaBundler/Serializers/getAssets';
// @ts-expect-error
import sourceMapString from 'metro/src/DeltaBundler/Serializers/sourceMapString';
import bundleToString from 'metro/src/lib/bundleToString';
import { InputConfigT, SerializerConfigT } from 'metro-config';
import path from 'path';

import {
  serverPreludeSerializerPlugin,
  environmentVariableSerializerPlugin,
} from './environmentVariableSerializerPlugin';
import { baseJSBundle, getPlatformOption } from './fork/baseJSBundle';
import { fileNameFromContents, getCssSerialAssets } from './getCssDeps';
import { SerialAsset } from './serializerAssets';
import { env } from '../env';

export type Serializer = NonNullable<SerializerConfigT['customSerializer']>;

export type SerializerParameters = Parameters<Serializer>;

// A serializer that processes the input and returns a modified version.
// Unlike a serializer, these can be chained together.
export type SerializerPlugin = (...props: SerializerParameters) => SerializerParameters;

export function withExpoSerializers(config: InputConfigT): InputConfigT {
  const processors: SerializerPlugin[] = [];
  processors.push(serverPreludeSerializerPlugin);
  if (!env.EXPO_NO_CLIENT_ENV_VARS) {
    processors.push(environmentVariableSerializerPlugin);
  }

  return withSerializerPlugins(config, processors);
}

// There can only be one custom serializer as the input doesn't match the output.
// Here we simply run
export function withSerializerPlugins(
  config: InputConfigT,
  processors: SerializerPlugin[]
): InputConfigT {
  const originalSerializer = config.serializer?.customSerializer;

  return {
    ...config,
    serializer: {
      ...config.serializer,
      customSerializer: createSerializerFromSerialProcessors(
        config,
        processors,
        originalSerializer
      ),
    },
  };
}

function getDefaultSerializer(
  config: MetroConfig,
  fallbackSerializer?: Serializer | null
): Serializer {
  const defaultSerializer =
    fallbackSerializer ??
    (async (...params: SerializerParameters) => {
      const bundle = baseJSBundle(...params);
      const outputCode = bundleToString(bundle).code;
      return outputCode;
    });
  return async (
    ...props: SerializerParameters
  ): Promise<string | { code: string; map: string }> => {
    const [entryPoint, preModules, graph, options] = props;

    const platform = getPlatformOption(graph, options);

    if (!options.sourceUrl) {
      return await defaultSerializer(entryPoint, preModules, graph, options);
    }

    const sourceUrl = isJscSafeUrl(options.sourceUrl)
      ? toNormalUrl(options.sourceUrl)
      : options.sourceUrl;

    const url = new URL(sourceUrl, 'https://expo.dev');

    if (platform !== 'web' || url.searchParams.get('serializer.output') !== 'static') {
      // Default behavior if `serializer.output=static` is not present in the URL.
      return await defaultSerializer(entryPoint, preModules, graph, options);
    }

    const includeSourceMaps = url.searchParams.get('serializer.map') === 'true';

    const cssDeps = getCssSerialAssets<MixedOutput>(graph.dependencies, {
      projectRoot: options.projectRoot,
      processModuleFilter: options.processModuleFilter,
    });

    // TODO: Convert to serial assets
    // TODO: Disable this call dynamically in development since assets are fetched differently.
    const metroAssets = (await getMetroAssets(graph.dependencies, {
      processModuleFilter: options.processModuleFilter,
      assetPlugins: config.transformer!.assetPlugins ?? [],
      platform,
      projectRoot: options.projectRoot, // this._getServerRootDir(),
      publicPath: config.transformer!.publicPath!,
    })) as AssetData[];

    const jsAssets: SerialAsset[] = [];

    const jsCode = await defaultSerializer(entryPoint, preModules, graph, {
      ...options,
      sourceMapUrl: includeSourceMaps ? options.sourceMapUrl : undefined,
    });

    const stringContents = typeof jsCode === 'string' ? jsCode : jsCode.code;

    const jsFilename = fileNameFromContents({
      filepath: url.pathname,
      src: stringContents,
    });

    jsAssets.push({
      filename: options.dev ? 'index.js' : `_expo/static/js/web/${jsFilename}.js`,
      originFilename: 'index.js',
      type: 'js',
      metadata: {},
      source: stringContents,
    });

    if (
      // Only include the source map if the `options.sourceMapUrl` option is provided and we are exporting a static build.
      includeSourceMaps &&
      options.sourceMapUrl
    ) {
      const sourceMap = typeof jsCode === 'string' ? serializeToSourceMap(...props) : jsCode.map;
      jsAssets.push({
        filename: options.dev ? 'index.map' : `_expo/static/js/web/${jsFilename}.js.map`,
        originFilename: 'index.map',
        type: 'map',
        metadata: {},
        source: sourceMap,
      });
    }

    return JSON.stringify({ artifacts: [...jsAssets, ...cssDeps], assets: metroAssets });
  };
}

function getSortedModules(
  graph: SerializerParameters[2],
  {
    createModuleId,
  }: {
    createModuleId: (path: string) => number;
  }
): readonly Module<any>[] {
  const modules = [...graph.dependencies.values()];
  // Assign IDs to modules in a consistent order
  for (const module of modules) {
    createModuleId(module.path);
  }
  // Sort by IDs
  return modules.sort(
    (a: Module<any>, b: Module<any>) => createModuleId(a.path) - createModuleId(b.path)
  );
}

function serializeToSourceMap(...props: SerializerParameters): string {
  const [, prepend, graph, options] = props;

  const modules = [
    ...prepend,
    ...getSortedModules(graph, {
      createModuleId: options.createModuleId,
    }),
  ].map((module) => {
    // TODO: Make this user-configurable.

    // Make all paths relative to the server root to prevent the entire user filesystem from being exposed.
    if (module.path.startsWith('/')) {
      return {
        ...module,
        path: '/' + path.relative(options.serverRoot ?? options.projectRoot, module.path),
      };
    }
    return module;
  });

  return sourceMapString(modules, {
    ...options,
  });
}

export function createSerializerFromSerialProcessors(
  config: MetroConfig,
  processors: (SerializerPlugin | undefined)[],
  originalSerializer?: Serializer | null
): Serializer {
  const finalSerializer = getDefaultSerializer(config, originalSerializer);
  return (...props: SerializerParameters): ReturnType<Serializer> => {
    for (const processor of processors) {
      if (processor) {
        props = processor(...props);
      }
    }

    return finalSerializer(...props);
  };
}

export { SerialAsset };
