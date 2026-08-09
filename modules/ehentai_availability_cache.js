const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')

const STATUS_TTL = {
  available: 24 * 60 * 60 * 1000,
  copyright: 7 * 24 * 60 * 60 * 1000,
  'generic-unavailable': 7 * 24 * 60 * 60 * 1000,
  'geo-blocked': 24 * 60 * 60 * 1000,
  'gallery-not-found': 30 * 60 * 1000,
  'auth-required': 5 * 60 * 1000,
  'ip-banned': 5 * 60 * 1000,
  'service-unavailable': 5 * 60 * 1000
}

class EhentaiAvailabilityCache {
  constructor(db) {
    this.db = db
  }

  static async open(auditStorePath) {
    await fs.promises.mkdir(auditStorePath, { recursive: true })
    const db = await open({
      filename: path.join(auditStorePath, 'audit-cache.sqlite'),
      driver: sqlite3.Database
    })
    await db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS gallery_availability (
        site TEXT NOT NULL,
        gid TEXT NOT NULL,
        token TEXT NOT NULL,
        status TEXT NOT NULL,
        httpStatus INTEGER,
        claimant TEXT,
        region TEXT,
        finalUrl TEXT,
        checkedAt INTEGER NOT NULL,
        evidence TEXT,
        PRIMARY KEY(site, gid, token)
      );
    `)
    return new EhentaiAvailabilityCache(db)
  }

  async get({ site, gid, token }, now = Date.now()) {
    const row = await this.db.get(
      'SELECT * FROM gallery_availability WHERE site = ? AND gid = ? AND token = ?',
      site,
      String(gid),
      String(token)
    )
    if (!row) return null
    const ttl = STATUS_TTL[row.status] || 0
    if (!ttl || now - Number(row.checkedAt) > ttl) return null
    return {
      site: row.site,
      status: row.status,
      httpStatus: row.httpStatus,
      claimant: row.claimant,
      region: row.region,
      finalUrl: row.finalUrl,
      checkedAt: Number(row.checkedAt),
      evidence: row.evidence,
      cached: true
    }
  }

  async set({ site, gid, token, status, httpStatus, claimant, region, finalUrl, checkedAt, evidence }) {
    if (!STATUS_TTL[status]) return
    await this.db.run(`
      INSERT INTO gallery_availability(
        site, gid, token, status, httpStatus, claimant, region, finalUrl, checkedAt, evidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(site, gid, token) DO UPDATE SET
        status = excluded.status,
        httpStatus = excluded.httpStatus,
        claimant = excluded.claimant,
        region = excluded.region,
        finalUrl = excluded.finalUrl,
        checkedAt = excluded.checkedAt,
        evidence = excluded.evidence
    `, [
      site,
      String(gid),
      String(token),
      status,
      httpStatus ?? null,
      claimant || null,
      region || null,
      finalUrl || null,
      Number(checkedAt || Date.now()),
      evidence || null
    ])
  }

  async close() {
    await this.db.close()
  }
}

module.exports = { EhentaiAvailabilityCache, STATUS_TTL }
