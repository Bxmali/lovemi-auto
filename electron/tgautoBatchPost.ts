/**
 * 推特资源 → Lovemi 文案 → TGAuto send-album 一键群发
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
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
    // 已标记发送的跳过扫描（避免重复入队）
    if (/已发送/.test(name)) continue
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

function runFfmpegFrame(mp4: string, ss: string, outFile: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false)
      return
    }
    const child = spawn(
      'ffmpeg',
      ['-y', '-ss', ss, '-i', mp4, '-frames:v', '1', '-q:v', '3', outFile],
      { stdio: 'ignore' },
    )
    const onAbort = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', () => {
      signal?.removeEventListener('abort', onAbort)
      resolve(false)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      resolve(code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 200)
    })
  })
}

/** 异步抽帧，不卡主进程；群发默认只抽 1 帧加快速度 */
async function extractVideoFrames(
  mp4: string,
  workDir: string,
  signal?: AbortSignal,
  maxFrames = 1,
): Promise<Array<{ base64: string; mimeType: string }>> {
  fs.mkdirSync(workDir, { recursive: true })
  const stamps = (['0.8', '2.0', '3.5'] as const).slice(0, Math.max(1, maxFrames))
  const out: Array<{ base64: string; mimeType: string }> = []
  for (let i = 0; i < stamps.length; i++) {
    if (signal?.aborted) break
    const file = path.join(workDir, `frame${i + 1}.jpg`)
    const ok = await runFfmpegFrame(mp4, stamps[i]!, file, signal)
    if (ok) out.push({ base64: fs.readFileSync(file).toString('base64'), mimeType: 'image/jpeg' })
  }
  return out
}

/** 发送成功后：文件名追加「已发送」 */
function markPathAsSent(filePath: string): string {
  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  if (/已发送/.test(base)) return filePath
  let dest = path.join(dir, `${base}_已发送${ext}`)
  let n = 2
  while (fs.existsSync(dest) && dest !== filePath) {
    dest = path.join(dir, `${base}_已发送_${n}${ext}`)
    n += 1
    if (n > 50) break
  }
  try {
    fs.renameSync(filePath, dest)
    return dest
  } catch {
    return filePath
  }
}

