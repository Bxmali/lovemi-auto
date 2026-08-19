/**
 * After cover accepted: bind motion video + presentation + publish for 朵莉亚.
 */
import { app, safeStorage } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))
const PROXY = 'http://127.0.0.1:7897'
const API = 'https://api.lovemi.ai'
const CHAR = 'chr_V6x4xLrXVDMprGim1fb2tw'
const COVER = 'asset_8918'
const VIDEO = 'asset_8947'
const LISTING = 'listing_AAS0E63adiNWjlKtDBwuOQ'
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
  return { method, path: p, status: res.status, ok: res.ok, allow: res.headers.get('allow'), msg: String(data.message||data.detail||'').slice(0,220), issues: data.issues, snippet: JSON.stringify(data).slice(0,500) }
}
app.whenReady().then(async () => {
  app.dock?.hide()
  const out = { steps: [] }
  out.steps.push({ step: 'assets_before', ...(await api('GET', `/v1/characters/${CHAR}/assets?scope=active`)) })

  // cover-only presentation
  out.steps.push({
    step: 'pres_clear_motion',
    ...(await api('PUT', `/v1/characters/${CHAR}/presentation`, {
      asset_id: COVER,
      clear_motion_asset: true,
      crop_x: 0.5, crop_y: 0.25, crop_zoom: 1,
      chat_background_crop_x: 0.5, chat_background_crop_y: 0.2, chat_background_crop_zoom: 1,
    })),
  })

  // try bind video
  const bindTries = [
    ['PUT', `/v1/characters/${CHAR}/assets/${VIDEO}`, { relation_type: 'gallery' }],
    ['PUT', `/v1/characters/${CHAR}/assets/${VIDEO}`, { relation_type: 'motion' }],
    ['PUT', `/v1/characters/${CHAR}/assets/${VIDEO}`, {}],
    ['POST', `/v1/characters/${CHAR}/assets/${VIDEO}`, { relation_type: 'gallery' }],
    ['PUT', `/v1/characters/${CHAR}/motion`, { asset_id: VIDEO }],
    ['PUT', `/v1/characters/${CHAR}/motion-asset`, { asset_id: VIDEO }],
    ['POST', `/v1/characters/${CHAR}/motion`, { asset_id: VIDEO }],
    ['PUT', `/v1/characters/${CHAR}/presentation/motion`, { asset_id: VIDEO }],
    ['PUT', `/v1/characters/${CHAR}/presentation`, {
      asset_id: COVER,
      motion_asset_id: VIDEO,
      crop_x: 0.5, crop_y: 0.25, crop_zoom: 1,
      chat_background_crop_x: 0.5, chat_background_crop_y: 0.2, chat_background_crop_zoom: 1,
    }],
  ]
  for (const [method, p, body] of bindTries) {
    out.steps.push(await api(method, p, body))
  }

  out.steps.push({ step: 'assets_mid', ...(await api('GET', `/v1/characters/${CHAR}/assets?scope=active`)) })

  // If presentation with motion still fails, check GET asset_8947 for character linkage fields
  const asset = await undiciFetch(`${API}/v1/assets/${VIDEO}`, {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token(), Origin: 'https://app.lovemi.ai', Referer: 'https://app.lovemi.ai/' },
    dispatcher: new ProxyAgent(PROXY),
  })
  const assetData = await asset.json()
  out.videoAsset = {
    keys: Object.keys(assetData),
    asset_id: assetData.asset_id,
    kind: assetData.asset_kind,
    origin: assetData.asset_origin,
    generation_job_id: assetData.generation_job_id,
    character_id: assetData.character_id,
    source_object_id: assetData.source_object_id,
    metadata: assetData.metadata,
  }

  // final presentation + draft + publish if motion set
  const pres = out.steps.find(s => s.path?.endsWith('/presentation') && s.ok && s.method === 'PUT')
  if (pres) {
    const ch = await undiciFetch(`${API}/v1/characters/${CHAR}`, {
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token(), Origin: 'https://app.lovemi.ai', Referer: 'https://app.lovemi.ai/' },
      dispatcher: new ProxyAgent(PROXY),
    }).then(r => r.json())
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
    const da = await api('GET', `/v1/community-listings/${LISTING}/draft-assets`)
    out.steps.push({ step: 'draft_assets', ...da })
    const sub = await api('POST', `/v1/community-listings/${LISTING}/publication-submissions`, {
      publication_scope: 'character',
      source_locale: 'zh-CN',
    })
    out.steps.push({ step: 'publish', ...sub })
    out.ok = sub.ok
  }

  fs.writeFileSync('/tmp/bind-motion.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify({
    videoAsset: out.videoAsset,
    ok: out.ok || false,
    summary: out.steps.map(s => ({
      step: s.step, method: s.method, path: s.path, status: s.status, ok: s.ok, allow: s.allow, msg: s.msg, issues: s.issues,
      snippet: (s.snippet || '').slice(0, 220),
    })),
  }, null, 2))
  app.exit(0)
})
