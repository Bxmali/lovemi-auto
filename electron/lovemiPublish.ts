import { fetch as undiciFetch } from 'undici'
import { dispatcherFor } from './mailProbe'
import { loadCreateCharSecrets } from './createCharSecrets'
import { appendConsoleLog } from './consoleDb'

const LOVEMI = 'https://api.lovemi.ai'

function headers(token: string, extra?: Record<string, string>) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: 'https://app.lovemi.ai',
    Referer: 'https://app.lovemi.ai/',
    'Accept-Language': 'zh-CN',
    ...extra,
  }
}

async function apiJson(input: {
  method: string
  path: string
  token: string
  proxyUrl: string
  body?: Record<string, unknown>
}): Promise<{ ok: boolean; status: number; data: Record<string, unknown>; error?: string }> {
  const url = `${LOVEMI}${input.path}`
  try {
    const res = await undiciFetch(url, {
      method: input.method,
      headers: headers(input.token, input.body ? { 'Content-Type': 'application/json' } : undefined),
      body: input.body ? JSON.stringify(input.body) : undefined,
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(60_000),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const msg =
        (typeof data.message === 'string' && data.message) ||
        (typeof data.error === 'string' && data.error) ||
        (typeof data.detail === 'string' && data.detail) ||
        `HTTP ${res.status}`
      return { ok: false, status: res.status, data, error: msg }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, data: {}, error: err instanceof Error ? err.message : String(err) }
  }
}

function adminToken(fallback?: string) {
  const secrets = loadCreateCharSecrets()
  return secrets.adminSessionToken || fallback || ''
}

export async function listMineCharacters(input: {
  proxyUrl: string
  sessionToken?: string
  page?: number
  limit?: number
}): Promise<{ ok: boolean; error?: string; items?: Record<string, unknown>[] }> {
  const token = adminToken(input.sessionToken)
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }
  const page = input.page ?? 1
  const limit = input.limit ?? 21
  const res = await apiJson({
    method: 'GET',
    path: `/v1/characters?scope=mine&page=${page}&limit=${limit}&gender_expression=female`,
    token,
    proxyUrl: input.proxyUrl,
  })
  if (!res.ok) return { ok: false, error: res.error }
  const items = Array.isArray(res.data.items) ? (res.data.items as Record<string, unknown>[]) : []
  return { ok: true, items }
}

export async function getPublicationsForCharacters(input: {
  proxyUrl: string
  sessionToken?: string
  characterIds: string[]
}): Promise<{ ok: boolean; error?: string; items?: Record<string, unknown>[] }> {
  const token = adminToken(input.sessionToken)
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }
  const ids = input.characterIds.filter(Boolean).slice(0, 40)
  if (!ids.length) return { ok: true, items: [] }
  const q = new URLSearchParams({
    listing_type: 'character_listing',
    source_object_type: 'character',
    source_object_ids: ids.join(','),
    limit: String(Math.max(ids.length, 5)),
  })
  const res = await apiJson({
    method: 'GET',
    path: `/v1/me/publications?${q.toString()}`,
    token,
    proxyUrl: input.proxyUrl,
  })
  if (!res.ok) return { ok: false, error: res.error }
  const items = Array.isArray(res.data.items) ? (res.data.items as Record<string, unknown>[]) : []
  return { ok: true, items }
}

export async function listCharacterAssets(input: {
  characterId: string
  proxyUrl: string
  sessionToken?: string
}): Promise<{ ok: boolean; error?: string; items?: Record<string, unknown>[] }> {
  const token = adminToken(input.sessionToken)
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }
  const res = await apiJson({
    method: 'GET',
    path: `/v1/characters/${encodeURIComponent(input.characterId)}/assets?scope=active`,
    token,
    proxyUrl: input.proxyUrl,
  })
  if (!res.ok) return { ok: false, error: res.error }
  const items = Array.isArray(res.data.items) ? (res.data.items as Record<string, unknown>[]) : []
  return { ok: true, items }
}

export function pickListingIdFromPublication(item: Record<string, unknown>): string | undefined {
  const listing = item.listing as Record<string, unknown> | undefined
  if (listing && typeof listing.listing_id === 'string') return listing.listing_id
  if (typeof item.listing_id === 'string') return item.listing_id
  return undefined
}

