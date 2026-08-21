import { useCallback, useEffect, useRef, useState } from 'react'
import {
  useCreateCharStore,
  slotLabel,
  findSlotByCharacterId,
  slotAcceptsPortrait,
  portraitMatchesSlot,
  hydrateCreateCharStoreFromSqlite,
  CREATE_CHAR_SLOT_IDS,
  type CreateCharQueueKind,
  type CreateCharSlotId,
  type CreateCharSlotDraft,
} from '../store/createCharStore'
import { useEmailStore } from '../store/emailStore'
import { useSettingsStore } from '../store/settingsStore'
import { runEmailPageEnter } from '../motion/timelines'
import { MediaLightbox } from '../components/MediaLightbox'

const QUEUE_KIND_LABELS: Record<CreateCharQueueKind, string> = {
  create: '创建到 Lovemi',
  motion: '生成动态视频',
  autoPublish: '生成视频并发布',
  pullPublish: '拉回并发布',
  fullAuto: '全自动到发布',
}

function isCreateCharQueueKind(value: unknown): value is CreateCharQueueKind {
  return typeof value === 'string' && value in QUEUE_KIND_LABELS
}

async function resolveProxyUrl() {
  const settings = useSettingsStore.getState()
  if (!window.lovemi?.resolveMailProxy) return { proxyUrl: undefined as string | undefined, error: '请在 Electron 中运行' }
  const st = await window.lovemi.resolveMailProxy({
    vlessEnabled: settings.urlProxyEnabled && settings.mailProxyRoute === 'vless',
    subscriptionUrl: settings.urlProxy,
    localEnabled: settings.localProxyEnabled,
    localHost: settings.localProxyHost,
    localPort: settings.localProxyPort,
  })
  return { proxyUrl: st.proxyUrl, error: st.error }
}

function fileToBase64(file: Blob): Promise<{ base64: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
      if (!m) {
        reject(new Error('无法读取图片'))
        return
      }
      resolve({ mime: m[1], base64: m[2] })
    }
    reader.onerror = () => reject(new Error('读图失败'))
    reader.readAsDataURL(file)
  })
}

/** 限制五槽参考图的解码内存；4K/8K 原图会让 Electron Renderer 被系统 OOM kill。 */
async function optimizeReferenceImage(blob: Blob): Promise<Blob> {
  const MAX_SIDE = 1_600
  const MAX_BYTES = 2_500_000
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(blob)
    const longest = Math.max(bitmap.width, bitmap.height)
    if (longest <= MAX_SIDE && blob.size <= MAX_BYTES) return blob
    const scale = Math.min(1, MAX_SIDE / longest)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return blob
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)
    return (
      (await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.9),
      )) || blob
    )
  } catch {
    return blob
  } finally {
    bitmap?.close()
  }
}

function formatCompactResult(value: unknown): string {
  const scrub = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(scrub)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string' && val.startsWith('data:image')) {
          out[k] = `[data-url omitted · ${Math.round(val.length / 1024)}KB]`
        } else if (typeof val === 'string' && val.length > 400 && /base64|,{20,}/i.test(val)) {
          out[k] = `${val.slice(0, 80)}…[truncated ${val.length}]`
        } else {
          out[k] = scrub(val)
        }
      }
      return out
    }
    return v
  }
  try {
    return JSON.stringify(scrub(value), null, 2)
  } catch {
    return String(value)
  }
}

const WAIT_MAX_PORTRAIT_OR_MOTION_SEC = 10 * 60
const WAIT_MAX_PUBLISH_SEC = 20 * 60

