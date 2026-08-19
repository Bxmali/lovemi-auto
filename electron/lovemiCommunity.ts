import { createHash, randomUUID } from 'node:crypto'
import { fetch as undiciFetch } from 'undici'
import { dispatcherFor } from './mailProbe'

const API_BASE = 'https://api.lovemi.ai'

function headers(bearer: string, extra?: Record<string, string>) {
  return {
    Accept: 'application/json',
    'Accept-Language': 'zh-CN',
    Authorization: `Bearer ${bearer}`,
    Origin: 'https://app.lovemi.ai',
    Referer: 'https://app.lovemi.ai/',
    ...extra,
  }
}

async function parseJson(res: Response | Awaited<ReturnType<typeof undiciFetch>>) {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const msg =
      (typeof data.message === 'string' && data.message) ||
      (typeof data.error === 'string' && data.error) ||
      (typeof data.error_code === 'string' && data.error_code) ||
      `HTTP ${res.status}`
    return { ok: false as const, status: res.status, data, error: msg }
  }
  return { ok: true as const, status: res.status, data }
}

export type ListingItem = {
  listing_id: string
  asset_id: string
  title: string
  viewer_liked?: boolean
  listing_kind?: 'character' | 'explore'
  raw: Record<string, unknown>
}

export function pickListingFields(item: Record<string, unknown>): ListingItem | null {
  const listingId = String(item.listing_id || '')
  const engagement = (item.engagement || {}) as Record<string, unknown>
  const preview = Array.isArray(item.preview_assets)
    ? (item.preview_assets[0] as Record<string, unknown> | undefined)
    : undefined
  const assetId = String(engagement.asset_id || preview?.asset_id || '')
  if (!listingId || !assetId.startsWith('pubasset_')) return null
  const characters = Array.isArray(item.characters) ? item.characters : []
  const c0 = (characters[0] || {}) as Record<string, unknown>
  const title = String(
    item.title || c0.display_name || c0.name || listingId,
  )
  return {
    listing_id: listingId,
    asset_id: assetId,
    title,
    viewer_liked: Boolean(engagement.viewer_liked),
    listing_kind: 'character',
    raw: item,
  }
}

/** Explore 短视频/图文混流条目 */
export function pickExploreFields(item: Record<string, unknown>): ListingItem | null {
  const listing = (item.listing || {}) as Record<string, unknown>
  const media = (item.media || {}) as Record<string, unknown>
  const engagement = (item.engagement || {}) as Record<string, unknown>
  const creator = (item.creator || {}) as Record<string, unknown>
  const listingId = String(listing.listing_id || media.listing_id || '')
  const assetId = String(media.asset_id || engagement.asset_id || '')
  if (!listingId || !assetId.startsWith('pubasset_')) return null
  const title = String(
    listing.title || creator.display_name || media.asset_kind || listingId,
  )
  return {
    listing_id: listingId,
    asset_id: assetId,
    title,
    viewer_liked: Boolean(engagement.viewer_liked),
    listing_kind: 'explore',
    raw: item,
  }
}

function fetchErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = 'cause' in err ? (err as Error & { cause?: Error & { code?: string } }).cause : undefined
  const parts = [err.message]
  if (cause?.code) parts.push(cause.code)
  if (cause?.message && cause.message !== err.message) parts.push(cause.message)
  return parts.filter(Boolean).join(' · ')
}

export async function fetchCommunityListings(input: {
  sessionToken: string
  proxyUrl: string
  page?: number
  limit?: number
  genderExpression?: string
  characterSort?: string
}): Promise<{ ok: boolean; error?: string; items: ListingItem[]; page: number }> {
  const page = input.page ?? 1
  const limit = input.limit ?? 21
  const gender = input.genderExpression ?? 'female'
  const sort = input.characterSort ?? 'popular_week'
  const path = `/v1/community-listings?scope=public&listing_type=character_listing&page=${page}&limit=${limit}&gender_expression=${encodeURIComponent(gender)}&character_sort=${encodeURIComponent(sort)}`
  const url = `${API_BASE}${path}`
  try {
    const res = await undiciFetch(url, {
      method: 'GET',
      headers: headers(input.sessionToken),
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(25_000),
    })
    const parsed = await parseJson(res)
    if (!parsed.ok) return { ok: false, error: parsed.error, items: [], page }
    const rawItems = Array.isArray(parsed.data.items) ? (parsed.data.items as Record<string, unknown>[]) : []
    const items = rawItems.map(pickListingFields).filter(Boolean) as ListingItem[]
    return { ok: true, items, page }
  } catch (err) {
    return {
      ok: false,
      error: fetchErrorMessage(err),
      items: [],
      page,
    }
  }
}

