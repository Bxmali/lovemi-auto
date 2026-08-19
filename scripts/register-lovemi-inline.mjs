/**
 * 独立测试：Lovemi 自动注册（不依赖 dist-electron）
 * LOVEMI_PROXY=http://127.0.0.1:7890 env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/register-lovemi-inline.mjs
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('lovemi-auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7890'
const LIMIT = Math.max(1, Number(process.env.LOVEMI_LIMIT || '1'))
const API = 'https://api.lovemi.ai'

function dispatcher(proxyUrl, targetUrl) {
  if (!proxyUrl) return undefined
  try {
    if (targetUrl && new URL(proxyUrl).hostname === new URL(targetUrl).hostname) return undefined
  } catch {
    /* ignore */
  }
  try {
    return new ProxyAgent(proxyUrl)
  } catch {
    return undefined
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function genPassword() {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$'
  let out = 'Lm'
  for (let i = 0; i < 14; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

async function apiPost(apiPath, body, proxyUrl) {
  const url = `${API}${apiPath}`
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'zh-CN',
      },
      body: JSON.stringify(body),
      dispatcher: dispatcher(proxyUrl, url),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const msg = data.message || data.error || data.error_code || `HTTP ${res.status}`
      return { ok: false, status: res.status, data, error: String(msg) }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, data: {}, error: err?.cause?.message || err?.message || String(err) }
  }
}

async function acquireToken(clientId, refreshToken, proxyUrl) {
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
  ]
  for (const a of attempts) {
    try {
      const res = await undiciFetch(a.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(a.fields).toString(),
        dispatcher: dispatcher(proxyUrl, a.url),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.access_token) {
        return { accessToken: data.access_token, refreshToken: data.refresh_token, via: a.name }
      }
    } catch {
      /* next */
    }
  }
  return { error: '换票失败' }
}

function extractOtp(text) {
  const m1 = text.match(/(?:验证码|verification code|one[- ]time(?: code)?|otp)[^\d]{0,24}(\d{6})/i)
  if (m1?.[1]) return m1[1]
  const m2 = text.match(/\b(\d{6})\b/)
  return m2?.[1] || null
}

async function waitOtp(accessToken, proxyUrl, afterMs) {
  const deadline = Date.now() + 90_000
  const url =
    'https://graph.microsoft.com/v1.0/me/messages?$top=12&$orderby=receivedDateTime desc&$select=subject,bodyPreview,body,from,receivedDateTime'
  while (Date.now() < deadline) {
    const res = await undiciFetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      dispatcher: dispatcher(proxyUrl, url),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { error: data?.error?.message || `mail HTTP ${res.status}` }
    for (const msg of data.value || []) {
      const received = msg.receivedDateTime ? Date.parse(msg.receivedDateTime) : 0
      if (received && received + 5000 < afterMs) continue
      const from = `${msg.from?.emailAddress?.address || ''} ${msg.from?.emailAddress?.name || ''}`.toLowerCase()
      const blob = `${msg.subject || ''}\n${msg.bodyPreview || ''}\n${msg.body?.content || ''}`
      const looks =
        /lovemi|kindred|验证码|verification|one[- ]time/i.test(blob) ||
        /lovemi|kindred|noreply/i.test(from)
      if (!looks && !extractOtp(blob)) continue
      const otp = extractOtp(blob)
      if (otp) return { otp }
    }
    await sleep(2500)
  }
  return { error: '等待邮件验证码超时' }
}