function pickListingIdFromDraftData(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined
  if (typeof data.listing_id === 'string' && data.listing_id.startsWith('listing_')) return data.listing_id
  const listing = data.listing as Record<string, unknown> | undefined
  if (listing && typeof listing.listing_id === 'string') return listing.listing_id
  const nested = data.publication as Record<string, unknown> | undefined
  if (nested) {
    if (typeof nested.listing_id === 'string') return nested.listing_id
    const nl = nested.listing as Record<string, unknown> | undefined
    if (nl && typeof nl.listing_id === 'string') return nl.listing_id
  }
  // 深挖一层
  const blob = JSON.stringify(data)
  const m = blob.match(/listing_[A-Za-z0-9_-]+/)
  return m?.[0]
}

async function resolveListingIdForCharacter(input: {
  characterId: string
  proxyUrl: string
  token: string
  preferred?: string
  draftData?: Record<string, unknown>
}): Promise<string | undefined> {
  const fromDraft = pickListingIdFromDraftData(input.draftData)
  if (fromDraft) return fromDraft

  const pubs = await getPublicationsForCharacters({
    proxyUrl: input.proxyUrl,
    sessionToken: input.token,
    characterIds: [input.characterId],
  })
  const items = pubs.items || []
  // 优先匹配 source 属于本角色的 listing
  for (const it of items) {
    const src =
      (typeof it.source_object_id === 'string' && it.source_object_id) ||
      (typeof (it.source as Record<string, unknown> | undefined)?.object_id === 'string' &&
        String((it.source as Record<string, unknown>).object_id)) ||
      ''
    const lid = pickListingIdFromPublication(it)
    if (lid && (!src || src === input.characterId || src.includes(input.characterId))) return lid
  }
  const first = items[0] ? pickListingIdFromPublication(items[0]) : undefined
  if (first) return first

  // 仅当 preferred 与本角色 publications 对得上时才用（防三槽串 listing）
  if (input.preferred?.startsWith('listing_')) {
    const hit = items.some((it) => pickListingIdFromPublication(it) === input.preferred)
    if (hit) return input.preferred
  }
  return undefined
}

/** 设发布草稿预览：PUT by-source/.../draft（封面 + preview_mode） */
export async function putPublicationDraft(input: {
  characterId: string
  proxyUrl: string
  sessionToken?: string
  body: Record<string, unknown>
}): Promise<{ ok: boolean; error?: string; status?: number; data?: Record<string, unknown> }> {
  const token = adminToken(input.sessionToken)
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }
  const res = await apiJson({
    method: 'PUT',
    path: `/v1/me/publications/by-source/character/${encodeURIComponent(input.characterId)}/draft`,
    token,
    proxyUrl: input.proxyUrl,
    body: input.body,
  })
  if (res.ok) {
    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `已更新发布草稿预览 · ${input.characterId.slice(0, 18)}`,
    })
  }
  return res.ok
    ? { ok: true, status: res.status, data: res.data }
    : { ok: false, error: res.error, status: res.status, data: res.data }
}

/**
 * 接受立绘候选（pending → accepted），否则 presentation 会 CHARACTER_ASSET_NOT_FOUND
 * POST /v1/characters/{id}/visual-references/{asset_id}/accept
 */
export async function acceptVisualReference(input: {
  characterId: string
  assetId: string
  proxyUrl: string
  sessionToken?: string
}): Promise<{ ok: boolean; error?: string; status?: number; data?: Record<string, unknown> }> {
  const token = adminToken(input.sessionToken)
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }
  const res = await apiJson({
    method: 'POST',
    path: `/v1/characters/${encodeURIComponent(input.characterId)}/visual-references/${encodeURIComponent(input.assetId)}/accept`,
    token,
    proxyUrl: input.proxyUrl,
    body: {},
  })
  if (res.ok) {
    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `已接受立绘 ${input.assetId}`,
    })
  }
  // 已接受时可能 4xx，调用方可忽略
  return res.ok
    ? { ok: true, status: res.status, data: res.data }
    : { ok: false, error: res.error, status: res.status, data: res.data }
}

/**
 * 设角色展示：封面 + 动态预览视频
 * PUT /v1/characters/{id}/presentation
 * body: { asset_id, motion_asset_id? | clear_motion_asset?, crop_*, chat_background_crop_* }
 * （draft-assets 只读；挂视频靠这条）
 */
