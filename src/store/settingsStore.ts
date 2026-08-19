import { create } from 'zustand'

const STORAGE_KEY = 'lovemi.systemSettings'

export const DEFAULT_URL_PROXY =
  'https://kaze1.aisaka-taiga.com/oosaka/903905b050ad016c4936de9509439874'

/** vless = 主通道；local = 仅用本地兜底档（现 7897） */
export type MailProxyRoute = 'vless' | 'local'

export type SystemSettings = {
  localProxyEnabled: boolean
  localProxyHost: string
  localProxyPort: number
  urlProxyEnabled: boolean
  urlProxy: string
  mailProxyRoute: MailProxyRoute
}

const DEFAULTS: SystemSettings = {
  localProxyEnabled: true,
  localProxyHost: '127.0.0.1',
  localProxyPort: 7897,
  urlProxyEnabled: true,
  urlProxy: DEFAULT_URL_PROXY,
  mailProxyRoute: 'local',
}

function load(): SystemSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = { ...DEFAULTS, ...JSON.parse(raw) } as SystemSettings & { mailProxyRoute?: string }
    // 兼容旧值 url → vless
    if (parsed.mailProxyRoute === 'url') parsed.mailProxyRoute = 'vless'
    return parsed as SystemSettings
  } catch {
    return { ...DEFAULTS }
  }
}

function persist(s: SystemSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

/** UI 展示用（实际出站由主进程 resolveMailProxy 决定） */
export function resolveOutboundProxy(settings: SystemSettings): {
  proxyUrl: string | undefined
  label: string
} {
  if (settings.mailProxyRoute === 'vless' && settings.urlProxyEnabled) {
    return {
      proxyUrl: 'http://127.0.0.1:17891',
      label: 'VLESS 主通道（sing-box :17891）',
    }
  }
  if (!settings.localProxyEnabled) {
    return { proxyUrl: undefined, label: '未启用出站（禁止直连）' }
  }
  const host = settings.localProxyHost.trim() || '127.0.0.1'
  const port = settings.localProxyPort || 7897
  return {
    proxyUrl: `http://${host}:${port}`,
    label: `本地兜底 ${host}:${port}`,
  }
}

interface SettingsState extends SystemSettings {
  hydrated: boolean
  update: (patch: Partial<SystemSettings>) => void
  resetProxyDefaults: () => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULTS,
  hydrated: false,
  update: (patch) => {
    const next = { ...get(), ...patch, hydrated: true }
    const saved: SystemSettings = {
      localProxyEnabled: next.localProxyEnabled,
      localProxyHost: next.localProxyHost,
      localProxyPort: next.localProxyPort,
      urlProxyEnabled: next.urlProxyEnabled,
      urlProxy: next.urlProxy,
      mailProxyRoute: next.mailProxyRoute,
    }
    persist(saved)
    set(saved)
  },
  resetProxyDefaults: () => {
    persist(DEFAULTS)
    set({ ...DEFAULTS })
  },
}))

export function hydrateSettings() {
  const s = load()
  // 当前可用：Clash/狗狗 mixed-port 7897 本地兜底
  const next: SystemSettings = {
    ...s,
    localProxyEnabled: true,
    localProxyHost: '127.0.0.1',
    localProxyPort: 7897,
    mailProxyRoute: 'local',
    urlProxyEnabled: s.urlProxyEnabled,
    urlProxy: s.urlProxy || DEFAULT_URL_PROXY,
  }
  persist(next)
  useSettingsStore.setState({ ...next, hydrated: true })
}
