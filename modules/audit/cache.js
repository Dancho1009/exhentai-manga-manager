const path = require('path')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const { normalizePath } = require('./utils.js')

const CACHE_VERSION = 1

class AuditCache {
  constructor(db) {
    this.db = db
  }

  static async open(storePath) {
    const db = await open({
      filename: path.join(storePath, 'audit-cache.sqlite'),
      driver: sqlite3.Database
    })
    await db.exec(`
      CREATE TABLE IF NOT EXISTS cache_entries (
        filepath TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtimeMs REAL NOT NULL,
        version INTEGER NOT NULL,
        archiveSha256 TEXT,
        inspection TEXT
      )
    `)
    return new AuditCache(db)
  }

  async get(book, stat) {
    const row = await this.db.get('SELECT * FROM cache_entries WHERE filepath = ?', normalizePath(book.filepath))
    if (!row || row.version !== CACHE_VERSION || row.size !== stat.size || Math.abs(row.mtimeMs - stat.mtimeMs) > 1) return null
    return {
      archiveSha256: row.archiveSha256 || null,
      inspection: row.inspection ? JSON.parse(row.inspection) : null
    }
  }

  async update(book, stat, patch) {
    const previous = await this.get(book, stat) || {}
    const next = { ...previous, ...patch }
    await this.db.run(`
      INSERT INTO cache_entries(filepath, size, mtimeMs, version, archiveSha256, inspection)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(filepath) DO UPDATE SET
        size = excluded.size,
        mtimeMs = excluded.mtimeMs,
        version = excluded.version,
        archiveSha256 = excluded.archiveSha256,
        inspection = excluded.inspection
    `, [
      normalizePath(book.filepath),
      stat.size,
      stat.mtimeMs,
      CACHE_VERSION,
      next.archiveSha256 || null,
      next.inspection ? JSON.stringify(next.inspection) : null
    ])
    return next
  }

  async close() {
    await this.db.close()
  }
}

module.exports = { AuditCache, CACHE_VERSION }