export async function registerInline(input) {
  const email = input.email.trim().toLowerCase()
  const password = input.password && input.password.length >= 12 ? input.password : genPassword()

  let challenge = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    const afterMs = Date.now()
    challenge = await apiPost('/v1/auth/email-challenges', { email, purpose: 'register' }, input.proxyUrl)
    if (challenge.ok) {
      challenge.afterMs = afterMs
      break
    }
    const retryable = /too many|rate|429|TLS|socket disconnected|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
      challenge.error || '',
    )
    if (!retryable || attempt === 4) {
      return { ok: false, email, error: `发验证码失败: ${challenge.error}` }
    }
    const wait = 3000 * attempt
    console.log(`  retry challenge ${attempt}/4 after ${wait}ms (${challenge.error})`)
    await sleep(wait)
  }

  const afterMs = challenge.afterMs || Date.now()
  const challengeId = String(challenge.data.challenge_id || '')
  if (!challengeId) return { ok: false, email, error: '缺少 challenge_id' }

  let otp = ''
  let otpSource = ''
  const devOtp = String(challenge.data.dev_otp || '').replace(/\D/g, '').slice(0, 6)
  if (devOtp.length === 6) {
    otp = devOtp
    otpSource = 'dev_otp'
  } else {
    const token = await acquireToken(input.clientId, input.refreshToken, input.proxyUrl)
    if (token.error) return { ok: false, email, challengeId, error: `换票失败: ${token.error}` }
    const mail = await waitOtp(token.accessToken, input.proxyUrl, afterMs)
    if (!mail.otp) return { ok: false, email, challengeId, error: mail.error || '未读到验证码' }
    otp = mail.otp
    otpSource = 'graph_mail'
  }

  let reg = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    reg = await apiPost(
      '/v1/auth/register',
      {
        email,
        challenge_id: challengeId,
        otp,
        password,
        adult_confirmed: true,
        terms_accepted: true,
        display_name: email.split('@')[0],
      },
      input.proxyUrl,
    )
    if (reg.ok) break
    if (/already|exists|registered|已注册|已存在/i.test(reg.error || JSON.stringify(reg.data))) {
      return { ok: true, email, challengeId, otp, otpSource, password, userId: 'already' }
    }
    const retryable = /too many|rate|429|TLS|socket disconnected|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
      reg.error || '',
    )
    if (!retryable || attempt === 4) {
      return { ok: false, email, challengeId, otp, otpSource, password, error: `注册失败: ${reg.error}` }
    }
    const wait = 5000 * attempt
    console.log(`  retry register ${attempt}/4 after ${wait}ms (${reg.error})`)
    await sleep(wait)
  }
  return {
    ok: true,
    email,
    challengeId,
    otp,
    otpSource,
    password,
    userId: reg.data.user_id ? String(reg.data.user_id) : undefined,
  }
}

function loadAccounts() {
  const file = path.join(app.getPath('userData'), 'accounts.enc')
  if (!fs.existsSync(file)) return []
  const buf = fs.readFileSync(file)
  const raw = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : []
}

function saveAccounts(accounts) {
  const file = path.join(app.getPath('userData'), 'accounts.enc')
  const plaintext = JSON.stringify(accounts)
  if (!safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(file, plaintext, 'utf8')
    return
  }
  fs.writeFileSync(file, safeStorage.encryptString(plaintext))
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('register-lovemi-inline.mjs')

if (isMain) {
  app.whenReady().then(async () => {
    app.dock?.hide()
    try {
      const accounts = loadAccounts().filter(
        (a) => a && !String(a.id || '').startsWith('demo-') && !String(a.email || '').endsWith('@example.com'),
      )
      const targets = accounts
        .filter((a) => !a.lovemiRegistered && a.status === 'ready' && a.refreshToken && a.clientId)
        .slice(0, LIMIT)
      console.log(`proxy=${PROXY} targets=${targets.length}`)
      if (!targets.length) {
        console.log('没有可用且未注册的账号')
        app.exit(0)
        return
      }
      for (const a of targets) {
        console.log(`→ ${a.email}`)
        const r = await registerInline({
          email: a.email,
          refreshToken: a.refreshToken,
          clientId: a.clientId,
          proxyUrl: PROXY,
        })
        if (r.ok) {
          console.log(`  OK via=${r.otpSource} user=${r.userId || '?'}`)
          a.lovemiRegistered = true
          a.lovemiRegStatus = 'registered'
          a.lovemiRegisteredAt = new Date().toISOString()
          a.lovemiPassword = r.password
          a.lovemiRegError = undefined
          a.labels = (Array.isArray(a.labels) ? a.labels : []).filter((l) => !/^lovemi(-reg)?$/i.test(l))
        } else {
          console.log(`  FAIL ${r.error}`)
          a.lovemiRegStatus = 'failed'
          a.lovemiRegError = r.error
        }
        await sleep(4000)
      }
      // 顺带清掉历史丑陋 lovemi 标签
      for (const a of accounts) {
        if (Array.isArray(a.labels)) {
          a.labels = a.labels.filter((l) => !/^lovemi(-reg)?$/i.test(l))
        }
      }
      saveAccounts(accounts)
      console.log('done')
      app.exit(0)
    } catch (e) {
      console.error(e)
      app.exit(1)
    }
  })
}
