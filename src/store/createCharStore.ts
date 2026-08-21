import { create } from 'zustand'

export type CreateCharBusy =
  | 'idle'
  | 'analyze'
  | 'create'
  | 'portrait'
  | 'motion'
  | 'publish'
  | 'auto'

export type CreateCharSlotId = 1 | 2 | 3 | 4 | 5
export const CREATE_CHAR_SLOT_IDS: CreateCharSlotId[] = [1, 2, 3, 4, 5]

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
  portraitCacheUrl: string | null
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
  /** 每次贴新图/新开任务 +1；异步回调必须对上 epoch 才能写立绘 */
  draftEpoch: number
  /** 当前立绘属于哪个 chr_；与 createdCharacterId 不一致则不展示 */
  portraitCharacterId: string
  /** 全自动严格串行队列状态（不持久化） */
  queueStatus: 'idle' | 'queued' | 'running'
  queuePosition: number
  /** 每次全自动唯一运行 ID；进度、素材、下载都必须匹配 */
  runId: string
  runStartedAt: number | null
  /** 步骤完成清单（绿色长显，切槽不丢） */
  stepLog: CreateCharStep[]
}

type SharedFields = {
  /** @deprecated 已改为手填 Bearer，保留字段避免旧 localStorage 炸掉 */
  adminId: string
  adminTokenInput: string
  downloadsDir: string
  teamoBase: string
  teamoModel: string
  teamoKeyInput: string
  hasApiKey: boolean
  hasAdminToken: boolean
  /** 是否自动导出含水印推特资源（默认开） */
  autoDownloadWatermark: boolean
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
  /** 新贴图 / 新开流水线前调用，返回新 epoch */
  bumpSlotEpoch: (slot: CreateCharSlotId) => number
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
  portraitCacheUrl: null,
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
  draftEpoch: 0,
  portraitCharacterId: '',
  queueStatus: 'idle',
  queuePosition: 0,
  runId: '',
  runStartedAt: null,
  stepLog: [],
}

const SHARED_KEYS = new Set([
  'adminId',
  'adminTokenInput',
  'downloadsDir',
  'teamoBase',
  'teamoModel',
  'teamoKeyInput',
  'hasApiKey',
  'hasAdminToken',
  'autoDownloadWatermark',
])

