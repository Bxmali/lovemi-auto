import { create } from 'zustand'

export type ConsoleLogRow = {
  id: number
  ts: string
  level: string
  account_email: string | null
  listing_id: string | null
  action: string
  message: string
}

type Stats = {
  characters: number
  pending: number
  engaged: number
  skipped: number
  failed?: number
  today?: { liked: number; commented: number; skipped: number }
}

type ConsoleUiState = {
  autoEngage: boolean
  discovering: boolean
  engaging: boolean
  renaming: boolean
  logs: ConsoleLogRow[]
  stats: Stats | null
  /** 抽样参与率区间 */
  rateMin: number
  rateMax: number
  /** 动作间隔 */
  gapMinMs: number
  gapMaxMs: number
  /** 同时跑几路互动 */
  engageConcurrency: number
  discoverEveryMs: number
  failStreak: number
  failPauseAt: number
  setAutoEngage: (v: boolean) => void
  setDiscovering: (v: boolean) => void
  setEngaging: (v: boolean) => void
  setRenaming: (v: boolean) => void
  bumpFailStreak: () => void
  resetFailStreak: () => void
  refreshLogs: () => Promise<void>
  refreshStats: () => Promise<void>
  clearLogs: () => Promise<void>
}

export const useConsoleStore = create<ConsoleUiState>((set, get) => ({
  autoEngage: false,
  discovering: false,
  engaging: false,
  renaming: false,
  logs: [],
  stats: null,
  rateMin: 0.5,
  rateMax: 0.8,
  gapMinMs: 1_500,
  gapMaxMs: 4_000,
  engageConcurrency: 8,
  discoverEveryMs: 3 * 60_000,
  failStreak: 0,
  failPauseAt: 20,
  setAutoEngage: (v) => set({ autoEngage: v, ...(v ? {} : { failStreak: 0 }) }),
  setDiscovering: (v) => set({ discovering: v }),
  setEngaging: (v) => set({ engaging: v }),
  setRenaming: (v) => set({ renaming: v }),
  bumpFailStreak: () => set({ failStreak: get().failStreak + 1 }),
  resetFailStreak: () => set({ failStreak: 0 }),
  refreshLogs: async () => {
    const logs = (await window.lovemi?.consoleLogs?.(20)) || []
    set({ logs })
  },
  refreshStats: async () => {
    const stats = (await window.lovemi?.consoleCharacterStats?.()) || null
    set({ stats })
  },
  clearLogs: async () => {
    await window.lovemi?.consoleClearLogs?.()
    set({ logs: [] })
  },
}))
