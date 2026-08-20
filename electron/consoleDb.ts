import { openAccountsDb } from './accountsDb'
import { buildAllCopySeed, commentId, generateComments, generateDisplayNames, nameId, normalizeName } from './copySeed'
import { buildExploreCopySeed, exploreCommentId, generateExploreComments } from './exploreCopySeed'
import { ZH_COPY_STYLE } from './zhCopyPools'
import { LOCALES, LOCALE_LABEL, type LocaleCode, isLocale } from './locales'
import {
  commentListingAsset,
  fetchCommunityExplore,
  fetchCommunityListings,
  likeListingAsset,
  patchCreatorProfile,
  type ListingItem,
} from './lovemiCommunity'
import { createHash } from 'node:crypto'

export type ConsoleLogLevel = 'info' | 'warn' | 'error'
export type ActionDecision = 'pending' | 'working' | 'skipped' | 'liked' | 'commented' | 'failed' | 'give_up'

export function appendConsoleLog(input: {
  level: ConsoleLogLevel
  action: string
  message: string
  accountEmail?: string
  listingId?: string
}) {
  const db = openAccountsDb()
  db.prepare(
    `INSERT INTO console_logs (ts, level, account_email, listing_id, action, message)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    input.level,
    input.accountEmail || null,
    input.listingId || null,
    input.action,
    input.message,
  )
}

export function listConsoleLogs(limit = 200) {
  const db = openAccountsDb()
  pruneConsoleLogs(800)
  return db
    .prepare(
      `SELECT id, ts, level, account_email, listing_id, action, message
       FROM console_logs ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: number
    ts: string
    level: string
    account_email: string | null
    listing_id: string | null
    action: string
    message: string
  }>
}

/** 只保留最近 N 条，避免日志表无限涨导致卡顿 */
function pruneConsoleLogs(keep = 800) {
  const db = openAccountsDb()
  const row = db.prepare(`SELECT COUNT(*) AS n FROM console_logs`).get() as { n: number }
  if (Number(row.n) <= keep + 200) return
  db.prepare(
    `DELETE FROM console_logs WHERE id NOT IN (
       SELECT id FROM console_logs ORDER BY id DESC LIMIT ?
     )`,
  ).run(keep)
}

export function clearConsoleLogsView() {
  // keep DB; UI can just re-fetch. Optional truncate:
  openAccountsDb().exec('DELETE FROM console_logs')
}

