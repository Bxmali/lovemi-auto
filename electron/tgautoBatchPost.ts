/**
 * 推特资源 → Lovemi 文案 → TGAuto send-album 一键群发
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { app } from 'electron'
import { fetch as undiciFetch } from 'undici'
import { twitterResourceDir } from './lovemiMediaCache'
import { generateSocialCaption } from './lovemiCaptionGen'
import { appendConsoleLog } from './consoleDb'

export type TgautoBridgeSettings = {
  baseUrl: string
  peer: string
  /** 空则读取 TGAuto broadcast.relay_account_ids */
  accountIds: number[]
  /** 已发过的角色跳过 */
  skipPosted: boolean
}

export type TgautoBatchProgress = {
  phase: 'scan' | 'caption' | 'send' | 'skip' | 'done_one' | 'error' | 'summary' | 'cancelled'
  index?: number
  total?: number
  char?: string
  accountId?: number
  message?: string
  ok?: boolean
  error?: string
  posted?: number
  failed?: number
  skipped?: number
}

export type TgautoBatchStartInput = {
  proxyUrl: string
  baseUrl?: string
  peer?: string
  accountIds?: number[]
  skipPosted?: boolean
  /** 推特资源父目录（Downloads）；空则用系统 Downloads / 配置 */
  downloadsParent?: string
}

const DEFAULTS: TgautoBridgeSettings = {
  baseUrl: 'http://127.0.0.1:8788',
  peer: 'kindredaiav1',
  accountIds: [],
  skipPosted: true,
}

type CharPair = {
  char: string
  jpg: string
  mp4: string
  mtime: number
}

type PostedMap = Record<
  string,
  { at: string; jpg: string; mp4: string; accountId: number; peer: string }
>

function settingsPath(appData: string) {
  return path.join(appData, 'tgauto-bridge.json')
}

function postedPath(appData: string) {
  return path.join(appData, 'tgauto-posted.json')
}

