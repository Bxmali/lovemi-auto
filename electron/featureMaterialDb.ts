import fs from 'node:fs'
import path from 'node:path'
import { openAccountsDb } from './accountsDb'
import { mediaCacheDir } from './lovemiMediaCache'

export type FeatureMaterialRecord = {
  runId: string
  userPrompt: string
  title?: string
  prompt?: string
  detail?: string
  jobId?: string
  assetId?: string
  cdnUrl?: string
  cacheUrl?: string
  localPath?: string
  twitterPath?: string
  watermarkApplied?: boolean
  stage: string
  error?: string
  createdAt: number
  updatedAt: number
}

function ensureTable() {
  const db = openAccountsDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS feature_materials (
      run_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feature_materials_updated
      ON feature_materials(updated_at DESC);
  `)
  return db
}

export function upsertFeatureMaterial(record: FeatureMaterialRecord) {
  const db = ensureTable()
  const now = new Date().toISOString()
  const createdAt = new Date(record.createdAt || Date.now()).toISOString()
  db.prepare(
    `INSERT INTO feature_materials (run_id, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       payload_json = excluded.payload_json,
       updated_at = excluded.updated_at`,
  ).run(record.runId, JSON.stringify({ ...record, updatedAt: Date.now() }), createdAt, now)
}

export function listFeatureMaterials(limit = 80): FeatureMaterialRecord[] {
  const db = ensureTable()
  const rows = db
    .prepare(
      `SELECT payload_json FROM feature_materials
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 200))) as Array<{ payload_json: string }>
  const out: FeatureMaterialRecord[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload_json) as FeatureMaterialRecord
      if (parsed?.runId) out.push(parsed)
    } catch {
      /* ignore */
    }
  }
  return out
}

export function deleteFeatureMaterial(input: {
  runId: string
  appData: string
}): { ok: boolean; error?: string } {
  const runId = input.runId?.trim()
  if (!runId) return { ok: false, error: '缺少 runId' }
  const db = ensureTable()
  const row = db
    .prepare(`SELECT payload_json FROM feature_materials WHERE run_id = ?`)
    .get(runId) as { payload_json?: string } | undefined
  let record: FeatureMaterialRecord | null = null
  if (row?.payload_json) {
    try {
      record = JSON.parse(row.payload_json) as FeatureMaterialRecord
    } catch {
      record = null
    }
  }
  db.prepare(`DELETE FROM feature_materials WHERE run_id = ?`).run(runId)

  const unlinkQuiet = (filePath?: string) => {
    if (!filePath) return
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch {
      /* ignore */
    }
  }

  unlinkQuiet(record?.localPath)
  unlinkQuiet(record?.twitterPath)

  if (record?.cacheUrl?.startsWith('lovemi-cache://media/')) {
    try {
      const fileName = decodeURIComponent(record.cacheUrl.replace(/^lovemi-cache:\/\/media\//, ''))
      const cachePath = path.join(mediaCacheDir(input.appData), fileName)
      unlinkQuiet(cachePath)
      unlinkQuiet(`${cachePath.replace(/\.[^.]+$/, '')}.twitter.json`)
      // markers are m-{hash}.twitter.json beside media
      const base = path.basename(fileName).replace(/\.[^.]+$/, '')
      unlinkQuiet(path.join(mediaCacheDir(input.appData), `${base}.twitter.json`))
    } catch {
      /* ignore */
    }
  }

  return { ok: true }
}