function refreshZhCopyPools(db: ReturnType<typeof openAccountsDb>): boolean {
  const oldNames = db
    .prepare(
      `SELECT COUNT(*) AS n FROM display_name_pool
       WHERE locale = 'zh' AND (name LIKE '%路过%' OR name LIKE '北巷%' OR name LIKE '孤狼%' OR name LIKE '%执刀%')`,
    )
    .get() as { n: number }
  const oldComments = db
    .prepare(
      `SELECT COUNT(*) AS n FROM comment_templates
       WHERE locale = 'zh' AND (body LIKE '%腰线绝了%' OR body LIKE '%这氛围感直接拿下%' OR body LIKE '%好欲好欲%')`,
    )
    .get() as { n: number }
  const zhCommentN = db
    .prepare(`SELECT COUNT(*) AS n FROM comment_templates WHERE locale = 'zh'`).get() as { n: number }
  const zhNameN = db
    .prepare(`SELECT COUNT(*) AS n FROM display_name_pool WHERE locale = 'zh'`).get() as { n: number }
  const newStyleHit = db
    .prepare(
      `SELECT COUNT(*) AS n FROM comment_templates WHERE locale = 'zh' AND body LIKE '%求教程 咋做的这么好%'`,
    )
    .get() as { n: number }

  const needNames = Number(oldNames.n) > 8 || Number(zhNameN.n) < 80
  const needComments =
    Number(oldComments.n) > 8 || Number(zhCommentN.n) < 80 || Number(newStyleHit.n) === 0
  if (!needNames && !needComments) return false

  const now = new Date().toISOString()
  const insC = db.prepare(
    `INSERT OR IGNORE INTO comment_templates (id, locale, body, enabled, use_count, created_at, surface)
     VALUES (?, ?, ?, 1, 0, ?, ?)`,
  )
  const insN = db.prepare(
    `INSERT OR IGNORE INTO display_name_pool (id, locale, name, normalized, used_by_account_id, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  )

  db.exec('BEGIN')
  try {
    if (needNames) {
      db.exec(`DELETE FROM display_name_pool WHERE locale = 'zh'`)
      for (const name of generateDisplayNames('zh', 360)) {
        insN.run(nameId('zh', name), 'zh', name, normalizeName(name), now)
      }
    }
    if (needComments) {
      db.exec(`DELETE FROM comment_templates WHERE locale = 'zh'`)
      generateComments('zh', 360).forEach((body, idx) => {
        insC.run(commentId('zh', body, idx), 'zh', body, now, 'character')
      })
      generateExploreComments('zh', 220).forEach((body, idx) => {
        insC.run(exploreCommentId('zh', body, idx), 'zh', body, now, 'explore')
      })
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  appendConsoleLog({
    level: 'info',
    action: 'seed',
    message: `中文文案库已换成混合风格（${ZH_COPY_STYLE}）：网名重刷 ${needNames ? '是' : '否'} · 评论重刷 ${needComments ? '是' : '否'}`,
  })
  return true
}

export function ensureCopyLibrariesSeeded(): { comments: number; names: number; seeded: boolean } {
  const db = openAccountsDb()
  const zhRefreshed = refreshZhCopyPools(db)
  const nRow = db.prepare('SELECT COUNT(*) AS n FROM display_name_pool').get() as { n: number }
  const digitRow = db
    .prepare(`SELECT COUNT(*) AS n FROM display_name_pool WHERE name GLOB '*[0-9]*'`)
    .get() as { n: number }
  const charCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM comment_templates WHERE COALESCE(surface, 'character') = 'character'`,
    )
    .get() as { n: number }
  const exploreCount = db
    .prepare(`SELECT COUNT(*) AS n FROM comment_templates WHERE surface = 'explore'`).get() as {
    n: number
  }
  const digitComments = db
    .prepare(`SELECT COUNT(*) AS n FROM comment_templates WHERE body GLOB '*[0-9]*'`)
    .get() as { n: number }
  const crimeComments = db
    .prepare(
      `SELECT COUNT(*) AS n FROM comment_templates
       WHERE body LIKE '%犯罪%' OR body LIKE '%criminal%' OR body LIKE '%crime%'
          OR body LIKE '%krimen%' OR body LIKE '%преступ%' OR body LIKE '%criminelle%'
          OR body LIKE '%illegal%' OR body LIKE '%illégale%' OR body LIKE '%phạm luật%'`,
    )
    .get() as { n: number }

  const targetCharacter = 3000 // 10 × 300
  const targetExplore = 2000 // 10 × 200
  const badBodies = Number(digitComments.n) > 0 || Number(crimeComments.n) > 0
  const needCharacterComments = Number(charCount.n) < targetCharacter || badBodies
  const needExploreComments = Number(exploreCount.n) < targetExplore || badBodies
  const needNames = Number(nRow.n) < targetCharacter || Number(digitRow.n) > 0

  if (!needCharacterComments && !needExploreComments && !needNames) {
    return {
      comments: Number(charCount.n) + Number(exploreCount.n),
      names: Number(nRow.n),
      seeded: zhRefreshed,
    }
  }

  if (needNames) db.exec('DELETE FROM display_name_pool')
  if (needCharacterComments) {
    db.exec(`DELETE FROM comment_templates WHERE COALESCE(surface, 'character') = 'character'`)
  }
  if (needExploreComments) {
    db.exec(`DELETE FROM comment_templates WHERE surface = 'explore'`)
  }

  const { comments, names } = buildAllCopySeed({ namesOnly: !needCharacterComments })
  const exploreSeed = needExploreComments ? buildExploreCopySeed() : { comments: [] }
  const now = new Date().toISOString()
  const insC = db.prepare(
    `INSERT OR IGNORE INTO comment_templates (id, locale, body, enabled, use_count, created_at, surface)
     VALUES (?, ?, ?, 1, 0, ?, ?)`,
  )
  const insN = db.prepare(
    `INSERT OR IGNORE INTO display_name_pool (id, locale, name, normalized, used_by_account_id, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  )
  db.exec('BEGIN')
  try {
    if (needCharacterComments) {
      for (const c of comments) insC.run(c.id, c.locale, c.body, now, 'character')
    }
    for (const c of exploreSeed.comments) insC.run(c.id, c.locale, c.body, now, 'explore')
    if (needNames) {
      for (const n of names) insN.run(n.id, n.locale, n.name, n.normalized, now)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  const c2 = db.prepare('SELECT COUNT(*) AS n FROM comment_templates').get() as { n: number }
  const n2 = db.prepare('SELECT COUNT(*) AS n FROM display_name_pool').get() as { n: number }
  const ex2 = db
    .prepare(`SELECT COUNT(*) AS n FROM comment_templates WHERE surface = 'explore'`)
    .get() as { n: number }
  appendConsoleLog({
    level: 'info',
    action: 'seed',
    message: `文案库已更新：角色评论 ${Number(c2.n) - Number(ex2.n)} · Explore评论 ${ex2.n} · 用户名 ${n2.n}${badBodies ? '（已去数字/犯罪字样）' : ''}`,
  })
  return { comments: Number(c2.n), names: Number(n2.n), seeded: true }
}


/** 启动时把卡在 working 的任务放回 pending（上次崩溃/强杀） */
export function releaseWorkingActions() {
  const db = openAccountsDb()
  const r = db
    .prepare(`UPDATE account_character_actions SET decision = 'pending', updated_at = ? WHERE decision = 'working'`)
    .run(new Date().toISOString())
  if (Number(r.changes) > 0) {
    appendConsoleLog({
      level: 'warn',
      action: 'engage',
      message: `已释放 ${r.changes} 条卡死的 working 任务`,
    })
  }
  return { released: Number(r.changes) }
}

export function listCommentTemplates(locale?: string, limit = 500) {
  const db = openAccountsDb()
  if (locale) {
    return db
      .prepare(
        `SELECT id, locale, body, enabled, use_count, created_at
         FROM comment_templates WHERE locale = ? ORDER BY created_at LIMIT ?`,
      )
      .all(locale, limit)
  }
  return db
    .prepare(
      `SELECT id, locale, body, enabled, use_count, created_at
       FROM comment_templates ORDER BY locale, created_at LIMIT ?`,
    )
    .all(limit)
}

export function listDisplayNames(locale?: string, onlyFree = false, limit = 500) {
  const db = openAccountsDb()
  if (locale && onlyFree) {
    return db
      .prepare(
        `SELECT id, locale, name, normalized, used_by_account_id, created_at
         FROM display_name_pool WHERE locale = ? AND used_by_account_id IS NULL
         ORDER BY created_at LIMIT ?`,
      )
      .all(locale, limit)
  }
  if (locale) {
    return db
      .prepare(
        `SELECT id, locale, name, normalized, used_by_account_id, created_at
         FROM display_name_pool WHERE locale = ? ORDER BY created_at LIMIT ?`,
      )
      .all(locale, limit)
  }
  return db
    .prepare(
      `SELECT id, locale, name, normalized, used_by_account_id, created_at
       FROM display_name_pool ORDER BY locale, created_at LIMIT ?`,
    )
    .all(limit)
}

export function copyLibraryStats() {
  const db = openAccountsDb()
  const byLocale: Record<string, { comments: number; names: number; namesFree: number }> = {}
  for (const loc of LOCALES) {
    const c = db.prepare(`SELECT COUNT(*) AS n FROM comment_templates WHERE locale = ?`).get(loc) as {
      n: number
    }
    const n = db.prepare(`SELECT COUNT(*) AS n FROM display_name_pool WHERE locale = ?`).get(loc) as {
      n: number
    }
    const f = db
      .prepare(`SELECT COUNT(*) AS n FROM display_name_pool WHERE locale = ? AND used_by_account_id IS NULL`)
      .get(loc) as { n: number }
    byLocale[loc] = { comments: Number(c.n), names: Number(n.n), namesFree: Number(f.n) }
  }
  return { locales: LOCALES, labels: LOCALE_LABEL, byLocale }
}

/** 均分语言：返回建议 locale（人数最少优先） */
export function pickBalancedLocale(existingLocales: Array<string | undefined>): LocaleCode {
  const counts = Object.fromEntries(LOCALES.map((l) => [l, 0])) as Record<LocaleCode, number>
  for (const loc of existingLocales) {
    if (loc && isLocale(loc)) counts[loc]++
  }
  let best: LocaleCode = LOCALES[0]
  let min = Infinity
  for (const loc of LOCALES) {
    if (counts[loc] < min) {
      min = counts[loc]
      best = loc
    }
  }
  return best
}

export function claimDisplayName(locale: LocaleCode, accountId: string): { ok: boolean; name?: string; error?: string } {
  const db = openAccountsDb()
  const row = db
    .prepare(
      `SELECT id, name FROM display_name_pool
       WHERE locale = ? AND used_by_account_id IS NULL
       ORDER BY RANDOM() LIMIT 1`,
    )
    .get(locale) as { id: string; name: string } | undefined
  if (!row) return { ok: false, error: `语言 ${locale} 无可用用户名` }
  const info = db
    .prepare(`UPDATE display_name_pool SET used_by_account_id = ? WHERE id = ? AND used_by_account_id IS NULL`)
    .run(accountId, row.id)
  if (!info.changes) return { ok: false, error: '用户名抢占失败，请重试' }
  return { ok: true, name: row.name }
}

export function releaseDisplayName(accountId: string) {
  openAccountsDb()
    .prepare(`UPDATE display_name_pool SET used_by_account_id = NULL WHERE used_by_account_id = ?`)
    .run(accountId)
}

export function pickComment(
  locale: LocaleCode,
  surface: 'character' | 'explore' = 'character',
): { ok: boolean; id?: string; body?: string; error?: string } {
  const db = openAccountsDb()
  // 双保险：绝不抽带数字的旧模板；Explore 用独立文案池
  const row = db
    .prepare(
      `SELECT id, body FROM comment_templates
       WHERE locale = ? AND enabled = 1 AND COALESCE(surface, 'character') = ?
         AND body NOT GLOB '*[0-9]*'
         AND body NOT LIKE '%犯罪%'
         AND lower(body) NOT LIKE '%criminal%'
         AND lower(body) NOT LIKE '%crime%'
         AND lower(body) NOT LIKE '%krimen%'
         AND body NOT LIKE '%преступ%'
         AND lower(body) NOT LIKE '%illegal%'
       ORDER BY use_count ASC, RANDOM() LIMIT 1`,
    )
    .get(locale, surface) as { id: string; body: string } | undefined
  if (!row) return { ok: false, error: `语言 ${locale} 无可用${surface === 'explore' ? 'Explore' : ''}评论` }
  const body = row.body.replace(/\s*#\d+\s*/g, ' ').replace(/\s+/g, ' ').trim()
  if (!body || /\d/.test(body) || /犯罪|criminal|crime|krimen|преступ|illegal/i.test(body)) {
    return { ok: false, error: `语言 ${locale} 评论不合规，已跳过` }
  }
  db.prepare(`UPDATE comment_templates SET use_count = use_count + 1 WHERE id = ?`).run(row.id)
  return { ok: true, id: row.id, body }
}

export function upsertCharacters(
  items: ListingItem[],
  feed: 'latest' | 'popular_week' | 'explore_recommended' | 'explore_popular' | 'explore_popularity' | '',
) {
  const db = openAccountsDb()
  const now = new Date().toISOString()
  const stmt = db.prepare(`
    INSERT INTO characters (listing_id, asset_id, title, first_seen_at, last_seen_at, raw_json, listing_kind, feed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(listing_id) DO UPDATE SET
      asset_id = excluded.asset_id,
      title = excluded.title,
      last_seen_at = excluded.last_seen_at,
      raw_json = excluded.raw_json,
      listing_kind = CASE
        WHEN excluded.listing_kind = 'character' THEN 'character'
        WHEN characters.listing_kind = 'character' THEN 'character'
        ELSE excluded.listing_kind
      END,
      feed = excluded.feed
  `)
  let inserted = 0
  for (const it of items) {
    const exists = db.prepare('SELECT listing_id FROM characters WHERE listing_id = ?').get(it.listing_id)
    const kind = it.listing_kind === 'explore' ? 'explore' : 'character'
    stmt.run(it.listing_id, it.asset_id, it.title, now, now, JSON.stringify(it.raw), kind, feed)
    if (!exists) inserted++
  }
  return { upserted: items.length, inserted }
}

export function ensurePendingActions(accountIds: string[], listingIds: string[]) {
  const db = openAccountsDb()
  const getAsset = db.prepare(`SELECT asset_id FROM characters WHERE listing_id = ?`)
  const exists = db.prepare(
    `SELECT 1 AS ok FROM account_character_actions WHERE account_id = ? AND listing_id = ?`,
  )
  const ins = db.prepare(`
    INSERT INTO account_character_actions
      (account_id, listing_id, asset_id, decision, fail_count, updated_at)
    VALUES (?, ?, ?, 'pending', 0, ?)
  `)
  // 打乱账号×角色写入顺序，避免同一号把所有角色「先占第一评」
  const accounts = shuffle([...accountIds])
  const listings = shuffle([...listingIds])
  let created = 0
  const base = Date.now()
  let i = 0
  for (const accountId of accounts) {
    for (const listingId of listings) {
      if (exists.get(accountId, listingId)) continue
      const row = getAsset.get(listingId) as { asset_id: string } | undefined
      // 微秒级错开 updated_at，配合抽取 RANDOM，避免整批同一时间戳
      const ts = new Date(base + (i++ % 10_000)).toISOString()
      ins.run(accountId, listingId, row?.asset_id || null, ts)
      created++
    }
  }
  return { created }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export function characterStats() {
  const db = openAccountsDb()
  const c = db.prepare(`SELECT COUNT(*) AS n FROM characters`).get() as { n: number }
  const byDecision = db
    .prepare(
      `SELECT decision, COUNT(*) AS n FROM account_character_actions GROUP BY decision`,
    )
    .all() as Array<{ decision: string; n: number }>
  const counts: Record<string, number> = {}
  for (const row of byDecision) counts[row.decision] = Number(row.n)
  const pending = counts.pending || 0
  const liked = (counts.liked || 0) + (counts.commented || 0)
  const skipped = counts.skipped || 0
  const failed = (counts.failed || 0) + (counts.give_up || 0)
  const day = new Date().toISOString().slice(0, 10)
  const dayStart = `${day}T00:00:00.000Z`
  const todayLiked = db
    .prepare(
      `SELECT COUNT(*) AS n FROM account_character_actions
       WHERE liked_at IS NOT NULL AND liked_at >= ?`,
    )
    .get(dayStart) as { n: number }
  const todayCommented = db
    .prepare(
      `SELECT COUNT(*) AS n FROM account_character_actions
       WHERE commented_at IS NOT NULL AND commented_at >= ?`,
    )
    .get(dayStart) as { n: number }
  const todaySkipped = db
    .prepare(
      `SELECT COUNT(*) AS n FROM account_character_actions
       WHERE decision = 'skipped' AND updated_at >= ?`,
    )
    .get(dayStart) as { n: number }
  return {
    characters: Number(c.n),
    pending,
    engaged: liked,
    skipped,
    failed,
    today: {
      liked: Number(todayLiked.n),
      commented: Number(todayCommented.n),
      skipped: Number(todaySkipped.n),
    },
  }
}

export type EngageAccount = {
  id: string
  email: string
  sessionToken: string
  locale?: string
  /** 站内 display_name；日志优先显示这个，而不是 Hotmail 前缀 */
  displayName?: string
}

/** 重点扶持作者：标题命中则 70%–80% 参与 */
const BOOST_CREATOR_NEEDLES = ['j哥', 'j 哥', 'big d', 'bigd']

export function isBoostCreatorTitle(title?: string | null) {
  const t = String(title || '').toLowerCase().replace(/\s+/g, ' ')
  if (!t) return false
  return BOOST_CREATOR_NEEDLES.some((n) => t.includes(n))
}

function engageLogName(account: EngageAccount) {
  const n = account.displayName?.trim()
  if (n) return n
  return account.email.split('@')[0] || account.email
}

/** 连续评论换号：最近几笔评论账号（并发下也尽量错开） */
const recentCommentAccountIds: string[] = []

function rememberCommentAccount(id: string) {
  recentCommentAccountIds.push(id)
  while (recentCommentAccountIds.length > 5) recentCommentAccountIds.shift()
}

function pickCommentAccount(
  accounts: EngageAccount[],
  listingId: string,
  likeAccountId: string,
): EngageAccount | undefined {
  const db = openAccountsDb()
  const getDec = db.prepare(
    `SELECT decision FROM account_character_actions WHERE account_id = ? AND listing_id = ?`,
  )
  const eligible = accounts.filter((a) => {
    if (!a.sessionToken) return false
    const row = getDec.get(a.id, listingId) as { decision: string } | undefined
    return !row || row.decision !== 'commented'
  })
  let pool = eligible.length ? eligible : accounts.filter((a) => a.sessionToken)
  if (!pool.length) return undefined

  // 强随机：尽量避开最近评论过的号，也尽量不用刚点赞的同一号（85%）
  if (recentCommentAccountIds.length && pool.length > 1) {
    const recent = new Set(recentCommentAccountIds)
    const rotated = pool.filter((a) => !recent.has(a.id))
    if (rotated.length) pool = rotated
  }
  if (pool.length > 1 && Math.random() < 0.85) {
    const other = pool.filter((a) => a.id !== likeAccountId)
    if (other.length) pool = other
  }
  return pool[Math.floor(Math.random() * pool.length)]
}

function upsertCommentedAction(input: {
  accountId: string
  listingId: string
  assetId: string
  likedAt?: string
  commentId?: string
  commentText: string
}) {
  const db = openAccountsDb()
  const now = new Date().toISOString()
  const existing = db
    .prepare(`SELECT decision FROM account_character_actions WHERE account_id = ? AND listing_id = ?`)
    .get(input.accountId, input.listingId) as { decision: string } | undefined
  if (!existing) {
    db.prepare(
      `INSERT INTO account_character_actions
        (account_id, listing_id, asset_id, decision, liked_at, commented_at, comment_id, comment_text, fail_count, updated_at)
       VALUES (?, ?, ?, 'commented', ?, ?, ?, ?, 0, ?)`,
    ).run(
      input.accountId,
      input.listingId,
      input.assetId,
      input.likedAt ?? null,
      now,
      input.commentId ?? null,
      input.commentText,
      now,
    )
    return
  }
  updateAction(input.accountId, input.listingId, {
    decision: 'commented',
    assetId: input.assetId,
    likedAt: input.likedAt,
    commentedAt: now,
    commentId: input.commentId,
    commentText: input.commentText,
  })
}

export type EngageStepResult = {
  ok: boolean
  done?: boolean
  action?: 'skipped' | 'liked' | 'commented' | 'failed' | 'give_up'
  rateLimited?: boolean
  accountEmail?: string
  listingId?: string
  title?: string
  message?: string
  error?: string
  engageRate?: number
}

function updateAction(
  accountId: string,
  listingId: string,
  patch: {
    decision: ActionDecision
    assetId?: string
    likedAt?: string
    commentedAt?: string
    commentId?: string
    commentText?: string
    skipReason?: string
    failCount?: number
    lastError?: string
  },
) {
  const db = openAccountsDb()
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE account_character_actions SET
      decision = ?,
      asset_id = COALESCE(?, asset_id),
      liked_at = COALESCE(?, liked_at),
      commented_at = COALESCE(?, commented_at),
      comment_id = COALESCE(?, comment_id),
      comment_text = COALESCE(?, comment_text),
      skip_reason = COALESCE(?, skip_reason),
      fail_count = COALESCE(?, fail_count),
      last_error = COALESCE(?, last_error),
      updated_at = ?
     WHERE account_id = ? AND listing_id = ?`,
  ).run(
    patch.decision,
    patch.assetId ?? null,
    patch.likedAt ?? null,
    patch.commentedAt ?? null,
    patch.commentId ?? null,
    patch.commentText ?? null,
    patch.skipReason ?? null,
    patch.failCount ?? null,
    patch.lastError ?? null,
    now,
    accountId,
    listingId,
  )
}

function jitterRate(base: number, noise: number, min = 0.08, max = 0.98) {
  const v = base + (Math.random() * 2 - 1) * noise
  return Math.min(max, Math.max(min, v))
}

function isFreshListing(feed?: string | null, firstSeenAt?: string | null) {
  const f = String(feed || '')
  if (f === 'latest' || f === 'explore_recommended') return true
  if (f === 'popular_week' || f === 'explore_popular' || f === 'explore_popularity') return false
  const seen = Date.parse(String(firstSeenAt || ''))
  if (!Number.isFinite(seen)) return false
  return Date.now() - seen < 36 * 60 * 60 * 1000
}

function pickEngageRates(opts: { boost: boolean; isNew: boolean }) {
  if (opts.boost) {
    return {
      likeRate: 1,
      commentRate: jitterRate(0.7, 0.04, 0.62, 0.78),
      label: '重点作者',
    }
  }
  if (opts.isNew) {
    return {
      likeRate: jitterRate(0.8, 0.06, 0.7, 0.9),
      commentRate: jitterRate(0.55, 0.08, 0.42, 0.68),
      label: '新发布',
    }
  }
  return {
    likeRate: jitterRate(0.55, 0.06, 0.45, 0.65),
    commentRate: jitterRate(0.36, 0.07, 0.28, 0.48),
    label: '热门',
  }
}

/** 取一条 pending：失败优先 → 未有站内评论的角色优先 → 换号 → 随机 */
export async function runEngageStep(input: {
  accounts: EngageAccount[]
  proxyUrl: string
  rateMin?: number
  rateMax?: number
}): Promise<EngageStepResult> {
  const byId = new Map(input.accounts.map((a) => [a.id, a]))
  const db = openAccountsDb()

  type PendingRow = {
    account_id: string
    listing_id: string
    asset_id: string | null
    fail_count: number
    title: string | null
    char_asset: string | null
    listing_kind: string | null
    feed: string | null
    first_seen_at: string | null
  }

  const claimPending = (excludeAccountIds: string[]): PendingRow | undefined => {
    const exclude = excludeAccountIds.filter(Boolean)
    const selectCols = `SELECT a.account_id, a.listing_id, a.asset_id, a.fail_count, c.title, c.asset_id AS char_asset,
                    COALESCE(c.listing_kind, 'character') AS listing_kind,
                    COALESCE(c.feed, '') AS feed,
                    c.first_seen_at
             FROM account_character_actions a
             LEFT JOIN characters c ON c.listing_id = a.listing_id`
    db.exec('BEGIN IMMEDIATE')
    try {
      const pick = (sql: string, params: unknown[]) =>
        db.prepare(sql).get(...params) as PendingRow | undefined

      let row: PendingRow | undefined
      if (exclude.length) {
        const ph = exclude.map(() => '?').join(',')
        row = pick(
          `${selectCols}
           WHERE a.decision = 'pending' AND a.fail_count > 0 AND a.account_id NOT IN (${ph})
           ORDER BY a.updated_at
           LIMIT 1`,
          exclude,
        )
        if (!row) {
          row = pick(
            `${selectCols}
             WHERE a.decision = 'pending' AND a.account_id NOT IN (${ph})
             ORDER BY a.updated_at
             LIMIT 1`,
            exclude,
          )
        }
      }
      if (!row) {
        row = pick(
          `${selectCols}
           WHERE a.decision = 'pending' AND a.fail_count > 0
           ORDER BY a.updated_at
           LIMIT 1`,
          [],
        )
      }
      if (!row) {
        row = pick(
          `${selectCols}
           WHERE a.decision = 'pending'
           ORDER BY a.updated_at
           LIMIT 1`,
          [],
        )
      }
      if (!row) {
        db.exec('COMMIT')
        return undefined
      }
      const now = new Date().toISOString()
      const changed = db
        .prepare(
          `UPDATE account_character_actions SET decision = 'working', updated_at = ?
           WHERE account_id = ? AND listing_id = ? AND decision = 'pending'`,
        )
        .run(now, row.account_id, row.listing_id)
      db.exec('COMMIT')
      if (Number(changed.changes) !== 1) return undefined
      return row
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw e
    }
  }

  const row = claimPending(recentCommentAccountIds)
  if (!row) {
    return { ok: true, done: true, message: '队列空闲' }
  }

  const account = byId.get(row.account_id)
  if (!account?.sessionToken) {
    updateAction(row.account_id, row.listing_id, {
      decision: 'failed',
      failCount: Number(row.fail_count || 0) + 1,
      lastError: '账号无 Bearer 或不在参与池',
    })
    appendConsoleLog({
      level: 'warn',
      action: 'engage',
      listingId: row.listing_id,
      message: 'pending 账号无 Bearer，已标 failed',
    })
    return {
      ok: false,
      action: 'failed',
      listingId: row.listing_id,
      error: '账号无 Bearer',
    }
  }

  const assetId = row.asset_id || row.char_asset || ''
  if (!assetId.startsWith('pubasset_')) {
    updateAction(row.account_id, row.listing_id, {
      decision: 'give_up',
      lastError: '缺少 pubasset_id',
    })
    return { ok: false, action: 'give_up', error: '缺少 pubasset_id', listingId: row.listing_id }
  }

  const title = row.title || row.listing_id
  const boost = isBoostCreatorTitle(title)
  const isNew = isFreshListing(row.feed, row.first_seen_at)
  const { likeRate: engageRate, commentRate, label: rateLabel } = pickEngageRates({ boost, isNew })
  const who = engageLogName(account)

  if (Math.random() > engageRate) {
    updateAction(row.account_id, row.listing_id, {
      decision: 'skipped',
      assetId,
      skipReason: boost ? 'random_sample_boost' : isNew ? 'random_sample_new' : 'random_sample',
    })
    appendConsoleLog({
      level: 'info',
      action: 'skip',
      accountEmail: who,
      listingId: row.listing_id,
      message: `跳过「${title}」（${rateLabel} · 赞 ${(engageRate * 100).toFixed(0)}%）`,
    })
    return {
      ok: true,
      action: 'skipped',
      accountEmail: who,
      listingId: row.listing_id,
      title,
      engageRate,
      message: '已跳过',
    }
  }

  const like = await likeListingAsset({
    sessionToken: account.sessionToken,
    proxyUrl: input.proxyUrl,
    listingId: row.listing_id,
    assetId,
  })
  if (!like.ok) {
    const rateLimited = /too many|rate|429/i.test(like.error || '')
    const failCount = Number(row.fail_count || 0) + 1
    const decision: ActionDecision = failCount >= 5 ? 'give_up' : 'failed'
    if (decision === 'give_up') {
      updateAction(row.account_id, row.listing_id, {
        decision: 'give_up',
        assetId,
        failCount,
        lastError: like.error,
      })
    } else {
      const now = new Date().toISOString()
      db.prepare(
        `UPDATE account_character_actions SET decision = 'pending', fail_count = ?, last_error = ?, updated_at = ? WHERE account_id = ? AND listing_id = ?`,
      ).run(failCount, like.error || 'like failed', now, row.account_id, row.listing_id)
    }
    appendConsoleLog({
      level: 'error',
      action: 'like',
      accountEmail: who,
      listingId: row.listing_id,
      message: `点赞失败「${title}」：${like.error}${rateLimited ? '（限流）' : ''} · 将重试(${failCount}/5)`,
    })
    return {
      ok: false,
      action: decision === 'give_up' ? 'give_up' : 'failed',
      rateLimited,
      accountEmail: who,
      listingId: row.listing_id,
      title,
      error: like.error,
    }
  }

  const likedAt = new Date().toISOString()
  updateAction(row.account_id, row.listing_id, {
    decision: 'liked',
    assetId,
    likedAt,
  })
  appendConsoleLog({
    level: 'info',
    action: 'like',
    accountEmail: who,
    listingId: row.listing_id,
    message: `已点赞「${title}」`,
  })

  // 点赞成功后再按档位抽评论（热门约 50赞:18评；新发布更高；J哥/Big D 约 70%）
  if (Math.random() > commentRate) {
    appendConsoleLog({
      level: 'info',
      action: 'skip_comment',
      accountEmail: who,
      listingId: row.listing_id,
      message: `仅点赞「${title}」（${rateLabel} · 评 ${(commentRate * 100).toFixed(0)}%）`,
    })
    return {
      ok: true,
      action: 'liked',
      accountEmail: who,
      listingId: row.listing_id,
      title,
      engageRate,
      message: '已点赞（本次不评论）',
    }
  }

  // 评论账号独立随机抽取（尽量换号），语言跟评论号走；Explore 用独立文案池
  const commenter = pickCommentAccount(input.accounts, row.listing_id, account.id) || account
  const commentWho = engageLogName(commenter)
  const locale = isLocale(commenter.locale || '') ? (commenter.locale as LocaleCode) : 'en'
  const localeTag = LOCALE_LABEL[locale] || locale
  const commentSurface = row.listing_kind === 'explore' ? 'explore' : 'character'
  const commentPick = pickComment(locale, commentSurface)
  if (!commentPick.ok || !commentPick.body) {
    appendConsoleLog({
      level: 'warn',
      action: 'comment',
      accountEmail: commentWho,
      listingId: row.listing_id,
      message: `点赞成功但无评论可用（${localeTag}${commentSurface === 'explore' ? ' · Explore' : ''}）`,
    })
    return {
      ok: true,
      action: 'liked',
      accountEmail: who,
      listingId: row.listing_id,
      title,
      engageRate,
      message: '已点赞（无评论）',
    }
  }

  const idem = `asset-comment:${row.listing_id}:${assetId}:${createHash('sha256')
    .update(`${commenter.id}|${row.listing_id}|${commentPick.id}`)
    .digest('hex')
    .slice(0, 32)}`
  const comment = await commentListingAsset({
    sessionToken: commenter.sessionToken,
    proxyUrl: input.proxyUrl,
    listingId: row.listing_id,
    assetId,
    body: commentPick.body,
    idempotencyKey: idem,
  })
  if (!comment.ok) {
    const rateLimited = /too many|rate|429/i.test(comment.error || '')
    appendConsoleLog({
      level: 'warn',
      action: 'comment',
      accountEmail: commentWho,
      listingId: row.listing_id,
      message: `评论失败「${title}」：${comment.error}（已保留点赞 · ${who}）`,
    })
    return {
      ok: true,
      action: 'liked',
      rateLimited,
      accountEmail: who,
      listingId: row.listing_id,
      title,
      engageRate,
      error: comment.error,
      message: '已点赞，评论失败',
    }
  }

  if (commenter.id === account.id) {
    updateAction(row.account_id, row.listing_id, {
      decision: 'commented',
      assetId,
      likedAt,
      commentedAt: new Date().toISOString(),
      commentId: comment.commentId,
      commentText: commentPick.body,
    })
  } else {
    upsertCommentedAction({
      accountId: commenter.id,
      listingId: row.listing_id,
      assetId,
      commentId: comment.commentId,
      commentText: commentPick.body,
    })
  }

  rememberCommentAccount(commenter.id)
  const rotateNote = commenter.id !== account.id ? `（赞 ${who} → 评 ${commentWho}）` : ''
  const surfaceNote = commentSurface === 'explore' ? ' · Explore' : ''
  appendConsoleLog({
    level: 'info',
    action: 'comment',
    accountEmail: commentWho,
    listingId: row.listing_id,
    message: `已评论「${title}」· [${localeTag}${surfaceNote}] ${commentPick.body.slice(0, 36)}${rotateNote}`,
  })
  return {
    ok: true,
    action: 'commented',
    accountEmail: commentWho,
    listingId: row.listing_id,
    title,
    engageRate,
    message: '点赞+评论完成',
  }
}

export async function runDiscoveryOnce(input: {
  sessionToken: string
  proxyUrl: string
  accountIds: string[]
  pages?: number
  limit?: number
}): Promise<{
  ok: boolean
  error?: string
  pages: number
  items: number
  inserted: number
  pendingCreated: number
}> {
  ensureCopyLibrariesSeeded()
  const maxPages = Math.max(1, Math.min(input.pages ?? 3, 20))
  const limit = input.limit ?? 21
  // 角色列表：50% 近一周 / 50% 新发布
  const characterSort = Math.random() < 0.5 ? 'popular_week' : 'latest'
  const sortLabel = characterSort === 'latest' ? '新发布' : '近一周推荐'
  // Explore 混流（不传 media=图+视频）：50% recommended / 50% popular
  let exploreSort = Math.random() < 0.5 ? 'recommended' : 'popular'
  const exploreSortLabel = exploreSort === 'popular' ? '欢迎度' : '推荐'
  appendConsoleLog({
    level: 'info',
    action: 'discover',
    message: `本轮：角色「${sortLabel}」+ Explore「${exploreSortLabel}」· 各 ${maxPages} 页`,
  })

  const pageResults = await Promise.all(
    Array.from({ length: maxPages }, (_, i) =>
      fetchCommunityListings({
        sessionToken: input.sessionToken,
        proxyUrl: input.proxyUrl,
        page: i + 1,
        limit,
        characterSort,
      }).then((res) => ({ page: i + 1, res })),
    ),
  )

  let totalItems = 0
  let inserted = 0
  const listingIds: string[] = []
  let firstError: string | undefined
  let okPages = 0
  for (const { page, res } of pageResults.sort((a, b) => a.page - b.page)) {
    if (!res.ok) {
      firstError = firstError || res.error
      appendConsoleLog({
        level: 'error',
        action: 'discover',
        message: `角色第 ${page} 页失败：${res.error}`,
      })
      continue
    }
    if (!res.items.length) continue
    okPages++
    const up = upsertCharacters(res.items, characterSort)
    inserted += up.inserted
    totalItems += res.items.length
    for (const it of res.items) listingIds.push(it.listing_id)
    appendConsoleLog({
      level: 'info',
      action: 'discover',
      message: `角色第 ${page} 页 ${res.items.length} 条 · 新入库 ${up.inserted}`,
    })
  }

  // Explore：cursor 翻页（顺序），limit 20；失败时可回退 popularity
  let exploreCursor: string | undefined
  let exploreOkPages = 0
  let exploreItems = 0
  let exploreInserted = 0
  for (let page = 1; page <= maxPages; page++) {
    let res = await fetchCommunityExplore({
      sessionToken: input.sessionToken,
      proxyUrl: input.proxyUrl,
      sort: exploreSort,
      limit: 20,
      cursor: exploreCursor,
    })
    if (!res.ok && exploreSort === 'popular' && page === 1) {
      exploreSort = 'popularity'
      appendConsoleLog({
        level: 'warn',
        action: 'discover',
        message: `Explore sort=popular 失败，改试 popularity：${res.error}`,
      })
      res = await fetchCommunityExplore({
        sessionToken: input.sessionToken,
        proxyUrl: input.proxyUrl,
        sort: exploreSort,
        limit: 20,
      })
    }
    if (!res.ok) {
      firstError = firstError || res.error
      appendConsoleLog({
        level: 'error',
        action: 'discover',
        message: `Explore 第 ${page} 页失败：${res.error}`,
      })
      break
    }
    if (!res.items.length) break
    exploreOkPages++
    const exploreFeed =
      exploreSort === 'recommended'
        ? 'explore_recommended'
        : exploreSort === 'popularity'
          ? 'explore_popularity'
          : 'explore_popular'
    const up = upsertCharacters(res.items, exploreFeed)
    exploreInserted += up.inserted
    exploreItems += res.items.length
    totalItems += res.items.length
    inserted += up.inserted
    for (const it of res.items) listingIds.push(it.listing_id)
    appendConsoleLog({
      level: 'info',
      action: 'discover',
      message: `Explore 第 ${page} 页 ${res.items.length} 条 · 新入库 ${up.inserted}（${exploreSort}）`,
    })
    if (!res.nextCursor) break
    exploreCursor = res.nextCursor
  }

  if (!listingIds.length) {
    appendConsoleLog({
      level: 'error',
      action: 'discover',
      message: firstError || '发现无结果',
    })
    return {
      ok: false,
      error: firstError || '发现无结果',
      pages: okPages + exploreOkPages,
      items: 0,
      inserted: 0,
      pendingCreated: 0,
    }
  }

  const pendingCreated = ensurePendingActions(input.accountIds, [...new Set(listingIds)]).created
  appendConsoleLog({
    level: 'info',
    action: 'discover',
    message: `本轮完成：角色「${sortLabel}」${okPages}页 + Explore「${exploreSortLabel}」${exploreOkPages}页 · 条目 ${totalItems}（Explore ${exploreItems}）· 新入库 ${inserted}（Explore ${exploreInserted}）· 新 pending ${pendingCreated}`,
  })
  return {
    ok: true,
    pages: okPages + exploreOkPages || maxPages,
    items: totalItems,
    inserted,
    pendingCreated,
  }
}

export async function renameAccountProfile(input: {
  accountId: string
  email: string
  sessionToken: string
  proxyUrl: string
  locale: LocaleCode
}): Promise<{ ok: boolean; error?: string; displayName?: string }> {
  ensureCopyLibrariesSeeded()
  // 同一账号重改名时先释放旧占用
  releaseDisplayName(input.accountId)
  const claimed = claimDisplayName(input.locale, input.accountId)
  if (!claimed.ok || !claimed.name) {
    appendConsoleLog({
      level: 'error',
      action: 'rename',
      accountEmail: input.email,
      message: claimed.error || '无名可领',
    })
    return { ok: false, error: claimed.error }
  }
  const res = await patchCreatorProfile({
    sessionToken: input.sessionToken,
    proxyUrl: input.proxyUrl,
    displayName: claimed.name,
  })
  if (!res.ok) {
    releaseDisplayName(input.accountId)
    appendConsoleLog({
      level: 'error',
      action: 'rename',
      accountEmail: input.email,
      message: `改名失败：${res.error}`,
    })
    return { ok: false, error: res.error }
  }
  appendConsoleLog({
    level: 'info',
    action: 'rename',
    accountEmail: input.email,
    message: `已改名为「${claimed.name}」（${input.locale}）`,
  })
  return { ok: true, displayName: claimed.name }
}

export function addCommentTemplate(locale: LocaleCode, body: string) {
  const db = openAccountsDb()
  const id = `cmt_custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  db.prepare(
    `INSERT INTO comment_templates (id, locale, body, enabled, use_count, created_at)
     VALUES (?, ?, ?, 1, 0, ?)`,
  ).run(id, locale, body.trim(), new Date().toISOString())
  return { ok: true, id }
}

export function addDisplayName(locale: LocaleCode, name: string) {
  const db = openAccountsDb()
  const normalized = normalizeName(name)
  const id = `name_custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  try {
    db.prepare(
      `INSERT INTO display_name_pool (id, locale, name, normalized, used_by_account_id, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(id, locale, name.trim(), normalized, new Date().toISOString())
    return { ok: true, id }
  } catch {
    return { ok: false, error: '用户名重复' }
  }
}
