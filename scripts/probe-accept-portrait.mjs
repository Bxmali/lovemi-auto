/**
 * Accept portrait candidate / bind cover for 朵莉亚, then set motion + publish.
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
const COVER = 'asset_8918'
const VIDEO = 'asset_8947'
function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(raw, 'base64')) : raw
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
  return { method, path: p, status: res.status, ok: res.ok, allow: res.headers.get('allow'), msg: String(data.message||data.detail||'').slice(0,220), issues: data.issues, snippet: JSON.stringify(data).slice(0,600) }
}
app.whenReady().then(async () => {
  app.dock?.hide()
  const out = { steps: [] }
  // full refs
  const refsRes = await undiciFetch(`${API}/v1/characters/${CHAR}/visual-references`, {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token(), Origin: 'https://app.lovemi.ai', Referer: 'https://app.lovemi.ai/' },
    dispatcher: new ProxyAgent(PROXY),
  })
  const refs = await refsRes.json()
  out.refs = refs

  const chRes = await undiciFetch(`${API}/v1/characters/${CHAR}`, {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token(), Origin: 'https://app.lovemi.ai', Referer: 'https://app.lovemi.ai/' },
    dispatcher: new ProxyAgent(PROXY),
  })
  const ch = await chRes.json()
  out.candidate = ch.latest_portrait_candidate

  const tryPaths = [
    [`POST`, `/v1/characters/${CHAR}/visual-references/${COVER}/accept`, {}],
    [`POST`, `/v1/characters/${CHAR}/visual-references/accept`, { asset_id: COVER }],
    [`PUT`, `/v1/characters/${CHAR}/visual-references/${COVER}`, { status: 'accepted' }],
    [`POST`, `/v1/characters/${CHAR}/portrait-candidates/${COVER}/accept`, {}],
    [`POST`, `/v1/characters/${CHAR}/latest-portrait-candidate/accept`, {}],
    [`PUT`, `/v1/characters/${CHAR}/latest-portrait-candidate`, { action: 'accept' }],
    [`POST`, `/v1/characters/${CHAR}/cover`, { asset_id: COVER }],
    [`PUT`, `/v1/characters/${CHAR}/cover`, { asset_id: COVER }],
    [`PUT`, `/v1/characters/${CHAR}`, { cover_asset_id: COVER }],
    [`PATCH`, `/v1/characters/${CHAR}`, { cover_asset_id: COVER }],
    [`PUT`, `/v1/characters/${CHAR}/assets/${COVER}`, { relation_type: 'cover' }],
    [`PUT`, `/v1/characters/${CHAR}/assets/${COVER}`, {}],
    [`POST`, `/v1/characters/${CHAR}/assets`, { asset_id: COVER, relation_type: 'cover' }],
  ]
  for (const [method, p, body] of tryPaths) {
    const r = await api(method, p, body)
    out.steps.push({ ...r, body })
  }

  // if any succeeded, try presentation + publish
  out.steps.push(await api('GET', `/v1/characters/${CHAR}/assets?scope=active`))
  const pres = await api('PUT', `/v1/characters/${CHAR}/presentation`, {
    asset_id: COVER,
    motion_asset_id: VIDEO,
    crop_x: 0.5, crop_y: 0.25, crop_zoom: 1,
    chat_background_crop_x: 0.5, chat_background_crop_y: 0.2, chat_background_crop_zoom: 1,
  })
  out.steps.push({ step: 'presentation', ...pres })

  if (pres.ok) {
    const draft = await api('PUT', `/v1/me/publications/by-source/character/${CHAR}/draft`, {
      listing_type: 'character_listing',
      title: `${ch.display_name || '朵莉亚'} · 22`,
      description: ch.profile_text || '',
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
    out.steps.push({ step: 'draft', ...draft })
    let listingId = draft.data?.listing?.listing_id || draft.data?.listing_id
    if (!listingId) {
      const pubs = await api('GET', `/v1/me/publications?listing_type=character_listing&source_object_type=character&source_object_ids=${CHAR}&limit=5`)
      out.steps.push({ step: 'pubs', ...pubs })
      try {
        const items = JSON.parse(pubs.snippet).items || []
        listingId = items[0]?.listing?.listing_id || items[0]?.listing_id
      } catch {}
    }
    // listing from earlier probe
    listingId = listingId || 'listing_AAS0E63adiNWjlKtDBwuOQ'
    const sub = await api('POST', `/v1/community-listings/${listingId}/publication-submissions`, {
      publication_scope: 'character',
      source_locale: 'zh-CN',
    })
    out.steps.push({ step: 'publish', listingId, ...sub })
    out.ok = sub.ok
  }

  fs.writeFileSync('/tmp/accept-portrait.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify({
    candidate: out.candidate,
    refs: out.refs,
    summary: out.steps.map(s => ({ step: s.step, method: s.method, path: s.path, status: s.status, ok: s.ok, msg: s.msg, issues: s.issues, snippet: (s.snippet||'').slice(0,200) })),
    ok: out.ok || false,
  }, null, 2))
  app.exit(0)
})
