/**
 * Find which PUT /draft field sets motion preview video.
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))
const PROXY = 'http://127.0.0.1:7897'
const API = 'https://api.lovemi.ai'
const CHAR = 'chr_V6x4xLrXVDMprGim1fb2tw'
const LISTING = 'listing_AAS0E63adiNWjlKtDBwuOQ'
const COVER = 'asset_8918'
const VIDEO = process.env.LOVEMI_VIDEO_ASSET_ID || 'asset_8947'
const SAGIRI = 'chr_RP69-2pjhJkbpeJM3rrLmQ'
const SAGIRI_LISTING = 'listing_9sizy-PEKMZ4ACn3iV5MnA'

function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
    : raw
  return JSON.parse(json).adminSessionToken
}

async function api(method, p, body) {
  const res = await undiciFetch(API + p, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + token(),
      Origin: 'https://app.lovemi.ai',
      Referer: 'https://app.lovemi.ai/',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    dispatcher: new ProxyAgent(PROXY),
    signal: AbortSignal.timeout(45000),
  })
  const data = await res.json().catch(() => ({}))
  return {
    method,
    path: p,
    status: res.status,
    ok: res.ok,
    msg: String(data.message || data.error || '').slice(0, 220),
    issues: data.issues,
    keys: Object.keys(data || {}).slice(0, 40),
    snippet: JSON.stringify(data).slice(0, 900),
  }
}

function baseDraft(extra = {}) {
  return {
    listing_type: 'character_listing',
    title: '朵莉亚 · 22',
    description: 'e2e motion preview probe',
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
    ...extra,
  }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const out = { video: VIDEO, probes: [] }

  // reference: sagiri listing + draft-assets + publication
  out.probes.push(await api('GET', `/v1/community-listings/${SAGIRI_LISTING}`))
  out.probes.push(await api('GET', `/v1/community-listings/${SAGIRI_LISTING}/draft-assets`))
  out.probes.push(
    await api(
      'GET',
      `/v1/me/publications?listing_type=character_listing&source_object_type=character&source_object_ids=${SAGIRI}&limit=3`,
    ),
  )
  out.probes.push(await api('GET', `/v1/community-listings/${LISTING}`))
  out.probes.push(await api('GET', `/v1/assets/${VIDEO}`))

  const fieldVariants = [
    { motion_preview_asset_id: VIDEO },
    { preview_asset_id: VIDEO },
    { motion_asset_id: VIDEO },
    { gallery_asset_id: VIDEO },
    { preview_video_asset_id: VIDEO },
    { video_asset_id: VIDEO },
    { motion_preview_asset: VIDEO },
    { preview_assets: [VIDEO] },
    { preview_asset_ids: [VIDEO] },
    { gallery_asset_ids: [VIDEO] },
    { motion_preview: { asset_id: VIDEO } },
    { clear_motion_preview: false, motion_preview_asset_id: VIDEO },
    { preview_mode: 'full', motion_preview_asset_id: VIDEO },
    { cover_asset_id: COVER, gallery_assets: [{ asset_id: VIDEO, relation_type: 'gallery' }] },
    { assets: [{ asset_id: VIDEO, relation_type: 'gallery' }] },
    { draft_assets: [{ asset_id: VIDEO, relation_type: 'gallery' }] },
  ]

  for (const extra of fieldVariants) {
    const r = await api('PUT', `/v1/me/publications/by-source/character/${CHAR}/draft`, baseDraft(extra))
    out.probes.push({
      step: 'put_draft',
      extraKeys: Object.keys(extra),
      status: r.status,
      ok: r.ok,
      msg: r.msg,
      issues: r.issues,
      snippet: r.snippet.slice(0, 350),
    })
    if (r.ok) {
      const da = await api('GET', `/v1/community-listings/${LISTING}/draft-assets`)
      out.probes.push({
        step: 'draft_assets_check',
        after: Object.keys(extra),
        status: da.status,
        snippet: da.snippet.slice(0, 500),
        itemCount: (da.snippet.match(/asset_id/g) || []).length,
      })
      // try publish once if video appears
      if (da.snippet.includes(VIDEO) || da.snippet.includes('video')) {
        const sub = await api('POST', `/v1/community-listings/${LISTING}/publication-submissions`, {
          publication_scope: 'character',
          source_locale: 'zh-CN',
        })
        out.probes.push({ step: 'publish_try', status: sub.status, ok: sub.ok, msg: sub.msg, snippet: sub.snippet })
        if (sub.ok) {
          out.ok = true
          out.winningFields = Object.keys(extra)
          break
        }
      }
    }
  }

  // also try PATCH listing
  for (const body of [
    { motion_preview_asset_id: VIDEO },
    { preview_asset_id: VIDEO },
    { cover_asset_id: COVER, motion_preview_asset_id: VIDEO },
  ]) {
    for (const method of ['PATCH', 'PUT', 'POST']) {
      const r = await api(method, `/v1/community-listings/${LISTING}`, body)
      out.probes.push({
        step: 'listing_write',
        method,
        bodyKeys: Object.keys(body),
        status: r.status,
        ok: r.ok,
        msg: r.msg,
        allow: r.allow,
        snippet: r.snippet.slice(0, 250),
      })
    }
  }

  fs.writeFileSync('/tmp/motion-preview-field.json', JSON.stringify(out, null, 2))
  console.log(
    JSON.stringify(
      {
        ok: out.ok || false,
        winningFields: out.winningFields || null,
        summary: out.probes.map((p) => ({
          step: p.step || p.method + ' ' + (p.path || ''),
          extraKeys: p.extraKeys,
          status: p.status,
          ok: p.ok,
          msg: p.msg,
          issues: p.issues,
          snippet: (p.snippet || '').slice(0, 180),
        })),
      },
      null,
      2,
    ),
  )
  app.exit(0)
})
