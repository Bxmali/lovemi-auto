import { useEmailStore } from '../store/emailStore'
import { useSettingsStore } from '../store/settingsStore'

function isDemo(email: string, id: string) {
  return id.startsWith('demo-') || email.endsWith('@example.com')
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function resolveOutbound() {
  const settings = useSettingsStore.getState()
  if (!window.lovemi?.resolveMailProxy) {
    return { proxyUrl: undefined as string | undefined, label: '无主进程', error: '请在 Electron 中运行' }
  }
  const st = await window.lovemi.resolveMailProxy({
    vlessEnabled: settings.urlProxyEnabled && settings.mailProxyRoute === 'vless',
    subscriptionUrl: settings.urlProxy,
    localEnabled: settings.localProxyEnabled,
    localHost: settings.localProxyHost,
    localPort: settings.localProxyPort,
  })
  const label =
    st.source === 'vless'
      ? `VLESS ${st.nodeServer || ''}`.trim()
      : st.source === 'fallback-local'
        ? `本地兜底${st.error ? `（VLESS 失败：${st.error}）` : ''}`
        : st.error || '无可用出站'
  return { proxyUrl: st.proxyUrl, label, error: st.error, source: st.source }
}

/** 注册队列：2 路并发，短间隔；限流退避 */
const pendingIds: string[] = []
let draining = false
const GAP_MS = 1500
const RATE_LIMIT_WAIT_MS = 12_000
const CONCURRENCY = 2

function isRateLimited(error?: string) {
  return /too many|rate|429/i.test(error || '')
}

function isAlreadyErr(error?: string) {
  return /already\s*registered|already\s*exists|isalready|已注册|已存在/i.test(error || '')
}

export function getRegisterQueueLength() {
  return pendingIds.length
}

/** 入队；已在队内 / 已注册的会跳过 */
export function enqueueLovemiRegister(ids: string[]) {
  const { accounts } = useEmailStore.getState()
  const byId = new Map(accounts.map((a) => [a.id, a]))
  for (const id of ids) {
    const a = byId.get(id)
    if (!a || isDemo(a.email, a.id) || a.lovemiRegistered) continue
    if (pendingIds.includes(id)) continue
    pendingIds.push(id)
  }
  void drainRegisterQueue()
}

async function processOneRegister(
  id: string,
  proxyUrl: string,
  counters: { ok: number; fail: number },
) {
  const { setToast, markLovemiRegistering, applyLovemiRegisters } = useEmailStore.getState()
  const account = useEmailStore.getState().accounts.find((a) => a.id === id)
  if (!account || account.lovemiRegistered || isDemo(account.email, account.id)) return

  markLovemiRegistering([id])
  setToast(`注册/接管 ${counters.ok + counters.fail + 1} · ${account.email}`)

  const preferReclaim = isAlreadyErr(account.lovemiRegError)

  try {
    let result = await window.lovemi!.registerLovemi({
      email: account.email,
      refreshToken: account.refreshToken,
      clientId: account.clientId,
      proxyUrl,
      preferReclaim,
    })

    if (!result.ok && isRateLimited(result.error)) {
      setToast(`限流，等待 ${RATE_LIMIT_WAIT_MS / 1000}s 后重试…`)
      await sleep(RATE_LIMIT_WAIT_MS)
      result = await window.lovemi!.registerLovemi({
        email: account.email,
        refreshToken: account.refreshToken,
        clientId: account.clientId,
        proxyUrl,
        preferReclaim,
      })
    }

    if (!result.ok && isAlreadyErr(result.error) && window.lovemi?.resetLovemiPassword) {
      setToast(`已注册，直接重置：${account.email}`)
      const reset = await window.lovemi.resetLovemiPassword({
        email: account.email,
        refreshToken: account.refreshToken,
        clientId: account.clientId,
        proxyUrl,
      })
      result = reset.ok
        ? {
            ok: true,
            email: account.email,
            password: reset.password,
            sessionToken: reset.sessionToken,
            userId: reset.userId,
          }
        : { ok: false, email: account.email, error: `已注册，重置失败: ${reset.error}` }
    }

    applyLovemiRegisters([
      {
        email: result.email,
        ok: result.ok,
        error: result.error,
        password: result.password,
        sessionToken: result.sessionToken,
        userId: result.userId,
      },
    ])
    if (result.ok) counters.ok++
    else counters.fail++
  } catch (err) {
    applyLovemiRegisters([
      {
        email: account.email,
        ok: false,
        error: err instanceof Error ? err.message : '注册进程失败',
      },
    ])
    counters.fail++
  }

  if (pendingIds.length > 0) await sleep(GAP_MS)
}

async function drainRegisterQueue() {
  if (draining) return
  draining = true
  const { setRegistering, setToast, applyLovemiRegisters, probing } = useEmailStore.getState()

  if (probing) {
    draining = false
    return
  }

  if (!window.lovemi?.registerLovemi) {
    setToast('请在 Electron 桌面窗口中操作')
    pendingIds.length = 0
    draining = false
    return
  }

  setRegistering(true)
  const outbound = await resolveOutbound()
  if (!outbound.proxyUrl) {
    setToast(outbound.error || '无可用代理（禁止直连）')
    applyLovemiRegisters(
      pendingIds.map((id) => {
        const a = useEmailStore.getState().accounts.find((x) => x.id === id)
        return { email: a?.email || id, ok: false, error: outbound.error || '无可用代理' }
      }),
    )
    pendingIds.length = 0
    setRegistering(false)
    draining = false
    return
  }

  const counters = { ok: 0, fail: 0 }
  const totalAtStart = pendingIds.length
  if (totalAtStart > 0) {
    setToast(`注册队列：${totalAtStart} 个 · ${CONCURRENCY} 路并发 · 间隔 ${GAP_MS / 1000}s`)
  }

  const worker = async () => {
    while (pendingIds.length > 0) {
      if (useEmailStore.getState().probing) break
      const id = pendingIds.shift()
      if (!id) break
      await processOneRegister(id, outbound.proxyUrl!, counters)
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  } finally {
    setRegistering(false)
    draining = false
  }

  if (counters.ok + counters.fail > 0) {
    setToast(`注册队列结束：成功 ${counters.ok} · 失败 ${counters.fail} · ${outbound.label}`)
  }

  const { enqueueLovemiLogin } = await import('./lovemiLogin')
  enqueueLovemiLogin(
    useEmailStore
      .getState()
      .accounts.filter(
        (a) =>
          a.lovemiRegistered &&
          !a.lovemiSessionToken &&
          (a.lovemiPassword || (a.refreshToken && a.clientId)),
      )
      .map((a) => a.id),
  )

  if (pendingIds.length > 0 && !useEmailStore.getState().probing) {
    void drainRegisterQueue()
  }
}

/** @deprecated 改走队列；保留兼容 */
export async function runLovemiRegister(ids: string[]) {
  enqueueLovemiRegister(ids)
}

export async function registerUnregisteredReady(limit = 1) {
  const { accounts } = useEmailStore.getState()
  const ids = accounts
    .filter(
      (a) =>
        !isDemo(a.email, a.id) &&
        !a.lovemiRegistered &&
        a.status === 'ready' &&
        Boolean(a.refreshToken && a.clientId),
    )
    .slice(0, limit)
    .map((a) => a.id)
  if (!ids.length) {
    useEmailStore.getState().setToast('没有「可用且未注册」的账号')
    return
  }
  enqueueLovemiRegister(ids)
}

/** 探活成功后：对本批可用未注册账号入队注册 */
export async function registerReadyAfterProbe(probedIds: string[]) {
  const { accounts, setToast } = useEmailStore.getState()
  const idSet = new Set(probedIds)
  const ids = accounts
    .filter(
      (a) =>
        idSet.has(a.id) &&
        !isDemo(a.email, a.id) &&
        !a.lovemiRegistered &&
        a.status === 'ready' &&
        Boolean(a.refreshToken && a.clientId),
    )
    .map((a) => a.id)
  if (!ids.length) return
  setToast(`探活通过，${ids.length} 个账号进入注册队列…`)
  enqueueLovemiRegister(ids)
}

export async function registerAllUnregisteredReady() {
  const { accounts } = useEmailStore.getState()
  const ids = accounts
    .filter(
      (a) =>
        !isDemo(a.email, a.id) &&
        !a.lovemiRegistered &&
        Boolean(a.refreshToken && a.clientId) &&
        (a.status === 'ready' || a.status === 'idle' || a.authMode === 'oauth_graph'),
    )
    .map((a) => a.id)
  if (!ids.length) {
    return
  }
  useEmailStore.getState().setToast(`未注册账号 ${ids.length} 个进入注册队列…`)
  enqueueLovemiRegister(ids)
}
