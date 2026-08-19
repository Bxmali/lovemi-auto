/**
 * 拉订阅 → 轮换节点直到 Lovemi API 通 → 监听 17891
 * LOVEMI_SUB=... node scripts/start-vless.mjs
 */
import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const PORT = 17891
const SUB =
  process.env.LOVEMI_SUB ||
  'https://kaze1.aisaka-taiga.com/oosaka/903905b050ad016c4936de9509439874'
const FALLBACK = 'http://127.0.0.1:7890'

function parseVlessUri(uri) {
  const trimmed = uri.trim()
  const withoutScheme = trimmed.slice('vless://'.length)
  const at = withoutScheme.indexOf('@')
  const uuid = decodeURIComponent(withoutScheme.slice(0, at))
  const rest = withoutScheme.slice(at + 1)
  const qIndex = rest.indexOf('?')
  const hostPort = qIndex >= 0 ? rest.slice(0, qIndex) : rest
  const query = qIndex >= 0 ? rest.slice(qIndex + 1) : ''
  const colon = hostPort.lastIndexOf(':')
  const server = hostPort.slice(0, colon)
  const port = Number(hostPort.slice(colon + 1))
  const params = new URLSearchParams(query.split('#')[0])
  return {
    uuid,
    server,
    port,
    flow: params.get('flow') || undefined,
    security: params.get('security') || undefined,
    sni: params.get('sni') || undefined,
    fp: params.get('fp') || undefined,
    pbk: params.get('pbk') || undefined,
    sid: params.get('sid') || undefined,
    network: params.get('type') || 'tcp',
  }
}

function extractAll(body) {
  let decoded = body.trim()
  if (!/^vless:\/\//i.test(decoded)) {
    decoded = Buffer.from(decoded, 'base64').toString('utf8').trim()
  }
  return [
    ...new Set(
      decoded
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^vless:\/\//i.test(l)),
    ),
  ]
}

async function fetchUris() {
  try {
    const res = await undiciFetch(SUB, {
      headers: { 'User-Agent': 'LovemiAuto/0.1' },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return extractAll(await res.text())
  } catch (e1) {
    const res = await undiciFetch(SUB, {
      dispatcher: new ProxyAgent(FALLBACK),
      headers: { 'User-Agent': 'LovemiAuto/0.1' },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} via fallback`)
    return extractAll(await res.text())
  }
}

function waitPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const once = () => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {
        s.end()
        resolve()
      })
      s.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('port timeout'))
        else setTimeout(once, 200)
      })
    }
    once()
  })
}

try {
  const out = execSync(`lsof -tiTCP:${PORT} -sTCP:LISTEN`, { encoding: 'utf8' }).trim()
  for (const pid of out.split(/\s+/).filter(Boolean)) {
    try {
      process.kill(Number(pid), 'SIGTERM')
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 800))
} catch {}

const bin = path.join(root, 'vendor/sing-box-1.11.15-darwin-arm64/sing-box')
if (!fs.existsSync(bin)) {
  console.error('NO_SINGBOX', bin)
  process.exit(1)
}

const uris = await fetchUris()
console.log('URIS', uris.length)
if (!uris.length) {
  console.error('NO_VLESS')
  process.exit(1)
}

const confDir = path.join(root, '.runtime-vless')
fs.mkdirSync(confDir, { recursive: true })
const confPath = path.join(confDir, 'sing-box.json')
const shuffled = uris.slice().sort(() => Math.random() - 0.5).slice(0, 8)

let child = null
let okNode = null
for (const uri of shuffled) {
  const node = parseVlessUri(uri)
  console.log('TRY', node.server + ':' + node.port)
  const outbound = {
    type: 'vless',
    tag: 'vless-out',
    server: node.server,
    server_port: node.port,
    uuid: node.uuid,
    packet_encoding: 'xudp',
  }
  if (node.flow) outbound.flow = node.flow
  if (node.security === 'reality' || node.pbk) {
    outbound.tls = {
      enabled: true,
      server_name: node.sni || node.server,
      utls: { enabled: true, fingerprint: node.fp || 'chrome' },
      reality: { enabled: true, public_key: node.pbk, short_id: node.sid || '' },
    }
  }
  fs.writeFileSync(
    confPath,
    JSON.stringify(
      {
        log: { level: 'warn' },
        inbounds: [{ type: 'mixed', listen: '127.0.0.1', listen_port: PORT }],
        outbounds: [outbound, { type: 'direct', tag: 'direct' }],
        route: { final: 'vless-out' },
      },
      null,
      2,
    ),
  )
  if (child) {
    try {
      child.kill('SIGTERM')
    } catch {}
    child = null
    await new Promise((r) => setTimeout(r, 400))
  }
  child = spawn(bin, ['run', '-c', confPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await waitPort(PORT, 10000)
    const res = await undiciFetch('https://api.lovemi.ai/v1/auth/me', {
      dispatcher: new ProxyAgent(`http://127.0.0.1:${PORT}`),
      signal: AbortSignal.timeout(12000),
    })
    console.log('PROBE', res.status, node.server)
    if (res.status === 401 || res.status === 200 || res.status === 403) {
      okNode = node
      break
    }
  } catch (e) {
    console.log('PROBE_FAIL', e.cause?.code || e.message)
  }
}

if (!okNode || !child) {
  console.error('ALL_NODES_FAILED')
  process.exit(1)
}

console.log('STARTED', `http://127.0.0.1:${PORT}`)
console.log('NODE', okNode.server + ':' + okNode.port)
fs.writeFileSync(path.join(confDir, 'pid'), String(child.pid))
console.log('PID', child.pid)
setTimeout(() => {
  try {
    child.kill('SIGTERM')
  } catch {}
  process.exit(0)
}, 30 * 60 * 1000)