function emptySlots(): Record<CreateCharSlotId, CreateCharSlotDraft> {
  return {
    1: { ...SLOT_DEFAULTS },
    2: { ...SLOT_DEFAULTS },
    3: { ...SLOT_DEFAULTS },
    4: { ...SLOT_DEFAULTS },
    5: { ...SLOT_DEFAULTS },
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
  base.queueStatus = 'idle'
  base.queuePosition = 0
  base.runId = ''
  base.runStartedAt = null
  // 旧版可能把多槽 base64 写进 Local Storage（可达几十 MB）；启动时一律丢掉，避免 OOM。
  base.imageBase64 = null
  base.previewUrl = null
  const cdn = extractPortraitCdn(base)
  base.portraitCdnUrl = cdn
  base.portraitCacheUrl =
    base.portraitCacheUrl?.startsWith('lovemi-cache://') ||
    base.portraitUrl?.startsWith('lovemi-cache://')
      ? (base.portraitCacheUrl || base.portraitUrl)
      : null
  base.portraitUrl = base.portraitCacheUrl || cdn
  if (base.portraitUrl && base.createdCharacterId && !base.portraitCharacterId) {
    base.portraitCharacterId = base.createdCharacterId
  }
  base.lastResult = scrubHugeText(base.lastResult)
  base.publishResult = scrubHugeText(base.publishResult)
  base.motionPreviewUrl =
    base.motionPreviewUrl?.startsWith('http') || base.motionPreviewUrl?.startsWith('lovemi-cache://')
      ? base.motionPreviewUrl
      : null
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

function normalizeSqlSlot(raw: Partial<CreateCharSlotDraft> | undefined): CreateCharSlotDraft {
  const base = { ...SLOT_DEFAULTS, ...(raw || {}) }
  const cdn = extractPortraitCdn(base)
  base.portraitCdnUrl = cdn
  base.portraitCacheUrl =
    base.portraitCacheUrl?.startsWith('lovemi-cache://') ||
    base.portraitUrl?.startsWith('lovemi-cache://')
      ? (base.portraitCacheUrl || base.portraitUrl)
      : null
  base.portraitUrl = base.portraitCacheUrl || cdn
  // SQLite 里的 busy/queue 可能是闪退前残留；真正是否在跑要靠主进程 runtime 再对齐。
  // 这里先清成 idle，避免「假跑」锁死全自动按钮。
  base.busy = 'idle'
  base.waitStartedAt = null
  base.waitKind = null
  base.queueStatus = 'idle'
  base.queuePosition = 0
  base.runId = ''
  base.runStartedAt = null
  base.lastResult = scrubHugeText(base.lastResult)
  base.publishResult = scrubHugeText(base.publishResult)
  base.stepLog = Array.isArray(base.stepLog)
    ? base.stepLog
        .filter((s) => s && typeof s.text === 'string')
        .slice(-60)
        .map((s) => ({
          id: String(s.id || `${s.at}-${Math.random()}`),
          at: typeof s.at === 'number' ? s.at : Date.now(),
          kind: s.kind === 'err' || s.kind === 'run' ? s.kind : 'ok',
          text: String(s.text).slice(0, 240),
        }))
    : []
  return base
}

function clearGeneratedResult(slot: CreateCharSlotDraft): CreateCharSlotDraft {
  return {
    ...slot,
    portraitUrl: null,
    portraitCdnUrl: null,
    portraitCacheUrl: null,
    createdCharacterId: '',
    portraitCharacterId: '',
    portraitJobId: '',
    motionJobId: '',
    motionPreviewUrl: null,
    motionInputAssetId: '',
    motionOutputAssetId: '',
    listingId: '',
    publishResult: '',
    lastResult: '已清除跨槽重复立绘，请重新点击全自动',
    stepLog: [],
  }
}

function clearCrossSlotDuplicatePortraits(slots: Record<CreateCharSlotId, CreateCharSlotDraft>) {
  const byUrl = new Map<string, CreateCharSlotId[]>()
  for (const id of CREATE_CHAR_SLOT_IDS) {
    const url = slots[id].portraitCdnUrl
    if (!url) continue
    byUrl.set(url, [...(byUrl.get(url) || []), id])
  }
  for (const ids of byUrl.values()) {
    if (ids.length < 2) continue
    for (const id of ids) slots[id] = clearGeneratedResult(slots[id])
  }
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
      for (const id of CREATE_CHAR_SLOT_IDS) {
        slots[id] = normalizeSlot(data.slots?.[id])
      }
      clearCrossSlotDuplicatePortraits(slots)
      return {
        activeSlot: CREATE_CHAR_SLOT_IDS.includes(data.activeSlot as CreateCharSlotId)
          ? (data.activeSlot as CreateCharSlotId)
          : 1,
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
    // 故意不持久化 imageBase64：5 槽各贴一张图会把 Local Storage 撑到几十 MB，渲染进程易 OOM 闪退。
    // 参考图只留在内存；重启后需重新 Ctrl+V。
    mimeType: s.mimeType,
    payloadText: s.payloadText,
    portraitUrl: cdn,
    portraitCdnUrl: cdn,
    portraitCacheUrl:
      s.portraitCacheUrl?.startsWith('lovemi-cache://') ||
      s.portraitUrl?.startsWith('lovemi-cache://')
        ? (s.portraitCacheUrl || s.portraitUrl)
        : null,
    portraitPrompt: s.portraitPrompt,
    userHint: s.userHint,
    createdCharacterId: s.createdCharacterId,
    portraitCharacterId: s.portraitCharacterId,
    portraitJobId: s.portraitJobId,
    motionJobId: s.motionJobId,
    motionPreviewUrl:
      s.motionPreviewUrl?.startsWith('http') || s.motionPreviewUrl?.startsWith('lovemi-cache://')
        ? s.motionPreviewUrl
        : null,
    motionPrompt: s.motionPrompt,
    motionInputAssetId: s.motionInputAssetId,
    motionOutputAssetId: s.motionOutputAssetId,
    listingId: s.listingId,
    publishResult: scrubHugeText(s.publishResult),
    wantPortrait: s.wantPortrait,
    lastResult: scrubHugeText(s.lastResult),
    // 不持久化 busy / epoch / queue / runId：重启后旧异步结果一律作废
    stepLog: (s.stepLog || []).slice(-40),
  }
}

function persistSqlSlot(s: CreateCharSlotDraft): Partial<CreateCharSlotDraft> {
  return {
    ...persistSlot(s),
    // 图片二进制单独写 create_char_reference_images，不放 JSON。
    imageBase64: null,
    previewUrl: null,
    busy: s.busy,
    waitStartedAt: s.waitStartedAt,
    waitKind: s.waitKind,
    draftEpoch: s.draftEpoch,
    queueStatus: s.queueStatus,
    queuePosition: s.queuePosition,
    runId: s.runId,
    runStartedAt: s.runStartedAt,
  }
}

function buildPersistedState(s: CreateCharState, forSqlite = false): PersistedV2 {
  const map = (slot: CreateCharSlotId) =>
    forSqlite ? persistSqlSlot(s.slots[slot]) : persistSlot(s.slots[slot])
  return {
    version: 2,
    activeSlot: s.activeSlot,
    adminId: s.adminId,
    teamoBase: s.teamoBase,
    teamoModel: s.teamoModel,
    slots: {
      1: map(1),
      2: map(2),
      3: map(3),
      4: map(4),
      5: map(5),
    },
  }
}

function savePersisted(s: CreateCharState) {
  try {
    const payload = buildPersistedState(s)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    /* quota — 再试：丢掉大字段 */
    try {
      const slim = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as PersistedV2
      for (const id of CREATE_CHAR_SLOT_IDS) {
        if (slim.slots?.[id]) {
          delete slim.slots[id].imageBase64
          delete slim.slots[id].payloadText
          delete slim.slots[id].lastResult
          delete slim.slots[id].publishResult
        }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim))
    } catch {
      /* ignore */
    }
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let sqliteSaveTimer: ReturnType<typeof setTimeout> | null = null
let sqliteHydrated = false
const pendingImageUpdates = new Map<
  CreateCharSlotId,
  { slot: CreateCharSlotId; mimeType: string; imageBase64: string | null }
>()

function scheduleSqliteSave(
  imageUpdate?: { slot: CreateCharSlotId; mimeType: string; imageBase64: string | null },
) {
  if (imageUpdate) pendingImageUpdates.set(imageUpdate.slot, imageUpdate)
  if (!sqliteHydrated || !window.lovemi?.createCharStateSave) return
  if (sqliteSaveTimer) clearTimeout(sqliteSaveTimer)
  sqliteSaveTimer = setTimeout(() => {
    sqliteSaveTimer = null
    const latest = useCreateCharStore.getState()
    const images = [...pendingImageUpdates.values()]
    pendingImageUpdates.clear()
    void window.lovemi
      ?.createCharStateSave?.({
        state: buildPersistedState(latest, true) as unknown as Record<string, unknown>,
        imageUpdates: images,
      })
      .catch(() => {
        // SQLite 暂时不可用时仍保留 localStorage 瘦身备份。
        for (const update of images) pendingImageUpdates.set(update.slot, update)
      })
  }, 250)
}

function scheduleSave(
  s: CreateCharState,
  imageUpdate?: { slot: CreateCharSlotId; mimeType: string; imageBase64: string | null },
) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => savePersisted(s), 400)
  scheduleSqliteSave(imageUpdate)
}

function applyPortraitSync(partial: Partial<CreateCharSlotDraft>) {
  const next = { ...partial }
  if (typeof partial.portraitUrl === 'string' && partial.portraitUrl.startsWith('http')) {
    next.portraitCdnUrl = partial.portraitUrl
  }
  if (
    typeof partial.portraitUrl === 'string' &&
    partial.portraitUrl.startsWith('lovemi-cache://')
  ) {
    next.portraitCacheUrl = partial.portraitUrl
  }
  if (typeof partial.portraitCdnUrl === 'string' && partial.portraitCdnUrl.startsWith('http')) {
    // 保留 CDN；展示 URL 可以是 cache，但 CDN 不能丢
    next.portraitCdnUrl = partial.portraitCdnUrl
  }
  if (partial.portraitUrl === null) {
    next.portraitCdnUrl = null
    next.portraitCacheUrl = null
  }
  return next
}

const hydrated = loadPersisted()

/** 三槽并发草稿 + 共享管理员/中转站配置 */
export const useCreateCharStore = create<CreateCharState>((set, get) => ({
  adminId: '',
  adminTokenInput: '',
  downloadsDir: '',
  teamoBase: 'https://api.teamorouter.com/v1',
  teamoModel: 'gpt-5.4-mini',
  teamoKeyInput: '',
  hasApiKey: false,
  hasAdminToken: false,
  autoDownloadWatermark: true,
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
    const current = get()
    const imageUpdate = Object.prototype.hasOwnProperty.call(draft, 'imageBase64')
      ? {
          slot: current.activeSlot,
          mimeType: String(draft.mimeType || current.slots[current.activeSlot].mimeType),
          imageBase64: typeof draft.imageBase64 === 'string' ? draft.imageBase64 : null,
        }
      : undefined
    scheduleSave(current, imageUpdate)
  },
  patchSlot: (slot, partial) => {
    set((s) => ({
      slots: {
        ...s.slots,
        [slot]: { ...s.slots[slot], ...applyPortraitSync(partial) },
      },
    }))
    const current = get()
    const imageUpdate = Object.prototype.hasOwnProperty.call(partial, 'imageBase64')
      ? {
          slot,
          mimeType: String(partial.mimeType || current.slots[slot].mimeType),
          imageBase64: typeof partial.imageBase64 === 'string' ? partial.imageBase64 : null,
        }
      : undefined
    scheduleSave(current, imageUpdate)
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
    set((s) => {
      const previous = s.activeSlot
      if (previous === slot) return { activeSlot: slot }
      const prevDraft = s.slots[previous]
      if (prevDraft.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(prevDraft.previewUrl)
      return {
        activeSlot: slot,
        // 非当前槽参考图留在 SQLite，不在 Renderer 同时保留 5 份 base64+解码位图。
        slots: {
          ...s.slots,
          [previous]: { ...prevDraft, imageBase64: null, previewUrl: null },
        },
      }
    })
    scheduleSave(get())
    void hydrateCreateCharSlotImageFromSqlite(slot)
  },
  resetDraft: () =>
    set((s) => {
      const cur = s.slots[s.activeSlot]
      if (cur.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(cur.previewUrl)
      const epoch = cur.draftEpoch + 1
      const next = {
        slots: {
          ...s.slots,
          [s.activeSlot]: { ...SLOT_DEFAULTS, draftEpoch: epoch },
        },
      }
      queueMicrotask(() => {
        const latest = { ...get(), ...next } as CreateCharState
        savePersisted(latest)
        scheduleSqliteSave({
          slot: s.activeSlot,
          mimeType: cur.mimeType,
          imageBase64: null,
        })
      })
      return next
    }),
  bumpSlotEpoch: (slot) => {
    let nextEpoch = 0
    set((s) => {
      nextEpoch = (s.slots[slot].draftEpoch || 0) + 1
      return {
        slots: {
          ...s.slots,
          [slot]: { ...s.slots[slot], draftEpoch: nextEpoch },
        },
      }
    })
    scheduleSave(get())
    return nextEpoch
  },
}))

// 启动即写回瘦身后的草稿，立刻甩掉旧版多槽 imageBase64（否则要等用户再操作才缩 Local Storage）
queueMicrotask(() => savePersisted(useCreateCharStore.getState()))

function restoredPreviewUrl(imageBase64: string, mimeType: string): string | null {
  try {
    const binary = atob(imageBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return URL.createObjectURL(new Blob([bytes], { type: mimeType || 'image/png' }))
  } catch {
    return null
  }
}

async function hydrateCreateCharSlotImageFromSqlite(slot: CreateCharSlotId) {
  const current = useCreateCharStore.getState().slots[slot]
  if (current.imageBase64 || !window.lovemi?.createCharStateLoadImage) return
  try {
    const loaded = await window.lovemi.createCharStateLoadImage(slot)
    if (!loaded.ok || !loaded.imageBase64) return
    const latest = useCreateCharStore.getState()
    if (latest.activeSlot !== slot || latest.slots[slot].imageBase64) return
    const mimeType = loaded.mimeType || latest.slots[slot].mimeType
    useCreateCharStore.setState((state) => ({
      slots: {
        ...state.slots,
        [slot]: {
          ...state.slots[slot],
          imageBase64: loaded.imageBase64,
          mimeType,
          previewUrl: restoredPreviewUrl(loaded.imageBase64!, mimeType),
        },
      },
    }))
  } catch {
    /* 保留无图状态，用户仍可重新粘贴 */
  }
}

/** SQLite 是创建角色草稿/队列的权威存储；localStorage 只做轻量兼容备份。 */
export async function hydrateCreateCharStoreFromSqlite(): Promise<boolean> {
  if (sqliteHydrated) return true
  const api = window.lovemi?.createCharStateLoad
  if (!api) {
    sqliteHydrated = true
    return false
  }
  try {
    const before = useCreateCharStore.getState()
    const loaded = await api()
    const raw = loaded.state as PersistedV2 | undefined
    if (loaded.ok && raw?.slots) {
      const slots = emptySlots()
      const imageUpdates: Array<{
        slot: CreateCharSlotId
        mimeType: string
        imageBase64: string | null
      }> = []
      for (const id of CREATE_CHAR_SLOT_IDS) {
        const image = loaded.images?.[id]
        const slot = normalizeSqlSlot(raw.slots?.[id])
        const prev = before.slots[id]
        if (image?.imageBase64) {
          slot.imageBase64 = image.imageBase64
          slot.mimeType = image.mimeType || slot.mimeType
          slot.previewUrl = restoredPreviewUrl(image.imageBase64, slot.mimeType)
        } else if (prev?.imageBase64) {
          // 水合前刚粘贴、DB 还没写上：保留内存图并补写 SQLite，防止闪退后参考图蒸发。
          slot.imageBase64 = prev.imageBase64
          slot.mimeType = prev.mimeType || slot.mimeType
          slot.previewUrl =
            prev.previewUrl?.startsWith('blob:')
              ? prev.previewUrl
              : restoredPreviewUrl(prev.imageBase64, slot.mimeType)
          imageUpdates.push({
            slot: id,
            mimeType: slot.mimeType,
            imageBase64: prev.imageBase64,
          })
        }
        slots[id] = slot
      }
      useCreateCharStore.setState((current) => ({
        ...current,
        activeSlot: CREATE_CHAR_SLOT_IDS.includes(raw.activeSlot as CreateCharSlotId)
          ? (raw.activeSlot as CreateCharSlotId)
          : current.activeSlot,
        adminId: raw.adminId || current.adminId,
        teamoBase: raw.teamoBase || current.teamoBase,
        teamoModel: raw.teamoModel || current.teamoModel,
        slots,
      }))
      sqliteHydrated = true
      for (const update of imageUpdates) scheduleSqliteSave(update)
      scheduleSqliteSave()
      return true
    }
    sqliteHydrated = true
    scheduleSqliteSave()
    return false
  } catch {
    sqliteHydrated = true
    scheduleSqliteSave()
    return false
  }
}

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
    slot.queueStatus === 'queued'
      ? ` ·排队${slot.queuePosition || ''}`
      : slot.queueStatus === 'running'
        ? ' ·运行中'
        : slot.busy === 'idle'
          ? ''
          : slot.busy === 'auto'
            ? ' ·跑着'
            : ` ·${slot.busy}`
  return name ? `${id}·${name}${busyHint}` : `角色${id}${busyHint}`
}

export function findSlotByCharacterId(characterId: string): CreateCharSlotId | null {
  const id = (characterId || '').trim()
  if (!id) return null
  const st = useCreateCharStore.getState()
  for (const slot of CREATE_CHAR_SLOT_IDS) {
    if (st.slots[slot].createdCharacterId === id) return slot
  }
  return null
}

/** 立绘/封面只能写入与槽内 createdCharacterId 完全一致的角色 */
export function slotAcceptsPortrait(slot: CreateCharSlotDraft, characterId: string): boolean {
  const cid = (characterId || '').trim()
  if (!cid || !slot.createdCharacterId) return false
  return slot.createdCharacterId === cid
}

/** 立绘是否仍属于当前槽任务（防旧任务迟到的图） */
export function portraitMatchesSlot(slot: CreateCharSlotDraft): boolean {
  if (!slot.portraitUrl) return false
  if (!slot.createdCharacterId) return false
  return slot.portraitCharacterId === slot.createdCharacterId
}