export async function putCharacterPresentation(input: {
  characterId: string
  proxyUrl: string
  sessionToken?: string
  coverAssetId: string
  motionAssetId?: string
  clearMotionAsset?: boolean
  cropX?: number
  cropY?: number
  cropZoom?: number
  chatBackgroundCropX?: number
  chatBackgroundCropY?: number
  chatBackgroundCropZoom?: number
}): Promise<{ ok: boolean; error?: string; status?: number; data?: Record<string, unknown> }> {
  const token = adminToken(input.sessionToken)
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }
  const body: Record<string, unknown> = {
    asset_id: input.coverAssetId,
    crop_x: input.cropX ?? 0.5,
    crop_y: input.cropY ?? 0.25,
    crop_zoom: input.cropZoom ?? 1,
    chat_background_crop_x: input.chatBackgroundCropX ?? 0.5,
    chat_background_crop_y: input.chatBackgroundCropY ?? 0.2,
    chat_background_crop_zoom: input.chatBackgroundCropZoom ?? 1,
  }
  if (input.motionAssetId) body.motion_asset_id = input.motionAssetId
  else if (input.clearMotionAsset !== false) body.clear_motion_asset = true
  const res = await apiJson({
    method: 'PUT',
    path: `/v1/characters/${encodeURIComponent(input.characterId)}/presentation`,
    token,
    proxyUrl: input.proxyUrl,
    body,
  })
  if (res.ok) {
    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `已设 presentation 封面${input.motionAssetId ? '+动态视频' : ''} · ${input.characterId.slice(0, 18)}`,
    })
  }
  return res.ok
    ? { ok: true, status: res.status, data: res.data }
    : { ok: false, error: res.error, status: res.status, data: res.data }
}

export async function submitPublication(input: {
  listingId: string
  proxyUrl: string
  sessionToken?: string
  sourceLocale?: string
}): Promise<{ ok: boolean; error?: string; status?: number; data?: Record<string, unknown> }> {
  const token = adminToken(input.sessionToken)
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }
  const res = await apiJson({
    method: 'POST',
    path: `/v1/community-listings/${encodeURIComponent(input.listingId)}/publication-submissions`,
    token,
    proxyUrl: input.proxyUrl,
    body: {
      publication_scope: 'character',
      source_locale: input.sourceLocale || 'zh-CN',
    },
  })
  if (res.ok) {
    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `已提交发布 · ${input.listingId}`,
    })
  }
  return res.ok
    ? { ok: true, status: res.status, data: res.data }
    : { ok: false, error: res.error, status: res.status, data: res.data }
}

/**
 * 设预览并可选发布：
 * 0) 如有需要：accept visual-reference（pending 立绘）
 * 1) PUT /v1/characters/{id}/presentation（封面 + motion_asset_id | clear_motion_asset）
 * 2) PUT /v1/me/publications/.../draft
 * 3) 可选 POST .../publication-submissions
 */
