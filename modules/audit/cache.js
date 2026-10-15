const path = require('path')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const { normalizePath } = require('./utils.js')

const CACHE_VERSION = 2
const ARCHIVE_HASH_VERSION = 1
const HEALTH_INSPECTION_VERSION = 2
const CONTENT_INSPECTION_VERSION = 1
const EHVIEWER_INSPECTION_VERSION = 1
const CACHE_TABLES = ['cache_entries', 'gallery_availability', 'gallery_gdata', 'dedupe_manifests']

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
      CREATE TABLE IF NOT EXISTS dedupe_manifests (
        filepath TEXT PRIMARY KEY, size INTEGER NOT NULL, mtimeMs REAL NOT NULL, manifest TEXT NOT NULL
      );
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
      WHERE (archiveSha256 IS NOT NULL AND archiveHashVersion IS NULL)
        OR (inspection IS NOT NULL AND (contentVersion IS NULL OR contentInspection IS NULL))
        OR (ehviewerInspection IS NOT NULL AND ehviewerVersion IS NULL)
    `, [ARCHIVE_HASH_VERSION, CONTENT_INSPECTION_VERSION, EHVIEWER_INSPECTION_VERSION])
    return new AuditCache(db)
  }

  async getManifest(book, stat) {
    if (book.type === 'folder') return null
    const row = await this.db.get('SELECT * FROM dedupe_manifests WHERE filepath = ?', normalizePath(book.filepath))
    if (!row || row.size !== stat.size || Math.abs(row.mtimeMs - stat.mtimeMs) > 1) return null
    const manifest = parseJson(row.manifest)
    return manifest?.version === 1 ? manifest : null
  }

  async updateManifest(book, stat, manifest) {
    await this.db.run('INSERT OR REPLACE INTO dedupe_manifests(filepath,size,mtimeMs,manifest) VALUES(?,?,?,?)',
      normalizePath(book.filepath), stat.size, stat.mtimeMs, JSON.stringify(manifest))
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

  async getHealthMany(items) {
    const healthByPath = new Map()
    const targets = new Map(items.map(item => [normalizePath(item.raw.filepath), item.actual]))
    const paths = [...targets.keys()]
    for (let offset = 0; offset < paths.length; offset += 200) {
      const batch = paths.slice(offset, offset + 200)
      const rows = await this.db.all(`
        SELECT filepath, size, mtimeMs, healthVersion, healthInspection
        FROM cache_entries WHERE filepath IN (${batch.map(() => '?').join(',')})
      `, batch)
      for (const row of rows) {
        const stat = targets.get(row.filepath)
        if (row.size !== stat.size || Math.abs(row.mtimeMs - stat.mtimeMs) > 1 || row.healthVersion !== HEALTH_INSPECTION_VERSION) continue
        const health = parseJson(row.healthInspection)
        if (health) healthByPath.set(row.filepath, health)
      }
    }
    return healthByPath
  }

  async updateHealthMany(items) {
    if (!items.length) return
    let statement
    await this.db.exec('BEGIN IMMEDIATE;')
    try {
      // Keep dedupe evidence only when it still describes the same file snapshot.
      const unchanged = 'cache_entries.size = excluded.size AND ABS(cache_entries.mtimeMs - excluded.mtimeMs) <= 1'
      statement = await this.db.prepare(`
        INSERT INTO cache_entries(filepath, size, mtimeMs, version, healthInspection, healthVersion, ehviewerInspection, ehviewerVersion)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(filepath) DO UPDATE SET
          archiveSha256 = CASE WHEN ${unchanged} THEN cache_entries.archiveSha256 ELSE NULL END,
          archiveHashVersion = CASE WHEN ${unchanged} THEN cache_entries.archiveHashVersion ELSE NULL END,
          contentInspection = CASE WHEN ${unchanged} THEN cache_entries.contentInspection ELSE NULL END,
          contentVersion = CASE WHEN ${unchanged} THEN cache_entries.contentVersion ELSE NULL END,
          inspection = CASE WHEN ${unchanged} THEN cache_entries.inspection ELSE NULL END,
          size = excluded.size, mtimeMs = excluded.mtimeMs, version = excluded.version,
          healthInspection = excluded.healthInspection, healthVersion = excluded.healthVersion,
          ehviewerInspection = excluded.ehviewerInspection, ehviewerVersion = excluded.ehviewerVersion
      `)
      for (const { book, stat, health } of items) {
        await statement.run(
          normalizePath(book.filepath), stat.size, stat.mtimeMs, CACHE_VERSION,
          JSON.stringify(health), HEALTH_INSPECTION_VERSION,
          health.ehviewer ? JSON.stringify(health.ehviewer) : null,
          health.ehviewer ? EHVIEWER_INSPECTION_VERSION : null
        )
      }
      await statement.finalize()
      statement = null
      await this.db.exec('COMMIT;')
    } catch (error) {
      if (statement) await statement.finalize().catch(() => {})
      await this.db.exec('ROLLBACK;')
      throw error
    }
  }

  async close() {
    await this.db.close()
  }
}

const clearAuditCacheDatabase = async storePath => {
  const db = await open({
    filename: path.join(storePath, 'audit-cache.sqlite'),
    driver: sqlite3.Database
  })
  try {
    await db.exec('PRAGMA busy_timeout = 5000;')
    const rows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")
    const existing = new Set(rows.map(row => row.name))
    await db.exec('BEGIN IMMEDIATE;')
    try {
      for (const table of CACHE_TABLES) {
        if (existing.has(table)) await db.exec(`DELETE FROM ${table};`)
      }
      await db.exec('COMMIT;')
    } catch (error) {
      await db.exec('ROLLBACK;').catch(() => {})
      throw error
    }
    await db.exec('PRAGMA wal_checkpoint(TRUNCATE);').catch(() => {})
    await db.exec('VACUUM;').catch(() => {})
  } finally {
    await db.close()
  }
}

const invalidateAuditCacheEntries = async (storePath, filepaths = []) => {
  const targets = [...new Set(filepaths.map(normalizePath).filter(Boolean))]
  if (targets.length === 0) return
  const db = await open({
    filename: path.join(storePath, 'audit-cache.sqlite'),
    driver: sqlite3.Database
  })
  try {
    await db.exec('PRAGMA busy_timeout = 5000;')
    const table = await db.get("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'cache_entries'")
    if (!table?.found) return
    for (const filepath of targets) await db.run('DELETE FROM cache_entries WHERE filepath = ?', filepath)
  } finally {
    await db.close()
  }
}

module.exports = {
  AuditCache,
  clearAuditCacheDatabase,
  invalidateAuditCacheEntries,
  CACHE_VERSION,
  ARCHIVE_HASH_VERSION,
  HEALTH_INSPECTION_VERSION,
  CONTENT_INSPECTION_VERSION,
  EHVIEWER_INSPECTION_VERSION
}
