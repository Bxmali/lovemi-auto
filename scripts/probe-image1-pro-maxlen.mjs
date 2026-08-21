/**
 * Find Image1-pro prompt max length after metadata fix.
 * env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-image1-pro-maxlen.mjs
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7897'
const API = 'https://api.lovemi.ai'
const BASE =
  '一名年满21岁的成年日本女性，可爱东亚面孔，酒店客房自慰，16:9横构图，写实摄影，阴毛短整齐，真丝睡裙，暖金灯光。'

function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
    : raw
  return JSON.parse(json).adminSessionToken
}

function pad(n) {
  let s = BASE
  while ([...s].length < n) s += '细节补充。'
  return [...s].slice(0, n).join('')
}

function bodyFor(prompt) {
  const threadId = `gen_${createHash('sha256').update(`${prompt}|${Date.now()}|${randomUUID()}`).digest('hex').slice(0, 32)}`
  return {
    public_model_key: 'image1_pro',
    capability_key: 'image.generate.v1',
    prompt,
    aspect_ratio: 'landscape',
    width: 2304,
    height: 1280,
    prompt_enhancement: true,
    metadata: {
      public_model_key: 'image1_pro',
      product_model: 'Image1-pro',
      aspect_ratio: '16:9',
      generation_mode: 'text_to_image',
      generation_thread_id: threadId,
      prompt,
      prompt_enhancement: 'true',
    },
    requested_options: {
      public_model_key: 'image1_pro',
      model_label: 'Image1-pro',
      aspect_ratio: '16:9',
      aspect: 'landscape',
      width: 2304,
      height: 1280,
      prompt,
      prompt_enhancement: true,
    },
  }
}

async function post(token, prompt) {
  const res = await undiciFetch(`${API}/v1/jobs`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Origin: 'https://app.lovemi.ai',
      Referer: 'https://app.lovemi.ai/',
    },
    body: JSON.stringify(bodyFor(prompt)),
    dispatcher: new ProxyAgent(PROXY),
    signal: AbortSignal.timeout(45_000),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, error: data.message || data.detail, jobId: data.job_id }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const t = token()
  const results = []
  for (const n of [40, 60, 80, 100, 120, 150, 200]) {
    const prompt = pad(n)
    const r = await post(t, prompt)
    results.push({ chars: [...prompt].length, bytes: Buffer.byteLength(prompt, 'utf8'), ...r })
    await new Promise((x) => setTimeout(x, 650))
  }
  console.log(JSON.stringify({ results }, null, 2))
  app.exit(0)
})
