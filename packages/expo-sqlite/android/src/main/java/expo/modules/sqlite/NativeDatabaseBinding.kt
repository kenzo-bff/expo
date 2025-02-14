// Copyright 2015-present 650 Industries. All rights reserved.

package expo.modules.sqlite

import com.facebook.jni.HybridData
import expo.modules.core.interfaces.DoNotStrip

private typealias UpdateListener = (dbName: String, tableName: String, operationType: Int, rowID: Long) -> Unit

@Suppress("KotlinJniMissingFunction")
@DoNotStrip
internal class NativeDatabaseBinding {
  @DoNotStrip
  private val mHybridData: HybridData

  private var mUpdateListener: UpdateListener? = null

  init {
    mHybridData = initHybrid()
  }

  /**
   * Enable data change notifications
   */
  fun enableUpdateHook(listener: UpdateListener) {
    sqlite3_update_hook(true)
    mUpdateListener = listener
  }

  /**
   * Disable data change notifications
   */
  fun disableUpdateHook() {
    mUpdateListener = null
    sqlite3_update_hook(false)
  }

  // region sqlite3 bindings

  external fun sqlite3_changes(): Int
  external fun sqlite3_close(): Int
  external fun sqlite3_db_filename(dbName: String): String
  external fun sqlite3_enable_load_extension(onoff: Int): Int
  external fun sqlite3_exec(source: String): Int
  external fun sqlite3_get_autocommit(): Int
  external fun sqlite3_last_insert_rowid(): Long
  external fun sqlite3_load_extension(libPath: String, entryProc: String): Int
  external fun sqlite3_open(dbPath: String): Int
  external fun sqlite3_prepare_v2(source: String, statement: NativeStatementBinding): Int
  private external fun sqlite3_update_hook(enabled: Boolean) // Keeps it private internally and uses `enableUpdateHook` publicly

  external fun convertSqlLiteErrorToString(): String

  // endregion

  // region internals

  private external fun initHybrid(): HybridData

  @Suppress("unused")
  @DoNotStrip
  private fun onUpdate(action: Int, dbName: String, tableName: String, rowId: Long) {
    mUpdateListener?.invoke(dbName, tableName, action, rowId)
  }

  // endregion

  companion object {
    init {
      System.loadLibrary("expo-sqlite")
    }

    // These error code should be synced with sqlite3.h
    const val SQLITE_OK = 0

    const val SQLITE_ROW = 100
    const val SQLITE_DONE = 101
  }
}
