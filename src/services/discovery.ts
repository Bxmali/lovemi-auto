import { useEmailStore } from '../store/emailStore'
import { useSettingsStore } from '../store/settingsStore'

async function resolveOutbound() {
  const settings = useSettingsStore.getState()
  if (!window.lovemi?.resolveMailProxy) {
    return { proxyUrl: undefined as string | undefined, error: '请在 Electron 中运行' }
  }
  const st = await window.lovemi.resolveMailProxy({
    vlessEnabled: settings.urlProxyEnabled && settings.mailProxyRoute === 'vless',
    subscriptionUrl: settings.urlProxy,
    localEnabled: settings.localProxyEnabled,
    localHost: settings.localProxyHost,
    localPort: settings.localProxyPort,
  })
  return { proxyUrl: st.proxyUrl, error: st.error }
}

/** 发现列表入库 + 为参与账号建 pending 去重行 */
export async function runDiscoverPass(opts?: { pages?: number }) {
  const { accounts, setToast } = useEmailStore.getState()
  if (!window.lovemi?.consoleDiscover) {
    setToast('请在 Electron 桌面窗口中操作')
    return null
  }
  const outbound = await resolveOutbound()
  if (!outbound.proxyUrl) {
    setToast(outbound.error || '无可用代理')
    return null
  }
  const withToken = accounts.filter(
    (a) =>
      !a.id.startsWith('demo-') &&
      !a.email.endsWith('@example.com') &&
      a.lovemiSessionToken,
  )
  if (!withToken.length) {
    setToast('没有可用 Bearer 账号')
    return null
  }
  // 发现用哪个 Bearer 也随机，避免总是第一个号打列表
  const bearerAccount = withToken[Math.floor(Math.random() * withToken.length)]
  const shuffledIds = [...withToken.map((a) => a.id)].sort(() => Math.random() - 0.5)
  setToast(`发现同步中（角色+Explore 各 ${opts?.pages ?? 3} 页）…`)
  const res = await window.lovemi.consoleDiscover({
    sessionToken: bearerAccount.lovemiSessionToken!,
    proxyUrl: outbound.proxyUrl,
    accountIds: shuffledIds,
    pages: opts?.pages ?? 3,
    limit: 21,
  })
  if (!res.ok) {
    setToast(`发现失败：${res.error}`)
    return res
  }
  setToast(
    `发现完成：${res.items} 条 · 新入库 ${res.inserted} · 新 pending ${res.pendingCreated}`,
  )
  return res
}
