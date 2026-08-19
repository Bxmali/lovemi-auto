import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import net from 'node:net'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { buildSingBoxConfig, extractAllVlessUris, parseVlessUri, type VlessNode } from './parse'

const VLESS_LISTEN_PORT = 17891
const SINGBOX_VERSION = '1.11.15'

export type VlessBridgeStatus = {
  running: boolean
  proxyUrl?: string
  nodeServer?: string
  error?: string
  source: 'vless' | 'fallback-local' | 'none'
}

let child: ChildProcessWithoutNullStreams | null = null
let lastNode: VlessNode | null = null
let lastError: string | undefined
let starting: Promise<VlessBridgeStatus> | null = null

function platformTag() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64'
  }
  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'linux-arm64' : 'linux-amd64'
  }
  return process.arch === 'arm64' ? 'windows-arm64' : 'windows-amd64'
}

function vendorCandidates(): string[] {
  const roots = [
    path.join(app.getAppPath(), 'vendor'),
    path.join(process.cwd(), 'vendor'),
    path.join(app.getPath('userData'), 'bin'),
  ]
  const name = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box'
  const folder = `sing-box-${SINGBOX_VERSION}-${platformTag()}`
  const list: string[] = []
  for (const root of roots) {
    list.push(path.join(root, folder, name))
    list.push(path.join(root, name))
  }
  return list
}

function findSingBox(): string | null {
  for (const p of vendorCandidates()) {
    if (fs.existsSync(p)) return p
  }
  return null
}

async function downloadWithOptionalProxy(url: string, dest: string, proxyUrl?: string) {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  const res = await undiciFetch(url, { dispatcher })
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest))
}

async function ensureSingBoxBinary(fallbackLocalProxy?: string): Promise<string> {
  const existing = findSingBox()
  if (existing) return existing

  const destRoot = path.join(app.getPath('userData'), 'bin')
  fs.mkdirSync(destRoot, { recursive: true })
  const tag = platformTag()
  const folder = `sing-box-${SINGBOX_VERSION}-${tag}`
  const archive = path.join(destRoot, 'sing-box.tgz')
  const url = `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-${tag}.tar.gz`

  try {
    await downloadWithOptionalProxy(url, archive, undefined)
  } catch {
    if (!fallbackLocalProxy) throw new Error('下载 sing-box 失败（直连），请开启本地 7890 兜底后重试')
    await downloadWithOptionalProxy(url, archive, fallbackLocalProxy)
  }

  await new Promise<void>((resolve, reject) => {
    const p = spawn('tar', ['-xzf', archive, '-C', destRoot], { stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))))
  })

  const bin = path.join(destRoot, folder, process.platform === 'win32' ? 'sing-box.exe' : 'sing-box')
  if (!fs.existsSync(bin)) throw new Error('sing-box 解压后未找到二进制')
  try {
    fs.chmodSync(bin, 0o755)
  } catch {
    /* ignore */
  }
  return bin
}

export async function fetchSubscriptionNode(
  subscriptionUrl: string,
  fallbackLocalProxy?: string,
): Promise<VlessNode> {
  const tryFetch = async (proxyUrl?: string) => {
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
    const res = await undiciFetch(subscriptionUrl, {
      dispatcher,
      headers: { 'User-Agent': 'LovemiAuto/0.1' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`订阅 HTTP ${res.status}`)
    const body = await res.text()
    const uris = extractAllVlessUris(body)
    if (!uris.length) throw new Error('订阅无 vless:// 节点')
    // 随机挑一个，避免总卡在失效的第一个节点
    const pick = uris[Math.floor(Math.random() * Math.min(uris.length, 12))]
    return parseVlessUri(pick)
  }

  try {
    return await tryFetch(undefined)
  } catch (e1) {
    if (!fallbackLocalProxy) throw e1
    try {
      return await tryFetch(fallbackLocalProxy)
    } catch (e2) {
      throw new Error(
        `拉取 VLESS 订阅失败：直连 ${(e1 as Error).message}；经本地兜底 ${(e2 as Error).message}`,
      )
    }
  }
}

async function probeProxyHealthy(proxyUrl: string): Promise<boolean> {
  try {
    const res = await undiciFetch('https://api.lovemi.ai/v1/auth/me', {
      dispatcher: new ProxyAgent(proxyUrl),
      signal: AbortSignal.timeout(12_000),
    })
    // 401 = 通路正常（未带票）
    return res.status === 401 || res.status === 200 || res.status === 403
  } catch {
    return false
  }
}

export async function stopVlessBridge() {
  if (!child) return
  const c = child
  child = null
  try {
    c.kill('SIGTERM')
  } catch {
    /* ignore */
  }
}

function waitPort(port: number, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now()
    const tryOnce = () => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {
        s.end()
        resolve()
      })
      s.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`VLESS 入站 ${port} 启动超时`))
        else setTimeout(tryOnce, 200)
      })
    }
    tryOnce()
  })
}

