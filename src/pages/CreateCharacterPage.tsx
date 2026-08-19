import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useCreateCharStore,
  slotLabel,
  type CreateCharSlotId,
  type CreateCharSlotDraft,
} from '../store/createCharStore'
import { useEmailStore } from '../store/emailStore'
import { useSettingsStore } from '../store/settingsStore'
import { runEmailPageEnter } from '../motion/timelines'
import { MediaLightbox } from '../components/MediaLightbox'

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

export function CreateCharacterPage({ active }: { active: boolean }) {
  const pageRef = useRef<HTMLElement>(null)
  const accounts = useEmailStore((s) => s.accounts)
  const setToast = useEmailStore((s) => s.setToast)
  const patch = useCreateCharStore((s) => s.patch)
  const patchSlot = useCreateCharStore((s) => s.patchSlot)
  const pushStep = useCreateCharStore((s) => s.pushStep)
  const clearStepLog = useCreateCharStore((s) => s.clearStepLog)
  const activeSlot = useCreateCharStore((s) => s.activeSlot)
  const setActiveSlot = useCreateCharStore((s) => s.setActiveSlot)
  const slots = useCreateCharStore((s) => s.slots)
  const adminId = useCreateCharStore((s) => s.adminId)
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
  const portraitPrompt = draft.portraitPrompt
  const busy = draft.busy
  const wantPortrait = draft.wantPortrait
  const lastResult = draft.lastResult
  const userHint = draft.userHint
  const createdCharacterId = draft.createdCharacterId
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

  const anySlotWaiting = Boolean(
    slots[1].waitStartedAt || slots[2].waitStartedAt || slots[3].waitStartedAt,
  )
  useEffect(() => {
    if (!anySlotWaiting) return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [anySlotWaiting])

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
    async (cdnOrUrl: string | null | undefined, slot?: CreateCharSlotId) => {
      const slotId = slot ?? useCreateCharStore.getState().activeSlot
      const write = (p: Parameters<typeof patchSlot>[1]) => patchSlot(slotId, p)
      if (!cdnOrUrl) return
      if (cdnOrUrl.startsWith('lovemi-cache://') || cdnOrUrl.startsWith('blob:') || cdnOrUrl.startsWith('data:')) {
        write({ motionPreviewUrl: cdnOrUrl })
        return
      }
      if (!cdnOrUrl.startsWith('http')) return
      const cacheKey = `${slotId}:${cdnOrUrl}`
      if (videoCacheTried.current.has(cacheKey)) return
      if (!window.lovemi?.createCharCacheMedia) {
        write({ motionPreviewUrl: cdnOrUrl })
        return
      }
      videoCacheTried.current.add(cacheKey)
      const outbound = await resolveProxyUrl()
      if (!outbound.proxyUrl) {
        write({ motionPreviewUrl: cdnOrUrl })
        setToast(outbound.error || '无代理，视频可能无法播放')
        return
      }
      setToast(`槽${slotId}：正在缓存视频…`)
      const name = characterDisplayName(slotId)
      const res = await window.lovemi.createCharCacheMedia({
        cdnUrl: cdnOrUrl,
        proxyUrl: outbound.proxyUrl,
        displayName: `${name}_槽${slotId}`,
        kind: 'video',
      })
      if (res.ok && res.cacheUrl) {
        write({ motionPreviewUrl: res.cacheUrl })
        pushStep(slotId, 'ok', '视频预览缓存已完成')
        setToast(res.twitterPath ? `槽${slotId}：视频已存推特资源` : `槽${slotId}：视频预览已就绪`)
      } else {
        write({ motionPreviewUrl: cdnOrUrl })
        setToast(res.error || '视频缓存失败，尝试直链播放')
      }
    },
    [patchSlot, setToast, characterDisplayName, pushStep],
  )

  const ensurePortraitDownloaded = useCallback(
    async (
      cdnOrUrl: string | null | undefined,
      slot?: CreateCharSlotId,
      displayNameOverride?: string,
    ) => {
      const slotId = slot ?? useCreateCharStore.getState().activeSlot
      if (!cdnOrUrl?.startsWith('http')) return
      const cacheKey = `${slotId}:${cdnOrUrl}`
      if (portraitSaveTried.current.has(cacheKey)) return
      if (!window.lovemi?.createCharCacheMedia) return
      portraitSaveTried.current.add(cacheKey)
      const outbound = await resolveProxyUrl()
      if (!outbound.proxyUrl) return
      const name = (displayNameOverride || characterDisplayName(slotId)).trim() || '未命名'
      const res = await window.lovemi.createCharCacheMedia({
        cdnUrl: cdnOrUrl,
        proxyUrl: outbound.proxyUrl,
        displayName: `${name}_槽${slotId}`,
        kind: 'portrait',
      })
      if (res.ok && res.twitterPath) {
        pushStep(slotId, 'ok', `立绘已存推特资源 · ${name}`)
        setToast(`槽${slotId}：立绘已存推特资源 · ${name}`)
      }
    },
    [setToast, characterDisplayName, pushStep],
  )

  const waitMaxSec =
    waitKind === 'publish' || busy === 'auto' || busy === 'publish'
      ? WAIT_MAX_PUBLISH_SEC
      : WAIT_MAX_PORTRAIT_OR_MOTION_SEC

  const withToken = useMemo(
    () =>
      accounts.filter(
        (a) =>
          !a.id.startsWith('demo-') &&
          !a.email.endsWith('@example.com') &&
          Boolean(a.lovemiSessionToken),
      ),
    [accounts],
  )

  const admin = withToken.find((a) => a.id === adminId)

  /** 重新进入页面时：有角色 ID 但立绘对比区空了 → 从 Lovemi 拉回 CDN 预览 */
  useEffect(() => {
    if (!active) return
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
        sessionToken: admin?.lovemiSessionToken,
        proxyUrl: outbound.proxyUrl,
      })
      if (cancelled || !res.ok || !res.cdnUrl) {
        // 允许稍后重试（全自动还在跑、站内刚出图）
        portraitRestoreTried.current.delete(restoreKey)
        return
      }
      const next: { portraitUrl: string; portraitCdnUrl?: string; motionInputAssetId?: string } = {
        portraitUrl: res.cdnUrl,
        portraitCdnUrl: res.cdnUrl,
      }
      const cur = useCreateCharStore.getState().slots[slotAtStart]
      if (res.assetId && !cur.motionInputAssetId) next.motionInputAssetId = res.assetId
      patchSlot(slotAtStart, next)
      const name = (() => {
        try {
          const obj = JSON.parse(cur.payloadText || '{}') as Record<string, unknown>
          return typeof obj.display_name === 'string' ? obj.display_name : undefined
        } catch {
          return undefined
        }
      })()
      void ensurePortraitDownloaded(res.cdnUrl, slotAtStart, name)
    })()
    return () => {
      cancelled = true
    }
  }, [
    active,
    activeSlot,
    createdCharacterId,
    portraitUrl,
    admin?.lovemiSessionToken,
    patchSlot,
    ensurePortraitDownloaded,
  ])

  /** 等待立绘时前端也快刷：站内已出图时不必干等主进程慢循环 */
  useEffect(() => {
    if (!active) return
    if (!createdCharacterId) return
    if (portraitUrl?.startsWith('http') || portraitUrl?.startsWith('lovemi-cache://')) return
    if (busy !== 'create' && busy !== 'auto' && busy !== 'portrait') return
    if (!window.lovemi?.createCharRefreshPortrait) return
    const slotAtStart = activeSlot
    const charId = createdCharacterId
    let cancelled = false
    let inFlight = false
    const tick = async () => {
      if (cancelled || inFlight) return
      inFlight = true
      try {
        const outbound = await resolveProxyUrl()
        if (!outbound.proxyUrl || cancelled) return
        const res = await window.lovemi!.createCharRefreshPortrait!({
          characterId: charId,
          sessionToken: admin?.lovemiSessionToken,
          proxyUrl: outbound.proxyUrl,
        })
        if (cancelled || !res.ok || !res.cdnUrl) return
        const cur = useCreateCharStore.getState().slots[slotAtStart]
        if (cur.createdCharacterId !== charId) return
        patchSlot(slotAtStart, {
          portraitUrl: res.cdnUrl,
          portraitCdnUrl: res.cdnUrl,
          ...(res.assetId && !cur.motionInputAssetId ? { motionInputAssetId: res.assetId } : {}),
        })
        pushStep(slotAtStart, 'ok', '立绘已拉回（站内同步）')
        setToast(`槽${slotAtStart}：立绘已拉回`)
        void ensurePortraitDownloaded(res.cdnUrl, slotAtStart)
      } finally {
        inFlight = false
      }
    }
    const timer = window.setInterval(() => void tick(), 2000)
    void tick()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [
    active,
    activeSlot,
    createdCharacterId,
    portraitUrl,
    busy,
    admin?.lovemiSessionToken,
    patchSlot,
    ensurePortraitDownloaded,
    setToast,
    pushStep,
  ])

  useEffect(() => {
    if (!pageRef.current) return
    runEmailPageEnter(pageRef.current)
  }, [])

  useEffect(() => {
    void (async () => {
      const cfg = await window.lovemi?.createCharConfig?.()
      if (!cfg) return
      const next: {
        teamoBase: string
        teamoModel: string
        hasApiKey: boolean
        hasAdminToken: boolean
        adminId?: string
      } = {
        teamoBase: cfg.teamoApiBase || 'https://api.teamorouter.com/v1',
        teamoModel: cfg.teamoModel || 'gpt-5.4-mini',
        hasApiKey: cfg.hasApiKey,
        hasAdminToken: cfg.hasAdminToken,
      }
      if (cfg.adminAccountId && withToken.some((a) => a.id === cfg.adminAccountId)) {
        next.adminId = cfg.adminAccountId
      } else if (cfg.adminEmailLocal) {
        const hit = withToken.find((a) => a.email.split('@')[0] === cfg.adminEmailLocal)
        if (hit) next.adminId = hit.id
      }
      patch(next)
    })()
  }, [withToken, patch])

  // 默认：优先已记住的；否则选第一个有 Bearer 的（用户可改成自己的号）
  useEffect(() => {
    if (adminId || !withToken.length) return
    patch({ adminId: withToken[0].id })
  }, [adminId, withToken, patch])

  const ingestBlob = useCallback(
    async (blob: Blob) => {
      // 只接受图片；绝不把剪贴板文字写进参数 JSON
      if (!blob.type.startsWith('image/')) {
        setToast('请粘贴图片（不是文字）')
        return
      }
      const { base64, mime } = await fileToBase64(blob)
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
      patch({
        imageBase64: base64,
        mimeType: mime,
        previewUrl: URL.createObjectURL(blob),
        payloadText: '',
        portraitUrl: null,
        portraitCdnUrl: null,
        portraitPrompt: '',
        createdCharacterId: '',
        portraitJobId: '',
        motionJobId: '',
        motionPreviewUrl: null,
        motionPrompt: '',
        motionInputAssetId: '',
        motionOutputAssetId: '',
        listingId: '',
        lastResult: '',
        publishResult: '',
        busy: 'idle',
        waitStartedAt: null,
        waitKind: null,
        stepLog: [],
      })
      pushStep(slotId, 'run', '已粘贴新参考图 · 旧草稿已清空，准备开始')
      setToast(`槽${slotId}：已换新参考图 · 旧立绘/参数/视频已清空`)
    },
    [setToast, patch, pushStep],
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
      const slotId = (p.clientSlot === 1 || p.clientSlot === 2 || p.clientSlot === 3
        ? p.clientSlot
        : useCreateCharStore.getState().activeSlot) as CreateCharSlotId
      const next: Parameters<typeof patchSlot>[1] = {}
      if (p.payload) next.payloadText = JSON.stringify(p.payload, null, 2)
      if (p.portraitPrompt) next.portraitPrompt = p.portraitPrompt
      if (p.characterId) next.createdCharacterId = p.characterId
      if (p.portraitCdnUrl) {
        next.portraitUrl = p.portraitCdnUrl
        next.portraitCdnUrl = p.portraitCdnUrl
      }
      if (p.coverAssetId) next.motionInputAssetId = p.coverAssetId
      if (p.motionPrompt) next.motionPrompt = p.motionPrompt
      if (p.videoAssetId) next.motionOutputAssetId = p.videoAssetId
      if (p.videoCdnUrl) next.motionPreviewUrl = p.videoCdnUrl
      if (p.listingId) next.listingId = p.listingId
      if (Object.keys(next).length) patchSlot(slotId, next)

      const nameFromPayload =
        typeof p.payload?.display_name === 'string' ? String(p.payload.display_name) : undefined
      if (p.portraitCdnUrl) void ensurePortraitDownloaded(p.portraitCdnUrl, slotId, nameFromPayload)
      if (p.videoCdnUrl) void ensurePlayableVideoUrl(p.videoCdnUrl, slotId)

      if (p.stage === 'portrait' && p.portraitCdnUrl) {
        pushStep(slotId, 'ok', `立绘已完成 · 继续生成视频`)
        setToast(`槽${slotId}：立绘已拉回 · 继续生成视频…`)
      } else if (p.stage === 'analyzed') {
        pushStep(slotId, 'ok', `分析已完成 · ${String(p.payload?.display_name || '角色')}`)
        setToast(`槽${slotId}：参数已生成 · ${String(p.payload?.display_name || '')}`)
      } else if (p.stage === 'video') {
        pushStep(slotId, 'run', '开始生成动态视频…')
        setToast(`槽${slotId}：开始生成动态视频…`)
      } else if (p.stage === 'create' && p.characterId) {
        pushStep(slotId, 'ok', `角色已创建 · ${p.characterId.slice(0, 18)}… · 等待立绘`)
        setToast(`槽${slotId}：角色已创建 · 等待立绘…`)
      } else if (p.stage === 'published') {
        pushStep(slotId, 'ok', `发布已完成${p.listingId ? ` · ${p.listingId}` : ''}`)
      } else if (p.stage === 'video_failed') {
        pushStep(slotId, 'err', '视频/发布阶段失败（见下方结果）')
      }
    })
  }, [patchSlot, setToast, ensurePlayableVideoUrl, ensurePortraitDownloaded, pushStep])

  const saveRelay = async () => {
    const savePatch: {
      teamoApiBase: string
      teamoModel: string
      teamoApiKey?: string
    } = {
      teamoApiBase: teamoBase.trim(),
      teamoModel: teamoModel.trim() || 'gpt-5.4-mini',
    }
    if (teamoKeyInput.trim()) savePatch.teamoApiKey = teamoKeyInput.trim()
    // 不拿下拉 Hotmail 覆盖本机管理员 Bearer（Lumi Vale 走浏览器 Token）
    const cfg = await window.lovemi?.createCharSaveConfig?.(savePatch)
    if (cfg) {
      patch({
        hasApiKey: cfg.hasApiKey,
        hasAdminToken: cfg.hasAdminToken,
        teamoKeyInput: '',
      })
      setToast('中转站配置已保存（管理员 Bearer 单独保留）')
    }
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
    await saveRelay()
    const outbound = await resolveProxyUrl()
    if (!outbound.proxyUrl) {
      setToast(outbound.error || '无代理')
      return
    }
    patchSlot(slot, { busy: 'analyze', lastResult: '', portraitUrl: null })
    pushStep(slot, 'run', '开始分析参考图…')
    try {
      const res = await window.lovemi.createCharAnalyze({
        imageBase64: img,
        mimeType: mime,
        proxyUrl: outbound.proxyUrl,
        userHint: hint,
      })
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
      patchSlot(slot, { busy: 'idle' })
    }
  }

  const onCreate = async () => {
    let body: Record<string, unknown>
    try {
      body = JSON.parse(payloadText) as Record<string, unknown>
    } catch {
      setToast('参数 JSON 无效')
      return
    }
    const slot = activeSlot
    const want = wantPortrait
    await saveRelay()
    const outbound = await resolveProxyUrl()
    if (!outbound.proxyUrl) {
      setToast(outbound.error || '无代理')
      return
    }
    if (!admin?.lovemiSessionToken && !hasAdminToken) {
      setToast('请选择管理员账号，或先保存浏览器 Bearer')
      return
    }
    patchSlot(slot, {
      busy: 'create',
      waitStartedAt: Date.now(),
      waitKind: 'portrait',
      portraitUrl: null,
      portraitCdnUrl: null,
    })
    try {
      const res = await window.lovemi!.createCharCreate({
        sessionToken: admin?.lovemiSessionToken,
        proxyUrl: outbound.proxyUrl,
        body,
        waitPortrait: false,
      })
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
      // 立刻写入角色 ID，立绘区可开始 2s 快刷
      patchSlot(slot, {
        createdCharacterId: id,
        busy: want ? 'portrait' : 'idle',
        waitStartedAt: want ? Date.now() : null,
        waitKind: want ? 'portrait' : null,
        lastResult: formatCompactResult({ characterOk: true, id, waitingPortrait: want }),
      })
      pushStep(slot, 'ok', `角色已创建 · ${id.slice(0, 18)}…`)
      setToast(`槽${slot}：角色已创建 · 等待立绘…`)

      let portrait = res.portrait
      if (want && window.lovemi?.createCharWaitPortrait) {
        pushStep(slot, 'run', '等待 Lovemi 立绘生成…')
        const waited = await window.lovemi.createCharWaitPortrait({
          characterId: id,
          sessionToken: admin?.lovemiSessionToken,
          proxyUrl: outbound.proxyUrl,
          forceRestart: false,
        })
        if (waited.ok) {
          portrait = {
            cdnUrl: waited.cdnUrl,
            jobId: waited.jobId,
            imageDataUrl: waited.imageDataUrl,
            assetId: waited.assetId,
          }
        } else {
          patchSlot(slot, {
            lastResult: formatCompactResult({ characterOk: true, id, portraitError: waited.error }),
          })
          pushStep(slot, 'err', `立绘未出 · ${waited.error || '超时'}`)
          setToast(`槽${slot}：角色在，立绘未出 · ${waited.error || ''}`)
        }
      }

      const next: {
        lastResult: string
        portraitJobId?: string
        portraitUrl?: string
        portraitCdnUrl?: string
        motionInputAssetId?: string
      } = { lastResult: '' }
      if (portrait?.jobId) next.portraitJobId = portrait.jobId
      const cdn = portrait?.cdnUrl
      const preview = cdn || portrait?.imageDataUrl
      if (preview) next.portraitUrl = preview
      if (cdn) next.portraitCdnUrl = cdn
      if (portrait?.assetId) next.motionInputAssetId = portrait.assetId
      const portraitOk = Boolean(preview)
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
      patchSlot(slot, next)
      if (cdn) void ensurePortraitDownloaded(cdn, slot)
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
    if (!window.lovemi?.createCharGenerateMotionOnly) {
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
    let payload: Record<string, unknown> | undefined
    try {
      payload = JSON.parse(snap.payloadText || '{}') as Record<string, unknown>
    } catch {
      payload = undefined
    }
    patchSlot(slot, {
      busy: 'motion',
      waitStartedAt: Date.now(),
      waitKind: 'motion',
      motionPreviewUrl: null,
    })
    pushStep(slot, 'run', '开始生成动态视频…')
    try {
      const res = await window.lovemi.createCharGenerateMotionOnly({
        characterId: snap.createdCharacterId,
        sessionToken: admin?.lovemiSessionToken,
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
      patchSlot(slot, { busy: 'idle', waitStartedAt: null, waitKind: null })
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
        sessionToken: admin?.lovemiSessionToken,
        proxyUrl: outbound.proxyUrl,
        coverAssetId: cover,
        videoAssetId: snap.motionOutputAssetId || undefined,
        title,
        description,
        publish: alsoPublish,
        // 不传槽内残留 listingId，由主进程按本角色草稿解析，防串台
      })
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
      patchSlot(slot, { busy: 'idle', waitStartedAt: null, waitKind: null })
    }
  }

  const onAutoVideoPublish = async () => {
    if (!createdCharacterId) {
      setToast('先创建角色')
      return
    }
    if (!window.lovemi?.createCharAutoVideoPublish) {
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
    let payload: Record<string, unknown> | undefined
    try {
      payload = JSON.parse(snap.payloadText || '{}') as Record<string, unknown>
    } catch {
      payload = undefined
    }
    patchSlot(slot, { busy: 'auto', waitStartedAt: Date.now(), waitKind: 'publish' })
    pushStep(slot, 'run', '开始自动生成视频并发布…')
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
      const res = await window.lovemi.createCharAutoVideoPublish({
        characterId: snap.createdCharacterId,
        sessionToken: admin?.lovemiSessionToken,
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
        `【槽${slot} 成功】${name} 视频已生成并提交发布${res.listingId ? ` · ${res.listingId}` : ''} · 预览已回填，推特资源文件夹也会存一份`,
        16000,
      )
    } finally {
      patchSlot(slot, { busy: 'idle', waitStartedAt: null, waitKind: null })
    }
  }

  const onFullAutoPublish = async () => {
    if (!imageBase64) {
      setToast('先 Ctrl+V 粘贴参考图')
      return
    }
    if (!window.lovemi?.createCharFullAutoPublish) {
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
    patchSlot(slot, {
      busy: 'auto',
      waitStartedAt: Date.now(),
      waitKind: 'publish',
      lastResult: '',
    })
    pushStep(slot, 'run', '开始全自动到发布…')
    try {
      const res = await window.lovemi.createCharFullAutoPublish({
        imageBase64: snap.imageBase64!,
        mimeType: snap.mimeType,
        proxyUrl: outbound.proxyUrl,
        sessionToken: admin?.lovemiSessionToken,
        userHint: snap.userHint.trim() || undefined,
        clientSlot: slot,
      })
      const upd: Parameters<typeof patchSlot>[1] = {
        lastResult: formatCompactResult(res),
        publishResult: formatCompactResult(res),
      }
      if (res.payload) upd.payloadText = JSON.stringify(res.payload, null, 2)
      if (res.portraitPrompt) upd.portraitPrompt = res.portraitPrompt
      if (res.characterId) upd.createdCharacterId = res.characterId
      if (res.portraitCdnUrl) upd.portraitUrl = res.portraitCdnUrl
      if (res.motionPrompt) upd.motionPrompt = res.motionPrompt
      if (res.coverAssetId) upd.motionInputAssetId = res.coverAssetId
      if (res.videoAssetId) upd.motionOutputAssetId = res.videoAssetId
      if (res.listingId) upd.listingId = res.listingId
      patchSlot(slot, upd)
      if (res.portraitCdnUrl) void ensurePortraitDownloaded(res.portraitCdnUrl, slot)
      if (res.videoCdnUrl) void ensurePlayableVideoUrl(res.videoCdnUrl, slot)
      if (!res.ok) {
        pushStep(slot, 'err', `全自动失败 · ${res.error || ''}`)
        setToast(`【槽${slot} 全自动失败】${res.error || '全自动发布失败'}`, 14000)
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
      patchSlot(slot, { busy: 'idle', waitStartedAt: null, waitKind: null })
    }
  }

  const onPullSiteVideoAndPublish = async () => {
    const slot = activeSlot
    const snap = useCreateCharStore.getState().slots[slot]
    if (!snap.createdCharacterId) {
      setToast(`槽${slot}：先有角色 ID`, 5000)
      return
    }
    if (!window.lovemi?.createCharRefreshVideo || !window.lovemi?.createCharSetPreviewPublish) {
      setToast('请在 Electron 桌面窗口操作', 5000)
      return
    }
    const outbound = await resolveProxyUrl()
    if (!outbound.proxyUrl) {
      setToast(outbound.error || '无代理', 5000)
      return
    }
    pushStep(slot, 'run', '拉回站内视频并提交发布…')
    patchSlot(slot, { busy: 'publish', waitStartedAt: Date.now(), waitKind: 'publish' })
    try {
      setToast(`槽${slot}：正在拉回站内视频…`, 4000)
      const pulled = await window.lovemi.createCharRefreshVideo({
        characterId: snap.createdCharacterId,
        sessionToken: admin?.lovemiSessionToken,
        proxyUrl: outbound.proxyUrl,
      })
      if (!pulled.ok || !pulled.videoAssetId) {
        pushStep(slot, 'err', `拉回失败 · ${pulled.error || '站内暂无视频'}`)
        setToast(`【槽${slot}】站内还没有视频可拉 · ${pulled.error || ''}`, 12000)
        return
      }
      pushStep(slot, 'ok', `已拉回站内视频 · ${pulled.videoAssetId}`)
      const cover =
        snap.motionInputAssetId ||
        (await (async () => {
          // 没有封面 asset 时，尽量用 refresh portrait
          if (!window.lovemi?.createCharRefreshPortrait) return ''
          const por = await window.lovemi.createCharRefreshPortrait({
            characterId: snap.createdCharacterId,
            sessionToken: admin?.lovemiSessionToken,
            proxyUrl: outbound.proxyUrl!,
          })
          return por.assetId || ''
        })())
      if (!cover) {
        pushStep(slot, 'err', '有视频但缺少立绘 asset，无法绑封面发布')
        setToast(`【槽${slot}】缺立绘 asset，先点创建/刷新立绘`, 12000)
        patchSlot(slot, {
          motionOutputAssetId: pulled.videoAssetId,
          motionPreviewUrl: pulled.cdnUrl || snap.motionPreviewUrl,
        })
        if (pulled.cdnUrl) void ensurePlayableVideoUrl(pulled.cdnUrl, slot)
        return
      }
      const { title, description } = buildPublishMeta()
      // 故意不传旧 listingId，避免三槽串台提交错 listing
      const pub = await window.lovemi.createCharSetPreviewPublish({
        characterId: snap.createdCharacterId,
        sessionToken: admin?.lovemiSessionToken,
        proxyUrl: outbound.proxyUrl,
        coverAssetId: cover,
        videoAssetId: pulled.videoAssetId,
        title,
        description,
        publish: true,
      })
      patchSlot(slot, {
        motionInputAssetId: cover,
        motionOutputAssetId: pulled.videoAssetId,
        motionPreviewUrl: pulled.cdnUrl || snap.motionPreviewUrl,
        listingId: pub.listingId || '',
        lastResult: formatCompactResult({ pulled, pub }),
        publishResult: formatCompactResult(pub),
      })
      if (pulled.cdnUrl) void ensurePlayableVideoUrl(pulled.cdnUrl, slot)
      if (!pub.ok) {
        pushStep(slot, 'err', `绑视频/发布失败 · ${pub.error || ''}`)
        setToast(`【槽${slot} 发布失败】${pub.error || '请看步骤清单'}`, 14000)
        return
      }
      pushStep(
        slot,
        'ok',
        `拉回并发布已完成${pub.listingId ? ` · ${pub.listingId}` : ''}`,
      )
      setToast(
        `【槽${slot} 成功】已拉回站内视频并提交发布${pub.listingId ? ` · ${pub.listingId}` : ''}。请到站内刷新看是否已离开草稿。`,
        18000,
      )
    } finally {
      patchSlot(slot, { busy: 'idle', waitStartedAt: null, waitKind: null })
    }
  }

  return (
    <section className="email-page create-char-page" ref={pageRef}>
      <h1 className="page-title">创建角色</h1>
      <p className="page-desc">
        顶部切换 <strong>1 / 2 / 3</strong> 三槽并发（草稿与进度隔离，管理员认证共用）→{' '}
        <strong>Ctrl+V</strong> 粘贴参考图 → 分析 / 创建 / 视频 / 发布。图片/视频可点击放大。
      </p>

      <div className="settings-card" data-motion="card" style={{ marginBottom: 12 }}>
        <div className="settings-card-head">工作槽（可同时跑 3 个）</div>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {([1, 2, 3] as CreateCharSlotId[]).map((id) => {
            const s = slots[id]
            const selected = activeSlot === id
            const running = s.waitStartedAt != null || s.busy !== 'idle'
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
          <span className="settings-hint" style={{ marginLeft: 4 }}>
            当前槽 {activeSlot}
            {busy !== 'idle' ? ` · ${busy}` : ''}
            {createdCharacterId ? ` · ${createdCharacterId.slice(0, 14)}…` : ''}
          </span>
        </div>
        {anySlotWaiting ? (
          <div className="settings-hint" style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {([1, 2, 3] as CreateCharSlotId[]).map((id) => {
              const s = slots[id]
              if (s.waitStartedAt == null) return null
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
                  {s.waitKind === 'publish' || s.busy === 'auto'
                    ? '到发布'
                    : s.waitKind === 'motion' || s.busy === 'motion'
                      ? '视频'
                      : '立绘'}{' '}
                  {formatClock(slotElapsedSec(s))}/{formatClock(slotWaitMaxSec(s))}
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
          {([1, 2, 3] as CreateCharSlotId[]).map((id) => {
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
        <div className="settings-card-head">管理员 & 中转站（三槽共用）</div>
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: 10 }}>
          <label className="chip" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            备用库存号
            <select
              className="field"
              style={{ minWidth: 220 }}
              value={adminId}
              onChange={(e) => patch({ adminId: e.target.value })}
            >
              {!withToken.length ? <option value="">无可用 Bearer</option> : null}
              {withToken.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.lovemiDisplayName || a.email.split('@')[0]}
                  {a.lovemiDisplayName ? ` · ${a.email.split('@')[0]}` : ''}
                </option>
              ))}
            </select>
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
            保存中转站配置
          </button>
        </div>
        <div className="settings-hint" style={{ marginTop: 8 }}>
          创建归属：{hasAdminToken ? '本机加密保存的管理员 Bearer（应对应为 Lumi Vale）' : '尚未保存管理员 Token'}
          {' · '}
          {hasApiKey ? 'API Key OK' : '请填写 API Key'}
          。角色会出现在该 Bearer 对应账号的「我的角色」里，不是 Hotmail 库存号。
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
            {portraitUrl ? (
              <img
                key={`portrait-${activeSlot}-${createdCharacterId}-${portraitUrl}`}
                src={portraitUrl}
                alt="portrait"
                onClick={() => setLightbox({ src: portraitUrl, kind: 'image' })}
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
              disabled={busy !== 'idle' || !imageBase64}
              onClick={() => void onAnalyze()}
            >
              {busy === 'analyze' ? '分析中…' : '分析生成参数'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== 'idle' || !payloadText}
              onClick={() => void onCreate()}
            >
              {busy === 'create' ? (wantPortrait ? '创建并等待立绘…' : '创建中…') : '创建到 Lovemi'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== 'idle' || !createdCharacterId}
              onClick={() => void onGenerateMotionOnly()}
              title="Teamo 诱惑向提示词 → companion 生 5s 视频（需再点确认发布）"
            >
              {busy === 'motion' ? '生成动态视频中…' : '生成动态视频'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                busy !== 'idle' || !createdCharacterId || !motionOutputAssetId || !motionInputAssetId
              }
              onClick={() => void onSetPreview(true)}
              title="把当前视频绑到 presentation 并提交发布"
            >
              {busy === 'publish' ? '发布中…' : '确认该视频发布'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== 'idle' || !createdCharacterId}
              onClick={() => void onAutoVideoPublish()}
              title="Teamo → 视频 → 绑动态图 → 发布（一条龙）"
            >
              {busy === 'auto' ? '自动视频发布中…' : '自动生成视频并发布'}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy !== 'idle' || !createdCharacterId}
              onClick={() => void onPullSiteVideoAndPublish()}
              title="站内已有视频但还是草稿时：拉回视频 → 绑动态图 → 提交发布"
            >
              拉回并发布
            </button>
            <button
              type="button"
              className="btn"
              style={{ fontSize: 12, opacity: 0.95 }}
              disabled={busy !== 'idle' || !imageBase64}
              onClick={() => void onFullAutoPublish()}
              title="参考图+提示词 → JSON → 立绘 → 视频 → 绑定 → 发布"
            >
              {busy === 'auto' ? '全自动进行中…' : '全自动到发布'}
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
              Teamo 动态提示词：{motionPrompt.slice(0, 120)}
              {motionPrompt.length > 120 ? '…' : ''}
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
                  onClick={() => setLightbox({ src: motionPreviewUrl, kind: 'video' })}
                  title="点击放大"
                  style={{
                    maxWidth: '100%',
                    maxHeight: 360,
                    borderRadius: 8,
                    marginTop: 8,
                    cursor: 'zoom-in',
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
                立绘提示词（已写入 appearance_tags「立绘提示词:…」，可改；创建时会带上）
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
                          .filter((t) => !t.startsWith('立绘提示词:'))
                      : []
                    if (v.trim()) appearance.push(`立绘提示词:${v.trim()}`)
                    obj.appearance_tags = appearance
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