/** 社区 Explore（图+视频混流）；cursor 翻页 */
export async function fetchCommunityExplore(input: {
  sessionToken: string
  proxyUrl: string
  sort?: string
  limit?: number
  cursor?: string
}): Promise<{
  ok: boolean
  error?: string
  items: ListingItem[]
  nextCursor?: string
  sort: string
}> {
  const sort = input.sort ?? 'recommended'
  const limit = input.limit ?? 20
  const qs = new URLSearchParams({
    sort,
    limit: String(limit),
  })
  if (input.cursor) qs.set('cursor', input.cursor)
  const path = `/v1/community/explore?${qs.toString()}`
  const url = `${API_BASE}${path}`
  try {
    const res = await undiciFetch(url, {
      method: 'GET',
      headers: headers(input.sessionToken),
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(25_000),
    })
    const parsed = await parseJson(res)
    if (!parsed.ok) return { ok: false, error: parsed.error, items: [], sort }
    const rawItems = Array.isArray(parsed.data.items) ? (parsed.data.items as Record<string, unknown>[]) : []
    const items = rawItems.map(pickExploreFields).filter(Boolean) as ListingItem[]
    const nextCursor = parsed.data.next_cursor ? String(parsed.data.next_cursor) : undefined
    return { ok: true, items, nextCursor, sort }
  } catch (err) {
    return { ok: false, error: fetchErrorMessage(err), items: [], sort }
  }
}

export async function likeListingAsset(input: {
  sessionToken: string
  proxyUrl: string
  listingId: string
  assetId: string
}): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
  const path = `/v1/community-listings/${input.listingId}/assets/${input.assetId}/likes`
  const url = `${API_BASE}${path}`
  try {
    const res = await undiciFetch(url, {
      method: 'PUT',
      headers: { ...headers(input.sessionToken), 'Content-Type': 'application/json' },
      body: '{}',
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(25_000),
    })
    const parsed = await parseJson(res)
    if (!parsed.ok) return { ok: false, error: parsed.error, data: parsed.data }
    return { ok: true, data: parsed.data }
  } catch (err) {
    return { ok: false, error: fetchErrorMessage(err) }
  }
}

export async function commentListingAsset(input: {
  sessionToken: string
  proxyUrl: string
  listingId: string
  assetId: string
  body: string
  idempotencyKey?: string
}): Promise<{ ok: boolean; error?: string; commentId?: string; data?: Record<string, unknown> }> {
  const path = `/v1/community-listings/${input.listingId}/assets/${input.assetId}/comments`
  const url = `${API_BASE}${path}`
  const idem =
    input.idempotencyKey ||
    `asset-comment:${input.listingId}:${input.assetId}:${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 32)}`
  try {
    const res = await undiciFetch(url, {
      method: 'POST',
      headers: {
        ...headers(input.sessionToken),
        'Content-Type': 'application/json',
        'Idempotency-Key': idem,
      },
      body: JSON.stringify({ body: input.body }),
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(25_000),
    })
    const parsed = await parseJson(res)
    if (!parsed.ok) return { ok: false, error: parsed.error, data: parsed.data }
    const commentId = String(parsed.data.comment_id || parsed.data.id || '')
    return { ok: true, commentId: commentId || undefined, data: parsed.data }
  } catch (err) {
    return { ok: false, error: fetchErrorMessage(err) }
  }
}

export async function getCreatorProfile(input: {
  sessionToken: string
  proxyUrl: string
}): Promise<{ ok: boolean; error?: string; displayName?: string; data?: Record<string, unknown> }> {
  const url = `${API_BASE}/v1/me/creator-profile`
  try {
    const res = await undiciFetch(url, {
      method: 'GET',
      headers: headers(input.sessionToken),
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(25_000),
    })
    const parsed = await parseJson(res)
    if (!parsed.ok) return { ok: false, error: parsed.error, data: parsed.data }
    return {
      ok: true,
      displayName: typeof parsed.data.display_name === 'string' ? parsed.data.display_name : undefined,
      data: parsed.data,
    }
  } catch (err) {
    return { ok: false, error: fetchErrorMessage(err) }
  }
}

export async function patchCreatorProfile(input: {
  sessionToken: string
  proxyUrl: string
  displayName: string
}): Promise<{ ok: boolean; error?: string; displayName?: string; data?: Record<string, unknown> }> {
  const url = `${API_BASE}/v1/me/creator-profile`
  try {
    const res = await undiciFetch(url, {
      method: 'PATCH',
      headers: { ...headers(input.sessionToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: input.displayName }),
      dispatcher: dispatcherFor(input.proxyUrl, url),
      signal: AbortSignal.timeout(25_000),
    })
    const parsed = await parseJson(res)
    if (!parsed.ok) return { ok: false, error: parsed.error, data: parsed.data }
    return {
      ok: true,
      displayName: typeof parsed.data.display_name === 'string' ? parsed.data.display_name : input.displayName,
      data: parsed.data,
    }
  } catch (err) {
    return { ok: false, error: fetchErrorMessage(err) }
  }
}
