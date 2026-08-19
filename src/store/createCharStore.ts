import { create } from 'zustand'

export type CreateCharBusy =
  | 'idle'
  | 'analyze'
  | 'create'
  | 'portrait'
  | 'motion'
  | 'publish'
  | 'auto'

export type CreateCharSlotId = 1 | 2 | 3

export type CreateCharStepKind = 'ok' | 'err' | 'run'

export type CreateCharStep = {
  id: string
  at: number
  kind: CreateCharStepKind
  text: string
}

/** 单槽草稿（互不影响，可并发跑） */
export type CreateCharSlotDraft = {
  previewUrl: string | null
  imageBase64: string | null
  mimeType: string
  payloadText: string
  portraitUrl: string | null
  portraitCdnUrl: string | null
  portraitPrompt: string
  busy: CreateCharBusy
  wantPortrait: boolean
  lastResult: string
  userHint: string
  createdCharacterId: string
  portraitJobId: string
  motionJobId: string
  motionPreviewUrl: string | null
  motionPrompt: string
  motionInputAssetId: string
  motionOutputAssetId: string
  listingId: string
  publishResult: string
  waitStartedAt: number | null
  waitKind: 'portrait' | 'motion' | 'publish' | null
  /** 步骤完成清单（绿色长显，切槽不丢） */
  stepLog: CreateCharStep[]
}

type SharedFields = {
  adminId: string
  teamoBase: string
  teamoModel: string
  teamoKeyInput: string
  hasApiKey: boolean
  hasAdminToken: boolean
}

type CreateCharState = SharedFields & {
  activeSlot: CreateCharSlotId
  slots: Record<CreateCharSlotId, CreateCharSlotDraft>
  /** 写当前槽；shared 键写共享区 */
  patch: (partial: Partial<CreateCharSlotDraft & SharedFields>) => void
  /** 写指定槽（异步任务必须用发起时的 slot，防串台） */
  patchSlot: (slot: CreateCharSlotId, partial: Partial<CreateCharSlotDraft>) => void
  /** 追加步骤提示（绿色长显） */
  pushStep: (slot: CreateCharSlotId, kind: CreateCharStepKind, text: string) => void
  clearStepLog: (slot?: CreateCharSlotId) => void
  setActiveSlot: (slot: CreateCharSlotId) => void
  resetDraft: () => void
}

const STORAGE_KEY = 'lovemi-auto-create-char-v2'
const STORAGE_KEY_LEGACY = 'lovemi-auto-create-char-v1'

const SLOT_DEFAULTS: CreateCharSlotDraft = {
  previewUrl: null,
  imageBase64: null,
  mimeType: 'image/png',
  payloadText: '',
  portraitUrl: null,
  portraitCdnUrl: null,
  portraitPrompt: '',
  busy: 'idle',
  wantPortrait: true,
  lastResult: '',
  userHint: '',
  createdCharacterId: '',
  portraitJobId: '',
  motionJobId: '',
  motionPreviewUrl: null,
  motionPrompt: '',
  motionInputAssetId: '',
  motionOutputAssetId: '',
  listingId: '',
  publishResult: '',
  waitStartedAt: null,
  waitKind: null,
  stepLog: [],
}

const SHARED_KEYS = new Set([
  'adminId',
  'teamoBase',
  'teamoModel',
  'teamoKeyInput',
  'hasApiKey',
  'hasAdminToken',
])

function emptySlots(): Record<CreateCharSlotId, CreateCharSlotDraft> {
  return {
    1: { ...SLOT_DEFAULTS },
    2: { ...SLOT_DEFAULTS },
    3: { ...SLOT_DEFAULTS },
  }
}

