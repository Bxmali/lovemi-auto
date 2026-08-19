/**
 * 重置全部/缺站内密码账号：发 password_reset 码 → Graph 取 OTP → /v1/auth/password/reset
 * LOVEMI_PROXY=http://127.0.0.1:7890 LOVEMI_LIMIT=15 env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/reset-lovemi-passwords.mjs
 */
import { app, safeStorage } from 'electron'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
const TARGET_DIR = path.join(app.getPath('appData'), 'lovemi-auto')
app.setName('Lovemi Auto')
app.setPath('userData', TARGET_DIR)

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7890'
const LIMIT = Math.max(1, Number(process.env.LOVEMI_LIMIT || '15'))
const ONLY_MISSING = process.env.LOVEMI_ONLY_MISSING !== '0'
const API = 'https://api.lovemi.ai'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function dispatcher(proxyUrl, targetUrl) {
  try {
    if (targetUrl && new URL(proxyUrl).hostname === new URL(targetUrl).hostname) return undefined
  } catch {
    /* ignore */
  }
  return new ProxyAgent(proxyUrl)
}

function genPassword() {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$'
  let out = 'Lm'
  for (let i = 0; i < 14; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

async function apiPost(apiPath, body) {
  const url = `${API}${apiPath}`
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Language': 'zh-CN' },
      body: JSON.stringify(body),
      dispatcher: dispatcher(PROXY, url),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, error: String(data.message || data.error || data.error_code || `HTTP ${res.status}`), data }
    }
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: err?.cause?.message || err?.message || String(err), data: {} }
  }
}

async function acquireToken(clientId, refreshToken) {
  const url = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
  const attempts = [
    { scope: 'https://graph.microsoft.com/.default' },
    { scope: 'https://graph.microsoft.com/Mail.Read offline_access' },
  ]
  let lastErr = '换票失败'
  for (const a of attempts) {
    try {
      const res = await undiciFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          scope: a.scope,
        }).toString(),
        dispatcher: dispatcher(PROXY, url),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.access_token) return { accessToken: data.access_token }
      lastErr = String(data.error_description || data.error || `token HTTP ${res.status}`)
    } catch (err) {
      lastErr = err?.cause?.message || err?.message || String(err)
    }
  }
  return { error: lastErr }
}

function extractOtp(text) {
  const m1 = text.match(/(?:验证码|verification code|one[- ]time(?: code)?|otp)[^\d]{0,24}(\d{6})/i)
  if (m1?.[1]) return m1[1]
  const m2 = text.match(/\b(\d{6})\b/)
  return m2?.[1] || null
}

async function waitOtp(accessToken, afterMs) {
  const deadline = Date.now() + 90_000
  const url =
    'https://graph.microsoft.com/v1.0/me/messages?$top=12&$orderby=receivedDateTime desc&$select=subject,bodyPreview,body,from,receivedDateTime'
  while (Date.now() < deadline) {
    const res = await undiciFetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      dispatcher: dispatcher(PROXY, url),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { error: data?.error?.message || `mail HTTP ${res.status}` }
    for (const msg of data.value || []) {
      const received = msg.receivedDateTime ? Date.parse(msg.receivedDateTime) : 0
      if (received && received + 5000 < afterMs) continue
      const blob = `${msg.subject || ''}\n${msg.bodyPreview || ''}\n${msg.body?.content || ''}`
      const from = `${msg.from?.emailAddress?.address || ''}`.toLowerCase()
      if (!/lovemi|kindred|验证码|verification|reset|password/i.test(blob + from) && !extractOtp(blob)) continue
      const otp = extractOtp(blob)
      if (otp) return { otp }
    }
    await sleep(2500)
  }
  return { error: '等待重置验证码超时' }
}

