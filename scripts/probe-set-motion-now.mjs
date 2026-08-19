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
const VIDEO = 'asset_8960'
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
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    dispatcher: new ProxyAgent(PROXY),
    signal: AbortSignal.timeout(45000),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, msg: String(data.message||'').slice(0,200), snippet: JSON.stringify(data).slice(0,500) }
}
app.whenReady().then(async () => {
  app.dock?.hide()
  const out = {}
  out.pres = await api('PUT', `/v1/characters/${CHAR}/presentation`, {
    asset_id: COVER,
    motion_asset_id: VIDEO,
    crop_x: 0.5, crop_y: 0.25, crop_zoom: 1,
    chat_background_crop_x: 0.5, chat_background_crop_y: 0.2, chat_background_crop_zoom: 1,
  })
  out.assets = await api('GET', `/v1/characters/${CHAR}/assets?scope=active`)
  out.draftAssets = await api('GET', `/v1/community-listings/${LISTING}/draft-assets`)
  // refresh draft so gallery syncs
  const ch = await undiciFetch(`${API}/v1/characters/${CHAR}`, {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token(), Origin: 'https://app.lovemi.ai', Referer: 'https://app.lovemi.ai/' },
    dispatcher: new ProxyAgent(PROXY),
  }).then(r => r.json())
  out.draft = await api('PUT', `/v1/me/publications/by-source/character/${CHAR}/draft`, {
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
  out.draftAssetsAfter = await api('GET', `/v1/community-listings/${LISTING}/draft-assets`)
  console.log(JSON.stringify(out, null, 2))
  app.exit(0)
})