export function loadTgautoBridgeSettings(appData: string): TgautoBridgeSettings {
  try {
    const file = settingsPath(appData)
    if (!fs.existsSync(file)) return { ...DEFAULTS }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TgautoBridgeSettings>
    return {
      ...DEFAULTS,
      ...parsed,
      baseUrl: String(parsed.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, ''),
      peer: String(parsed.peer || DEFAULTS.peer).trim(),
      accountIds: Array.isArray(parsed.accountIds)
        ? parsed.accountIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : [],
      skipPosted: parsed.skipPosted !== false,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveTgautoBridgeSettings(
  appData: string,
  patch: Partial<TgautoBridgeSettings>,
): TgautoBridgeSettings {
  const cur = loadTgautoBridgeSettings(appData)
  const next: TgautoBridgeSettings = {
    ...cur,
    ...patch,
    baseUrl: String(patch.baseUrl ?? cur.baseUrl).replace(/\/$/, ''),
    peer: String(patch.peer ?? cur.peer).trim(),
    accountIds: Array.isArray(patch.accountIds)
      ? patch.accountIds.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : cur.accountIds,
    skipPosted: patch.skipPosted !== undefined ? Boolean(patch.skipPosted) : cur.skipPosted,
  }
  fs.writeFileSync(settingsPath(appData), JSON.stringify(next, null, 2), 'utf8')
  return next
}

function loadPosted(appData: string): PostedMap {
  try {
    const file = postedPath(appData)
    if (!fs.existsSync(file)) return {}
    return JSON.parse(fs.readFileSync(file, 'utf8')) as PostedMap
  } catch {
    return {}
  }
}

function savePosted(appData: string, map: PostedMap) {
  fs.writeFileSync(postedPath(appData), JSON.stringify(map, null, 2), 'utf8')
}

export function listTwitterCharacterPairs(downloadsParent: string): CharPair[] {
  const dir = twitterResourceDir(downloadsParent)
  const groups = new Map<string, { jpg?: string; mp4?: string; mtime: number }>()
  for (const name of fs.readdirSync(dir)) {
    const lower = name.toLowerCase()
    if (!/\.(jpg|jpeg|mp4|png)$/.test(lower)) continue
    const char = name.split(/[_－—\-\s]+/)[0]?.trim()
    if (!char || /^(m-|asset|aset|chr_|slot|槽)/i.test(char)) continue
    const full = path.join(dir, name)
    let st: fs.Stats
    try {
      st = fs.statSync(full)
    } catch {
      continue
    }
    if (!groups.has(char)) groups.set(char, { mtime: 0 })
    const g = groups.get(char)!
    const kind = lower.endsWith('.mp4') ? 'mp4' : 'jpg'
    const prev = g[kind]
    if (!prev || st.mtimeMs > fs.statSync(prev).mtimeMs) g[kind] = full
    g.mtime = Math.max(g.mtime, st.mtimeMs)
  }
  return [...groups.entries()]
    .filter(([, g]) => g.jpg && g.mp4)
    .sort((a, b) => a[1].mtime - b[1].mtime)
    .map(([char, g]) => ({
      char,
      jpg: g.jpg!,
      mp4: g.mp4!,
      mtime: g.mtime,
    }))
}

function extractVideoFrames(mp4: string, workDir: string): Array<{ base64: string; mimeType: string }> {
  fs.mkdirSync(workDir, { recursive: true })
  const out: Array<{ base64: string; mimeType: string }> = []
  for (const [i, ss] of [
    [1, '0.5'],
    [2, '2.0'],
    [3, '3.5'],
  ] as const) {
    const file = path.join(workDir, `frame${i}.jpg`)
    spawnSync('ffmpeg', ['-y', '-ss', ss, '-i', mp4, '-frames:v', '1', '-q:v', '2', file], {
      stdio: 'ignore',
    })
    if (fs.existsSync(file)) {
      out.push({ base64: fs.readFileSync(file).toString('base64'), mimeType: 'image/jpeg' })
    }
  }
  return out
}

function fitTelegramCaption(full: string): string {
  if ([...full].length <= 1024) return full
  const head = full.split(/\n\n💗 Lovemi/)[0]?.trim() || full.slice(0, 900)
  const footer = '\n\n💗 Lovemi → https://ackr.app/e2'
  let out = head + footer
  if ([...out].length <= 1024) return `${out}\n`
  const keep = 1024 - [...footer].length - 1
  return `${[...head].slice(0, Math.max(200, keep)).join('').trimEnd()}…${footer}\n`
}

async function fetchRelayAccountIds(baseUrl: string): Promise<number[]> {
  try {
    const res = await undiciFetch(`${baseUrl}/api/broadcast/settings`, {
      signal: AbortSignal.timeout(8000),
    })
    const data = (await res.json().catch(() => ({}))) as { relay_account_ids?: number[] }
    const ids = Array.isArray(data.relay_account_ids)
      ? data.relay_account_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : []
    return ids.slice(0, 3)
  } catch {
    return []
  }
}

export async function checkTgautoHealth(baseUrl: string): Promise<{ ok: boolean; error?: string; baseUrl: string }> {
  const url = String(baseUrl || DEFAULTS.baseUrl).replace(/\/$/, '')
  const health = await tgautoHealth(url)
  return { ...health, baseUrl: url }
}

async function tgautoHealth(baseUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await undiciFetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean }
    if (res.ok && data.ok) return { ok: true }
    return { ok: false, error: `TGAuto 健康检查失败 HTTP ${res.status}` }
  } catch (e) {
    return {
      ok: false,
      error: `连不上 TGAuto（${baseUrl}）：${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

async function sendAlbum(input: {
  baseUrl: string
  accountId: number
  peer: string
  caption: string
  paths: string[]
}): Promise<{ ok: boolean; error?: string; sent?: number }> {
  try {
    const res = await undiciFetch(`${input.baseUrl}/api/contacts/send-album`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(300_000),
      body: JSON.stringify({
        account_id: input.accountId,
        peer: input.peer,
        caption: input.caption,
        paths: input.paths,
      }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      sent?: number
      detail?: string
      message?: string
      error?: string
    }
    if (!res.ok || data.ok === false) {
      return {
        ok: false,
        error: String(data.detail || data.error || data.message || `HTTP ${res.status}`),
      }
    }
    return { ok: true, sent: data.sent }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

let cancelFlag = false
let running = false

export function cancelTgautoBatch() {
  cancelFlag = true
}

export function isTgautoBatchRunning() {
  return running
}

export async function runTgautoBatchPost(input: {
  appData: string
  downloadsParent: string
  proxyUrl: string
  baseUrl?: string
  peer?: string
  accountIds?: number[]
  skipPosted?: boolean
  onProgress: (p: TgautoBatchProgress) => void
}): Promise<{
  ok: boolean
  error?: string
  posted: number
  failed: number
  skipped: number
  total: number
}> {
  if (running) return { ok: false, error: '已有群发任务在跑', posted: 0, failed: 0, skipped: 0, total: 0 }
  running = true
  cancelFlag = false

  const settings = saveTgautoBridgeSettings(input.appData, {
    baseUrl: input.baseUrl,
    peer: input.peer,
    accountIds: input.accountIds,
    skipPosted: input.skipPosted,
  })
  const baseUrl = settings.baseUrl
  const peer = settings.peer
  if (!peer) {
    running = false
    return { ok: false, error: '未配置目标频道 peer', posted: 0, failed: 0, skipped: 0, total: 0 }
  }
  if (!input.proxyUrl) {
    running = false
    return { ok: false, error: '未配置出站代理', posted: 0, failed: 0, skipped: 0, total: 0 }
  }

  const health = await tgautoHealth(baseUrl)
  if (!health.ok) {
    running = false
    return { ok: false, error: health.error, posted: 0, failed: 0, skipped: 0, total: 0 }
  }

  let accounts =
    settings.accountIds.length > 0 ? settings.accountIds.slice(0, 3) : await fetchRelayAccountIds(baseUrl)
  if (!accounts.length) {
    running = false
    return {
      ok: false,
      error: '没有可用转发号（请在 TGAuto 配置 relay，或在此填写 accountIds）',
      posted: 0,
      failed: 0,
      skipped: 0,
      total: 0,
    }
  }

  const pairs = listTwitterCharacterPairs(input.downloadsParent)
  input.onProgress({
    phase: 'scan',
    total: pairs.length,
    message: `推特资源共 ${pairs.length} 组角色（jpg+mp4）· 转发号 ${accounts.join(',')}`,
  })

  const postedMap = loadPosted(input.appData)
  let posted = 0
  let failed = 0
  let skipped = 0
  const workRoot = path.join(app.getPath('temp'), 'lovemi-tgauto-batch')
  fs.mkdirSync(workRoot, { recursive: true })

  for (let i = 0; i < pairs.length; i++) {
    if (cancelFlag) {
      input.onProgress({ phase: 'cancelled', message: '已取消', posted, failed, skipped, total: pairs.length })
      break
    }
    const item = pairs[i]!
    if (settings.skipPosted && postedMap[item.char]?.jpg === item.jpg && postedMap[item.char]?.mp4 === item.mp4) {
      skipped++
      input.onProgress({
        phase: 'skip',
        index: i,
        total: pairs.length,
        char: item.char,
        message: `跳过已发过：${item.char}`,
      })
      continue
    }

    try {
      input.onProgress({
        phase: 'caption',
        index: i,
        total: pairs.length,
        char: item.char,
        message: `生成文案 ${i + 1}/${pairs.length} · ${item.char}`,
      })
      const work = path.join(workRoot, `c_${i}`)
      const frames = extractVideoFrames(item.mp4, work)
      const jpgB64 = fs.readFileSync(item.jpg).toString('base64')
      const images = [{ base64: jpgB64, mimeType: 'image/jpeg' as const }, ...frames].slice(0, 4)
      const cap = await generateSocialCaption({
        proxyUrl: input.proxyUrl,
        images,
        fileName: path.basename(item.jpg),
        characterName: item.char,
        style: 'standard',
      })
      if (!cap.ok || !cap.caption) throw new Error(cap.error || '文案生成失败')
      const caption = fitTelegramCaption(cap.caption)

      const preferred = accounts[i % accounts.length]!
      const order = [preferred, ...accounts.filter((a) => a !== preferred)]
      let sendOk = false
      let lastErr = ''
      let usedAccount = preferred
      for (const aid of order) {
        if (cancelFlag) break
        input.onProgress({
          phase: 'send',
          index: i,
          total: pairs.length,
          char: item.char,
          accountId: aid,
          message: `发送 ${item.char} → #${aid} → ${peer}`,
        })
        const sent = await sendAlbum({
          baseUrl,
          accountId: aid,
          peer,
          caption,
          paths: [item.jpg, item.mp4],
        })
        if (sent.ok) {
          sendOk = true
          usedAccount = aid
          break
        }
        lastErr = sent.error || '发送失败'
        input.onProgress({
          phase: 'error',
          index: i,
          total: pairs.length,
          char: item.char,
          accountId: aid,
          error: lastErr,
          message: `号 ${aid} 失败：${lastErr}，尝试下一号…`,
        })
      }

      if (!sendOk) {
        failed++
        input.onProgress({
          phase: 'done_one',
          index: i,
          total: pairs.length,
          char: item.char,
          ok: false,
          error: lastErr,
          message: `失败 ${item.char}：${lastErr}`,
        })
        continue
      }

      postedMap[item.char] = {
        at: new Date().toISOString(),
        jpg: item.jpg,
        mp4: item.mp4,
        accountId: usedAccount,
        peer,
      }
      savePosted(input.appData, postedMap)
      posted++
      input.onProgress({
        phase: 'done_one',
        index: i,
        total: pairs.length,
        char: item.char,
        accountId: usedAccount,
        ok: true,
        message: `已发 ${item.char} · 号 ${usedAccount}`,
      })
      appendConsoleLog({
        level: 'info',
        action: 'tgauto-batch',
        message: `已群发 ${item.char} → ${peer} via #${usedAccount}`,
      })
    } catch (e) {
      failed++
      const err = e instanceof Error ? e.message : String(e)
      input.onProgress({
        phase: 'done_one',
        index: i,
        total: pairs.length,
        char: item.char,
        ok: false,
        error: err,
        message: `失败 ${item.char}：${err}`,
      })
    }
  }

  running = false
  cancelFlag = false
  const summary = {
    ok: failed === 0,
    posted,
    failed,
    skipped,
    total: pairs.length,
  }
  input.onProgress({
    phase: 'summary',
    ...summary,
    message: `完成：成功 ${posted} · 失败 ${failed} · 跳过 ${skipped} / 共 ${pairs.length}`,
  })
  return summary
}

export function previewTgautoBatch(appData: string, downloadsParent: string) {
  const settings = loadTgautoBridgeSettings(appData)
  const pairs = listTwitterCharacterPairs(downloadsParent)
  const postedMap = loadPosted(appData)
  const pending = pairs.filter(
    (p) => !(settings.skipPosted && postedMap[p.char]?.jpg === p.jpg && postedMap[p.char]?.mp4 === p.mp4),
  )
  return {
    ok: true as const,
    settings,
    resourceDir: twitterResourceDir(downloadsParent),
    total: pairs.length,
    pending: pending.length,
    posted: pairs.length - pending.length,
    characters: pending.map((p) => p.char),
  }
}
