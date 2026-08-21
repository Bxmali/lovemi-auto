/**
 * Probe Image1-pro POST /v1/jobs body shapes (no secrets printed).
 * env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-image1-pro-body.mjs
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

const LONG_PROMPT =
  '一名年满21岁的成年日本女性，独自站在高档酒店客房内进行自慰，单人画面，16:9横版电影构图，单一连贯场景。她是可爱漂亮的东亚成年女性，黑色长直发微微内扣，皮肤白皙细腻、自然毛孔可见，五官精致，眼神迷离而专注，嘴唇微张，表情带有沉浸的情欲。机位为室内中景偏低角度，镜头35mm，浅景深，主体清晰背景柔和虚化。她坐在床沿，一条腿自然屈起，另一条腿微张，身体前倾，双手置于私密部位进行自慰，姿势自然连贯，解剖准确。私密处仅在动作中局部可见，阴毛为精心修剪的短整齐状态。她穿着质感高级的象牙白真丝吊带睡裙，轻薄贴身、略有皱褶，细肩带滑落一侧，边缘微微掀起，露出锁骨、肩颈和大腿线条，配以细链项链与小巧耳钉。房间内有柔软床品、落地窗、半拉窗帘、床头灯与酒杯，暖金色灯光从侧面勾勒身体轮廓，营造私密、真实、性感的氛围。背景细致、酒店陈设高级、皮肤质感真实自然，无文字、水印、多余肢体或手指，写实摄影风格，高动态范围，色彩以暖米色、金色和乳白色为主。'

function token() {
  const file = path.join(app.getPath('userData'), 'create-char.secrets')
  const raw = fs.readFileSync(file, 'utf8').trim()
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(raw, 'base64'))
    : raw
  return JSON.parse(json).adminSessionToken
}

function makeBody(prompt, extra = {}) {
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
      prompt_enhancement: true,
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
    ...extra,
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
    error:
      (typeof data.message === 'string' && data.message) ||
      (typeof data.error === 'string' && data.error) ||
      (!res.ok ? `HTTP ${res.status}` : undefined),
    jobId: typeof data.id === 'string' ? data.id : typeof data.job_id === 'string' ? data.job_id : undefined,
    keys: Object.keys(data || {}).slice(0, 12),
  }
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const t = token()
  if (!t) {
    console.log(JSON.stringify({ ok: false, error: 'no admin token' }))
    app.exit(1)
    return
  }

  const cases = [
    { name: 'short_capture', prompt: '一个日本美女自慰' },
    { name: 'medium_120', prompt: LONG_PROMPT.slice(0, 120) },
    { name: 'medium_250', prompt: LONG_PROMPT.slice(0, 250) },
    { name: 'medium_400', prompt: LONG_PROMPT.slice(0, 400) },
    { name: 'long_full', prompt: LONG_PROMPT },
    {
      name: 'short_no_top_enhancement',
      prompt: '一个日本美女自慰',
      mutate: (b) => {
        delete b.prompt_enhancement
        return b
      },
    },
    {
      name: 'short_requested_only',
      prompt: '一个日本美女自慰',
      mutate: (b) => {
        const next = {
          public_model_key: b.public_model_key,
          capability_key: b.capability_key,
          metadata: b.metadata,
          requested_options: b.requested_options,
        }
        return next
      },
    },
  ]

  const results = []
  for (const c of cases) {
    let body = makeBody(c.prompt)
    if (c.mutate) body = c.mutate(body)
    const r = await post(t, body)
    results.push({
      name: c.name,
      promptChars: [...c.prompt].length,
      promptBytes: Buffer.byteLength(c.prompt, 'utf8'),
      status: r.status,
      ok: r.ok,
      error: r.error,
      jobId: r.jobId,
    })
    // avoid rate spam
    await new Promise((r) => setTimeout(r, 800))
  }

  console.log(JSON.stringify({ ok: true, results }, null, 2))
  app.exit(0)
})