function formatClock(totalSec: number) {
  const s = Math.max(0, Math.floor(totalSec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

/** IPC 进度：有 characterId 时只写入拥有该 ID 的槽；孤儿事件必须匹配 clientRunEpoch */
function resolveProgressSlot(p: {
  clientSlot?: 1 | 2 | 3 | 4 | 5
  clientRunEpoch?: number
  runId?: string
  characterId?: string
  portraitCdnUrl?: string
  coverAssetId?: string
}): CreateCharSlotId | null {
  const charId = p.characterId?.trim()
  const slotFromClient = CREATE_CHAR_SLOT_IDS.includes(p.clientSlot as CreateCharSlotId)
    ? (p.clientSlot as CreateCharSlotId)
    : null

  const epochOk = (slotId: CreateCharSlotId) => {
    if (p.clientRunEpoch == null) return true
    return useCreateCharStore.getState().slots[slotId].draftEpoch === p.clientRunEpoch
  }

  if (charId) {
    const owner = findSlotByCharacterId(charId)
    if (owner) return owner
    // 该 characterId 不属于任何槽：仅允许写回发起本次全自动的槽，且 epoch 必须一致
    if (slotFromClient && epochOk(slotFromClient)) return slotFromClient
    return null
  }

  if (slotFromClient) {
    if (!epochOk(slotFromClient)) return null
    return slotFromClient
  }
  return null
}

function hasActiveFullAutoQueue(): boolean {
  const slots = useCreateCharStore.getState().slots
  return CREATE_CHAR_SLOT_IDS.some((id) => slots[id].queueStatus !== 'idle')
}

function slotStillMatches(slot: CreateCharSlotId, epoch: number, characterId?: string): boolean {
  const current = useCreateCharStore.getState().slots[slot]
  return (
    current.draftEpoch === epoch &&
    (!characterId || current.createdCharacterId === characterId)
  )
}

export function CreateCharacterPage({ active }: { active: boolean }) {
  const pageRef = useRef<HTMLElement>(null)
  const setToast = useEmailStore((s) => s.setToast)
  const patch = useCreateCharStore((s) => s.patch)
  const patchSlot = useCreateCharStore((s) => s.patchSlot)
  const bumpSlotEpoch = useCreateCharStore((s) => s.bumpSlotEpoch)
  const pushStep = useCreateCharStore((s) => s.pushStep)
  const clearStepLog = useCreateCharStore((s) => s.clearStepLog)
  const activeSlot = useCreateCharStore((s) => s.activeSlot)
  const setActiveSlot = useCreateCharStore((s) => s.setActiveSlot)
  const slots = useCreateCharStore((s) => s.slots)
  const adminTokenInput = useCreateCharStore((s) => s.adminTokenInput)
  const downloadsDir = useCreateCharStore((s) => s.downloadsDir)
  const autoDownloadWatermark = useCreateCharStore((s) => s.autoDownloadWatermark)
  const teamoBase = useCreateCharStore((s) => s.teamoBase)
  const teamoModel = useCreateCharStore((s) => s.teamoModel)
  const teamoKeyInput = useCreateCharStore((s) => s.teamoKeyInput)
  const hasApiKey = useCreateCharStore((s) => s.hasApiKey)
  const hasAdminToken = useCreateCharStore((s) => s.hasAdminToken)
  const draft = useCreateCharStore((s) => s.slots[s.activeSlot])
  const previewUrl = draft.previewUrl
  const imageBase64 = draft.imageBase64
  const mimeType = draft.mimeType
  const payloadText = draft.payloadText
  const portraitUrl = draft.portraitUrl
  const portraitCdnUrl = draft.portraitCdnUrl
  const portraitPrompt = draft.portraitPrompt
  const busy = draft.busy
  const wantPortrait = draft.wantPortrait
  const lastResult = draft.lastResult
  const userHint = draft.userHint
  const createdCharacterId = draft.createdCharacterId
  const portraitCharacterId = draft.portraitCharacterId
  const draftEpoch = draft.draftEpoch
  const queueStatus = draft.queueStatus
  const queuePosition = draft.queuePosition
  const queueKind = draft.queueKind
  const waitStartedAt = draft.waitStartedAt
  const motionPrompt = draft.motionPrompt
  const motionPreviewUrl = draft.motionPreviewUrl
  const motionInputAssetId = draft.motionInputAssetId
  const motionOutputAssetId = draft.motionOutputAssetId
  const listingId = draft.listingId
  const waitKind = draft.waitKind
  const stepLog = draft.stepLog || []
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [lightbox, setLightbox] = useState<{ src: string; kind: 'image' | 'video' } | null>(null)
  const closeLightbox = useCallback(() => setLightbox(null), [])
  const portraitRestoreTried = useRef<Set<string>>(new Set())
  const videoCacheTried = useRef<Set<string>>(new Set())
  const portraitSaveTried = useRef<Set<string>>(new Set())
  /** 永久失败的 CDN（404/410 等）：不再轮询下载，避免 toast 刷屏卡死操作感 */
  const portraitCdnDead = useRef<Set<string>>(new Set())
  const portraitDeadToastOnce = useRef<Set<string>>(new Set())
  const sqliteHydrateStarted = useRef(false)
  /** 槽 → 当前流水线 epoch（贴新图 / 全自动开始时更新） */
  const slotRunEpoch = useRef<Record<CreateCharSlotId, number>>({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })
  const pushStepUnique = useCallback(
    (slot: CreateCharSlotId, kind: 'ok' | 'err' | 'run', text: string) => {
      const existing = useCreateCharStore.getState().slots[slot].stepLog
      if (existing.some((entry) => entry.text === text)) return
      pushStep(slot, kind, text)
    },
    [pushStep],
  )

  /** 闪退重载后：先从 SQLite 恢复五槽草稿/参考图，再接回主进程仍在跑的队列。 */
  useEffect(() => {
    if (sqliteHydrateStarted.current) return
    sqliteHydrateStarted.current = true
    let cancelled = false
    void (async () => {
      await hydrateCreateCharStoreFromSqlite()
      if (cancelled) return
      const runtime = await window.lovemi?.createCharRuntimeState?.()
      if (cancelled) return
      const runtimeRuns = runtime?.ok ? runtime.runs || [] : []
      const reportedRunning = runtimeRuns.filter((run) => run.status === 'running')
      // 主队列严格串行，任意时刻最多一个 running。旧版本重启时可能只更新 SQLite
      // 的 status 列、未同步 snapshot_json，导致多个历史任务被误报为 running。
      // 当前真正运行的任务一定有最新的 runStartedAt，其余按 interrupted 清掉。
      const activeRunningRun = reportedRunning.reduce<(typeof reportedRunning)[number] | undefined>(
        (latest, run) =>
          !latest || Number(run.runStartedAt || 0) > Number(latest.runStartedAt || 0) ? run : latest,
        undefined,
      )
      const normalizedRuntimeRuns = runtimeRuns.map((run) =>
        run.status === 'running' && run.runId !== activeRunningRun?.runId
          ? { ...run, status: 'interrupted' as const }
          : run,
      )
      const liveRuns = normalizedRuntimeRuns.filter(
        (run) => run.status === 'queued' || run.status === 'running',
      )
      const liveBySlot = new Map<number, (typeof liveRuns)[number]>()
      for (const run of liveRuns) liveBySlot.set(Number(run.slot), run)

      // 先清掉 SQLite/内存里的假忙状态，只保留主进程确认仍在跑的槽。
      for (const slot of CREATE_CHAR_SLOT_IDS) {
        const live = liveBySlot.get(slot)
        if (live) continue
        const cur = useCreateCharStore.getState().slots[slot]
        if (cur.busy === 'idle' && cur.queueStatus === 'idle' && !cur.waitStartedAt) continue
        patchSlot(slot, {
          busy: 'idle',
          queueStatus: 'idle',
          queuePosition: 0,
          queueKind: null,
          waitStartedAt: null,
          waitKind: null,
          runId: '',
          runStartedAt: null,
        })
      }

      for (const run of normalizedRuntimeRuns) {
        const slot = Number(run.slot) as CreateCharSlotId
        if (!CREATE_CHAR_SLOT_IDS.includes(slot)) continue
        const cur = useCreateCharStore.getState().slots[slot]
        // 槽已有更新任务时，旧现场不得覆盖。
        if (cur.runId && cur.runId !== run.runId && cur.draftEpoch > Number(run.epoch || 0)) continue
        const characterId = typeof run.characterId === 'string' ? run.characterId : ''
        const portraitCdnUrl = typeof run.portraitCdnUrl === 'string' ? run.portraitCdnUrl : ''
        const live = run.status === 'queued' || run.status === 'running'
        if (!live && run.status !== 'interrupted') continue
        const patch: Parameters<typeof patchSlot>[1] = {
          runId: live ? run.runId : '',
          draftEpoch: Number(run.epoch || cur.draftEpoch),
          queueStatus: run.status === 'queued' ? 'queued' : run.status === 'running' ? 'running' : 'idle',
          queuePosition: run.status === 'queued' ? Math.max(1, Number(run.queuePosition || 1)) : 0,
          queueKind: isCreateCharQueueKind(run.jobKind) ? run.jobKind : 'fullAuto',
          busy: live ? 'auto' : 'idle',
          waitKind: live ? 'publish' : null,
          runStartedAt: live
            ? typeof run.runStartedAt === 'number'
              ? run.runStartedAt
              : Date.now()
            : null,
          waitStartedAt: live
            ? typeof run.runStartedAt === 'number'
              ? run.runStartedAt
              : Date.now()
            : null,
        }
        if (run.payload && typeof run.payload === 'object') {
          patch.payloadText = JSON.stringify(run.payload, null, 2)
        }
        if (typeof run.portraitPrompt === 'string') patch.portraitPrompt = run.portraitPrompt
        if (characterId) {
          patch.createdCharacterId = characterId
          patch.portraitCharacterId = characterId
        }
        if (typeof run.portraitJobId === 'string') patch.portraitJobId = run.portraitJobId
        if (typeof run.coverAssetId === 'string') patch.motionInputAssetId = run.coverAssetId
        if (typeof run.videoAssetId === 'string') patch.motionOutputAssetId = run.videoAssetId
        if (typeof run.videoCdnUrl === 'string') patch.motionPreviewUrl = run.videoCdnUrl
        if (typeof run.listingId === 'string') patch.listingId = run.listingId
        if (typeof run.motionPrompt === 'string') patch.motionPrompt = run.motionPrompt
        if (portraitCdnUrl && characterId) {
          if (!cur.portraitCacheUrl) patch.portraitUrl = portraitCdnUrl
          patch.portraitCdnUrl = portraitCdnUrl
        }
        patchSlot(slot, patch)
        if (run.status === 'interrupted') {
          const latest = useCreateCharStore.getState().slots[slot]
          const text = characterId
            ? '上次 App 进程中断，已恢复角色现场；将从站内资产继续拉取，不会重新创建角色'
            : '上次 App 进程中断，已恢复参数；参考图若缺失请重新粘贴'
          if (!latest.stepLog.some((entry) => entry.text === text)) pushStepUnique(slot, 'err', text)
        }
      }

      // 当前槽若仍无参考图，再按需拉一次（兼容旧库只存了部分槽）。
      const active = useCreateCharStore.getState().activeSlot
      const activeDraft = useCreateCharStore.getState().slots[active]
      if (!activeDraft.imageBase64) {
        const loaded = await window.lovemi?.createCharStateLoadImage?.(active)
        if (!cancelled && loaded?.ok && loaded.imageBase64) {
          patchSlot(active, {
            imageBase64: loaded.imageBase64,
            mimeType: loaded.mimeType || activeDraft.mimeType,
            previewUrl: URL.createObjectURL(
              new Blob(
                [Uint8Array.from(atob(loaded.imageBase64), (c) => c.charCodeAt(0))],
                { type: loaded.mimeType || 'image/png' },
              ),
            ),
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [patchSlot, pushStepUnique])

  const beginSlotRun = useCallback(
    (slotId: CreateCharSlotId, clearCharacter: boolean) => {
      const previous = useCreateCharStore.getState().slots[slotId]
      if (previous.runId && previous.queueStatus !== 'idle') {
        void window.lovemi?.createCharCancelJob?.({ runId: previous.runId })
      }
      const epoch = bumpSlotEpoch(slotId)
      slotRunEpoch.current[slotId] = epoch
      patchSlot(slotId, {
        draftEpoch: epoch,
        portraitUrl: null,
        portraitCdnUrl: null,
        portraitCharacterId: '',
        queueStatus: 'idle',
        queuePosition: 0,
        queueKind: null,
        runId: '',
        runStartedAt: null,
        ...(clearCharacter
          ? {
              createdCharacterId: '',
              portraitJobId: '',
              motionJobId: '',
              motionPreviewUrl: null,
              motionInputAssetId: '',
              motionOutputAssetId: '',
              listingId: '',
            }
          : {}),
      })
      return epoch
    },
    [bumpSlotEpoch, patchSlot],
  )

  const applyPortraitUpdate = useCallback(
    (
      slotId: CreateCharSlotId,
      characterId: string,
      partial: {
        portraitUrl: string
        portraitCdnUrl: string
        portraitCacheUrl?: string
        motionInputAssetId?: string
      },
      expectedEpoch?: number,
    ): boolean => {
      const st = useCreateCharStore.getState().slots[slotId]
      if (!slotAcceptsPortrait(st, characterId)) return false
      if (expectedEpoch != null && st.draftEpoch !== expectedEpoch) return false
      patchSlot(slotId, {
        ...partial,
        portraitCharacterId: characterId,
      })
      return true
    },
    [patchSlot],
  )

  const showPortraitUrl = portraitMatchesSlot(draft) ? portraitUrl : null

  const anySlotWaiting = Boolean(
    CREATE_CHAR_SLOT_IDS.some((id) => slots[id].waitStartedAt || slots[id].queueStatus !== 'idle'),
  )
  const fullAutoQueueBusy = CREATE_CHAR_SLOT_IDS.some(
    (id) => slots[id].queueStatus !== 'idle',
  )
  useEffect(() => {
    if (!active || !anySlotWaiting) return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [active, anySlotWaiting])

  const slotElapsedSec = useCallback(
    (slot: CreateCharSlotDraft) => {
      if (slot.waitStartedAt == null) return 0
      return Math.max(0, Math.floor((nowMs - slot.waitStartedAt) / 1000))
    },
    [nowMs],
  )
  const waitElapsedSec = waitStartedAt != null ? Math.max(0, Math.floor((nowMs - waitStartedAt) / 1000)) : 0

  const slotWaitMaxSec = (slot: CreateCharSlotDraft) =>
    slot.waitKind === 'publish' || slot.busy === 'auto' || slot.busy === 'publish'
      ? WAIT_MAX_PUBLISH_SEC
      : WAIT_MAX_PORTRAIT_OR_MOTION_SEC

  const characterDisplayName = useCallback((slot?: CreateCharSlotId) => {
    try {
      const st = useCreateCharStore.getState()
      const d = st.slots[slot ?? st.activeSlot]
      const obj = JSON.parse(d.payloadText || '{}') as Record<string, unknown>
      if (typeof obj.display_name === 'string' && obj.display_name.trim()) return obj.display_name.trim()
    } catch {
      /* ignore */
    }
    return '未命名'
  }, [])

  const ensurePlayableVideoUrl = useCallback(
    async (
      cdnOrUrl: string | null | undefined,
      slot?: CreateCharSlotId,
      expectedAssetId?: string,
      expectedRunId?: string,
    ) => {
      const slotId = slot ?? useCreateCharStore.getState().activeSlot
      const write = (p: Parameters<typeof patchSlot>[1]) => patchSlot(slotId, p)
      const start = useCreateCharStore.getState().slots[slotId]
      if (expectedRunId && start.runId !== expectedRunId) return false
      if (!cdnOrUrl) return false
      if (cdnOrUrl.startsWith('lovemi-cache://') || cdnOrUrl.startsWith('blob:') || cdnOrUrl.startsWith('data:')) {
        write({ motionPreviewUrl: cdnOrUrl })
        return true
      }
      if (!cdnOrUrl.startsWith('http')) return false
      const cacheKey = `${slotId}:${start.createdCharacterId}:${expectedAssetId || ''}:${expectedRunId || start.runId}:${cdnOrUrl}`
      if (videoCacheTried.current.has(cacheKey)) {
        return useCreateCharStore.getState().slots[slotId].motionPreviewUrl?.startsWith('lovemi-cache://') === true
      }
      if (!window.lovemi?.createCharCacheMedia) {
        write({ motionPreviewUrl: cdnOrUrl })
        return false
      }
      videoCacheTried.current.add(cacheKey)
      const outbound = await resolveProxyUrl()
      if (!outbound.proxyUrl) {
        write({ motionPreviewUrl: cdnOrUrl })
        setToast(outbound.error || '无代理，视频可能无法播放')
        return false
      }
      setToast(`槽${slotId}：正在缓存视频…`)
      const name = characterDisplayName(slotId)
      const videoFileTag = `${name}_槽${slotId}_${start.createdCharacterId.slice(-10)}_a${(
        expectedAssetId ||
        start.motionOutputAssetId ||
        'unknown'
      ).slice(-8)}_r${(expectedRunId || start.runId || 'manual').slice(0, 8)}`
      const res = await window.lovemi.createCharCacheMedia({
        cdnUrl: cdnOrUrl,
        proxyUrl: outbound.proxyUrl,
        displayName: videoFileTag,
        kind: 'video',
        characterId: start.createdCharacterId || undefined,
        assetId: expectedAssetId || start.motionOutputAssetId || undefined,
        runId: expectedRunId || start.runId || undefined,
      })
      const current = useCreateCharStore.getState().slots[slotId]
      if (expectedRunId && current.runId !== expectedRunId) return false
      if (res.ok && res.cacheUrl) {
        write({ motionPreviewUrl: res.cacheUrl })
        const wantTwitter = useCreateCharStore.getState().autoDownloadWatermark !== false
        if (res.twitterPath) {
          pushStepUnique(slotId, 'ok', '视频已存推特资源（含水印）')
          setToast(`槽${slotId}：视频已存推特资源`)
          return true
        }
        pushStepUnique(slotId, 'ok', wantTwitter ? '视频预览已缓存' : '视频预览已缓存 · 未导出推特水印')
        setToast(
          wantTwitter
            ? `槽${slotId}：视频预览已就绪`
            : `槽${slotId}：视频预览已就绪（水印导出已关）`,
        )
        return !wantTwitter
      } else {
        write({ motionPreviewUrl: cdnOrUrl })
        setToast(res.error || '视频缓存失败，尝试直链播放')
        return false
      }
    },
    [patchSlot, setToast, characterDisplayName, pushStepUnique],
  )

  const ensurePortraitDownloaded = useCallback(
    async (
      cdnOrUrl: string | null | undefined,
      slot?: CreateCharSlotId,
      displayNameOverride?: string,
      expectedCharacterId?: string,
      expectedEpoch?: number,
      expectedAssetId?: string,
      expectedRunId?: string,
    ) => {
      const slotId = slot ?? useCreateCharStore.getState().activeSlot
      if (!cdnOrUrl?.startsWith('http')) return false
      if (portraitCdnDead.current.has(cdnOrUrl)) return false
      const st0 = useCreateCharStore.getState().slots[slotId]
      const charAtStart = (expectedCharacterId?.trim() || st0.createdCharacterId || '').trim()
      const epochAtStart = expectedEpoch ?? st0.draftEpoch
      if (!charAtStart || !slotAcceptsPortrait(st0, charAtStart)) return false
      if (st0.draftEpoch !== epochAtStart) return false
      if (expectedRunId && st0.runId !== expectedRunId) return false
      const cacheKey = `${slotId}:${epochAtStart}:${charAtStart}:${expectedAssetId || ''}:${expectedRunId || st0.runId}:${cdnOrUrl}`
      if (portraitSaveTried.current.has(cacheKey)) {
        return useCreateCharStore.getState().slots[slotId].portraitUrl?.startsWith('lovemi-cache://') === true
      }
      if (!window.lovemi?.createCharCacheMedia) return false
      const outbound = await resolveProxyUrl()
      if (!outbound.proxyUrl) {
        setToast(outbound.error || '无代理，立绘预览可能加载失败', 5000)
        return false
      }
      portraitSaveTried.current.add(cacheKey)
      const name = (displayNameOverride || characterDisplayName(slotId)).trim() || '未命名'
      const fileTag = `${name}_槽${slotId}_${charAtStart.slice(-10)}_a${(
        expectedAssetId ||
        st0.motionInputAssetId ||
        'unknown'
      ).slice(-8)}_r${(expectedRunId || st0.runId || `e${epochAtStart}`).slice(0, 8)}`
      try {
        const res = await window.lovemi.createCharCacheMedia({
          cdnUrl: cdnOrUrl,
          proxyUrl: outbound.proxyUrl,
          displayName: fileTag,
          kind: 'portrait',
          characterId: charAtStart,
          assetId: expectedAssetId || st0.motionInputAssetId || undefined,
          runId: expectedRunId || st0.runId || undefined,
        })
        const cur = useCreateCharStore.getState().slots[slotId]
        if (cur.draftEpoch !== epochAtStart) {
          portraitSaveTried.current.delete(cacheKey)
          return false
        }
        if (!slotAcceptsPortrait(cur, charAtStart)) {
          portraitSaveTried.current.delete(cacheKey)
          return false
        }
        if (expectedRunId && cur.runId !== expectedRunId) {
          portraitSaveTried.current.delete(cacheKey)
          return false
        }
        if (res.ok && res.cacheUrl) {
          const ok = applyPortraitUpdate(
            slotId,
            charAtStart,
            {
              portraitUrl: res.cacheUrl,
              portraitCdnUrl: cdnOrUrl,
              portraitCacheUrl: res.cacheUrl,
            },
            epochAtStart,
          )
          if (!ok) {
            portraitSaveTried.current.delete(cacheKey)
            return false
          }
          if (res.twitterPath) {
            pushStepUnique(slotId, 'ok', `立绘已存推特资源 · ${name}`)
            setToast(`槽${slotId}：立绘已存推特资源 · ${name}`)
            return true
          } else {
            const wantTwitter = useCreateCharStore.getState().autoDownloadWatermark !== false
            pushStepUnique(
              slotId,
              'ok',
              wantTwitter ? '立绘预览已缓存' : '立绘预览已缓存 · 未导出推特水印',
            )
            return !wantTwitter
          }
        }

        const errText = res.error || `槽${slotId}：立绘缓存失败`
        const permanent =
          /CDN HTTP (404|410|403)/i.test(errText) || /HTTP (404|410|403)/i.test(errText)
        if (permanent) {
          // 过期 CDN：标记死链，尝试从 Lovemi 拉新地址；不要 delete tried（否则 3s 轮询狂刷）
          portraitCdnDead.current.add(cdnOrUrl)
          if (!portraitDeadToastOnce.current.has(cdnOrUrl)) {
            portraitDeadToastOnce.current.add(cdnOrUrl)
            setToast(`槽${slotId}：立绘 CDN 已失效（${errText}），正在尝试重新拉取…`, 5000)
          }
          if (window.lovemi?.createCharRefreshPortrait) {
            try {
              const refreshed = await window.lovemi.createCharRefreshPortrait({
                characterId: charAtStart,
                proxyUrl: outbound.proxyUrl,
              })
              const fresh = refreshed.cdnUrl?.startsWith('http') ? refreshed.cdnUrl : ''
              if (refreshed.ok && fresh && fresh !== cdnOrUrl && !portraitCdnDead.current.has(fresh)) {
                applyPortraitUpdate(
                  slotId,
                  charAtStart,
                  { portraitUrl: fresh, portraitCdnUrl: fresh },
                  epochAtStart,
                )
                portraitSaveTried.current.delete(cacheKey)
                return ensurePortraitDownloaded(
                  fresh,
                  slotId,
                  displayNameOverride,
                  charAtStart,
                  epochAtStart,
                  expectedAssetId,
                  expectedRunId,
                )
              }
            } catch {
              /* ignore refresh errors */
            }
          }
          // 清掉死链，避免对比区一直裂图 / 轮询死磕
          const latest = useCreateCharStore.getState().slots[slotId]
          if (latest.portraitCdnUrl === cdnOrUrl || latest.portraitUrl === cdnOrUrl) {
            patchSlot(slotId, {
              portraitUrl: latest.portraitUrl === cdnOrUrl ? null : latest.portraitUrl,
              portraitCdnUrl: latest.portraitCdnUrl === cdnOrUrl ? null : latest.portraitCdnUrl,
            })
          }
          return false
        }

        // 临时失败（网络等）：允许稍后重试
        portraitSaveTried.current.delete(cacheKey)
        setToast(errText, 6000)
        return false
      } catch (err) {
        portraitSaveTried.current.delete(cacheKey)
        setToast(err instanceof Error ? err.message : '立绘缓存异常', 6000)
        return false
      }
    },
    [setToast, characterDisplayName, pushStepUnique, applyPortraitUpdate, patchSlot],
  )

  const waitMaxSec =
    waitKind === 'publish' || busy === 'auto' || busy === 'publish'
      ? WAIT_MAX_PUBLISH_SEC
      : WAIT_MAX_PORTRAIT_OR_MOTION_SEC

  /** 重新进入页面时：有角色 ID 但立绘对比区空了 → 从 Lovemi 拉回 CDN 预览 */
  useEffect(() => {
    if (!active) return
    if (hasActiveFullAutoQueue()) return
    if (!createdCharacterId) return
    if (portraitUrl?.startsWith('http') || portraitUrl?.startsWith('lovemi-cache://')) return
    const restoreKey = `${activeSlot}:${createdCharacterId}`
    if (portraitRestoreTried.current.has(restoreKey)) return
    if (!window.lovemi?.createCharRefreshPortrait) return
    portraitRestoreTried.current.add(restoreKey)
    const slotAtStart = activeSlot
    const charId = createdCharacterId
    let cancelled = false
    void (async () => {
      const outbound = await resolveProxyUrl()
      if (!outbound.proxyUrl || cancelled) return
      const res = await window.lovemi!.createCharRefreshPortrait!({
        characterId: charId,
        sessionToken: undefined, // 主进程用本机加密保存的管理员 Bearer
        proxyUrl: outbound.proxyUrl,
      })
      if (cancelled || !res.ok || !res.cdnUrl) {
        portraitRestoreTried.current.delete(restoreKey)
        return
      }
      const cur = useCreateCharStore.getState().slots[slotAtStart]
      if (cur.createdCharacterId !== charId || !slotAcceptsPortrait(cur, charId)) return
      if (
        !applyPortraitUpdate(
          slotAtStart,
          charId,
          { portraitUrl: res.cdnUrl, portraitCdnUrl: res.cdnUrl },
          cur.draftEpoch,
        )
      ) {
        return
      }
      if (res.assetId && !cur.motionInputAssetId) {
        patchSlot(slotAtStart, { motionInputAssetId: res.assetId })
      }
      const name = (() => {
        try {
          const obj = JSON.parse(cur.payloadText || '{}') as Record<string, unknown>
          return typeof obj.display_name === 'string' ? obj.display_name : undefined
        } catch {
          return undefined
        }
      })()
      void ensurePortraitDownloaded(res.cdnUrl, slotAtStart, name, charId, cur.draftEpoch)
    })()
    return () => {
      cancelled = true
    }
  }, [
    active,
    activeSlot,
    createdCharacterId,
    portraitUrl,
    hasAdminToken,
    patchSlot,
    ensurePortraitDownloaded,
    applyPortraitUpdate,
  ])

  /** CDN 直链无法在渲染进程稳定显示 → 三槽各自经代理落到 lovemi-cache:// */
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      if (hasActiveFullAutoQueue()) return
      for (const slotId of CREATE_CHAR_SLOT_IDS) {
        const st = useCreateCharStore.getState().slots[slotId]
        const cdn =
          (st.portraitCdnUrl?.startsWith('http') && st.portraitCdnUrl) ||
          (st.portraitUrl?.startsWith('http') && st.portraitUrl) ||
          null
        if (!cdn) continue
        if (portraitCdnDead.current.has(cdn)) continue
        if (st.portraitUrl?.startsWith('lovemi-cache://') || st.portraitUrl?.startsWith('data:')) continue
        if (!st.createdCharacterId || !portraitMatchesSlot(st)) continue
        void ensurePortraitDownloaded(
          cdn,
          slotId,
          undefined,
          st.createdCharacterId,
          st.draftEpoch,
        )
      }
    }
    tick()
    const timer = window.setInterval(tick, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, ensurePortraitDownloaded])

  /** CDN 视频：三槽各自缓存 */
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      if (hasActiveFullAutoQueue()) return
      for (const slotId of CREATE_CHAR_SLOT_IDS) {
        const url = useCreateCharStore.getState().slots[slotId].motionPreviewUrl
        if (url?.startsWith('http')) void ensurePlayableVideoUrl(url, slotId)
      }
    }
    tick()
    const timer = window.setInterval(tick, 4000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, ensurePlayableVideoUrl])

  /** 等待立绘时三槽并行快刷（不只看当前激活槽） */
  useEffect(() => {
    if (!active) return
    if (!window.lovemi?.createCharRefreshPortrait) return
    let cancelled = false
    const inflight = new Set<CreateCharSlotId>()

    const tickSlot = async (slotId: CreateCharSlotId) => {
      if (cancelled || inflight.has(slotId)) return
      if (hasActiveFullAutoQueue()) return
      const st = useCreateCharStore.getState().slots[slotId]
      const charId = st.createdCharacterId
      if (!charId) return
      if (st.portraitUrl?.startsWith('http') || st.portraitUrl?.startsWith('lovemi-cache://')) return
      if (st.busy !== 'create' && st.busy !== 'auto' && st.busy !== 'portrait') return
      inflight.add(slotId)
      try {
        const outbound = await resolveProxyUrl()
        if (!outbound.proxyUrl || cancelled) return
        const res = await window.lovemi!.createCharRefreshPortrait!({
          characterId: charId,
          sessionToken: undefined, // 主进程用本机加密保存的管理员 Bearer
          proxyUrl: outbound.proxyUrl,
        })
        if (cancelled || !res.ok || !res.cdnUrl) return
        const cur = useCreateCharStore.getState().slots[slotId]
        if (cur.createdCharacterId !== charId || !slotAcceptsPortrait(cur, charId)) return
        if (
          !applyPortraitUpdate(
            slotId,
            charId,
            { portraitUrl: res.cdnUrl, portraitCdnUrl: res.cdnUrl },
            cur.draftEpoch,
          )
        ) {
          return
        }
        if (res.assetId && !cur.motionInputAssetId) {
          patchSlot(slotId, { motionInputAssetId: res.assetId })
        }
        pushStep(slotId, 'ok', '立绘已拉回（站内同步）')
        void ensurePortraitDownloaded(res.cdnUrl, slotId, undefined, charId, cur.draftEpoch)
      } finally {
        inflight.delete(slotId)
      }
    }

    const timer = window.setInterval(() => {
      for (const slotId of CREATE_CHAR_SLOT_IDS) void tickSlot(slotId)
    }, 2500)
    for (const slotId of CREATE_CHAR_SLOT_IDS) void tickSlot(slotId)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, hasAdminToken, patchSlot, ensurePortraitDownloaded, pushStep, applyPortraitUpdate])

  useEffect(() => {
    if (!pageRef.current) return
    runEmailPageEnter(pageRef.current)
  }, [])

  useEffect(() => {
    void (async () => {
      const cfg = await window.lovemi?.createCharConfig?.()
      if (!cfg) return
      patch({
        teamoBase: cfg.teamoApiBase || 'https://api.teamorouter.com/v1',
        teamoModel: cfg.teamoModel || 'gpt-5.4-mini',
        hasApiKey: cfg.hasApiKey,
        hasAdminToken: cfg.hasAdminToken,
        downloadsDir: cfg.downloadsDir || '',
        autoDownloadWatermark: cfg.autoDownloadWatermark !== false,
      })
    })()
  }, [patch])

  const ingestBlob = useCallback(
    async (blob: Blob) => {
      // 只接受图片；绝不把剪贴板文字写进参数 JSON
      if (!blob.type.startsWith('image/')) {
        setToast('请粘贴图片（不是文字）')
        return
      }
      const optimized = await optimizeReferenceImage(blob)
      const { base64, mime } = await fileToBase64(optimized)
      const st = useCreateCharStore.getState()
      const slotId = st.activeSlot
      const old = st.slots[slotId]
      if (old.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(old.previewUrl)
      // 新参考图 = 新一轮创作：清空该槽旧立绘/JSON/视频/角色 ID，避免串台乱套
      for (const key of [...portraitRestoreTried.current]) {
        if (key.startsWith(`${slotId}:`)) portraitRestoreTried.current.delete(key)
      }
      for (const key of [...portraitSaveTried.current]) {
        if (key.startsWith(`${slotId}:`)) portraitSaveTried.current.delete(key)
      }
      for (const key of [...videoCacheTried.current]) {
        if (key.startsWith(`${slotId}:`)) videoCacheTried.current.delete(key)
      }
      portraitDeadToastOnce.current.clear()
      const epoch = beginSlotRun(slotId, true)
      patchSlot(slotId, {
        imageBase64: base64,
        mimeType: mime,
        previewUrl: URL.createObjectURL(optimized),
        payloadText: '',
        portraitPrompt: '',
        userHint: old.userHint,
        busy: 'idle',
        waitStartedAt: null,
        waitKind: null,
        stepLog: [],
        lastResult: '',
        publishResult: '',
        draftEpoch: epoch,
      })
      pushStep(slotId, 'run', '已粘贴新参考图 · 旧任务/立绘已作废')
      setToast(`槽${slotId}：新参考图已就绪 · 此前进行中的生图结果将被忽略`)
    },
    [setToast, patchSlot, pushStep, beginSlotRun],
  )

  useEffect(() => {
    if (!active) return
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items?.length) return
      for (const it of Array.from(items)) {
        if (it.type.startsWith('image/')) {
          // 有图就只处理图，阻止文字进 textarea
          e.preventDefault()
          e.stopPropagation()
          const file = it.getAsFile()
          if (file) void ingestBlob(file)
          return
        }
      }
    }
    window.addEventListener('paste', onPaste, true)
    return () => window.removeEventListener('paste', onPaste, true)
  }, [ingestBlob, active])

  useEffect(() => {
    if (!window.lovemi?.onCreateCharProgress) return
    return window.lovemi.onCreateCharProgress((p) => {
      const slotId = resolveProgressSlot(p)
      if (slotId == null) return
      const cur = useCreateCharStore.getState().slots[slotId]
      if (p.clientRunEpoch != null && cur.draftEpoch !== p.clientRunEpoch) return
      if (p.runId && cur.runId && cur.runId !== p.runId) return
      if (p.stage === 'queued') {
        patchSlot(slotId, {
          queueStatus: 'queued',
          queuePosition: Math.max(1, Number(p.queuePosition || 1)),
          queueKind: isCreateCharQueueKind(p.jobKind) ? p.jobKind : cur.queueKind,
          waitStartedAt: null,
          runStartedAt: null,
        })
        return
      }
      if (p.stage === 'running') {
        const startedAt = p.runStartedAt || Date.now()
        patchSlot(slotId, {
          queueStatus: 'running',
          queuePosition: 0,
          queueKind: isCreateCharQueueKind(p.jobKind) ? p.jobKind : cur.queueKind,
          waitStartedAt: startedAt,
          runStartedAt: startedAt,
        })
        const label = isCreateCharQueueKind(p.jobKind) ? QUEUE_KIND_LABELS[p.jobKind] : '角色任务'
        pushStepUnique(slotId, 'run', `已出队 · 开始独占执行「${label}」`)
        return
      }
      if (p.stage === 'cancelled') {
        patchSlot(slotId, {
          queueStatus: 'idle',
          queuePosition: 0,
          queueKind: null,
          busy: 'idle',
          waitStartedAt: null,
          waitKind: null,
        })
        return
      }
      if (p.stage === 'failed') {
        const failMsg = typeof (p as { error?: unknown }).error === 'string' ? (p as { error?: string }).error : ''
        patchSlot(slotId, {
          queueStatus: 'idle',
          queuePosition: 0,
          queueKind: null,
          busy: 'idle',
          waitStartedAt: null,
          waitKind: null,
        })
        if (failMsg) pushStepUnique(slotId, 'err', `队列任务失败 · ${failMsg}`)
        return
      }
      const charId = p.characterId?.trim()
      const runEpoch = p.clientRunEpoch ?? cur.draftEpoch

      const next: Parameters<typeof patchSlot>[1] = {}
      if (p.payload) next.payloadText = JSON.stringify(p.payload, null, 2)
      if (p.portraitPrompt) next.portraitPrompt = p.portraitPrompt
      if (
        p.characterId &&
        (!cur.createdCharacterId || cur.createdCharacterId === charId)
      ) {
        next.createdCharacterId = p.characterId
      }
      if (p.portraitJobId) next.portraitJobId = p.portraitJobId
      if (p.motionPrompt) next.motionPrompt = p.motionPrompt
      if (p.videoAssetId) next.motionOutputAssetId = p.videoAssetId
      if (p.videoCdnUrl) next.motionPreviewUrl = p.videoCdnUrl
      if (p.listingId) next.listingId = p.listingId
      if (
        p.coverAssetId &&
        charId &&
        (cur.createdCharacterId === charId || p.characterId === charId || !cur.createdCharacterId)
      ) {
        next.motionInputAssetId = p.coverAssetId
      }
      if (Object.keys(next).length) patchSlot(slotId, next)

      if (p.portraitCdnUrl && charId) {
        const st = useCreateCharStore.getState().slots[slotId]
        if (slotAcceptsPortrait(st, charId)) {
          applyPortraitUpdate(
            slotId,
            charId,
            { portraitUrl: p.portraitCdnUrl, portraitCdnUrl: p.portraitCdnUrl },
            runEpoch,
          )
        }
      }

      // 全自动素材只在最终结果完成后统一下载并等待结果；避免 progress 与最终回调重复抓取。

      if (p.stage === 'portrait' && p.portraitCdnUrl) {
        pushStepUnique(slotId, 'ok', `立绘已完成 · 继续生成视频`)
        setToast(`槽${slotId}：立绘已拉回 · 继续生成视频…`)
      } else if (p.stage === 'analyzed') {
        pushStepUnique(slotId, 'ok', `分析已完成 · ${String(p.payload?.display_name || '角色')}`)
        setToast(`槽${slotId}：参数已生成 · ${String(p.payload?.display_name || '')}`)
      } else if (p.stage === 'video') {
        pushStepUnique(slotId, 'run', '开始生成动态视频…')
        setToast(`槽${slotId}：开始生成动态视频…`)
      } else if (p.stage === 'create' && p.characterId) {
        pushStepUnique(slotId, 'ok', `角色已创建 · ${p.characterId.slice(0, 18)}… · 等待立绘`)
        setToast(`槽${slotId}：角色已创建 · 等待立绘…`)
      } else if (p.stage === 'published') {
        pushStepUnique(slotId, 'ok', `发布已完成${p.listingId ? ` · ${p.listingId}` : ''}`)
      } else if (p.stage === 'video_failed') {
        pushStepUnique(slotId, 'err', '视频/发布阶段失败（见下方结果）')
      }
    })
  }, [
    patchSlot,
    setToast,
    ensurePlayableVideoUrl,
    ensurePortraitDownloaded,
    pushStepUnique,
    applyPortraitUpdate,
  ])

  const saveRelay = async () => {
    const savePatch: {
      teamoApiBase: string
      teamoModel: string
      teamoApiKey?: string
      adminSessionToken?: string
      downloadsDir?: string
      autoDownloadWatermark?: boolean
    } = {
      teamoApiBase: teamoBase.trim(),
      teamoModel: teamoModel.trim() || 'gpt-5.4-mini',
      autoDownloadWatermark,
    }
    if (teamoKeyInput.trim()) savePatch.teamoApiKey = teamoKeyInput.trim()
    if (adminTokenInput.trim()) savePatch.adminSessionToken = adminTokenInput.trim()
    if (downloadsDir.trim()) savePatch.downloadsDir = downloadsDir.trim()
    const cfg = await window.lovemi?.createCharSaveConfig?.(savePatch)
    if (cfg) {
      patch({
        hasApiKey: cfg.hasApiKey,
        hasAdminToken: cfg.hasAdminToken,
        downloadsDir: cfg.downloadsDir || '',
        autoDownloadWatermark: cfg.autoDownloadWatermark !== false,
        teamoKeyInput: '',
        adminTokenInput: '',
      })
      setToast(
        cfg.hasAdminToken
          ? '配置已保存（管理员 Bearer 已加密写入本机）'
          : '中转站已保存 · 请再填写管理员 Bearer',
      )
    }
  }

  const pickDownloadsDir = async () => {
    const res = await window.lovemi?.createCharPickDownloadsDir?.()
    if (!res) {
      setToast('请在 Electron 桌面窗口操作')
      return
    }
    if (!res.ok) return
    patch({ downloadsDir: res.downloadsDir || '' })
    setToast(`推特资源将保存到：${res.downloadsDir}/推特资源`)
  }

  const onAnalyze = async () => {
    if (!imageBase64) {
      setToast('先 Ctrl+V 粘贴参考图')
      return
    }
    if (!window.lovemi?.createCharAnalyze) {
      setToast('请在 Electron 桌面窗口操作（IPC 未就绪）')
      return
    }
    const slot = activeSlot
    const img = imageBase64
    const mime = mimeType
    const hint = userHint.trim() || undefined
    const preflightEpoch = draftEpoch
    await saveRelay()
    const outbound = await resolveProxyUrl()
    if (!outbound.proxyUrl) {
      setToast(outbound.error || '无代理')
      return
    }
    const beforeStart = useCreateCharStore.getState().slots[slot]
    if (beforeStart.draftEpoch !== preflightEpoch || beforeStart.imageBase64 !== img) {
      setToast(`槽${slot}：准备期间参考图已更换，本次分析已取消`)
      return
    }
    const analyzeEpoch = beginSlotRun(slot, true)
    patchSlot(slot, { busy: 'analyze', lastResult: '', payloadText: '' })
    pushStep(slot, 'run', '开始分析参考图…')
    try {
      const res = await window.lovemi.createCharAnalyze({
        imageBase64: img,
        mimeType: mime,
        proxyUrl: outbound.proxyUrl,
        userHint: hint,
      })
      if (useCreateCharStore.getState().slots[slot].draftEpoch !== analyzeEpoch) return
      if (!res.ok || !res.payload || !Object.keys(res.payload).length) {
        const detail = res.error || '分析失败'
        pushStep(slot, 'err', `分析失败 · ${detail}`)
        setToast(`槽${slot}：${detail}`)
        patchSlot(slot, {
          lastResult: [detail, res.rawPreview].filter(Boolean).join('\n\n'),
          payloadText: '',
        })
        return
      }
      const text = JSON.stringify(res.payload, null, 2)
      patchSlot(slot, {
        payloadText: text,
        portraitPrompt: res.portraitPrompt || '',
        lastResult: `OK · ${String(res.payload.display_name || '')}`,
      })
      pushStep(slot, 'ok', `分析已完成 · ${String(res.payload.display_name || '角色')}`)
      setToast(`槽${slot}：参数已生成（${res.model || 'model'}）`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      pushStep(slot, 'err', `分析异常 · ${msg}`)
      setToast(`槽${slot}：分析异常：${msg}`)
      patchSlot(slot, { lastResult: msg })
    } finally {
      if (useCreateCharStore.getState().slots[slot].draftEpoch === analyzeEpoch) {
        patchSlot(slot, { busy: 'idle' })
      }
    }
  }

  const onCreate = async () => {
    if (!window.lovemi?.createCharEnqueueJob) {
      setToast('请在 Electron 桌面窗口操作')
      return
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(payloadText) as Record<string, unknown>
    } catch {
      setToast('参数 JSON 无效')
      return
    }
    const slot = activeSlot
    const want = wantPortrait
    const preflightEpoch = draftEpoch
    const payloadAtStart = payloadText
    await saveRelay()
    const outbound = await resolveProxyUrl()
    if (!outbound.proxyUrl) {
      setToast(outbound.error || '无代理')
      return
    }
    if (!hasAdminToken && !adminTokenInput.trim()) {
      setToast('请先填写并保存管理员 Bearer')
      return
    }
    const beforeStart = useCreateCharStore.getState().slots[slot]
    if (
      beforeStart.draftEpoch !== preflightEpoch ||
      beforeStart.payloadText !== payloadAtStart
    ) {
      setToast(`槽${slot}：准备期间草稿已更换，本次创建已取消`)
      return
    }
    const runEpoch = beginSlotRun(slot, true)
    const runId = crypto.randomUUID()
    patchSlot(slot, {
      busy: 'create',
      queueStatus: 'queued',
      queuePosition: 1,
      queueKind: 'create',
      runId,
      runStartedAt: null,
      waitStartedAt: null,
      waitKind: 'portrait',
    })
    pushStep(slot, 'run', '「创建到 Lovemi」已加入全局队列')
    try {
      const res = await window.lovemi!.createCharEnqueueJob({
        jobKind: 'create',
        clientRunId: runId,
        clientSlot: slot,
        clientRunEpoch: runEpoch,
        sessionToken: undefined, // 主进程用本机加密保存的管理员 Bearer
        proxyUrl: outbound.proxyUrl,
        body,
        waitPortrait: want,
      })
      const current = useCreateCharStore.getState().slots[slot]
      if (current.draftEpoch !== runEpoch || current.runId !== runId) return
      if (!res.ok) {
        setToast(`槽${slot}：${res.error || '创建失败'}`)
        patchSlot(slot, { lastResult: res.error || '创建失败' })
        return
      }
      const id = String(res.data?.id || res.data?.character_id || '')
      if (!id) {
        setToast(`槽${slot}：已创建但无 character id`)
        patchSlot(slot, { lastResult: formatCompactResult(res) })
        return
      }
      // 仅当前 epoch 可绑定角色 ID；旧创建结果不得写入新草稿。
      patchSlot(slot, {
        createdCharacterId: id,
        lastResult: formatCompactResult({ characterOk: true, id, waitingPortrait: want }),
      })
      pushStep(slot, 'ok', `角色已创建 · ${id.slice(0, 18)}…`)
      setToast(`槽${slot}：角色已创建${want ? ' · 立绘流程已完成' : ''}`)

      const portrait = res.portrait

      const next: {
        lastResult: string
        portraitJobId?: string
        motionInputAssetId?: string
      } = { lastResult: '' }
      if (portrait?.jobId) next.portraitJobId = portrait.jobId
      const cdn = portrait?.cdnUrl
      if (portrait?.assetId) next.motionInputAssetId = portrait.assetId
      const portraitOk = Boolean(cdn || portrait?.imageDataUrl)
      if (want && portraitOk) {
        pushStep(slot, 'ok', '立绘已完成')
        setToast(`槽${slot}：角色+立绘都成功`)
      }
      next.lastResult = formatCompactResult({
        characterOk: true,
        id,
        portraitOk,
        portrait: {
          cdnUrl: portrait?.cdnUrl,
          jobId: portrait?.jobId,
          assetId: portrait?.assetId,
        },
      })
      const curAfter = useCreateCharStore.getState().slots[slot]
      if (curAfter.draftEpoch !== runEpoch) {
        pushStep(slot, 'err', '创建结果已作废（该槽已贴新图）')
        return
      }
      patchSlot(slot, { ...next, createdCharacterId: id })
      if (cdn) {
        applyPortraitUpdate(slot, id, { portraitUrl: cdn, portraitCdnUrl: cdn }, runEpoch)
        void ensurePortraitDownloaded(cdn, slot, undefined, id, runEpoch)
      } else if (portrait?.imageDataUrl) {
        applyPortraitUpdate(
          slot,
          id,
          { portraitUrl: portrait.imageDataUrl, portraitCdnUrl: cdn || '' },
          runEpoch,
        )
      }
    } finally {
      const current = useCreateCharStore.getState().slots[slot]
      if (current.draftEpoch === runEpoch && current.runId === runId) {
        patchSlot(slot, {
          busy: 'idle',
          queueStatus: 'idle',
          queuePosition: 0,
          queueKind: null,
          runId: '',
          runStartedAt: null,
          waitStartedAt: null,
          waitKind: null,
        })
      }
    }
  }

  const onRestartPortrait = async () => {
    if (!createdCharacterId) {
      setToast('先创建角色')
      return
    }
    if (!window.lovemi?.createCharWaitPortrait) {
      setToast('请在 Electron 桌面窗口操作')
      return
    }
    const slot = activeSlot
    const charId = createdCharacterId
    const epochAtStart = draftEpoch
    await saveRelay()
    const outbound = await resolveProxyUrl()
    if (!outbound.proxyUrl) {
      setToast(outbound.error || '无代理')
      return
    }
    patchSlot(slot, {
      busy: 'portrait',
      waitStartedAt: Date.now(),
      waitKind: 'portrait',
      portraitUrl: null,
      portraitCdnUrl: null,
      portraitCharacterId: '',
    })
    pushStep(slot, 'run', '重新触发 Lovemi 生图…')
    try {
      const waited = await window.lovemi.createCharWaitPortrait({
        characterId: charId,
        sessionToken: undefined, // 主进程用本机加密保存的管理员 Bearer
        proxyUrl: outbound.proxyUrl,
        forceRestart: true,
      })
      const epoch = useCreateCharStore.getState().slots[slot].draftEpoch
      if (epoch !== epochAtStart) {
        pushStep(slot, 'err', '重新生图结果已作废（该槽已贴新图）')
        return
      }
      const next: Parameters<typeof patchSlot>[1] = {
        lastResult: formatCompactResult({ portrait: waited }),
      }
      if (waited.jobId) next.portraitJobId = waited.jobId
      if (waited.assetId) next.motionInputAssetId = waited.assetId
      patchSlot(slot, next)
      if (waited.ok && waited.cdnUrl) {
        applyPortraitUpdate(
          slot,
          charId,
          { portraitUrl: waited.cdnUrl, portraitCdnUrl: waited.cdnUrl },
          epoch,
        )
        pushStep(slot, 'ok', '立绘已重新生成')
        setToast(`槽${slot}：立绘已就绪`)
        void ensurePortraitDownloaded(waited.cdnUrl, slot, undefined, charId, epoch)
      } else {
        pushStep(slot, 'err', `重新生图失败 · ${waited.error || '超时'}`)
        setToast(`槽${slot}：${waited.error || '重新生图失败'}`, 12000)
      }
    } finally {
      patchSlot(slot, { busy: 'idle', waitStartedAt: null, waitKind: null })
    }
  }

  /** 手动：Teamo 提示词 → companion 生视频（不发布） */
  const onGenerateMotionOnly = async () => {
    if (!createdCharacterId) {
      setToast('先创建角色（需要 chr_）')
      return
    }
    if (!window.lovemi?.createCharEnqueueJob) {
      setToast('请在 Electron 桌面窗口操作')
      return
    }
    const slot = activeSlot
    const preflight = useCreateCharStore.getState().slots[slot]
    const preflightEpoch = preflight.draftEpoch
    const preflightImage = preflight.imageBase64
    await saveRelay()
    const outbound = await resolveProxyUrl()
    if (!outbound.proxyUrl) {
      setToast(outbound.error || '无代理')
      return
    }
    if (!slotStillMatches(slot, preflight.draftEpoch, preflight.createdCharacterId)) {
      setToast(`槽${slot}：准备期间角色已变更，本次视频任务已取消`)
      return
    }
    const currentBeforeQueue = useCreateCharStore.getState().slots[slot]
    if (
      currentBeforeQueue.draftEpoch !== preflightEpoch ||
      currentBeforeQueue.imageBase64 !== preflightImage ||
      !currentBeforeQueue.imageBase64
    ) {
      setToast(`槽${slot}：准备期间参考图已更换，请重新点生成视频`)
      return
    }
    const snap = { ...currentBeforeQueue }
    let payload: Record<string, unknown> | undefined
    try {
      payload = JSON.parse(snap.payloadText || '{}') as Record<string, unknown>
    } catch {
      payload = undefined
    }
    const runId = crypto.randomUUID()
    patchSlot(slot, {
      busy: 'motion',
      queueStatus: 'queued',
      queuePosition: 1,
      queueKind: 'motion',
      runId,
      runStartedAt: null,
      waitStartedAt: null,
      waitKind: 'motion',
      motionPreviewUrl: null,
    })
    pushStep(slot, 'run', '「生成动态视频」已加入全局队列')
    try {
      const res = await window.lovemi.createCharEnqueueJob({
        jobKind: 'motion',
        clientRunId: runId,
        clientSlot: slot,
        clientRunEpoch: snap.draftEpoch,
        characterId: snap.createdCharacterId,
        sessionToken: undefined, // 主进程用本机加密保存的管理员 Bearer
        proxyUrl: outbound.proxyUrl,
        portraitCdnUrl: snap.portraitUrl?.startsWith('http') ? snap.portraitUrl : undefined,
        imageBase64: snap.imageBase64 || undefined,
        mimeType: snap.mimeType,
        coverAssetId: snap.motionInputAssetId || undefined,
        characterHint: snap.userHint.trim() || String(payload?.display_name || ''),
        appearanceHint: Array.isArray(payload?.appearance_tags)
          ? payload!.appearance_tags.map(String).slice(0, 12).join('；')
          : '',
      })
      const current = useCreateCharStore.getState().slots[slot]
      if (!slotStillMatches(slot, snap.draftEpoch, snap.createdCharacterId) || current.runId !== runId) return
      const upd: Parameters<typeof patchSlot>[1] = {
        lastResult: formatCompactResult(res),
      }
      if (res.motionPrompt) upd.motionPrompt = res.motionPrompt
      if (res.coverAssetId) upd.motionInputAssetId = res.coverAssetId
      if (res.videoAssetId) upd.motionOutputAssetId = res.videoAssetId
      patchSlot(slot, upd)
      if (res.cdnUrl) void ensurePlayableVideoUrl(res.cdnUrl, slot)
      if (!res.ok) {
        pushStep(slot, 'err', `动态视频失败 · ${res.error || ''}`)
        setToast(`槽${slot}：${res.error || '动态视频生成失败'}`)
        return
      }
      pushStep(slot, 'ok', `动态视频已完成${res.videoAssetId ? ` · ${res.videoAssetId}` : ''}`)
      setToast(`槽${slot}：视频已生成 · 预览后点「确认该视频发布」`)
    } finally {
      const current = useCreateCharStore.getState().slots[slot]
      if (slotStillMatches(slot, snap.draftEpoch, snap.createdCharacterId) && current.runId === runId) {
        patchSlot(slot, {
          busy: 'idle',
          queueStatus: 'idle',
          queuePosition: 0,
          queueKind: null,
          runId: '',
          runStartedAt: null,
          waitStartedAt: null,
          waitKind: null,
        })
      }
    }
  }

  const buildPublishMeta = () => {
    let title = '未命名角色'
    let description = ''
    try {
      const obj = JSON.parse(payloadText || '{}') as Record<string, unknown>
      if (typeof obj.display_name === 'string' && obj.display_name.trim()) {
        title = String(obj.display_name).trim()
        const age = typeof obj.age_statement === 'string' ? obj.age_statement.replace(/[^\d]/g, '') : ''
        if (age) title = `${title} · ${age}`
      }
      const profile = typeof obj.profile_text === 'string' ? obj.profile_text : ''
      const personality = Array.isArray(obj.personality_tags)
        ? (obj.personality_tags as unknown[]).map(String).join('；')
        : ''
      description = [profile, personality].filter(Boolean).join('\n') || userHint || title
    } catch {
      description = userHint || title
    }
    return { title, description }
  }

  const onSetPreview = async (alsoPublish: boolean) => {
    const slot = useCreateCharStore.getState().activeSlot
    const snap = useCreateCharStore.getState().slots[slot]
    if (!snap.createdCharacterId) {
      setToast(`槽${slot}：先创建角色`)
      return
    }
    const cover = snap.motionInputAssetId
    if (!cover) {
      setToast(`槽${slot}：缺少立绘 asset（请先「生成动态视频」拿到封面 asset）`)
      return
    }
    if (alsoPublish && !snap.motionOutputAssetId) {
      setToast(`槽${slot}：还没有动态视频，请先点「生成动态视频」`)
      return
    }
    const outbound = await resolveProxyUrl()
    if (!outbound.proxyUrl) {
      setToast(outbound.error || '无代理')
      return
    }
    if (!slotStillMatches(slot, snap.draftEpoch, snap.createdCharacterId)) {
      setToast(`槽${slot}：准备期间角色已变更，本次发布已取消`)
      return
    }
    if (!window.lovemi?.createCharSetPreviewPublish) {
      setToast('请在 Electron 桌面窗口操作')
      return
    }
    const { title, description } = buildPublishMeta()
    patchSlot(slot, {
      busy: 'publish',
      waitStartedAt: alsoPublish ? Date.now() : null,
      waitKind: alsoPublish ? 'publish' : null,
    })
    try {
      const res = await window.lovemi.createCharSetPreviewPublish({
        characterId: snap.createdCharacterId,
        sessionToken: undefined, // 主进程用本机加密保存的管理员 Bearer
        proxyUrl: outbound.proxyUrl,
        coverAssetId: cover,
        videoAssetId: snap.motionOutputAssetId || undefined,
        title,
        description,
        publish: alsoPublish,
        // 不传槽内残留 listingId，由主进程按本角色草稿解析，防串台
      })
      if (!slotStillMatches(slot, snap.draftEpoch, snap.createdCharacterId)) return
      patchSlot(slot, { listingId: res.listingId || '' })
      if (!res.ok) {
        pushStep(slot, 'err', `设预览/发布失败 · ${res.error || ''}`)
        setToast(`槽${slot}：${res.error || '设预览/发布失败'}`)
        patchSlot(slot, {
          publishResult: formatCompactResult(res),
          lastResult: formatCompactResult(res),
        })
        return
      }
      setToast(
        alsoPublish
          ? `槽${slot}：已确认视频并提交发布${res.listingId ? ` · ${res.listingId}` : ''}`
          : `槽${slot}：已写入发布草稿${res.listingId ? ` · ${res.listingId}` : ''}`,
      )
      pushStep(
        slot,
        'ok',
        alsoPublish
          ? `确认发布已完成${res.listingId ? ` · ${res.listingId}` : ''}`
          : `发布草稿已完成${res.listingId ? ` · ${res.listingId}` : ''}`,
      )
      patchSlot(slot, {
        publishResult: formatCompactResult(res),
        lastResult: formatCompactResult(res),
      })
    } finally {
      if (slotStillMatches(slot, snap.draftEpoch, snap.createdCharacterId)) {
        patchSlot(slot, { busy: 'idle', waitStartedAt: null, waitKind: null })
      }
    }
  }

  const onAutoVideoPublish = async () => {
    if (!createdCharacterId) {
      setToast('先创建角色')
      return
    }
    if (!window.lovemi?.createCharEnqueueJob) {
      setToast('请在 Electron 桌面窗口操作')
      return
    }
    const slot = activeSlot
    const snap = { ...useCreateCharStore.getState().slots[slot] }
    await saveRelay()
    const outbound = await resolveProxyUrl()
    if (!outbound.proxyUrl) {
      setToast(outbound.error || '无代理')
      return
    }
    if (!slotStillMatches(slot, snap.draftEpoch, snap.createdCharacterId)) {
      setToast(`槽${slot}：准备期间角色已变更，本次自动发布已取消`)
      return
    }
    let payload: Record<string, unknown> | undefined
    try {
      payload = JSON.parse(snap.payloadText || '{}') as Record<string, unknown>
    } catch {
      payload = undefined
    }
    const runId = crypto.randomUUID()
    patchSlot(slot, {
      busy: 'auto',
      queueStatus: 'queued',
      queuePosition: 1,
      queueKind: 'autoPublish',
      runId,
      runStartedAt: null,
      waitStartedAt: null,
      waitKind: 'publish',
    })
    pushStep(slot, 'run', '「生成视频并发布」已加入全局队列')
    try {
      const portraitCdn =
        (snap.portraitCdnUrl?.startsWith('http') && snap.portraitCdnUrl) ||
        (snap.portraitUrl?.startsWith('http') && snap.portraitUrl) ||
        undefined
      const rawOverride = snap.motionPrompt.trim()
      const motionPromptOverride =
        rawOverride && !/不能帮你|无法协助|我不能|拒[绝写]|未成年|近未成年|underage|as an ai|i can'?t|i cannot/i.test(rawOverride)
          ? rawOverride
          : undefined
      const res = await window.lovemi.createCharEnqueueJob({
        jobKind: 'autoPublish',
        clientRunId: runId,
        clientSlot: slot,
        clientRunEpoch: snap.draftEpoch,
        characterId: snap.createdCharacterId,
        sessionToken: undefined, // 主进程用本机加密保存的管理员 Bearer
        proxyUrl: outbound.proxyUrl,
        portraitCdnUrl: portraitCdn,
        // 不要把参考图当立绘喂给 Teamo；没有 CDN 时让主进程自己 resolve
        coverAssetId: snap.motionInputAssetId || undefined,
        characterHint: snap.userHint.trim() || String(payload?.display_name || ''),
        appearanceHint: Array.isArray(payload?.appearance_tags)
          ? payload!.appearance_tags.map(String).slice(0, 12).join('；')
          : '',
        payload,
        motionPromptOverride,
      })
      const current = useCreateCharStore.getState().slots[slot]
      if (!slotStillMatches(slot, snap.draftEpoch, snap.createdCharacterId) || current.runId !== runId) return
      const upd: Parameters<typeof patchSlot>[1] = {
        lastResult: formatCompactResult(res),
        publishResult: formatCompactResult(res),
      }
      if (res.motionPrompt) upd.motionPrompt = res.motionPrompt
      if (res.coverAssetId) upd.motionInputAssetId = res.coverAssetId
      if (res.videoAssetId) upd.motionOutputAssetId = res.videoAssetId
      if (res.listingId) upd.listingId = res.listingId
      patchSlot(slot, upd)
      if (res.cdnUrl) void ensurePlayableVideoUrl(res.cdnUrl, slot)
      if (!res.ok) {
        pushStep(slot, 'err', `自动视频/发布失败 · ${res.error || ''}`)
        setToast(
          `【槽${slot} 失败】${res.error || '自动视频发布失败'}。若站内已有视频，可点「拉回并发布」。`,
          14000,
        )
        return
      }
      const name = characterDisplayName(slot)
      pushStep(
        slot,
        'ok',
        `自动视频并发布已完成 · ${name}${res.listingId ? ` · ${res.listingId}` : ''}`,
      )
      setToast(
        `【槽${slot} 成功】${name} 视频已生成并提交发布${res.listingId ? ` · ${res.listingId}` : ''} · 预览已回填${
          useCreateCharStore.getState().autoDownloadWatermark !== false
            ? '，推特资源文件夹也会存一份'
            : '（水印导出已关）'
        }`,
        16000,
      )
    } finally {
      const current = useCreateCharStore.getState().slots[slot]
      if (slotStillMatches(slot, snap.draftEpoch, snap.createdCharacterId) && current.runId === runId) {
        patchSlot(slot, {
          busy: 'idle',
          queueStatus: 'idle',
          queuePosition: 0,
          queueKind: null,
          runId: '',
          runStartedAt: null,
          waitStartedAt: null,
          waitKind: null,
        })
      }
    }
  }

  const onStopOrUnlockSlot = async () => {
    const slot = activeSlot
    const cur = useCreateCharStore.getState().slots[slot]
    if (cur.runId) {
      await window.lovemi?.createCharCancelJob?.({ runId: cur.runId })
    }
    patchSlot(slot, {
      busy: 'idle',
      queueStatus: 'idle',
      queuePosition: 0,
      queueKind: null,
      waitStartedAt: null,
      waitKind: null,
      runId: '',
      runStartedAt: null,
    })
    pushStepUnique(slot, 'err', '已停止/解锁本槽 · 可重新加入全局队列（不会自动重跑）')
    setToast(`槽${slot}：已解锁，可重新加入队列`)
  }

  const onFullAutoPublish = async () => {
    if (!imageBase64) {
      setToast('先 Ctrl+V 粘贴参考图（闪退后若本槽无图，请重新粘贴一次）')
      return
    }
    if (!window.lovemi?.createCharEnqueueJob) {
      setToast('请在 Electron 桌面窗口操作')
      return
    }
    const slot = activeSlot
    const snap = { ...useCreateCharStore.getState().slots[slot] }
    await saveRelay()
    const outbound = await resolveProxyUrl()
    if (!outbound.proxyUrl) {
      setToast(outbound.error || '无代理')
      return
    }
    const st = useCreateCharStore.getState()
    if (!st.hasAdminToken && !st.adminTokenInput.trim()) {
      setToast('请先填写并保存管理员 Bearer')
      return
    }
    const runEpoch = beginSlotRun(slot, true)
    const runId = crypto.randomUUID()
    patchSlot(slot, {
      busy: 'auto',
      queueStatus: 'queued',
      queuePosition: 1,
      queueKind: 'fullAuto',
      runId,
      runStartedAt: null,
      waitStartedAt: null,
      waitKind: 'publish',
      lastResult: '',
      draftEpoch: runEpoch,
    })
    pushStep(slot, 'run', '已加入全自动队列 · 等待前序角色完成')
    const epochAtStart = runEpoch
    try {
      const res = await window.lovemi.createCharEnqueueJob({
        jobKind: 'fullAuto',
        imageBase64: snap.imageBase64!,
        mimeType: snap.mimeType,
        proxyUrl: outbound.proxyUrl,
        sessionToken: undefined, // 主进程用本机加密保存的管理员 Bearer
        userHint: snap.userHint.trim() || undefined,
        clientSlot: slot,
        clientRunEpoch: runEpoch,
        clientRunId: runId,
      })
      const upd: Parameters<typeof patchSlot>[1] = {
        lastResult: formatCompactResult(res),
        publishResult: formatCompactResult(res),
      }
      if (res.payload) upd.payloadText = JSON.stringify(res.payload, null, 2)
      if (res.portraitPrompt) upd.portraitPrompt = res.portraitPrompt
      if (res.characterId) upd.createdCharacterId = res.characterId
      if (res.portraitJobId) upd.portraitJobId = res.portraitJobId
      if (res.motionPrompt) upd.motionPrompt = res.motionPrompt
      if (res.coverAssetId) upd.motionInputAssetId = res.coverAssetId
      if (res.videoAssetId) upd.motionOutputAssetId = res.videoAssetId
      if (res.videoCdnUrl) upd.motionPreviewUrl = res.videoCdnUrl
      if (res.listingId) upd.listingId = res.listingId
      const curAfter = useCreateCharStore.getState().slots[slot]
      if (curAfter.draftEpoch !== epochAtStart || curAfter.runId !== runId) {
        pushStep(slot, 'err', '全自动结果已作废（该槽已贴新图）')
        setToast(`槽${slot}：任务期间已换新参考图，此结果已忽略`, 12000)
        return
      }
      patchSlot(slot, upd)
      let portraitSaved = false
      let videoSaved = false
      if (res.portraitCdnUrl && res.characterId) {
        applyPortraitUpdate(
          slot,
          res.characterId,
          { portraitUrl: res.portraitCdnUrl, portraitCdnUrl: res.portraitCdnUrl },
          epochAtStart,
        )
        portraitSaved = await ensurePortraitDownloaded(
          res.portraitCdnUrl,
          slot,
          undefined,
          res.characterId,
          epochAtStart,
          res.coverAssetId,
          runId,
        )
      }
      if (res.videoCdnUrl) {
        videoSaved = await ensurePlayableVideoUrl(res.videoCdnUrl, slot, res.videoAssetId, runId)
      }
      if (!res.ok) {
        if (res.cancelled) return
        if (res.characterId && !res.portraitCdnUrl) {
          pushStep(slot, 'run', `角色已在 · 生图未出，可点「重新生图」或稍后再试`)
        }
        pushStep(slot, 'err', `全自动失败 · ${res.error || ''}`)
        setToast(`【槽${slot} 全自动失败】${res.error || '全自动发布失败'}`, 14000)
        return
      }
      if (!portraitSaved || !videoSaved) {
        const missing = [!portraitSaved && '立绘下载', !videoSaved && '视频下载'].filter(Boolean).join('、')
        pushStep(slot, 'err', `全自动素材未完整落盘 · ${missing}`)
        setToast(`【槽${slot} 未完成】${missing}失败，未标记全自动成功`, 14000)
        patchSlot(slot, {
          lastResult: `${formatCompactResult(res)}\n\n素材落盘失败：${missing}`,
        })
        return
      }
      pushStep(
        slot,
        'ok',
        `全自动到发布已完成 · ${String(res.payload?.display_name || characterDisplayName(slot))}${res.listingId ? ` · ${res.listingId}` : ''}`,
      )
      setToast(
        `【槽${slot} 全自动成功】${String(res.payload?.display_name || characterDisplayName(slot))} · ${res.characterId || ''} · ${res.listingId || '已提交发布'}`,
        16000,
      )
    } finally {
      const current = useCreateCharStore.getState().slots[slot]
      if (current.draftEpoch === epochAtStart && current.runId === runId) {
        patchSlot(slot, {
          busy: 'idle',
          queueStatus: 'idle',
          queuePosition: 0,
          queueKind: null,
          runId: '',
          runStartedAt: null,
          waitStartedAt: null,
          waitKind: null,
        })
      }
    }
  }

  const onPullSiteVideoAndPublish = async () => {
    const slot = activeSlot
    const snap = useCreateCharStore.getState().slots[slot]
    if (!snap.createdCharacterId) {
      setToast(`槽${slot}：先有角色 ID`, 5000)
      return
    }
    if (!window.lovemi?.createCharEnqueueJob) {
      setToast('请在 Electron 桌面窗口操作', 5000)
      return
    }
    const outbound = await resolveProxyUrl()
    if (!outbound.proxyUrl) {
      setToast(outbound.error || '无代理', 5000)
      return
    }
    if (!slotStillMatches(slot, snap.draftEpoch, snap.createdCharacterId)) {
      setToast(`槽${slot}：准备期间角色已变更，本次拉回已取消`)
      return
    }
    const { title, description } = buildPublishMeta()
    const runId = crypto.randomUUID()
    pushStep(slot, 'run', '「拉回并发布」已加入全局队列')
    patchSlot(slot, {
      busy: 'publish',
      queueStatus: 'queued',
      queuePosition: 1,
      queueKind: 'pullPublish',
      runId,
      runStartedAt: null,
      waitStartedAt: null,
      waitKind: 'publish',
    })
    try {
      const result = await window.lovemi.createCharEnqueueJob({
        jobKind: 'pullPublish',
        clientRunId: runId,
        clientSlot: slot,
        clientRunEpoch: snap.draftEpoch,
        characterId: snap.createdCharacterId,
        sessionToken: undefined, // 主进程用本机加密保存的管理员 Bearer
        proxyUrl: outbound.proxyUrl,
        coverAssetId: snap.motionInputAssetId || undefined,
        title,
        description,
      })
      const current = useCreateCharStore.getState().slots[slot]
      if (!slotStillMatches(slot, snap.draftEpoch, snap.createdCharacterId) || current.runId !== runId) return
      patchSlot(slot, {
        motionInputAssetId: result.coverAssetId || snap.motionInputAssetId,
        motionOutputAssetId: result.videoAssetId || snap.motionOutputAssetId,
        motionPreviewUrl: result.cdnUrl || snap.motionPreviewUrl,
        listingId: result.listingId || '',
        lastResult: formatCompactResult(result),
        publishResult: formatCompactResult(result),
      })
      if (result.cdnUrl) void ensurePlayableVideoUrl(result.cdnUrl, slot)
      if (!result.ok) {
        pushStep(slot, 'err', `拉回/发布失败 · ${result.error || ''}`)
        setToast(`【槽${slot} 发布失败】${result.error || '请看步骤清单'}`, 14000)
        return
      }
      pushStep(
        slot,
        'ok',
        `拉回并发布已完成${result.listingId ? ` · ${result.listingId}` : ''}`,
      )
      setToast(
        `【槽${slot} 成功】已拉回站内视频并提交发布${result.listingId ? ` · ${result.listingId}` : ''}。请到站内刷新看是否已离开草稿。`,
        18000,
      )
    } finally {
      const current = useCreateCharStore.getState().slots[slot]
      if (slotStillMatches(slot, snap.draftEpoch, snap.createdCharacterId) && current.runId === runId) {
        patchSlot(slot, {
          busy: 'idle',
          queueStatus: 'idle',
          queuePosition: 0,
          queueKind: null,
          runId: '',
          runStartedAt: null,
          waitStartedAt: null,
          waitKind: null,
        })
      }
    }
  }

  return (
    <section className="email-page create-char-page" ref={pageRef}>
      <h1 className="page-title">创建角色</h1>
      <p className="page-desc">
        顶部切换 <strong>1 ~ 5</strong> 五槽排队（整条流水线严格串行，素材按角色校验）→{' '}
        <strong>Ctrl+V</strong> 粘贴参考图 → 分析 / 创建 / 视频 / 发布。图片/视频可点击放大。
      </p>

      <div className="settings-card" data-motion="card" style={{ marginBottom: 12 }}>
        <div className="settings-card-head">工作槽（可连续点击，严格排队运行）</div>
        <div
          className="toolbar"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(90px, max-content))',
            gap: 8,
            alignItems: 'center',
          }}
        >
          {CREATE_CHAR_SLOT_IDS.map((id) => {
            const s = slots[id]
            const selected = activeSlot === id
            const running = s.waitStartedAt != null || s.busy !== 'idle' || s.queueStatus !== 'idle'
            const elapsed = slotElapsedSec(s)
            return (
              <button
                key={id}
                type="button"
                className={selected ? 'btn primary' : 'btn ghost'}
                onClick={() => {
                  setLightbox(null)
                  setActiveSlot(id)
                }}
                title={
                  s.createdCharacterId
                    ? `${s.createdCharacterId}${running ? ` · ${formatClock(elapsed)}` : ''}`
                    : '空槽'
                }
                style={{ minWidth: running ? 120 : 88 }}
              >
                {slotLabel(s, id)}
                {running ? (
                  <span style={{ marginLeft: 6, fontVariantNumeric: 'tabular-nums', opacity: 0.9 }}>
                    {formatClock(elapsed)}
                  </span>
                ) : null}
              </button>
            )
          })}
          <span className="settings-hint" style={{ marginLeft: 4, gridColumn: '1 / -1' }}>
            当前槽 {activeSlot}
            {busy !== 'idle' ? ` · ${busy}` : ''}
            {createdCharacterId ? ` · ${createdCharacterId.slice(0, 14)}…` : ''}
          </span>
        </div>
        {anySlotWaiting ? (
          <div className="settings-hint" style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {CREATE_CHAR_SLOT_IDS.map((id) => {
              const s = slots[id]
              if (s.waitStartedAt == null && s.queueStatus === 'idle') return null
              return (
                <span
                  key={`wait-${id}`}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 999,
                    border: '1px solid var(--line)',
                    background: id === activeSlot ? 'rgba(228, 90, 154, 0.12)' : 'transparent',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  槽{id}{' '}
                  {s.queueStatus === 'queued'
                    ? `${s.queueKind ? QUEUE_KIND_LABELS[s.queueKind] : '任务'} · 排队第 ${s.queuePosition || 1} 位`
                    : s.queueKind
                      ? QUEUE_KIND_LABELS[s.queueKind]
                    : s.waitKind === 'publish' || s.busy === 'auto'
                    ? '到发布'
                    : s.waitKind === 'motion' || s.busy === 'motion'
                      ? '视频'
                      : '立绘'}{' '}
                  {s.queueStatus === 'queued'
                    ? ''
                    : `${formatClock(slotElapsedSec(s))}/${formatClock(slotWaitMaxSec(s))}`}
                </span>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="settings-card create-char-step-card" data-motion="card" style={{ marginBottom: 12 }}>
        <div className="settings-card-head" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <span>步骤完成（槽{activeSlot} · 长显）</span>
          <button
            type="button"
            className="btn ghost"
            style={{ fontSize: 12, padding: '2px 10px' }}
            onClick={() => clearStepLog(activeSlot)}
            disabled={!stepLog.length}
          >
            清空本槽记录
          </button>
        </div>
        {stepLog.length ? (
          <ul className="create-char-step-log">
            {[...stepLog].reverse().map((s) => (
              <li key={s.id} className={`create-char-step create-char-step-${s.kind}`}>
                <span className="create-char-step-mark">
                  {s.kind === 'ok' ? '✓ 已完成' : s.kind === 'err' ? '✕ 失败' : '… 进行中'}
                </span>
                <span className="create-char-step-text">{s.text}</span>
                <span className="create-char-step-time">
                  {new Date(s.at).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="settings-hint">跑分析 / 创建 / 视频 / 发布后，这里会用绿色长显每一步「已完成」。</div>
        )}
        <div className="settings-hint" style={{ marginTop: 8 }}>
          其它槽最近一步：{' '}
          {CREATE_CHAR_SLOT_IDS.map((id) => {
            const last = slots[id].stepLog?.[slots[id].stepLog.length - 1]
            if (!last) return null
            return (
              <span key={id} className={`create-char-step-pill create-char-step-${last.kind}`}>
                {id}·{last.kind === 'ok' ? '✓' : last.kind === 'err' ? '✕' : '…'} {last.text.slice(0, 28)}
                {last.text.length > 28 ? '…' : ''}
              </span>
            )
          })}
        </div>
      </div>

      <div className="settings-card" data-motion="card" style={{ marginBottom: 12 }}>
        <div className="settings-card-head">管理员 Bearer & 中转站（五槽共用）</div>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 10 }}>
          <label className="chip" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            管理员 Bearer {hasAdminToken ? '（已保存）' : ''}
            <input
              className="field"
              style={{ minWidth: 280 }}
              type="password"
              autoComplete="off"
              placeholder={hasAdminToken ? '留空则沿用已保存 · 可粘贴 Bearer xxx' : '粘贴自己账号的 Bearer'}
              value={adminTokenInput}
              onChange={(e) => patch({ adminTokenInput: e.target.value })}
            />
          </label>
          <label className="chip" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            模型
            <input
              className="field"
              style={{ width: 160 }}
              value={teamoModel}
              onChange={(e) => patch({ teamoModel: e.target.value })}
            />
          </label>
          <label className="chip" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            Base
            <input
              className="field"
              style={{ width: 260 }}
              value={teamoBase}
              onChange={(e) => patch({ teamoBase: e.target.value })}
            />
          </label>
          <label className="chip" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            API Key {hasApiKey ? '（已保存）' : ''}
            <input
              className="field"
              style={{ width: 220 }}
              type="password"
              placeholder={hasApiKey ? '留空则沿用已保存' : 'sk-…'}
              value={teamoKeyInput}
              onChange={(e) => patch({ teamoKeyInput: e.target.value })}
            />
          </label>
          <label className="chip" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={wantPortrait}
              onChange={(e) => patch({ wantPortrait: e.target.checked })}
              style={{ marginRight: 6 }}
            />
            创建后等 Lovemi 立绘
          </label>
          <button type="button" className="btn" onClick={() => void saveRelay()}>
            保存配置
          </button>
        </div>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
          <span className="chip" style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: '100%' }}>
            下载目录
            <code
              className="field"
              style={{
                minWidth: 280,
                maxWidth: 520,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                display: 'inline-block',
                padding: '6px 10px',
              }}
              title={
                downloadsDir
                  ? `${downloadsDir}/推特资源`
                  : '默认：系统 Downloads/推特资源'
              }
            >
              {downloadsDir
                ? `${downloadsDir}/推特资源`
                : '默认 · 系统 Downloads/推特资源'}
            </code>
            <button type="button" className="btn btn-ghost" onClick={() => void pickDownloadsDir()}>
              选择文件夹
            </button>
          </span>
          <label className="chip" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoDownloadWatermark}
              onChange={(e) => {
                const next = e.target.checked
                patch({ autoDownloadWatermark: next })
                void window.lovemi?.createCharSaveConfig?.({ autoDownloadWatermark: next }).then((cfg) => {
                  if (cfg) patch({ autoDownloadWatermark: cfg.autoDownloadWatermark !== false })
                })
                setToast(next ? '已开启：自动下载带水印推特资源' : '已关闭：只缓存预览，不导出推特水印')
              }}
              style={{ marginRight: 6 }}
            />
            自动下载带水印
          </label>
        </div>
        <div className="settings-hint" style={{ marginTop: 8 }}>
          创建归属：{hasAdminToken ? '本机加密保存的管理员 Bearer' : '尚未保存管理员 Bearer'}
          {' · '}
          {hasApiKey ? 'API Key OK' : '请填写 API Key'}
          。
          {autoDownloadWatermark
            ? '立绘/视频会写入所选目录下的「推特资源」（含水印）。'
            : '已关闭水印导出：只做本地预览缓存，不写入「推特资源」。'}
        </div>
      </div>

      <div
        className="card-grid"
        style={{ gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}
      >
        <div className="settings-card" data-motion="card">
          <div className="settings-card-head">参考图（Ctrl+V）</div>
          <div
            tabIndex={0}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const f = e.dataTransfer.files?.[0]
              if (f) void ingestBlob(f)
            }}
            style={{
              minHeight: 320,
              border: '1px dashed var(--line)',
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--panel-2, transparent)',
              outline: 'none',
            }}
          >
            {previewUrl ? (
              <img
                key={`ref-${activeSlot}-${previewUrl.slice(0, 48)}`}
                src={previewUrl}
                alt="reference"
                onClick={() => setLightbox({ src: previewUrl, kind: 'image' })}
                title="点击放大"
                style={{
                  maxWidth: '100%',
                  maxHeight: 420,
                  borderRadius: 8,
                  cursor: 'zoom-in',
                }}
              />
            ) : (
              <div className="empty" style={{ textAlign: 'center', padding: 24 }}>
                在此页按 Ctrl+V 粘贴图片
                <br />
                或拖拽图片到这里
              </div>
            )}
          </div>
        </div>
        <div className="settings-card" data-motion="card">
          <div className="settings-card-head">Lovemi 立绘（对比）· 槽{activeSlot}</div>
          <div
            style={{
              minHeight: 320,
              border: '1px dashed var(--line)',
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--panel-2, transparent)',
            }}
          >
            {showPortraitUrl ? (
              <img
                key={`portrait-${activeSlot}-${createdCharacterId}-${portraitCharacterId}-${showPortraitUrl}`}
                src={showPortraitUrl}
                alt="portrait"
                onClick={() => setLightbox({ src: showPortraitUrl, kind: 'image' })}
                onError={() => {
                  const cdn =
                    (portraitCdnUrl?.startsWith('http') && portraitCdnUrl) ||
                    (showPortraitUrl.startsWith('http') && showPortraitUrl) ||
                    null
                  if (!cdn || portraitCdnDead.current.has(cdn)) return
                  const retryKey = `${activeSlot}:${draftEpoch}:${createdCharacterId}:${cdn}`
                  // 裂图时只重试一次；404 会进 dead 集合，不会无限刷
                  if (portraitSaveTried.current.has(retryKey)) return
                  void ensurePortraitDownloaded(
                    cdn,
                    activeSlot,
                    undefined,
                    createdCharacterId || undefined,
                    draftEpoch,
                  )
                }}
                title="点击放大"
                style={{
                  maxWidth: '100%',
                  maxHeight: 420,
                  borderRadius: 8,
                  cursor: 'zoom-in',
                }}
              />
            ) : (
              <div className="empty" style={{ textAlign: 'center', padding: 24 }}>
                {createdCharacterId
                  ? '正在尝试从 Lovemi 拉回立绘预览…'
                  : '创建并等待立绘后，这里会和左侧参考图并排对比'}
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        className="card-grid"
        style={{ gridTemplateColumns: 'minmax(240px, 1fr) minmax(280px, 1.2fr)', gap: 12 }}
      >
        <div className="settings-card" data-motion="card">
          <div className="settings-card-head">提示词 & 操作</div>
          <label style={{ display: 'block' }}>
            <div className="settings-hint" style={{ marginBottom: 6 }}>
              我的提示词（可选）· 介绍角色是谁、名字偏好、人设等
            </div>
            <textarea
              className="field"
              value={userHint}
              onChange={(e) => patch({ userHint: e.target.value })}
              placeholder="例如：她叫林念，北欧混血网红，温柔但带一点欲感；中文对话；职业博主…"
              rows={4}
              style={{ width: '100%', resize: 'vertical', fontSize: 13 }}
            />
          </label>
          <div className="toolbar" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== 'idle' || fullAutoQueueBusy || !imageBase64}
              onClick={() => void onAnalyze()}
            >
              {busy === 'analyze' ? '分析中…' : '分析生成参数'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== 'idle' || queueStatus !== 'idle' || !payloadText}
              onClick={() => void onCreate()}
            >
              {queueKind === 'create' && queueStatus === 'queued'
                ? `创建排队中（第 ${queuePosition || 1} 位）`
                : queueKind === 'create' && queueStatus === 'running'
                  ? '创建到 Lovemi 中…'
                  : '创建到 Lovemi'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== 'idle' || queueStatus !== 'idle' || !createdCharacterId}
              onClick={() => void onRestartPortrait()}
              title="Lovemi 生图 job 失败或超时时，强制重新触发生图"
            >
              {busy === 'portrait' ? '重新生图中…' : '重新生图'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== 'idle' || fullAutoQueueBusy || !createdCharacterId}
              onClick={() => void onGenerateMotionOnly()}
              title="Teamo 诱惑向提示词 → companion 生 5s 视频（需再点确认发布）"
            >
              {queueKind === 'motion' && queueStatus === 'queued'
                ? `视频排队中（第 ${queuePosition || 1} 位）`
                : queueKind === 'motion' && queueStatus === 'running'
                  ? '生成动态视频中…'
                  : '生成动态视频'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                busy !== 'idle' ||
                fullAutoQueueBusy ||
                !createdCharacterId ||
                !motionOutputAssetId ||
                !motionInputAssetId
              }
              onClick={() => void onSetPreview(true)}
              title="把当前视频绑到 presentation 并提交发布"
            >
              {busy === 'publish' ? '发布中…' : '确认该视频发布'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== 'idle' || queueStatus !== 'idle' || !createdCharacterId}
              onClick={() => void onAutoVideoPublish()}
              title="Teamo → 视频 → 绑动态图 → 发布（一条龙）"
            >
              {queueKind === 'autoPublish' && queueStatus === 'queued'
                ? `视频发布排队中（第 ${queuePosition || 1} 位）`
                : queueKind === 'autoPublish' && queueStatus === 'running'
                  ? '自动视频发布中…'
                  : '自动生成视频并发布'}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy !== 'idle' || queueStatus !== 'idle' || !createdCharacterId}
              onClick={() => void onPullSiteVideoAndPublish()}
              title="站内已有视频但还是草稿时：拉回视频 → 绑动态图 → 提交发布"
            >
              {queueKind === 'pullPublish' && queueStatus === 'queued'
                ? `拉回排队中（第 ${queuePosition || 1} 位）`
                : queueKind === 'pullPublish' && queueStatus === 'running'
                  ? '拉回并发布中…'
                  : '拉回并发布'}
            </button>
            <button
              type="button"
              className="btn"
              style={{ fontSize: 12, opacity: 0.95 }}
              disabled={busy !== 'idle' || queueStatus !== 'idle' || !imageBase64}
              onClick={() => void onFullAutoPublish()}
              title="参考图+提示词 → JSON → 立绘 → 视频 → 绑定 → 发布；其他槽运行时可继续加入串行队列"
            >
              {queueKind === 'fullAuto' && queueStatus === 'queued'
                ? `排队中（第 ${queuePosition || 1} 位）`
                : queueKind === 'fullAuto' && queueStatus === 'running'
                  ? '全自动进行中…'
                  : '全自动到发布'}
            </button>
            <button
              type="button"
              className="btn ghost"
              style={{ fontSize: 12 }}
              disabled={busy === 'idle' && queueStatus === 'idle' && !waitStartedAt}
              onClick={() => void onStopOrUnlockSlot()}
              title="停止本槽假跑/真跑并解锁。官方已发送失败或按钮点不了时点这里"
            >
              停止/解锁
            </button>
          </div>
          {createdCharacterId ? (
            <div className="settings-hint" style={{ marginTop: 8 }}>
              当前角色 · {createdCharacterId}
              {listingId ? ` · ${listingId}` : ''}
            </div>
          ) : null}
          {waitStartedAt != null ? (
            <div
              className="settings-hint"
              style={{
                marginTop: 12,
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid var(--line)',
                background: 'rgba(228, 90, 154, 0.08)',
                fontVariantNumeric: 'tabular-nums',
                fontSize: 14,
                color: 'var(--text)',
              }}
            >
              {busy === 'auto' || waitKind === 'publish'
                ? '到发布流水线'
                : busy === 'motion' || waitKind === 'motion'
                  ? '生成动态视频'
                  : '等待 Lovemi 生图'}{' '}
              · 已等{' '}
              <strong style={{ fontSize: 18, letterSpacing: '0.04em' }}>{formatClock(waitElapsedSec)}</strong>
              {' / 最长 '}
              {formatClock(waitMaxSec)}
              <span style={{ color: 'var(--muted)', marginLeft: 8 }}>
                （生图/视频约 10 分钟；到发布约 20 分钟）
              </span>
            </div>
          ) : null}
          {motionPrompt ? (
            <div className="settings-hint" style={{ marginTop: 10 }}>
              Teamo 动态提示词：{motionPrompt.slice(0, 220)}
              {motionPrompt.length > 220 ? '…' : ''}
            </div>
          ) : null}
          {motionPreviewUrl || motionOutputAssetId ? (
            <div style={{ marginTop: 12 }}>
              <div className="settings-hint">
                动态视频预览
                {motionOutputAssetId ? ` · ${motionOutputAssetId}` : ''}
              </div>
              {motionPreviewUrl ? (
                <video
                  key={`video-${activeSlot}-${motionPreviewUrl}`}
                  src={motionPreviewUrl}
                  controls
                  playsInline
                  preload="metadata"
                  onDoubleClick={() => setLightbox({ src: motionPreviewUrl, kind: 'video' })}
                  onError={() => {
                    if (motionPreviewUrl.startsWith('http')) {
                      videoCacheTried.current.delete(`${activeSlot}:${motionPreviewUrl}`)
                      void ensurePlayableVideoUrl(motionPreviewUrl, activeSlot)
                    }
                  }}
                  title="双击放大"
                  style={{
                    maxWidth: '100%',
                    maxHeight: 360,
                    borderRadius: 8,
                    marginTop: 8,
                    cursor: 'default',
                    background: '#000',
                  }}
                />
              ) : (
                <div className="settings-hint" style={{ marginTop: 8 }}>
                  视频 asset 已就绪（暂无预览 URL，仍可确认发布）
                </div>
              )}
              {motionPreviewUrl?.startsWith('http') ? (
                <button
                  type="button"
                  className="btn ghost"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    videoCacheTried.current.delete(`${activeSlot}:${motionPreviewUrl}`)
                    void ensurePlayableVideoUrl(motionPreviewUrl, activeSlot)
                  }}
                >
                  重新缓存视频预览
                </button>
              ) : null}
              {listingId ? (
                <div className="settings-hint" style={{ marginTop: 6 }}>
                  listing · {listingId}
                </div>
              ) : null}
            </div>
          ) : null}
          {portraitPrompt ? (
            <label style={{ display: 'block', marginTop: 12 }}>
              <div className="settings-hint" style={{ marginBottom: 6 }}>
                立绘提示词（本地草稿 portrait_prompt；创建时不会发给 Lovemi 服务器，仅供你对照编辑。生图只吃短 appearance_tags + 官网 enhancement）
              </div>
              <textarea
                className="field"
                value={portraitPrompt}
                onChange={(e) => {
                  const v = e.target.value
                  const next: { portraitPrompt: string; payloadText?: string } = { portraitPrompt: v }
                  try {
                    const obj = JSON.parse(payloadText || '{}') as Record<string, unknown>
                    const appearance = Array.isArray(obj.appearance_tags)
                      ? (obj.appearance_tags as unknown[])
                          .map(String)
                          .filter((t) => !t.startsWith('立绘提示词:') && !t.startsWith('立绘提示词：'))
                      : []
                    obj.appearance_tags = appearance
                    obj.portrait_prompt = v.trim()
                    next.payloadText = JSON.stringify(obj, null, 2)
                  } catch {
                    /* ignore */
                  }
                  patch(next)
                }}
                rows={8}
                style={{ width: '100%', fontSize: 12, lineHeight: 1.45 }}
              />
            </label>
          ) : null}
        </div>

        <div className="settings-card" data-motion="card">
          <div className="settings-card-head">角色参数 JSON（可改）</div>
          <textarea
            className="field"
            value={payloadText}
            onChange={(e) => patch({ payloadText: e.target.value })}
            placeholder="分析后会出现完整创建 body…"
            style={{
              width: '100%',
              height: 360,
              maxHeight: 360,
              resize: 'vertical',
              fontFamily: 'ui-monospace, monospace',
              fontSize: 12,
              overflow: 'auto',
              boxSizing: 'border-box',
            }}
          />
          {lastResult ? (
            <pre
              style={{
                marginTop: 10,
                maxHeight: 240,
                overflow: 'auto',
                fontSize: 11,
                color: 'var(--muted)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: 10,
                background: 'var(--panel-2, rgba(0,0,0,0.15))',
              }}
            >
              {lastResult}
            </pre>
          ) : null}
        </div>
      </div>
      {lightbox ? (
        <MediaLightbox
          src={lightbox.src}
          kind={lightbox.kind}
          onClose={closeLightbox}
        />
      ) : null}
    </section>
  )
}
