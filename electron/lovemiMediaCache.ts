/**
 * 经代理拉取 Lovemi CDN 媒体到本地缓存，供渲染进程用 lovemi-cache:// 播放
 *（直连 CDN 常黑屏：无代理 / 缺 Referer）
 * 同时可复制到 ~/Downloads/推特资源/{角色名}.ext（带粉色官方水印）
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fetch as undiciFetch } from 'undici'
import { dispatcherFor } from './mailProbe'
import { appendConsoleLog } from './consoleDb'

/** ESM bundle 下没有 Node 的 __dirname */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

export function mediaCacheDir(appData: string) {
  const dir = path.join(appData, 'media-cache')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function twitterResourceDir(downloadsPath: string) {
  const dir = path.join(downloadsPath, '推特资源')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function sanitizeFileBase(name: string) {
  const s = (name || '')
    .replace(/[\\/:*?"<>|\n\r\t]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.slice(0, 60) || '未命名'
}

function watermarkScriptPath(): string {
  // vite-plugin-electron: MODULE_DIR ≈ dist-electron；开发时脚本在 electron/
  const candidates = [
    path.join(MODULE_DIR, 'watermark_pink.py'),
    path.join(MODULE_DIR, '..', 'electron', 'watermark_pink.py'),
    path.join(process.cwd(), 'electron', 'watermark_pink.py'),
  ]
  return candidates.find((p) => fs.existsSync(p)) || candidates[0]
}

/**
 * 粉色官方水印 + Telegram 友好导出（下载到推特资源时）
 * 图片强制 JPEG；视频强制 1080x1920 H.264/AAC
 * 必须用异步 spawn：同步 spawnSync 会卡死 Electron 主进程（跑完 1~2 个角色后像闪退）。
 */
export async function applyPinkOfficialWatermark(input: {
  srcPath: string
  destPath: string
  kind?: 'portrait' | 'video' | 'media'
  /** 仅转格式、不打水印（水印失败时的回退） */
  noWatermark?: boolean
}): Promise<{ ok: boolean; error?: string; destPath?: string }> {
  try {
    if (!input.srcPath || !fs.existsSync(input.srcPath)) {
      return { ok: false, error: '源文件不存在' }
    }
    const script = watermarkScriptPath()
    if (!fs.existsSync(script)) {
      return { ok: false, error: `水印脚本缺失 · ${script}` }
    }

    const ext = path.extname(input.destPath).toLowerCase()
    const isVideo =
      input.kind === 'video' ||
      /\.(mp4|webm|mov|m4v)$/i.test(ext)

    // 脚本会强制改成 .jpg / .mp4
    const finalDest = input.destPath.replace(/\.[^.]+$/i, isVideo ? '.mp4' : '.jpg')
    fs.mkdirSync(path.dirname(finalDest), { recursive: true })
    const args = [script, input.srcPath, finalDest]
    if (isVideo) args.push('--video')
    if (input.noWatermark) args.push('--no-watermark')

    const timeoutMs = isVideo ? 420_000 : 90_000
    const pythonBins =
      process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']
    const run = await new Promise<{
      code: number | null
      stdout: string
      stderr: string
      timedOut: boolean
    }>((resolve) => {
      const spawnPython = (binIndex: number) => {
        const bin = pythonBins[binIndex]
        const child = spawn(bin, process.platform === 'win32' && bin === 'py' ? ['-3', ...args] : args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        let stdout = ''
        let stderr = ''
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          try {
            child.kill()
          } catch {
            /* ignore */
          }
        }, timeoutMs)
        child.stdout.on('data', (chunk: Buffer | string) => {
          stdout += String(chunk)
          if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024)
        })
        child.stderr.on('data', (chunk: Buffer | string) => {
          stderr += String(chunk)
          if (stderr.length > 8 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024)
        })
        child.on('error', (err) => {
          clearTimeout(timer)
          if (binIndex + 1 < pythonBins.length) {
            spawnPython(binIndex + 1)
            return
          }
          resolve({ code: 1, stdout, stderr: err.message, timedOut })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({ code, stdout, stderr, timedOut })
        })
      }
      spawnPython(0)
    })

    if (
      run.timedOut ||
      run.code !== 0 ||
      !fs.existsSync(finalDest) ||
      fs.statSync(finalDest).size < 200
    ) {
      const err = (
        run.timedOut ? 'watermark timeout' : run.stderr || run.stdout || 'watermark failed'
      ).slice(-400)
      return { ok: false, error: err }
    }
    return { ok: true, destPath: finalDest }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 复制到 Downloads/推特资源，文件名=角色名（重名自动 _2/_3），JPEG/MP4 + 粉色水印 */
export async function copyToTwitterResource(input: {
  localPath: string
  displayName: string
  downloadsPath: string
  kind?: 'portrait' | 'video' | 'media'
  /** @deprecated 推特资源统一 jpg/mp4，忽略 CDN 原扩展名 */
  extOverride?: string
}): Promise<{ ok: boolean; destPath?: string; error?: string }> {
  try {
    if (!input.localPath || !fs.existsSync(input.localPath)) {
      return { ok: false, error: '本地文件不存在' }
    }
    const dir = twitterResourceDir(input.downloadsPath)
    const head = Buffer.alloc(32)
    const fd = fs.openSync(input.localPath, 'r')
    fs.readSync(fd, head, 0, 32, 0)
    fs.closeSync(fd)
    const sniffed = sniffMediaExt(head) || path.extname(input.localPath)
    const isVideo =
      input.kind === 'video' || /\.(mp4|webm|mov|m4v)$/i.test(sniffed || '')
    // Telegram：勿存 webp（会被当贴纸）；统一 jpg / mp4
    const ext = isVideo ? '.mp4' : '.jpg'
    const base = sanitizeFileBase(input.displayName)
    let dest = path.join(dir, `${base}${ext}`)
    let n = 2
    while (fs.existsSync(dest)) {
      dest = path.join(dir, `${base}_${n}${ext}`)
      n += 1
      if (n > 99) break
    }

    const marked = await applyPinkOfficialWatermark({
      srcPath: input.localPath,
      destPath: dest,
      kind: isVideo ? 'video' : input.kind || 'portrait',
    })
    if (marked.ok && marked.destPath) {
      appendConsoleLog({
        level: 'info',
        action: 'create_char',
        message: `已保存到推特资源（含水印·TG友好）· ${path.basename(marked.destPath)}`,
      })
      return { ok: true, destPath: marked.destPath }
    }

    // 水印失败：仍转成 jpg/mp4，绝不原样落 webp
    const plain = await applyPinkOfficialWatermark({
      srcPath: input.localPath,
      destPath: dest,
      kind: isVideo ? 'video' : input.kind || 'portrait',
      noWatermark: true,
    })
    if (plain.ok && plain.destPath) {
      appendConsoleLog({
        level: 'warn',
        action: 'create_char',
        message: `水印失败已转TG友好格式 · ${path.basename(plain.destPath)} · ${marked.error?.slice(0, 100) || ''}`,
      })
      return { ok: true, destPath: plain.destPath }
    }

    return {
      ok: false,
      error: plain.error || marked.error || '导出推特资源失败',
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 按文件头魔数认真实格式（CDN 常标 png 实际是 jpeg） */
export function sniffMediaExt(buf: Buffer | Uint8Array): string | undefined {
  if (!buf || buf.length < 12) return undefined
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg'
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png'
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif'
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return '.webp'
  }
  // WebM / Matroska
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return '.webm'
  // MP4 / MOV (ftyp at offset 4)
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return '.mp4'
  return undefined
}

function extFromUrlOrMime(cdnUrl: string, mime: string, body?: Buffer) {
  const sniffed = body ? sniffMediaExt(body) : undefined
  if (sniffed) return sniffed
  if (/video\/webm/i.test(mime) || /\.webm(\?|$)/i.test(cdnUrl)) return '.webm'
  if (/video\//i.test(mime) || /\.mp4(\?|$)/i.test(cdnUrl) || /video/i.test(cdnUrl)) return '.mp4'
  if (/image\/png/i.test(mime)) return '.png'
  if (/image\/webp/i.test(mime)) return '.webp'
  if (/image\/gif/i.test(mime)) return '.gif'
  if (/image\/jpe?g/i.test(mime)) return '.jpg'
  if (/image\//i.test(mime)) return '.jpg'
  if (/\.png(\?|$)/i.test(cdnUrl)) return '.png'
  if (/\.jpe?g(\?|$)/i.test(cdnUrl)) return '.jpg'
  if (/\.webp(\?|$)/i.test(cdnUrl)) return '.webp'
  return '.bin'
}

export async function cacheLovemiCdnMedia(input: {
  cdnUrl: string
  proxyUrl: string
  appData: string
  preferredName?: string
  /** 若提供则额外复制到 Downloads/推特资源/{displayName}.ext */
  saveDisplayName?: string
  downloadsPath?: string
  kind?: 'portrait' | 'video' | 'media'
  characterId?: string
  assetId?: string
  runId?: string
}): Promise<{
  ok: boolean
  error?: string
  fileName?: string
  localPath?: string
  cacheUrl?: string
  bytes?: number
  twitterPath?: string
}> {
  const url = (input.cdnUrl || '').trim()
  if (!url.startsWith('http')) return { ok: false, error: '无效 CDN URL' }
  if (!input.proxyUrl) return { ok: false, error: '未配置出站代理' }

  const dir = mediaCacheDir(input.appData)
  const identity = [input.characterId, input.assetId, input.runId].filter(Boolean).join(':')
  const hash = createHash('sha1')
    .update(`${url.split('?')[0]}|${identity || 'legacy'}`)
    .digest('hex')
    .slice(0, 16)
  const existing = fs.readdirSync(dir).find((f) => f.startsWith(`m-${hash}.`) || f.startsWith(`m-${hash}-`))
  let localPath = ''
  let fileName = ''
  let bytes = 0

  if (existing) {
    localPath = path.join(dir, existing)
    const st = fs.statSync(localPath)
    if (st.size > 1000) {
      // 旧缓存可能扩展名错了（png 壳 jpeg 心）：按魔数纠正文件名
      const head = Buffer.alloc(32)
      const fd = fs.openSync(localPath, 'r')
      fs.readSync(fd, head, 0, 32, 0)
      fs.closeSync(fd)
      const rightExt = sniffMediaExt(head)
      const curExt = path.extname(existing).toLowerCase()
      if (rightExt && curExt && rightExt !== curExt) {
        const fixedName = `m-${hash}${rightExt}`
        const fixedPath = path.join(dir, fixedName)
        if (!fs.existsSync(fixedPath)) {
          fs.renameSync(localPath, fixedPath)
        } else {
          fs.unlinkSync(localPath)
        }
        localPath = fixedPath
        fileName = fixedName
        appendConsoleLog({
          level: 'info',
          action: 'create_char',
          message: `缓存扩展名已纠正 ${curExt} → ${rightExt} · ${fixedName}`,
        })
      } else {
        fileName = path.basename(localPath)
      }
      bytes = st.size
    }
  }

  if (!localPath || bytes < 1000) {
    try {
      const res = await undiciFetch(url, {
        method: 'GET',
        headers: {
          Accept: '*/*',
          Origin: 'https://app.lovemi.ai',
          Referer: 'https://app.lovemi.ai/',
          'Accept-Language': 'zh-CN',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
        dispatcher: dispatcherFor(input.proxyUrl, url),
        signal: AbortSignal.timeout(180_000),
      })
      if (!res.ok) {
        return { ok: false, error: `CDN HTTP ${res.status}` }
      }
      const mime = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim()
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 500) return { ok: false, error: `CDN 内容过短（${buf.length}B）` }

      const ext = extFromUrlOrMime(url, mime, buf)
      fileName = `m-${hash}${ext}`
      localPath = path.join(dir, fileName)
      fs.writeFileSync(localPath, buf)
      bytes = buf.length
      appendConsoleLog({
        level: 'info',
        action: 'create_char',
        message: `媒体已缓存本地预览 · ${fileName} · ${(buf.length / 1024 / 1024).toFixed(2)}MB${
          /png/i.test(mime) && ext === '.jpg' ? ' ·（头标 png 实为 jpeg，已按内容命名）' : ''
        }`,
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const verifyHead = Buffer.alloc(32)
  const verifyFd = fs.openSync(localPath, 'r')
  fs.readSync(verifyFd, verifyHead, 0, 32, 0)
  fs.closeSync(verifyFd)
  const verifiedExt = sniffMediaExt(verifyHead) || path.extname(localPath)
  const isVerifiedVideo = /\.(mp4|webm|mov|m4v)$/i.test(verifiedExt)
  if (input.kind === 'portrait' && isVerifiedVideo) {
    return { ok: false, error: '素材类型校验失败：立绘 URL 实际返回视频' }
  }
  if (input.kind === 'video' && !isVerifiedVideo) {
    return { ok: false, error: '素材类型校验失败：视频 URL 实际返回的不是视频' }
  }

  let twitterPath: string | undefined
  if (input.saveDisplayName && input.downloadsPath) {
    // 同一 CDN/角色素材只导出一次推特资源，避免轮询缓存反复落盘 _2/_3
    const markerPath = path.join(dir, `m-${hash}.twitter.json`)
    let reused = false
    if (fs.existsSync(markerPath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { destPath?: string }
        if (prev.destPath && fs.existsSync(prev.destPath) && fs.statSync(prev.destPath).size > 1000) {
          twitterPath = prev.destPath
          reused = true
          appendConsoleLog({
            level: 'info',
            action: 'create_char',
            message: `推特资源已存在，跳过重复导出 · ${path.basename(prev.destPath)}`,
          })
        }
      } catch {
        /* ignore bad marker */
      }
    }
    if (!reused) {
      const copied = await copyToTwitterResource({
        localPath,
        displayName: input.saveDisplayName,
        downloadsPath: input.downloadsPath,
        kind: input.kind,
        extOverride: path.extname(localPath) || undefined,
      })
      if (copied.ok && copied.destPath) {
        twitterPath = copied.destPath
        try {
          fs.writeFileSync(
            markerPath,
            JSON.stringify({ destPath: copied.destPath, at: Date.now(), url: url.split('?')[0] }),
            'utf8',
          )
        } catch {
          /* ignore marker write */
        }
      }
    }
  }

  return {
    ok: true,
    fileName,
    localPath,
    cacheUrl: `lovemi-cache://media/${encodeURIComponent(fileName)}`,
    bytes,
    twitterPath,
  }
}

/** 从角色资产对象里抠视频 CDN（字段不统一） */
export function pickAssetCdnUrl(it: Record<string, unknown>, depth = 0): string | undefined {
  if (depth > 4) return undefined
  for (const k of ['cdn_url', 'url', 'playback_url', 'download_url', 'signed_url', 'media_url']) {
    const v = it[k]
    if (typeof v === 'string' && v.startsWith('http')) return v
  }
  for (const nestKey of ['media', 'file', 'output', 'primary_variant', 'variants', 'outputs']) {
    const nest = it[nestKey]
    if (Array.isArray(nest)) {
      for (const x of nest) {
        if (x && typeof x === 'object') {
          const u = pickAssetCdnUrl(x as Record<string, unknown>, depth + 1)
          if (u) return u
        }
      }
    } else if (nest && typeof nest === 'object') {
      const u = pickAssetCdnUrl(nest as Record<string, unknown>, depth + 1)
      if (u) return u
    }
  }
  return undefined
}
