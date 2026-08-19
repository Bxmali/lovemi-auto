import { useEmailStore } from '../store/emailStore'
import { useSettingsStore } from '../store/settingsStore'

function isDemo(email: string, id: string) {
  return id.startsWith('demo-') || email.endsWith('@example.com')
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

/** 对指定账号发起探活：VLESS 主通道 → 7890 兜底 → 禁止直连 */
export async function runAutoProbe(ids: string[]) {
  const { accounts, markProbing, applyProbes, setToast, probing } = useEmailStore.getState()
  if (probing) return

  const targets = accounts.filter((a) => ids.includes(a.id) && !isDemo(a.email, a.id))
  if (!targets.length) return

  if (!window.lovemi?.probeBatch) {
    setToast('请在 Electron 桌面窗口中操作')
    return
  }

  setToast('正在拉起 VLESS 出站…')
  const outbound = await resolveOutbound()
  if (!outbound.proxyUrl) {
    setToast(outbound.error || '无可用代理（禁止直连）')
    applyProbes(
      targets.map((a) => ({
        email: a.email,
        ok: false,
        error: outbound.error || '无可用代理',
      })),
    )
    return
  }

  markProbing(targets.map((a) => a.id))
  setToast(`正在检测 ${targets.length} 个账号…（${outbound.label}）`)

  try {
    const results = await window.lovemi.probeBatch(
      targets.map((a) => ({
        email: a.email,
        authMode: a.authMode,
        refreshToken: a.refreshToken,
        clientId: a.clientId,
        proxyUrl: outbound.proxyUrl,
        fallbackDirect: false,
      })),
    )
    const { ok, fail } = applyProbes(
      results.map((r) => ({
        email: r.email,
        ok: r.ok,
        error: r.error,
        refreshToken: r.refreshToken,
        displayName: r.displayName,
        via: r.via,
      })),
    )
    setToast(`检测完成：可用 ${ok} · 异常 ${fail} · ${outbound.label}`)

    // 入库/探活后：可用且未注册的账号自动注册 Lovemi（白名单，不节流）
    if (ok > 0) {
      const { registerReadyAfterProbe } = await import('./lovemiRegister')
      await registerReadyAfterProbe(ids)
    }
  } catch (err) {
    applyProbes(
      targets.map((a) => ({
        email: a.email,
        ok: false,
        error: err instanceof Error ? err.message : '检测进程失败',
      })),
    )
    setToast('自动检测失败，请重试')
  }
}

export async function probeIdleAccounts() {
  const { accounts, probing } = useEmailStore.getState()
  if (probing) return

  const idleIds = accounts
    .filter(
      (a) =>
        a.status === 'idle' &&
        !isDemo(a.email, a.id) &&
        Boolean(a.refreshToken && a.clientId),
    )
    .map((a) => a.id)

  if (!idleIds.length) return
  await runAutoProbe(idleIds)
}
