import { fetch as undiciFetch } from 'undici'
import { acquireAccessToken, dispatcherFor } from './mailProbe'

const API_BASE = 'https://api.lovemi.ai'

export type LoginInput = {
  email: string
  password?: string
  refreshToken?: string
  clientId?: string
  proxyUrl?: string
}

export type LoginResult = {
  ok: boolean
  email: string
  error?: string
  sessionToken?: string
  userId?: string
  expiresAt?: string
  via?: 'password' | 'email_otp'
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function apiPost(
  path: string,
  body: Record<string, unknown>,
  proxyUrl?: string,
  bearer?: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; error?: string }> {
  const url = `${API_BASE}${path}`
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Language': 'zh-CN',
    }
    if (bearer) headers.Authorization = `Bearer ${bearer}`
    const res = await undiciFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      dispatcher: dispatcherFor(proxyUrl, url),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const msg =
        (typeof data.message === 'string' && data.message) ||
        (typeof data.error === 'string' && data.error) ||
        (typeof data.error_code === 'string' && data.error_code) ||
        `HTTP ${res.status}`
      return { ok: false, status: res.status, data, error: msg }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    const cause =
      err instanceof Error && 'cause' in err ? (err as Error & { cause?: Error }).cause : undefined
    return {
      ok: false,
      status: 0,
      data: {},
      error: cause?.message || (err instanceof Error ? err.message : String(err)),
    }
  }
}

async function apiGet(
  path: string,
  proxyUrl?: string,
  bearer?: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; error?: string }> {
  const url = `${API_BASE}${path}`
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Language': 'zh-CN',
    }
    if (bearer) headers.Authorization = `Bearer ${bearer}`
    const res = await undiciFetch(url, {
      method: 'GET',
      headers,
      dispatcher: dispatcherFor(proxyUrl, url),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const msg =
        (typeof data.message === 'string' && data.message) ||
        (typeof data.error === 'string' && data.error) ||
        (typeof data.error_code === 'string' && data.error_code) ||
        `HTTP ${res.status}`
      return { ok: false, status: res.status, data, error: msg }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    const cause =
      err instanceof Error && 'cause' in err ? (err as Error & { cause?: Error }).cause : undefined
    return {
      ok: false,
      status: 0,
      data: {},
      error: cause?.message || (err instanceof Error ? err.message : String(err)),
    }
  }
}

function extractOtp(text: string): string | null {
  const m1 = text.match(/(?:验证码|verification code|one[- ]time(?: code)?|otp)[^\d]{0,24}(\d{6})/i)
  if (m1?.[1]) return m1[1]
  const m2 = text.match(/\b(\d{6})\b/)
  return m2?.[1] || null
}

async function waitForMailOtp(input: {
  accessToken: string
  proxyUrl?: string
  afterMs: number
  timeoutMs?: number
}): Promise<{ otp?: string; error?: string }> {
  const deadline = Date.now() + (input.timeoutMs ?? 90_000)
  const url =
    'https://graph.microsoft.com/v1.0/me/messages?$top=12&$orderby=receivedDateTime desc&$select=subject,bodyPreview,body,from,receivedDateTime'
  while (Date.now() < deadline) {
    try {
      const res = await undiciFetch(url, {
        headers: { Authorization: `Bearer ${input.accessToken}` },
        dispatcher: dispatcherFor(input.proxyUrl, url),
      })
      const data = (await res.json().catch(() => ({}))) as {
        value?: Array<{
          subject?: string
          bodyPreview?: string
          body?: { content?: string }
          receivedDateTime?: string
          from?: { emailAddress?: { address?: string; name?: string } }
        }>
        error?: { message?: string }
      }
      if (!res.ok) return { error: data.error?.message || `Graph mail HTTP ${res.status}` }
      for (const msg of data.value || []) {
        const received = msg.receivedDateTime ? Date.parse(msg.receivedDateTime) : 0
        if (received && received + 5000 < input.afterMs) continue
        const from =
          `${msg.from?.emailAddress?.address || ''} ${msg.from?.emailAddress?.name || ''}`.toLowerCase()
        const blob = `${msg.subject || ''}\n${msg.bodyPreview || ''}\n${msg.body?.content || ''}`
        const looks =
          /lovemi|kindred|验证码|verification|one[- ]time/i.test(blob) ||
          /lovemi|kindred|noreply/i.test(from)
        if (!looks && !extractOtp(blob)) continue
        const otp = extractOtp(blob)
        if (otp) return { otp }
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    await sleep(1500)
  }
  return { error: '等待登录验证码超时' }
}

function sessionFrom(data: Record<string, unknown>, email: string, via: LoginResult['via']): LoginResult {
  const sessionToken = data.session_token ? String(data.session_token) : undefined
  if (!sessionToken) return { ok: false, email, error: '成功但缺少 session_token' }
  return {
    ok: true,
    email,
    sessionToken,
    userId: data.user_id ? String(data.user_id) : undefined,
    expiresAt: data.expires_at ? String(data.expires_at) : undefined,
    via,
  }
}

export async function loginLovemiPassword(input: LoginInput): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase()
  if (!input.proxyUrl) return { ok: false, email, error: '未配置出站代理（禁止直连）' }
  if (!input.password) return { ok: false, email, error: '缺少 Lovemi 密码' }

  const res = await apiPost(
    '/v1/auth/password/sign-in',
    { email, password: input.password },
    input.proxyUrl,
  )
  if (!res.ok) return { ok: false, email, error: `登录失败: ${res.error}` }
  return sessionFrom(res.data, email, 'password')
}

export async function loginLovemiEmailOtp(input: LoginInput): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase()
  if (!input.proxyUrl) return { ok: false, email, error: '未配置出站代理（禁止直连）' }
  if (!input.refreshToken || !input.clientId) {
    return { ok: false, email, error: '缺少 Graph 令牌，无法 OTP 登录' }
  }

  const afterMs = Date.now()
  const challenge = await apiPost(
    '/v1/auth/email-challenges',
    { email, purpose: 'email_access' },
    input.proxyUrl,
  )
  if (!challenge.ok) return { ok: false, email, error: `发登录码失败: ${challenge.error}` }

  const challengeId = String(challenge.data.challenge_id || '')
  if (!challengeId) return { ok: false, email, error: '缺少 challenge_id' }

  let otp = String(challenge.data.dev_otp || '').replace(/\D/g, '').slice(0, 6)
  if (otp.length !== 6) {
    const token = await acquireAccessToken(input.clientId, input.refreshToken, input.proxyUrl)
    if ('error' in token) return { ok: false, email, error: `换票失败: ${token.error}` }
    const mail = await waitForMailOtp({
      accessToken: token.accessToken,
      proxyUrl: input.proxyUrl,
      afterMs,
    })
    if (!mail.otp) return { ok: false, email, error: mail.error || '未读到登录验证码' }
    otp = mail.otp
  }

  const res = await apiPost(
    '/v1/auth/email-otp/sign-in',
    { email, challenge_id: challengeId, otp, purpose: 'email_access' },
    input.proxyUrl,
  )
  if (!res.ok) return { ok: false, email, error: `OTP 登录失败: ${res.error}` }
  return sessionFrom(res.data, email, 'email_otp')
}