export async function startVlessBridge(opts: {
  subscriptionUrl: string
  fallbackLocalProxy?: string
}): Promise<VlessBridgeStatus> {
  if (starting) return starting
  starting = (async () => {
    try {
      await stopVlessBridge()
      const bin = await ensureSingBoxBinary(opts.fallbackLocalProxy)
      const confDir = path.join(app.getPath('userData'), 'vless')
      fs.mkdirSync(confDir, { recursive: true })
      const confPath = path.join(confDir, 'sing-box.json')

      let lastStartError = ''
      for (let attempt = 0; attempt < 5; attempt++) {
        const node = await fetchSubscriptionNode(opts.subscriptionUrl, opts.fallbackLocalProxy)
        lastNode = node
        const config = buildSingBoxConfig(node, VLESS_LISTEN_PORT)
        fs.writeFileSync(confPath, JSON.stringify(config, null, 2), 'utf8')

        child = spawn(bin, ['run', '-c', confPath], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        })
        child.on('exit', () => {
          child = null
        })

        try {
          await waitPort(VLESS_LISTEN_PORT, 10000)
        } catch (e) {
          lastStartError = e instanceof Error ? e.message : String(e)
          await stopVlessBridge()
          continue
        }

        const proxyUrl = `http://127.0.0.1:${VLESS_LISTEN_PORT}`
        const healthy = await probeProxyHealthy(proxyUrl)
        if (healthy) {
          lastError = undefined
          return {
            running: true,
            proxyUrl,
            nodeServer: `${node.server}:${node.port}`,
            source: 'vless',
          }
        }
        lastStartError = `节点 ${node.server}:${node.port} 不通 Lovemi API`
        await stopVlessBridge()
      }

      lastError = lastStartError || 'VLESS 多节点尝试均失败'
      return {
        running: false,
        error: lastError,
        source: 'none',
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      await stopVlessBridge()
      return {
        running: false,
        error: lastError,
        source: 'none',
      }
    } finally {
      starting = null
    }
  })()
  return starting
}

/** 主通道 VLESS；失败则本地 7890 兜底；禁止直连 */
export async function resolveMailProxy(opts: {
  vlessEnabled: boolean
  subscriptionUrl: string
  localEnabled: boolean
  localProxyUrl: string
}): Promise<VlessBridgeStatus> {
  if (opts.vlessEnabled && opts.subscriptionUrl.trim()) {
    const st = await startVlessBridge({
      subscriptionUrl: opts.subscriptionUrl.trim(),
      fallbackLocalProxy: opts.localEnabled ? opts.localProxyUrl : undefined,
    })
    if (st.running && st.proxyUrl) return st
    lastError = st.error
  }

  if (opts.localEnabled && opts.localProxyUrl) {
    return {
      running: false,
      proxyUrl: opts.localProxyUrl,
      error: lastError,
      source: 'fallback-local',
    }
  }

  return {
    running: false,
    error: lastError || 'VLESS 未就绪且本地兜底未启用（禁止直连）',
    source: 'none',
  }
}

export function getVlessStatus(): VlessBridgeStatus {
  if (child && lastNode) {
    return {
      running: true,
      proxyUrl: `http://127.0.0.1:${VLESS_LISTEN_PORT}`,
      nodeServer: `${lastNode.server}:${lastNode.port}`,
      source: 'vless',
    }
  }
  return { running: false, error: lastError, source: 'none' }
}
