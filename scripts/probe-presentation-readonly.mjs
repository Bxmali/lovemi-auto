import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))
const PROXY = 'http://127.0.0.1:7897'
const API = 'https://api.lovemi.ai'
const DORIA = 'chr_V6x4xLrXVDMprGim1fb2tw'
const SAGIRI = 'chr_RP69-2pjhJkbpeJM3rrLmQ'
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
  return { method, path: p, status: res.status, ok: res.ok, allow: res.headers.get('allow'), msg: String(data.message||'').slice(0,200), keys: Object.keys(data||{}).slice(0,40), snippet: JSON.stringify(data).slice(0,900) }
}
app.whenReady().then(async () => {
  app.dock?.hide()
  const out = []
  for (const id of [SAGIRI, DORIA]) {
    out.push(await api('GET', `/v1/characters/${id}/presentation`))
    out.push(await api('OPTIONS', `/v1/characters/${id}/presentation`))
    out.push(await api('GET', `/v1/characters/${id}/assets?scope=active`))
    out.push(await api('GET', `/v1/characters/${id}/visual-references`))
    out.push(await api('GET', `/v1/characters/${id}`))
  }
  // try presentation cover-only for doria
  out.push(await api('PUT', `/v1/characters/${DORIA}/presentation`, {
    asset_id: 'asset_8918', crop_x: 0.5, crop_y: 0.25, crop_zoom: 1,
    chat_background_crop_x: 0.5, chat_background_crop_y: 0.2, chat_background_crop_zoom: 1,
  }))
  // try attach character asset endpoints
  for (const p of [
    `/v1/characters/${DORIA}/assets`,
    `/v1/characters/${DORIA}/presentation/assets`,
  ]) {
    out.push(await api('OPTIONS', p))
    out.push(await api('POST', p, { asset_id: 'asset_8918' }))
    out.push(await api('PUT', p, { asset_id: 'asset_8918' }))
  }
  // try motion only paths
  out.push(await api('PUT', `/v1/characters/${DORIA}/presentation`, {
    asset_id: 'asset_8918', motion_asset_id: 'asset_8947',
    crop_x: 0.5, crop_y: 0.25, crop_zoom: 1,
    chat_background_crop_x: 0.5, chat_background_crop_y: 0.2, chat_background_crop_zoom: 1,
  }))
  fs.writeFileSync('/tmp/presentation-readonly.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out.map(x => ({ method: x.method, path: x.path, status: x.status, ok: x.ok, allow: x.allow, msg: x.msg, keys: x.keys, snippet: x.snippet.slice(0,280) })), null, 2))
  app.exit(0)
})