/** 先密码，失败再邮箱 OTP */
export async function loginLovemi(input: LoginInput): Promise<LoginResult> {
  if (input.password) {
    const pw = await loginLovemiPassword(input)
    if (pw.ok) return pw
    if (!/invalid|password|凭证|密码/i.test(pw.error || '')) return pw
  }
  return loginLovemiEmailOtp(input)
}

export async function fetchLovemiMe(input: {
  sessionToken: string
  proxyUrl?: string
  email?: string
}): Promise<{ ok: boolean; email?: string; error?: string; data?: Record<string, unknown> }> {
  if (!input.proxyUrl) return { ok: false, error: '未配置出站代理' }
  const res = await apiGet('/v1/auth/me', input.proxyUrl, input.sessionToken)
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, email: input.email, data: res.data }
}

function genPassword() {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$'
  let out = 'Lm'
  for (let i = 0; i < 14; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

export type ResetPasswordInput = {
  email: string
  refreshToken?: string
  clientId?: string
  proxyUrl?: string
  /** 可选；不传则自动生成 ≥12 位 */
  newPassword?: string
}

export type ResetPasswordResult = {
  ok: boolean
  email: string
  error?: string
  password?: string
  sessionToken?: string
  userId?: string
}

/** 邮箱验证码重置 Lovemi 站内密码（读 Graph 收信） */
export async function resetLovemiPassword(input: ResetPasswordInput): Promise<ResetPasswordResult> {
  const email = input.email.trim().toLowerCase()
  if (!input.proxyUrl) return { ok: false, email, error: '未配置出站代理（禁止直连）' }
  if (!input.refreshToken || !input.clientId) {
    return { ok: false, email, error: '缺少 Graph 令牌，无法收重置验证码' }
  }

  const password =
    input.newPassword && input.newPassword.length >= 12 ? input.newPassword : genPassword()

  const afterMs = Date.now()
  let challenge = await apiPost(
    '/v1/auth/email-challenges',
    { email, purpose: 'password_reset' },
    input.proxyUrl,
  )
  if (!challenge.ok && /too many|rate|429/i.test(challenge.error || '')) {
    await sleep(5000)
    challenge = await apiPost(
      '/v1/auth/email-challenges',
      { email, purpose: 'password_reset' },
      input.proxyUrl,
    )
  }
  if (!challenge.ok) return { ok: false, email, error: `发重置码失败: ${challenge.error}` }

  const challengeId = String(challenge.data.challenge_id || '')
  if (!challengeId) return { ok: false, email, error: '缺少 challenge_id' }

  let otp = String(challenge.data.dev_otp || '').replace(/\D/g, '').slice(0, 6)
  if (otp.length !== 6) {
    const token = await acquireAccessToken(input.clientId, input.refreshToken, input.proxyUrl)
    if ('error' in token) return { ok: false, email, error: `换票失败: ${token.error}` }
    const mail = await waitForMailOtp({
      accessToken: token.accessToken,
      proxyUrl: input.proxyUrl,
      afterMs,
    })
    if (!mail.otp) return { ok: false, email, error: mail.error || '未读到重置验证码' }
    otp = mail.otp
  }

  const reset = await apiPost(
    '/v1/auth/password/reset',
    {
      email,
      challenge_id: challengeId,
      otp,
      new_password: password,
    },
    input.proxyUrl,
  )
  if (!reset.ok) {
    return { ok: false, email, password, error: `重置失败: ${reset.error}` }
  }

  // 重置成功通常会直接发 session；没有则再密码登录一次
  let sessionToken = reset.data.session_token ? String(reset.data.session_token) : undefined
  let userId = reset.data.user_id ? String(reset.data.user_id) : undefined
  if (!sessionToken) {
    const login = await loginLovemiPassword({
      email,
      password,
      proxyUrl: input.proxyUrl,
    })
    if (login.ok) {
      sessionToken = login.sessionToken
      userId = login.userId
    }
  }

  return { ok: true, email, password, sessionToken, userId }
}

export { apiGet, apiPost, API_BASE }