function scrubHugeText(text: string | undefined | null, max = 12_000): string {
  if (!text) return ''
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated ${text.length} chars]`
}

function httpUrlOnly(url: string | null | undefined): string | null {
  if (!url) return null
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  return null
}

function extractPortraitCdn(data: {
  portraitUrl?: string | null
  portraitCdnUrl?: string | null
  lastResult?: string
  publishResult?: string
}): string | null {
  const direct = httpUrlOnly(data.portraitCdnUrl) || httpUrlOnly(data.portraitUrl)
  if (direct) return direct
  const blob = `${data.lastResult || ''}\n${data.publishResult || ''}`
  const m = blob.match(/https:\/\/assets\.lovemi\.ai\/[^\s"'\\]+/)
  return m?.[0] || null
}

function normalizeSlot(raw: Partial<CreateCharSlotDraft> | undefined): CreateCharSlotDraft {
  const base = { ...SLOT_DEFAULTS, ...(raw || {}) }
  // 进程重启后 IPC 已断，禁止把「跑着」从 localStorage 复活（否则会假倒计时十几二十分钟）
  base.busy = 'idle'
  base.waitStartedAt = null
  base.waitKind = null
  const cdn = extractPortraitCdn(base)
  base.portraitCdnUrl = cdn
  base.portraitUrl = cdn
  if (base.imageBase64) {
    const mime = base.mimeType || 'image/png'
    base.previewUrl = `data:${mime};base64,${base.imageBase64}`
  } else {
    base.previewUrl = null
  }
  base.lastResult = scrubHugeText(base.lastResult)
  base.publishResult = scrubHugeText(base.publishResult)
  base.motionPreviewUrl = base.motionPreviewUrl?.startsWith('http') ? base.motionPreviewUrl : null
  base.stepLog = Array.isArray(base.stepLog)
    ? base.stepLog
        .filter((s) => s && typeof s.text === 'string')
        .slice(-40)
        .map((s) => ({
          id: String(s.id || `${s.at}-${Math.random()}`),
          at: typeof s.at === 'number' ? s.at : Date.now(),
          kind: s.kind === 'err' || s.kind === 'run' ? s.kind : 'ok',
          text: String(s.text).slice(0, 240),
        }))
    : []
  return base
}

type PersistedV2 = {
  version: 2
  activeSlot?: CreateCharSlotId
  adminId?: string
  teamoBase?: string
  teamoModel?: string
  slots?: Partial<Record<CreateCharSlotId, Partial<CreateCharSlotDraft>>>
}

function loadPersisted(): Partial<CreateCharState> {
  try {
    const rawV2 = localStorage.getItem(STORAGE_KEY)
    if (rawV2) {
      const data = JSON.parse(rawV2) as PersistedV2
      const slots = emptySlots()
      for (const id of [1, 2, 3] as CreateCharSlotId[]) {
        slots[id] = normalizeSlot(data.slots?.[id])
      }
      return {
        activeSlot: data.activeSlot === 2 || data.activeSlot === 3 ? data.activeSlot : 1,
        adminId: data.adminId || '',
        teamoBase: data.teamoBase || 'https://api.teamorouter.com/v1',
        teamoModel: data.teamoModel || 'gpt-5.4-mini',
        slots,
      }
    }

    // 迁移旧单槽草稿 → 槽 1
    const rawV1 = localStorage.getItem(STORAGE_KEY_LEGACY)
    if (!rawV1) return {}
    const legacy = JSON.parse(rawV1) as Partial<CreateCharSlotDraft> & {
      adminId?: string
      teamoBase?: string
      teamoModel?: string
    }
    const slots = emptySlots()
    slots[1] = normalizeSlot(legacy)
    return {
      activeSlot: 1,
      adminId: legacy.adminId || '',
      teamoBase: legacy.teamoBase || 'https://api.teamorouter.com/v1',
      teamoModel: legacy.teamoModel || 'gpt-5.4-mini',
      slots,
    }
  } catch {
    return {}
  }
}

function persistSlot(s: CreateCharSlotDraft): Partial<CreateCharSlotDraft> {
  const cdn =
    httpUrlOnly(s.portraitCdnUrl) ||
    httpUrlOnly(s.portraitUrl) ||
    extractPortraitCdn(s)
  return {
    imageBase64: s.imageBase64,
    mimeType: s.mimeType,
    payloadText: s.payloadText,
    portraitUrl: cdn,
    portraitCdnUrl: cdn,
    portraitPrompt: s.portraitPrompt,
    userHint: s.userHint,
    createdCharacterId: s.createdCharacterId,
    portraitJobId: s.portraitJobId,
    motionJobId: s.motionJobId,
    motionPreviewUrl: s.motionPreviewUrl?.startsWith('http') ? s.motionPreviewUrl : null,
    motionPrompt: s.motionPrompt,
    motionInputAssetId: s.motionInputAssetId,
    motionOutputAssetId: s.motionOutputAssetId,
    listingId: s.listingId,
    publishResult: scrubHugeText(s.publishResult),
    wantPortrait: s.wantPortrait,
    lastResult: scrubHugeText(s.lastResult),
    // 不持久化 busy：Electron 崩溃/重启后任务不会续跑，避免假「跑着」
    stepLog: (s.stepLog || []).slice(-40),
  }
}

function savePersisted(s: CreateCharState) {
  try {
    const payload: PersistedV2 = {
      version: 2,
      activeSlot: s.activeSlot,
      adminId: s.adminId,
      teamoBase: s.teamoBase,
      teamoModel: s.teamoModel,
      slots: {
        1: persistSlot(s.slots[1]),
        2: persistSlot(s.slots[2]),
        3: persistSlot(s.slots[3]),
      },
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    /* quota — 再试：丢掉各槽 imageBase64 */
    try {
      const slim = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as PersistedV2
      for (const id of [1, 2, 3] as CreateCharSlotId[]) {
        if (slim.slots?.[id]) delete slim.slots[id].imageBase64
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim))
    } catch {
      /* ignore */
    }
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(s: CreateCharState) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => savePersisted(s), 400)
}

function applyPortraitSync(partial: Partial<CreateCharSlotDraft>) {
  const next = { ...partial }
  if (typeof partial.portraitUrl === 'string' && partial.portraitUrl.startsWith('http')) {
    next.portraitCdnUrl = partial.portraitUrl
  }
  if (typeof partial.portraitCdnUrl === 'string' && partial.portraitCdnUrl.startsWith('http')) {
    // 保留 CDN；展示 URL 可以是 cache，但 CDN 不能丢
    next.portraitCdnUrl = partial.portraitCdnUrl
  }
  if (partial.portraitUrl === null) {
    next.portraitCdnUrl = null
  }
  return next
}

const hydrated = loadPersisted()

/** 三槽并发草稿 + 共享管理员/中转站配置 */
export const useCreateCharStore = create<CreateCharState>((set, get) => ({
  adminId: '',
  teamoBase: 'https://api.teamorouter.com/v1',
  teamoModel: 'gpt-5.4-mini',
  teamoKeyInput: '',
  hasApiKey: false,
  hasAdminToken: false,
  activeSlot: 1,
  slots: emptySlots(),
  ...hydrated,
  patch: (partial) => {
    const shared: Partial<SharedFields> = {}
    const draft: Partial<CreateCharSlotDraft> = {}
    for (const [k, v] of Object.entries(partial)) {
      if (SHARED_KEYS.has(k)) (shared as Record<string, unknown>)[k] = v
      else (draft as Record<string, unknown>)[k] = v
    }
    set((s) => {
      const slotId = s.activeSlot
      const slotNext = { ...s.slots[slotId], ...applyPortraitSync(draft) }
      return {
        ...shared,
        slots: { ...s.slots, [slotId]: slotNext },
      }
    })
    scheduleSave(get())
  },
  patchSlot: (slot, partial) => {
    set((s) => ({
      slots: {
        ...s.slots,
        [slot]: { ...s.slots[slot], ...applyPortraitSync(partial) },
      },
    }))
    scheduleSave(get())
  },
  pushStep: (slot, kind, text) => {
    const entry: CreateCharStep = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      kind,
      text: text.slice(0, 240),
    }
    set((s) => {
      const prev = s.slots[slot]?.stepLog || []
      return {
        slots: {
          ...s.slots,
          [slot]: { ...s.slots[slot], stepLog: [...prev, entry].slice(-40) },
        },
      }
    })
    scheduleSave(get())
  },
  clearStepLog: (slot) => {
    set((s) => {
      const id = slot ?? s.activeSlot
      return {
        slots: {
          ...s.slots,
          [id]: { ...s.slots[id], stepLog: [] },
        },
      }
    })
    scheduleSave(get())
  },
  setActiveSlot: (slot) => {
    set({ activeSlot: slot })
    scheduleSave(get())
  },
  resetDraft: () =>
    set((s) => {
      const cur = s.slots[s.activeSlot]
      if (cur.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(cur.previewUrl)
      const next = {
        slots: { ...s.slots, [s.activeSlot]: { ...SLOT_DEFAULTS } },
      }
      queueMicrotask(() => savePersisted({ ...get(), ...next } as CreateCharState))
      return next
    }),
}))

/** 读当前槽草稿（组件里用） */
export function selectActiveSlot(s: CreateCharState): CreateCharSlotDraft {
  return s.slots[s.activeSlot]
}

export function slotLabel(slot: CreateCharSlotDraft, id: CreateCharSlotId): string {
  let name = ''
  try {
    const obj = JSON.parse(slot.payloadText || '{}') as Record<string, unknown>
    if (typeof obj.display_name === 'string' && obj.display_name.trim()) {
      name = obj.display_name.trim()
    }
  } catch {
    /* ignore */
  }
  const busyHint =
    slot.busy === 'idle' ? '' : slot.busy === 'auto' ? ' ·跑着' : ` ·${slot.busy}`
  return name ? `${id}·${name}${busyHint}` : `角色${id}${busyHint}`
}
