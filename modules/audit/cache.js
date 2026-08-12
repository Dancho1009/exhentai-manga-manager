const path = require('path')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const { normalizePath } = require('./utils.js')

const CACHE_VERSION = 2
const ARCHIVE_HASH_VERSION = 1
const HEALTH_INSPECTION_VERSION = 1
const CONTENT_INSPECTION_VERSION = 1
const EHVIEWER_INSPECTION_VERSION = 1

const parseJson = value => {
  if (!value) return null
  try { return JSON.parse(value) } catch { return null }
}

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
        inspection TEXT,
        ehviewerInspection TEXT,
        archiveHashVersion INTEGER,
        healthVersion INTEGER,
        contentVersion INTEGER,
        ehviewerVersion INTEGER,
        healthInspection TEXT,
        contentInspection TEXT
      )
    `)
    const columns = await db.all('PRAGMA table_info(cache_entries)')
    const existing = new Set(columns.map(column => column.name))
    const migrations = [
      ['ehviewerInspection', 'TEXT'],
      ['archiveHashVersion', 'INTEGER'],
      ['healthVersion', 'INTEGER'],
      ['contentVersion', 'INTEGER'],
      ['ehviewerVersion', 'INTEGER'],
      ['healthInspection', 'TEXT'],
      ['contentInspection', 'TEXT']
    ]
    for (const [name, type] of migrations) {
      if (!existing.has(name)) await db.exec(`ALTER TABLE cache_entries ADD COLUMN ${name} ${type}`)
    }
    await db.run(`
      UPDATE cache_entries SET
        archiveHashVersion = CASE WHEN archiveSha256 IS NOT NULL AND archiveHashVersion IS NULL THEN ? ELSE archiveHashVersion END,
        contentVersion = CASE WHEN inspection IS NOT NULL AND contentVersion IS NULL THEN ? ELSE contentVersion END,
        contentInspection = COALESCE(contentInspection, inspection),
        ehviewerVersion = CASE WHEN ehviewerInspection IS NOT NULL AND ehviewerVersion IS NULL THEN ? ELSE ehviewerVersion END
    `, [ARCHIVE_HASH_VERSION, CONTENT_INSPECTION_VERSION, EHVIEWER_INSPECTION_VERSION])
    return new AuditCache(db)
  }

  async get(book, stat) {
    const row = await this.db.get('SELECT * FROM cache_entries WHERE filepath = ?', normalizePath(book.filepath))
    if (!row || row.size !== stat.size || Math.abs(row.mtimeMs - stat.mtimeMs) > 1) return null
    return {
      archiveSha256: row.archiveHashVersion === ARCHIVE_HASH_VERSION ? row.archiveSha256 || null : null,
      healthInspection: row.healthVersion === HEALTH_INSPECTION_VERSION ? parseJson(row.healthInspection) : null,
      contentInspection: row.contentVersion === CONTENT_INSPECTION_VERSION ? parseJson(row.contentInspection) : null,
      ehviewerInspection: row.ehviewerVersion === EHVIEWER_INSPECTION_VERSION ? parseJson(row.ehviewerInspection) : null
    }
  }

  async update(book, stat, patch) {
    const previous = await this.get(book, stat) || {}
    const next = { ...previous, ...patch }
    await this.db.run(`
      INSERT INTO cache_entries(
        filepath, size, mtimeMs, version,
        archiveSha256, archiveHashVersion,
        healthInspection, healthVersion,
        contentInspection, contentVersion,
        ehviewerInspection, ehviewerVersion,
        inspection
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(filepath) DO UPDATE SET
        size = excluded.size,
        mtimeMs = excluded.mtimeMs,
        version = excluded.version,
        archiveSha256 = excluded.archiveSha256,
        archiveHashVersion = excluded.archiveHashVersion,
        healthInspection = excluded.healthInspection,
        healthVersion = excluded.healthVersion,
        contentInspection = excluded.contentInspection,
        contentVersion = excluded.contentVersion,
        ehviewerInspection = excluded.ehviewerInspection,
        ehviewerVersion = excluded.ehviewerVersion,
        inspection = excluded.inspection
    `, [
      normalizePath(book.filepath),
      stat.size,
      stat.mtimeMs,
      CACHE_VERSION,
      next.archiveSha256 || null,
      next.archiveSha256 ? ARCHIVE_HASH_VERSION : null,
      next.healthInspection ? JSON.stringify(next.healthInspection) : null,
      next.healthInspection ? HEALTH_INSPECTION_VERSION : null,
      next.contentInspection ? JSON.stringify(next.contentInspection) : null,
      next.contentInspection ? CONTENT_INSPECTION_VERSION : null,
      next.ehviewerInspection ? JSON.stringify(next.ehviewerInspection) : null,
      next.ehviewerInspection ? EHVIEWER_INSPECTION_VERSION : null,
      next.contentInspection ? JSON.stringify(next.contentInspection) : null
    ])
    return next
  }

  async close() {
    await this.db.close()
  }
}

module.exports = {
  AuditCache,
  CACHE_VERSION,
  ARCHIVE_HASH_VERSION,
  HEALTH_INSPECTION_VERSION,
  CONTENT_INSPECTION_VERSION,
  EHVIEWER_INSPECTION_VERSION
}