export async function setPreviewAndMaybePublish(input: {
  characterId: string
  proxyUrl: string
  sessionToken?: string
  coverAssetId: string
  videoAssetId?: string
  title?: string
  description?: string
  tags?: string[]
  publish?: boolean
  listingId?: string
  skipAcceptVisualRef?: boolean
}): Promise<{
  ok: boolean
  error?: string
  listingId?: string
  draftOk?: boolean
  presentationOk?: boolean
  acceptOk?: boolean
  videoAttachOk?: boolean
  publishOk?: boolean
  data?: Record<string, unknown>
}> {
  const token = adminToken(input.sessionToken)
  if (!token) return { ok: false, error: '缺少管理员 Bearer' }

  let acceptOk: boolean | undefined
  if (!input.skipAcceptVisualRef) {
    const acc = await acceptVisualReference({
      characterId: input.characterId,
      assetId: input.coverAssetId,
      proxyUrl: input.proxyUrl,
      sessionToken: token,
    })
    acceptOk = acc.ok
    // 已接受 / 非 visual-ref 时可能失败，不阻断（后面 presentation 会再报错）
  }

  // 1) presentation：封面 + 动态视频（或 clear_motion）
  const presentation = await putCharacterPresentation({
    characterId: input.characterId,
    proxyUrl: input.proxyUrl,
    sessionToken: token,
    coverAssetId: input.coverAssetId,
    motionAssetId: input.videoAssetId,
    clearMotionAsset: !input.videoAssetId,
  })
  if (!presentation.ok) {
    // 有视频但挂不上时，降级为仅封面（仍可发布）
    if (input.videoAssetId) {
      const fallback = await putCharacterPresentation({
        characterId: input.characterId,
        proxyUrl: input.proxyUrl,
        sessionToken: token,
        coverAssetId: input.coverAssetId,
        clearMotionAsset: true,
      })
      if (!fallback.ok) {
        return {
          ok: false,
          error: presentation.error || '设 presentation 失败',
          acceptOk,
          presentationOk: false,
          videoAttachOk: false,
          data: presentation.data,
        }
      }
      appendConsoleLog({
        level: 'warn',
        action: 'create_char',
        message: `动态视频未能挂上（${presentation.error}），已用仅封面 presentation`,
      })
    } else {
      return {
        ok: false,
        error: presentation.error || '设 presentation 失败',
        acceptOk,
        presentationOk: false,
        data: presentation.data,
      }
    }
  }

  const videoAttachOk = input.videoAssetId ? presentation.ok : undefined

  // 2) publication draft（务必先写草稿，再从草稿响应抠本角色 listing，禁止用其它槽残留的 listingId）
  const draftBody: Record<string, unknown> = {
    listing_type: 'character_listing',
    title: input.title || '未命名角色',
    description: input.description || '',
    adult_content: true,
    clear_cover_asset: false,
    clear_description: false,
    content_rating: 'adult',
    cover_asset_id: input.coverAssetId,
    preview_mode: 'full',
    price_coins: 0,
    pricing_mode: 'free',
    supported_lab_apps: ['companion', 'intimacy_lab', 'galgame', 'adult_film_director'],
    tags: input.tags || [],
  }

  const draft = await putPublicationDraft({
    characterId: input.characterId,
    proxyUrl: input.proxyUrl,
    sessionToken: token,
    body: draftBody,
  })
  if (!draft.ok) {
    return {
      ok: false,
      error: draft.error || '更新草稿失败',
      acceptOk,
      presentationOk: true,
      videoAttachOk,
      draftOk: false,
      data: draft.data,
    }
  }

  const listingId = await resolveListingIdForCharacter({
    characterId: input.characterId,
    proxyUrl: input.proxyUrl,
    token,
    preferred: input.listingId,
    draftData: draft.data,
  })

  if (input.publish) {
    if (!listingId) {
      return {
        ok: false,
        error: '草稿已写，但找不到本角色 listing_id，无法提交发布（请勿使用其它槽残留 listing）',
        acceptOk,
        presentationOk: true,
        draftOk: true,
        videoAttachOk,
      }
    }
    if (input.listingId && input.listingId !== listingId) {
      appendConsoleLog({
        level: 'warn',
        action: 'create_char',
        message: `忽略串槽 listing ${input.listingId}，改用本角色 ${listingId}`,
      })
    }
    const sub = await submitPublication({
      listingId,
      proxyUrl: input.proxyUrl,
      sessionToken: token,
    })
    if (!sub.ok) {
      appendConsoleLog({
        level: 'error',
        action: 'create_char',
        message: `提交发布失败 · ${listingId} · ${sub.error || ''}`,
      })
      return {
        ok: false,
        error: sub.error || '提交发布失败',
        listingId,
        acceptOk,
        presentationOk: true,
        draftOk: true,
        videoAttachOk,
        publishOk: false,
        data: sub.data,
      }
    }
    appendConsoleLog({
      level: 'info',
      action: 'create_char',
      message: `已提交发布 · ${listingId} · 角色 ${input.characterId.slice(0, 18)}${input.videoAssetId ? ' · 含动态视频' : ''}`,
    })
    return {
      ok: true,
      listingId,
      acceptOk,
      presentationOk: true,
      draftOk: true,
      videoAttachOk,
      publishOk: true,
      data: sub.data,
    }
  }

  return {
    ok: true,
    listingId,
    acceptOk,
    presentationOk: true,
    draftOk: true,
    videoAttachOk,
  }
}