async function resetOne(account) {
  const email = account.email
  const password = genPassword()
  const afterMs = Date.now()
  let challenge = await apiPost('/v1/auth/email-challenges', { email, purpose: 'password_reset' })
  if (!challenge.ok && /too many|rate|429/i.test(challenge.error || '')) {
    await sleep(8000)
    challenge = await apiPost('/v1/auth/email-challenges', { email, purpose: 'password_reset' })
  }
  if (!challenge.ok) return { ok: false, email, error: `发码失败: ${challenge.error}` }
  const challengeId = String(challenge.data.challenge_id || '')
  if (!challengeId) return { ok: false, email, error: '缺少 challenge_id' }

  let otp = String(challenge.data.dev_otp || '').replace(/\D/g, '').slice(0, 6)
  if (otp.length !== 6) {
    const token = await acquireToken(account.clientId, account.refreshToken)
    if (token.error) return { ok: false, email, error: token.error }
    const mail = await waitOtp(token.accessToken, afterMs)
    if (!mail.otp) return { ok: false, email, error: mail.error || '未读到验证码' }
    otp = mail.otp
  }

  const reset = await apiPost('/v1/auth/password/reset', {
    email,
    challenge_id: challengeId,
    otp,
    new_password: password,
  })
  if (!reset.ok) return { ok: false, email, error: `重置失败: ${reset.error}`, password }

  let sessionToken = reset.data.session_token ? String(reset.data.session_token) : undefined
  let userId = reset.data.user_id ? String(reset.data.user_id) : undefined
  if (!sessionToken) {
    const login = await apiPost('/v1/auth/password/sign-in', { email, password })
    if (login.ok) {
      sessionToken = login.data.session_token ? String(login.data.session_token) : undefined
      userId = login.data.user_id ? String(login.data.user_id) : undefined
    }
  }
  return { ok: true, email, password, sessionToken, userId }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  try {
    const dbFile = path.join(TARGET_DIR, 'accounts.sqlite')
    const db = new DatabaseSync(dbFile)
    const rows = db.prepare('SELECT id, email, payload FROM accounts').all()
    const accounts = rows.map((r) => {
      const a = JSON.parse(safeStorage.decryptString(Buffer.from(r.payload, 'base64')))
      return { ...a, _rowId: r.id }
    })
    const targets = accounts
      .filter((a) => a.refreshToken && a.clientId && (!ONLY_MISSING || !a.lovemiPassword))
      .slice(0, LIMIT)
    console.log(`proxy=${PROXY} targets=${targets.length} onlyMissing=${ONLY_MISSING}`)

    let ok = 0
    let fail = 0
    const upsert = db.prepare(
      `UPDATE accounts SET payload = ?, updated_at = ? WHERE id = ?`,
    )
    for (const a of targets) {
      console.log(`→ ${a.email}`)
      let r
      try {
        r = await resetOne(a)
        if (!r.ok && /too many|rate|429/i.test(r.error || '')) {
          console.log('  rate-limit, wait 25s…')
          await sleep(25_000)
          r = await resetOne(a)
        }
      } catch (err) {
        r = { ok: false, email: a.email, error: err?.cause?.message || err?.message || String(err) }
      }
      if (r.ok) {
        a.lovemiPassword = r.password
        a.lovemiSessionToken = r.sessionToken || a.lovemiSessionToken
        a.lovemiUserId = r.userId || a.lovemiUserId
        a.lovemiTokenAt = r.sessionToken ? new Date().toISOString() : a.lovemiTokenAt
        a.lovemiRegError = undefined
        a.lovemiRegistered = true
        a.lovemiRegStatus = 'registered'
        const { _rowId, ...payload } = a
        upsert.run(
          safeStorage.encryptString(JSON.stringify(payload)).toString('base64'),
          new Date().toISOString(),
          _rowId,
        )
        console.log('  OK password+token')
        ok++
      } else {
        console.log(`  FAIL ${r.error}`)
        fail++
      }
      await sleep(6000)
    }
    db.close()
    console.log(`done ok=${ok} fail=${fail}`)
    app.exit(0)
  } catch (e) {
    console.error(e)
    app.exit(1)
  }
})