function parseFloodWaitSeconds(err: string): number | null {
  const m =
    err.match(/FLOOD_WAIT[^0-9]*(\d+)/i) ||
    err.match(/wait of (\d+) seconds/i) ||
    err.match(/value:\s*(\d+)/i)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 本轮应冷却的账号错误（别再撞） */
function isHardAccountCoolError(err: string): string | null {
  if (/FROZEN_METHOD_INVALID/i.test(err)) return '媒体上传被冻结(FROZEN)'
  if (/USER_DEACTIVATED|AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_BANNED/i.test(err)) {
    return '账号不可用'
  }
  if (/PEER_FLOOD/i.test(err)) return 'PEER_FLOOD'
  const floodSec = parseFloodWaitSeconds(err)
  if (floodSec != null && floodSec >= 30) return `FLOOD_WAIT ${floodSec}s`
  return null
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
  signal?: AbortSignal
}): Promise<{ ok: boolean; error?: string; sent?: number }> {
  // jpg+mp4 相册上传经常 >90s；超时只换号，取消仍靠 batch AbortController
  const SEND_TIMEOUT_MS = 240_000
  const timeout = AbortSignal.timeout(SEND_TIMEOUT_MS)
  try {
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
    const res = await undiciFetch(`${input.baseUrl}/api/contacts/send-album`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
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
    if (input.signal?.aborted) return { ok: false, error: '任务已取消' }
    const msg = e instanceof Error ? e.message : String(e)
    if (/timeout|TimeoutError/i.test(msg) || (e instanceof Error && e.name === 'TimeoutError')) {
      return {
        ok: false,
        error: `发送超时（${Math.round(SEND_TIMEOUT_MS / 1000)}s 内 TGAuto 未返回，常见于大视频上传慢）`,
      }
    }
    // AbortSignal.any 超时也可能是 AbortError + timeout 文案
    if (/aborted due to timeout/i.test(msg)) {
      return {
        ok: false,
        error: `发送超时（${Math.round(SEND_TIMEOUT_MS / 1000)}s 内 TGAuto 未返回，常见于大视频上传慢）`,
      }
    }
    if (e instanceof Error && e.name === 'AbortError') {
      return { ok: false, error: '任务已取消' }
    }
    return { ok: false, error: msg }
  }
}

let cancelFlag = false
let running = false
let batchAbort: AbortController | null = null

export function cancelTgautoBatch() {
  cancelFlag = true
  try {
    batchAbort?.abort()
  } catch {
    /* ignore */
  }
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
  batchAbort?.abort()
  batchAbort = new AbortController()
  const signal = batchAbort.signal

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
    batchAbort = null
    return { ok: false, error: '未配置目标频道 peer', posted: 0, failed: 0, skipped: 0, total: 0 }
  }
  if (!input.proxyUrl) {
    running = false
    batchAbort = null
    return { ok: false, error: '未配置出站代理', posted: 0, failed: 0, skipped: 0, total: 0 }
  }

  const health = await tgautoHealth(baseUrl)
  if (!health.ok) {
    running = false
    batchAbort = null
    return { ok: false, error: health.error, posted: 0, failed: 0, skipped: 0, total: 0 }
  }

  let accounts =
    settings.accountIds.length > 0 ? settings.accountIds.slice(0, 3) : await fetchRelayAccountIds(baseUrl)
  if (!accounts.length) {
    running = false
    batchAbort = null
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
  const cooledAccounts = new Set<number>()
  let stickyAccount: number | null = null
  const workRoot = path.join(app.getPath('temp'), 'lovemi-tgauto-batch')
  fs.mkdirSync(workRoot, { recursive: true })

  for (let i = 0; i < pairs.length; i++) {
    if (cancelFlag || signal.aborted) {
      input.onProgress({
        phase: 'cancelled',
        message: '已取消群发',
        posted,
        failed,
        skipped,
        total: pairs.length,
      })
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
      const work = path.join(workRoot, `c_${i}_${Date.now()}`)
      const frames = await extractVideoFrames(item.mp4, work, signal, 1)
      if (cancelFlag || signal.aborted) throw new Error('任务已取消')
      const jpgB64 = fs.readFileSync(item.jpg).toString('base64')
      // 加快：立绘 + 最多 1 帧
      const images = [{ base64: jpgB64, mimeType: 'image/jpeg' as const }, ...frames].slice(0, 2)
      let cap = await generateSocialCaption({
        proxyUrl: input.proxyUrl,
        images,
        fileName: path.basename(item.jpg),
        characterName: item.char,
        style: 'standard',
        signal,
        timeoutMs: 90_000,
      })
      // 偶发 fetch failed：自动再试一次
      if (
        !cap.ok &&
        cap.error &&
        /fetch failed|ECONNRESET|ETIMEDOUT|socket/i.test(cap.error) &&
        !cancelFlag &&
        !signal.aborted
      ) {
        input.onProgress({
          phase: 'caption',
          index: i,
          total: pairs.length,
          char: item.char,
          message: `文案网络抖动，重试 ${item.char}…`,
        })
        await new Promise((r) => setTimeout(r, 1200))
        cap = await generateSocialCaption({
          proxyUrl: input.proxyUrl,
          images,
          fileName: path.basename(item.jpg),
          characterName: item.char,
          style: 'standard',
          signal,
          timeoutMs: 90_000,
        })
      }
      if (cancelFlag || signal.aborted || cap.error === '任务已取消') throw new Error('任务已取消')
      if (!cap.ok || !cap.caption) throw new Error(cap.error || '文案生成失败')
      const caption = fitTelegramCaption(cap.caption)

      const liveAccounts = accounts.filter((a) => !cooledAccounts.has(a))
      if (!liveAccounts.length) {
        throw new Error('全部转发号不可用（FLOOD/冻结），请稍后再发或换号')
      }
      // 优先用上一成功号，避免轮询撞上已坏号
      const preferred =
        stickyAccount && liveAccounts.includes(stickyAccount)
          ? stickyAccount
          : liveAccounts[0]!
      const order = [preferred, ...liveAccounts.filter((a) => a !== preferred)]
      let sendOk = false
      let lastErr = ''
      let usedAccount = preferred
      for (const aid of order) {
        if (cancelFlag || signal.aborted) break
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
          signal,
        })
        if (sent.ok) {
          sendOk = true
          usedAccount = aid
          stickyAccount = aid
          break
        }
        lastErr = sent.error || '发送失败'
        if (lastErr === '任务已取消' || cancelFlag || signal.aborted) break
        const coolReason = isHardAccountCoolError(lastErr)
        if (coolReason) {
          cooledAccounts.add(aid)
          if (stickyAccount === aid) stickyAccount = null
          input.onProgress({
            phase: 'error',
            index: i,
            total: pairs.length,
            char: item.char,
            accountId: aid,
            error: lastErr,
            message: `号 ${aid} ${coolReason}，本轮跳过该号`,
          })
          continue
        }
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

      if (cancelFlag || signal.aborted || lastErr === '任务已取消') {
        input.onProgress({
          phase: 'cancelled',
          message: '已取消群发',
          posted,
          failed,
          skipped,
          total: pairs.length,
        })
        break
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

      const jpgSent = markPathAsSent(item.jpg)
      const mp4Sent = markPathAsSent(item.mp4)
      postedMap[item.char] = {
        at: new Date().toISOString(),
        jpg: jpgSent,
        mp4: mp4Sent,
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
        message: `已发 ${item.char} · 号 ${usedAccount} · 文件已标「已发送」`,
      })
      appendConsoleLog({
        level: 'info',
        action: 'tgauto-batch',
        message: `已群发 ${item.char} → ${peer} via #${usedAccount}`,
      })
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      if (cancelFlag || signal.aborted || err === '任务已取消') {
        input.onProgress({
          phase: 'cancelled',
          message: '已取消群发',
          posted,
          failed,
          skipped,
          total: pairs.length,
        })
        break
      }
      failed++
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

  const wasCancelled = cancelFlag || signal.aborted
  running = false
  cancelFlag = false
  batchAbort = null
  const summary = {
    ok: !wasCancelled && failed === 0,
    posted,
    failed,
    skipped,
    total: pairs.length,
  }
  if (!wasCancelled) {
    input.onProgress({
      phase: 'summary',
      ...summary,
      message: `完成：成功 ${posted} · 失败 ${failed} · 跳过 ${skipped} / 共 ${pairs.length}`,
    })
  }
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
