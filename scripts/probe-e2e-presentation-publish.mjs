/**
 * E2E with correct motion attach:
 * PUT /v1/characters/{id}/presentation { asset_id, motion_asset_id }
 * PUT /v1/me/publications/.../draft
 * POST .../publication-submissions
 *
 * LOVEMI_PROXY=http://127.0.0.1:7897 LOVEMI_DO_PUBLISH=1 \
 * env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-e2e-presentation-publish.mjs
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7897'
const API = 'https://api.lovemi.ai'
const CHAR = process.env.LOVEMI_CHAR_ID || 'chr_V6x4xLrXVDMprGim1fb2tw'
const COVER = process.env.LOVEMI_COVER_ASSET_ID || 'asset_8918'
const VIDEO = process.env.LOVEMI_VIDEO_ASSET_ID || 'asset_8947'
const DO_PUBLISH = process.env.LOVEMI_DO_PUBLISH !== '0'

function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
    : raw
  return JSON.parse(json).adminSessionToken
}

async function api(method, p, body) {
  const res = await undiciFetch(`${API}${p}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token()}`,
      Origin: 'https://app.lovemi.ai',
      Referer: 'https://app.lovemi.ai/',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    dispatcher: new ProxyAgent(PROXY),
    signal: AbortSignal.timeout(60000),
  })
  const data = await res.json().catch(() => ({}))
  return {
    method,
    path: p,
    status: res.status,
    ok: res.ok,
    msg: String(data.message || data.detail || data.error || '').slice(0, 240),
    issues: data.issues,
    keys: Object.keys(data || {}).slice(0, 30),
    snippet: JSON.stringify(data).slice(0, 700),
    data,
  }
}

function listingIdFrom(data) {
  if (!data || typeof data !== 'object') return ''
  if (typeof data.listing_id === 'string') return data.listing_id
  if (data.listing && typeof data.listing.listing_id === 'string') return data.listing.listing_id
  if (Array.isArray(data.items) && data.items[0]) {
    const first = data.items[0]
    if (typeof first.listing_id === 'string') return first.listing_id
    if (first.listing && typeof first.listing.listing_id === 'string') return first.listing.listing_id
  }
  return ''
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const out = { char: CHAR, cover: COVER, video: VIDEO, doPublish: DO_PUBLISH, steps: [] }

  const charGet = await api('GET', `/v1/characters/${encodeURIComponent(CHAR)}`)
  out.steps.push({
    step: 'get_character',
    status: charGet.status,
    ok: charGet.ok,
    name: charGet.data.display_name,
  })

  const presentation = await api('PUT', `/v1/characters/${encodeURIComponent(CHAR)}/presentation`, {
    asset_id: COVER,
    crop_x: 0.5,
    crop_y: 0.25,
    crop_zoom: 1,
    chat_background_crop_x: 0.5,
    chat_background_crop_y: 0.2,
    chat_background_crop_zoom: 1,
    motion_asset_id: VIDEO,
  })
  out.steps.push({
    step: 'put_presentation',
    status: presentation.status,
    ok: presentation.ok,
    msg: presentation.msg,
    keys: presentation.keys,
    snippet: presentation.snippet,
  })
  if (!presentation.ok) {
    out.error = presentation.msg || 'presentation failed'
    console.log(JSON.stringify(out, null, 2))
    app.exit(1)
    return
  }

  const title = `${charGet.data.display_name || '角色'} · e2e`
  const draft = await api('PUT', `/v1/me/publications/by-source/character/${encodeURIComponent(CHAR)}/draft`, {
    listing_type: 'character_listing',
    title,
    description:
      (typeof charGet.data.profile_text === 'string' && charGet.data.profile_text) ||
      'LovemiAuto e2e presentation + publish',
    adult_content: true,
    clear_cover_asset: false,
    clear_description: false,
    content_rating: 'adult',
    cover_asset_id: COVER,
    preview_mode: 'full',
    price_coins: 0,
    pricing_mode: 'free',
    supported_lab_apps: ['companion', 'intimacy_lab', 'galgame', 'adult_film_director'],
    tags: [],
  })
  let listingId = listingIdFrom(draft.data)
  out.steps.push({
    step: 'put_draft',
    status: draft.status,
    ok: draft.ok,
    msg: draft.msg,
    listingId: listingId || null,
    snippet: draft.snippet,
  })
  if (!draft.ok) {
    out.error = draft.msg || 'draft failed'
    console.log(JSON.stringify(out, null, 2))
    app.exit(1)
    return
  }

  if (!listingId) {
    const pubs = await api(
      'GET',
      `/v1/me/publications?listing_type=character_listing&source_object_type=character&source_object_ids=${encodeURIComponent(CHAR)}&limit=5`,
    )
    listingId = listingIdFrom(pubs.data)
    out.steps.push({ step: 'resolve_listing', status: pubs.status, listingId: listingId || null })
  }
  out.listingId = listingId || null

  if (listingId) {
    const da = await api('GET', `/v1/community-listings/${encodeURIComponent(listingId)}/draft-assets`)
    const items = Array.isArray(da.data.items) ? da.data.items : []
    out.steps.push({
      step: 'draft_assets',
      status: da.status,
      ok: da.ok,
      items: items.map((it) => ({
        asset_id: it.asset_id,
        kind: it.asset_kind,
        relation: it.relation_type,
      })),
    })
  }

  if (DO_PUBLISH) {
    if (!listingId) {
      out.error = 'no listingId'
      console.log(JSON.stringify(out, null, 2))
      app.exit(1)
      return
    }
    const sub = await api(
      'POST',
      `/v1/community-listings/${encodeURIComponent(listingId)}/publication-submissions`,
      { publication_scope: 'character', source_locale: 'zh-CN' },
    )
    out.steps.push({
      step: 'publish',
      status: sub.status,
      ok: sub.ok,
      msg: sub.msg,
      issues: sub.issues,
      snippet: sub.snippet,
    })
    out.publishOk = sub.ok
    if (!sub.ok) {
      out.error = sub.msg || 'publish failed'
      console.log(JSON.stringify(out, null, 2))
      app.exit(1)
      return
    }
  }

  out.ok = true
  fs.writeFileSync('/tmp/e2e-presentation-publish.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
  app.exit(0)
})
