// Node 22.15.1 SQLite DatabaseSync & Windows PowerShell stderr Filter Patch for ZCode
// Resolves ZCode CLI database initialization, and suppresses benign stderr logs that cause PowerShell NativeCommandError.

const sqlite = require('node:sqlite');

// 1. node:sqlite DatabaseSync.prototype.isTransaction getter
if (sqlite && sqlite.DatabaseSync) {
  if (!Object.getOwnPropertyDescriptor(sqlite.DatabaseSync.prototype, 'isTransaction')) {
    Object.defineProperty(sqlite.DatabaseSync.prototype, 'isTransaction', {
      get() {
        return this._inTx || false;
      },
      set(v) {
        this._inTx = Boolean(v);
      },
      configurable: true,
      enumerable: true
    });

    const originalExec = sqlite.DatabaseSync.prototype.exec;
    sqlite.DatabaseSync.prototype.exec = function(sql) {
      if (typeof sql === 'string') {
        const trimmed = sql.trim().toLowerCase();
        if (/^begin\b/.test(trimmed)) {
          this._inTx = true;
        } else if (/^(commit|rollback)\b/.test(trimmed)) {
          this._inTx = false;
        }
      }
      return originalExec.call(this, sql);
    };
  }
}

// 2. Set NODE_ENV to production to suppress developer diagnostic logs to stderr
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

// 3. Filter benign diagnostic lines from stderr that trigger PowerShell NativeCommandError
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function(chunk, encoding, callback) {
  const str = typeof chunk === 'string' ? chunk : chunk?.toString(encoding || 'utf8') || '';
  if (
    str.includes('ZCode Built-in') ||
    str.includes('ExperimentalWarning: SQLite') ||
    str.includes('Patch installed successfully')
  ) {
    if (typeof callback === 'function') callback();
    return true;
  }
  return originalStderrWrite(chunk, encoding, callback);
};
