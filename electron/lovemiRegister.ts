import { fetch as undiciFetch } from 'undici'
import { acquireAccessToken, dispatcherFor } from './mailProbe'

const API_BASE = 'https://api.lovemi.ai'

export type RegisterInput = {
  email: string
  refreshToken?: string
  clientId?: string
  proxyUrl?: string
  /** 可选；不传则自动生成 ≥12 位 */
  password?: string
  displayName?: string
  /** 已知已注册：跳过注册验证码，直接重置接管 */
  preferReclaim?: boolean
}

export type RegisterResult = {
  ok: boolean
  email: string
  error?: string
  challengeId?: string
  otp?: string
  otpSource?: 'dev_otp' | 'graph_mail'
  password?: string
  userId?: string
  sessionToken?: string
  refreshToken?: string
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function genPassword() {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%'
  let out = 'Lm'
  for (let i = 0; i < 14; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

function isAlreadyRegisteredError(err?: string) {
  return /already\s*registered|already\s*exists|email.*already|isalready|已注册|已存在/i.test(
    String(err || '').replace(/\s+/g, ' '),
  )
}

/** 站上已有号：重置站内密码并尽量直接拿 session */
async function reclaimExistingAccount(input: RegisterInput): Promise<RegisterResult> {
  const email = input.email.trim().toLowerCase()
  const { resetLovemiPassword } = await import('./lovemiAuth')
  const reset = await resetLovemiPassword({
    email,
    refreshToken: input.refreshToken,
    clientId: input.clientId,
    proxyUrl: input.proxyUrl,
  })
  if (!reset.ok) {
    return {
      ok: false,
      email,
      error: `已注册，自动重置失败: ${reset.error}`,
    }
  }
  return {
    ok: true,
    email,
    password: reset.password,
    sessionToken: reset.sessionToken,
    userId: reset.userId,
    otpSource: 'graph_mail',
  }
}

async function apiPost(
  path: string,
  body: Record<string, unknown>,
  proxyUrl?: string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; error?: string }> {
  const url = `${API_BASE}${path}`
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Language': 'zh-CN',
      },
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

function extractOtp(text: string): string | null {
  const patterns = [
    /(?:验证码|verification code|one[- ]time(?: code)?|otp)[^\d]{0,24}(\d{6})/i,
    /\b(\d{6})\b/,
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m?.[1]) return m[1]
  }
  return null
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
      if (!res.ok) {
        return { error: data.error?.message || `Graph mail HTTP ${res.status}` }
      }

      for (const msg of data.value || []) {
        const received = msg.receivedDateTime ? Date.parse(msg.receivedDateTime) : 0
        if (received && received + 5000 < input.afterMs) continue
        const from =
          `${msg.from?.emailAddress?.address || ''} ${msg.from?.emailAddress?.name || ''}`.toLowerCase()
        const blob = `${msg.subject || ''}\n${msg.bodyPreview || ''}\n${msg.body?.content || ''}`
        const looksLovemi =
          /lovemi|kindred|验证码|verification|one[- ]time/i.test(blob) ||
          /lovemi|kindred|noreply/i.test(from)
        if (!looksLovemi && !extractOtp(blob)) continue
        const otp = extractOtp(blob)
        if (otp) return { otp }
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
    await sleep(1500)
  }
  return { error: '等待邮件验证码超时' }
}

/**
 * Lovemi 邮箱注册：发验证码 →（dev_otp 或 Graph 收信）→ /v1/auth/register
 */
export async function registerLovemiAccount(input: RegisterInput): Promise<RegisterResult> {
  const email = input.email.trim().toLowerCase()
  if (!email.includes('@')) return { ok: false, email, error: '邮箱无效' }
  if (!input.proxyUrl) return { ok: false, email, error: '未配置出站代理（禁止直连）' }
  if (!input.refreshToken || !input.clientId) {
    return { ok: false, email, error: '缺少 Graph 刷新令牌，无法自动取验证码' }
  }

  // 已知已注册：少绕一轮注册验证码，直接重置密码接管
  if (input.preferReclaim) {
    return reclaimExistingAccount(input)
  }

  const password =
    input.password && input.password.length >= 12 ? input.password : genPassword()

  const afterMs = Date.now()
  let challenge = await apiPost(
    '/v1/auth/email-challenges',
    { email, purpose: 'register' },
    input.proxyUrl,
  )
  if (!challenge.ok && /too many|rate|429/i.test(challenge.error || '')) {
    await sleep(4000)
    challenge = await apiPost(
      '/v1/auth/email-challenges',
      { email, purpose: 'register' },
      input.proxyUrl,
    )
  }
  if (!challenge.ok) {
    if (isAlreadyRegisteredError(challenge.error) || isAlreadyRegisteredError(JSON.stringify(challenge.data))) {
      return reclaimExistingAccount(input)
    }
    return { ok: false, email, error: `发验证码失败: ${challenge.error}` }
  }

  const challengeId = String(challenge.data.challenge_id || '')
  if (!challengeId) {
    return { ok: false, email, error: '发验证码成功但缺少 challenge_id' }
  }

  let otp = ''
  let otpSource: RegisterResult['otpSource']

  const devOtp = String(challenge.data.dev_otp || '').replace(/\D/g, '').slice(0, 6)
  if (devOtp.length === 6) {
    otp = devOtp
    otpSource = 'dev_otp'
  } else {
    const token = await acquireAccessToken(input.clientId, input.refreshToken, input.proxyUrl)
    if ('error' in token) {
      return {
        ok: false,
        email,
        challengeId,
        error: `换票失败，无法读信: ${token.error}`,
        refreshToken: undefined,
      }
    }
    const mail = await waitForMailOtp({
      accessToken: token.accessToken,
      proxyUrl: input.proxyUrl,
      afterMs,
    })
    if (!mail.otp) {
      return {
        ok: false,
        email,
        challengeId,
        error: mail.error || '未读到验证码',
        refreshToken: token.refreshToken,
      }
    }
    otp = mail.otp
    otpSource = 'graph_mail'
  }

  const reg = await apiPost(
    '/v1/auth/register',
    {
      email,
      challenge_id: challengeId,
      otp,
      password,
      adult_confirmed: true,
      terms_accepted: true,
      display_name: input.displayName || email.split('@')[0],
    },
    input.proxyUrl,
  )

  if (!reg.ok) {
    if (isAlreadyRegisteredError(reg.error) || isAlreadyRegisteredError(JSON.stringify(reg.data))) {
      return reclaimExistingAccount(input)
    }
    return {
      ok: false,
      email,
      challengeId,
      otp,
      otpSource,
      password,
      error: `注册失败: ${reg.error}`,
    }
  }

  return {
    ok: true,
    email,
    challengeId,
    otp,
    otpSource,
    password,
    userId: reg.data.user_id ? String(reg.data.user_id) : undefined,
    sessionToken: reg.data.session_token ? String(reg.data.session_token) : undefined,
  }
}
