/**
 * 探活库存账号（经 VLESS 入站 17890）。只打印邮箱与结果，不打印令牌。
 * 用法: env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-stock.mjs
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

// 对齐正式应用的 userData，避免落到 Application Support/Electron
app.setName('lovemi-auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:17890'

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
      name: 'graph-mail',
      url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      fields: {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'https://graph.microsoft.com/Mail.Read offline_access',
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

  for (const a of attempts) {
    const r = await postForm(a.url, a.fields, proxyUrl)
    if (r.ok) {
      let displayName = email
      try {
        const me = await undiciFetch('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${r.data.access_token}` },
          dispatcher: dispatcher(proxyUrl),
        })
        if (me.ok) {
          const j = await me.json()
          displayName = j.displayName || j.mail || j.userPrincipalName || email
        }
      } catch {
        /* ignore */
      }
      return {
        ok: true,
        email,
        via: a.name,
        displayName,
        refreshToken: r.data.refresh_token || refreshToken,
      }
    }
    const err = r.networkError || r.data.error_description || r.data.error || `HTTP ${r.status}`
    if (a === attempts[attempts.length - 1]) {
      return { ok: false, email, error: String(err).slice(0, 180) }
    }
  }
  return { ok: false, email, error: '全部路径失败' }
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return out
}

app.whenReady().then(async () => {
  app.dock?.hide()
  try {
    const file = path.join(app.getPath('userData'), 'accounts.enc')
    console.log('FILE', file)
    if (!fs.existsSync(file)) {
      console.log('NO_ACCOUNTS')
      app.exit(1)
      return
    }
    const buf = fs.readFileSync(file)
    const raw = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf8')
    const accounts = JSON.parse(raw)
    const list = (Array.isArray(accounts) ? accounts : []).filter(
      (a) => a?.email && a?.refreshToken && a?.clientId,
    )
    console.log('COUNT', list.length)
    console.log('PROXY', PROXY)

    const results = await mapPool(list, 3, (a) =>
      probeOne(a.email, a.clientId, a.refreshToken, PROXY),
    )

    let ok = 0
    let fail = 0
    for (const r of results) {
      if (r.ok) {
        ok++
        console.log('OK', r.email, r.via, r.displayName || '')
      } else {
        fail++
        console.log('FAIL', r.email, r.error || '')
      }
    }
    console.log('SUMMARY', JSON.stringify({ ok, fail, total: results.length }))

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
          notes: r.via ? `via:${r.via}` : a.notes,
        }
      }
      return { ...a, status: 'error', lastError: r.error || '检测失败' }
    })
    const plaintext = JSON.stringify(next)
    fs.writeFileSync(
      file,
      safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plaintext) : plaintext,
    )
    console.log('SAVED')
    app.exit(0)
  } catch (e) {
    console.error('FATAL', e)
    app.exit(2)
  }
})
