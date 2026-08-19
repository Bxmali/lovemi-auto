/**
 * 拉起 Lovemi VLESS（:17891）并对库存账号探活。
 * env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-with-vless.mjs
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('lovemi-auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const SUB =
  process.env.LOVEMI_SUB ||
  'https://kaze1.aisaka-taiga.com/oosaka/63c80d94460fc03b769cf666c119950c'
const FALLBACK = 'http://127.0.0.1:7890'

function dispatcher(proxyUrl) {
  return proxyUrl ? new ProxyAgent(proxyUrl) : undefined
}

async function postForm(url, fields, proxyUrl) {
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      dispatcher: dispatcher(proxyUrl),
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok && Boolean(data.access_token), status: res.status, data }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: {},
      networkError: err?.cause?.message || err?.message || String(err),
    }
  }
}

async function probeOne(email, clientId, refreshToken, proxyUrl) {
  const attempts = [
    {
      name: 'graph',
      url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      fields: {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'https://graph.microsoft.com/.default',
      },
    },
    {
      name: 'live',
      url: 'https://login.live.com/oauth20_token.srf',
      fields: {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
    },
    {
      name: 'imap',
      url: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
      fields: {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
      },
    },
  ]
  let lastErr = ''
  for (const a of attempts) {
    const r = await postForm(a.url, a.fields, proxyUrl)
    if (r.ok) {
      return {
        ok: true,
        email,
        via: a.name,
        refreshToken: r.data.refresh_token || refreshToken,
      }
    }
    lastErr = r.networkError || r.data.error_description || r.data.error || `HTTP ${r.status}`
  }
  return { ok: false, email, error: String(lastErr).slice(0, 180) }
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return out
}

app.whenReady().then(async () => {
  app.dock?.hide()
  try {
    const runnerUrl = pathToFileURL(path.join(process.cwd(), 'electron/vless/runner.ts')).href
    // Electron 不能直接 import .ts；用已构建的 dist-electron 里没有单独导出。
    // 改为动态 import 相对 JS：先用 vite-node 不可用。改为 spawn 同目录编译后的逻辑——
    // 最稳：通过 Function 加载 runner 的 ESM 构建。这里直接用 child_process 调已存在的 vendor sing-box + parse。
    const { startVlessBridge, stopVlessBridge } = await import(
      pathToFileURL(path.join(process.cwd(), 'dist-electron/vless-runner.js')).href
    ).catch(() => ({ startVlessBridge: null, stopVlessBridge: null }))

    let proxyUrl = 'http://127.0.0.1:17891'
    let source = 'vless'

    if (startVlessBridge) {
      const st = await startVlessBridge({ subscriptionUrl: SUB, fallbackLocalProxy: FALLBACK })
      console.log('VLESS', st)
      if (st.proxyUrl) {
        proxyUrl = st.proxyUrl
        source = st.source
      } else if (st.error) {
        console.log('VLESS_FAIL', st.error)
        proxyUrl = FALLBACK
        source = 'fallback-local'
      }
    } else {
      // 无打包 runner：内联拉起
      const parseUrl = pathToFileURL(path.join(process.cwd(), 'electron/vless/parse.ts')).href
      console.log('INLINE_START — use fallback path via node helper')
      // 用 7890 兜底探活（当前实测微软通），并提示 UI 拉起 VLESS
      proxyUrl = FALLBACK
      source = 'fallback-local'
      console.log('NOTE', 'dist vless-runner 未单独构建，本轮先用 7890 兜底测号；请在设置里点「拉起 VLESS」')
    }

    // 验证代理能否访问微软
    try {
      const res = await undiciFetch(
        'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
        { dispatcher: dispatcher(proxyUrl) },
      )
      console.log('MS_PING', proxyUrl, res.status)
      if (!res.ok) throw new Error('ping not ok')
    } catch (e) {
      console.log('MS_PING_FAIL', proxyUrl, e.message)
      if (proxyUrl !== FALLBACK) {
        proxyUrl = FALLBACK
        source = 'fallback-local'
        const res2 = await undiciFetch(
          'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
          { dispatcher: dispatcher(proxyUrl) },
        )
        console.log('MS_PING_FALLBACK', proxyUrl, res2.status)
      }
    }

    const file = path.join(app.getPath('userData'), 'accounts.enc')
    const buf = fs.readFileSync(file)
    const raw = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf8')
    const accounts = JSON.parse(raw)
    const list = (Array.isArray(accounts) ? accounts : []).filter(
      (a) => a?.email && a?.refreshToken && a?.clientId,
    )
    console.log('COUNT', list.length, 'SOURCE', source, 'PROXY', proxyUrl)

    const results = await mapPool(list, 3, (a) =>
      probeOne(a.email, a.clientId, a.refreshToken, proxyUrl),
    )

    let ok = 0
    let fail = 0
    for (const r of results) {
      if (r.ok) {
        ok++
        console.log('OK', r.email, r.via)
      } else {
        fail++
        console.log('FAIL', r.email, r.error)
      }
    }
    console.log('SUMMARY', JSON.stringify({ ok, fail, total: results.length, source, proxyUrl }))

    const byEmail = new Map(results.map((r) => [r.email.toLowerCase(), r]))
    const next = list.map((a) => {
      const r = byEmail.get(String(a.email).toLowerCase())
      if (!r) return a
      if (r.ok) {
        return {
          ...a,
          status: 'ready',
          lastOkAt: new Date().toISOString(),
          lastError: undefined,
          refreshToken: r.refreshToken || a.refreshToken,
          notes: `via:${r.via}`,
        }
      }
      return { ...a, status: 'error', lastError: r.error || '检测失败' }
    })
    fs.writeFileSync(
      file,
      safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(JSON.stringify(next))
        : JSON.stringify(next),
    )
    console.log('SAVED')
    if (stopVlessBridge) await stopVlessBridge()
    app.exit(0)
  } catch (e) {
    console.error('FATAL', e)
    app.exit(2)
  }
})
