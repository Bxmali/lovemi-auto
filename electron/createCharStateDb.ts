import { openAccountsDb } from './accountsDb'

export type CreateCharImageUpdate = {
  slot: number
  mimeType: string
  imageBase64: string | null
}

export type CreateCharRunSnapshot = {
  runId: string
  slot: number
  epoch: number
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  stage: string
  [key: string]: unknown
}

const MAX_STATE_JSON = 2_000_000

export function saveCreateCharUiState(input: {
  state: Record<string, unknown>
  imageUpdates?: CreateCharImageUpdate[]
}) {
  const db = openAccountsDb()
  const stateJson = JSON.stringify(input.state || {})
  if (stateJson.length > MAX_STATE_JSON) {
    return { ok: false as const, error: `创建角色状态过大（${stateJson.length}）` }
  }
  const now = new Date().toISOString()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `INSERT INTO create_char_ui_state (id, state_json, updated_at)
       VALUES ('main', ?, ?)
       ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`,
    ).run(stateJson, now)
    const upsertImage = db.prepare(
      `INSERT INTO create_char_reference_images (slot, mime_type, image_data, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(slot) DO UPDATE SET
         mime_type=excluded.mime_type,
         image_data=excluded.image_data,
         updated_at=excluded.updated_at`,
    )
    const deleteImage = db.prepare(`DELETE FROM create_char_reference_images WHERE slot = ?`)
    for (const update of input.imageUpdates || []) {
      if (!Number.isInteger(update.slot) || update.slot < 1 || update.slot > 5) continue
      if (!update.imageBase64) {
        deleteImage.run(update.slot)
        continue
      }
      // SQLite 存二进制，不在 localStorage 留几十 MB 的 base64。
      const data = Buffer.from(update.imageBase64, 'base64')
      upsertImage.run(update.slot, update.mimeType || 'image/png', data, now)
    }
    db.exec('COMMIT')
    return { ok: true as const }
  } catch (error) {
    db.exec('ROLLBACK')
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
  }
}

export function loadCreateCharUiState() {
  const db = openAccountsDb()
  const row = db
    .prepare(`SELECT state_json, updated_at FROM create_char_ui_state WHERE id = 'main'`)
    .get() as { state_json?: string; updated_at?: string } | undefined
  let state: Record<string, unknown> | undefined
  if (row?.state_json) {
    try {
      state = JSON.parse(row.state_json) as Record<string, unknown>
    } catch {
      state = undefined
    }
  }
  const images: Record<number, { imageBase64: string; mimeType: string }> = {}
  const activeSlot =
    typeof state?.activeSlot === 'number' && state.activeSlot >= 1 && state.activeSlot <= 5
      ? state.activeSlot
      : 1
  const imageRows = db
    .prepare(
      `SELECT slot, mime_type, image_data FROM create_char_reference_images
       WHERE image_data IS NOT NULL AND slot = ?`,
    )
    .all(activeSlot) as Array<{ slot: number; mime_type: string; image_data: Uint8Array }>
  for (const image of imageRows) {
    images[image.slot] = {
      mimeType: image.mime_type || 'image/png',
      imageBase64: Buffer.from(image.image_data).toString('base64'),
    }
  }
  return { ok: true as const, state, images, updatedAt: row?.updated_at }
}

export function loadCreateCharReferenceImage(slot: number) {
  if (!Number.isInteger(slot) || slot < 1 || slot > 5) {
    return { ok: false as const, error: '无效槽位' }
  }
  const row = openAccountsDb()
    .prepare(
      `SELECT mime_type, image_data FROM create_char_reference_images
       WHERE slot = ? AND image_data IS NOT NULL`,
    )
    .get(slot) as { mime_type: string; image_data: Uint8Array } | undefined
  if (!row) return { ok: true as const, imageBase64: null, mimeType: null }
  return {
    ok: true as const,
    imageBase64: Buffer.from(row.image_data).toString('base64'),
    mimeType: row.mime_type || 'image/png',
  }
}

export function saveCreateCharRun(snapshot: CreateCharRunSnapshot) {
  const db = openAccountsDb()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO create_char_runs
       (run_id, slot, epoch, status, stage, snapshot_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       slot=excluded.slot,
       epoch=excluded.epoch,
       status=excluded.status,
       stage=excluded.stage,
       snapshot_json=excluded.snapshot_json,
       updated_at=excluded.updated_at`,
  ).run(
    snapshot.runId,
    snapshot.slot,
    snapshot.epoch,
    snapshot.status,
    snapshot.stage,
    JSON.stringify(snapshot),
    now,
  )
}

export function loadRecoverableCreateCharRuns(): CreateCharRunSnapshot[] {
  const rows = openAccountsDb()
    .prepare(
      `SELECT snapshot_json FROM create_char_runs
       WHERE status IN ('queued', 'running', 'interrupted')
       ORDER BY updated_at ASC`,
    )
    .all() as Array<{ snapshot_json: string }>
  const out: CreateCharRunSnapshot[] = []
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.snapshot_json) as CreateCharRunSnapshot)
    } catch {
      /* ignore one corrupt run */
    }
  }
  return out
}

export function markActiveCreateCharRunsInterrupted() {
  openAccountsDb()
    .prepare(
      `UPDATE create_char_runs
       SET status='interrupted', updated_at=?
       WHERE status IN ('queued', 'running')`,
    )
    .run(new Date().toISOString())
}
