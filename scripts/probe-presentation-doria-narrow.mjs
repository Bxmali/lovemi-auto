/**
 * Narrow: set presentation on 朵莉亚 using known cover/video; try clear_motion; dump portrait candidate.
 * Uses admin token from create-char.secrets; no secrets printed.
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
  return { method, path: p, status: res.status, ok: res.ok, msg: String(data.message || data.detail || '').slice(0, 220), issues: data.issues, snippet: JSON.stringify(data).slice(0, 800) }
}
app.whenReady().then(async () => {
  app.dock?.hide()
  const out = { steps: [] }
  const ch = await api('GET', `/v1/characters/${CHAR}`)
  const full = JSON.parse(ch.snippet.includes('"character_id"') ? ch.snippet.replace(/,\s*$/, '') : '{}')
  // re-fetch full without truncation
  const res = await undiciFetch(`${API}/v1/characters/${CHAR}`, {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token(), Origin: 'https://app.lovemi.ai', Referer: 'https://app.lovemi.ai/' },
    dispatcher: new ProxyAgent(PROXY),
    signal: AbortSignal.timeout(45000),
  })
  const data = await res.json()
  const cand = data.latest_portrait_candidate || null
  out.portrait = {
    cover_asset_id: data.cover_asset_id || null,
    motion_asset: data.motion_asset || null,
    candidate_asset: cand && (cand.asset_id || cand.id) || null,
    candidate_keys: cand ? Object.keys(cand) : [],
    publishable: data.publishable,
  }
  out.steps.push({
    step: 'clear_motion',
    ...(await api('PUT', `/v1/characters/${CHAR}/presentation`, {
      asset_id: COVER,
      clear_motion_asset: true,
      crop_x: 0.5, crop_y: 0.25, crop_zoom: 1,
      chat_background_crop_x: 0.5, chat_background_crop_y: 0.2, chat_background_crop_zoom: 1,
    })),
  })
  out.steps.push({
    step: 'set_motion',
    ...(await api('PUT', `/v1/characters/${CHAR}/presentation`, {
      asset_id: COVER,
      motion_asset_id: VIDEO,
      crop_x: 0.5, crop_y: 0.25, crop_zoom: 1,
      chat_background_crop_x: 0.5, chat_background_crop_y: 0.2, chat_background_crop_zoom: 1,
    })),
  })
  // try candidate asset if different
  const candId = out.portrait.candidate_asset
  if (candId && candId !== COVER) {
    out.steps.push({
      step: 'set_motion_candidate',
      ...(await api('PUT', `/v1/characters/${CHAR}/presentation`, {
        asset_id: candId,
        motion_asset_id: VIDEO,
        crop_x: 0.5, crop_y: 0.25, crop_zoom: 1,
        chat_background_crop_x: 0.5, chat_background_crop_y: 0.2, chat_background_crop_zoom: 1,
      })),
    })
  }
  out.steps.push({ step: 'assets_after', ...(await api('GET', `/v1/characters/${CHAR}/assets?scope=active`)) })
  // sanity: re-PUT sagiri presentation (known-good assets) to confirm shape
  out.steps.push({
    step: 'sagiri_sanity',
    ...(await api('PUT', `/v1/characters/chr_RP69-2pjhJkbpeJM3rrLmQ/presentation`, {
      asset_id: 'asset_6990',
      motion_asset_id: 'asset_8232',
      crop_x: 0.47479110063054286,
      crop_y: 0.2616112164863895,
      crop_zoom: 1,
      chat_background_crop_x: 0.5030074160144903,
      chat_background_crop_y: 0.17824594446807218,
      chat_background_crop_zoom: 1,
    })),
  })
  fs.writeFileSync('/tmp/pres-doria-narrow.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
  app.exit(0)
})
