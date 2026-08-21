/**
 * Confirm fixed Image1-pro body (metadata string-only).
 * env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-image1-pro-fix.mjs
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
const SHORT = '一个日本美女自慰'
const LONG =
  '一名年满21岁的成年日本女性，独自在高档酒店客房内自慰，单人16:9横构图。可爱东亚成年女性，黑色长直发，白皙细腻皮肤，迷离表情。坐在床沿自慰，阴毛短整齐修剪。穿象牙白真丝吊带睡裙，肩带滑落。暖金灯光，写实摄影，无文字水印。'

function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
    : raw
  return JSON.parse(json).adminSessionToken
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

async function post(token, body) {
  const res = await undiciFetch(`${API}/v1/jobs`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Origin: 'https://app.lovemi.ai',
      Referer: 'https://app.lovemi.ai/',
      'Accept-Language': 'zh-CN',
    },
    body: JSON.stringify(body),
    dispatcher: new ProxyAgent(PROXY),
    signal: AbortSignal.timeout(45_000),
  })
  const data = await res.json().catch(() => ({}))
  return {
    status: res.status,
    ok: res.ok,
    error: data.message || data.error || data.detail,
    jobId: data.job_id || data.id,
  }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const t = token()
  const results = []
  for (const [name, prompt] of [
    ['short_fixed', SHORT],
    ['long_zh_fixed', LONG],
  ]) {
    const r = await post(t, bodyFor(prompt))
    results.push({ name, promptChars: [...prompt].length, ...r })
    await new Promise((x) => setTimeout(x, 700))
  }
  console.log(JSON.stringify({ results }, null, 2))
  app.exit(results.every((r) => r.ok) ? 0 : 1)
})
