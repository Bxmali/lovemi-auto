/**
 * 用库存里第一个有 Bearer 的账号拉发现列表
 * LOVEMI_PROXY=http://127.0.0.1:7890 env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/probe-community-listings.mjs
 */
import { app, safeStorage } from 'electron'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7890'
const PATH =
  '/v1/community-listings?scope=public&listing_type=character_listing&page=1&limit=21&gender_expression=female&character_sort=popular_week'

app.whenReady().then(async () => {
  app.dock?.hide()
  try {
    const db = new DatabaseSync(path.join(app.getPath('userData'), 'accounts.sqlite'))
    const rows = db.prepare('SELECT email, payload FROM accounts').all()
    let email = ''
    let token = ''
    for (const r of rows) {
      const a = JSON.parse(safeStorage.decryptString(Buffer.from(r.payload, 'base64')))
      if (a.lovemiSessionToken) {
        email = a.email
        token = a.lovemiSessionToken
        break
      }
    }
    db.close()
    if (!token) {
      console.log('no bearer in stock')
      app.exit(1)
      return
    }

    const url = `https://api.lovemi.ai${PATH}`
    const res = await undiciFetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'zh-CN',
        Authorization: `Bearer ${token}`,
        Origin: 'https://app.lovemi.ai',
        Referer: 'https://app.lovemi.ai/',
      },
      dispatcher: new ProxyAgent(PROXY),
    })
    const text = await res.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text.slice(0, 200) }
    }
    const items = data.items || data.data || data.listings || data.results || []
    const count = Array.isArray(items) ? items.length : 0
    const keys = data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : []
    console.log(
      JSON.stringify(
        {
          email,
          status: res.status,
          ok: res.ok,
          topKeys: keys,
          itemCount: count,
          sampleTitle:
            count > 0
              ? String(
                  items[0]?.title ||
                    items[0]?.name ||
                    items[0]?.character?.display_name ||
                    items[0]?.character?.name ||
                    '',
                ).slice(0, 80)
              : undefined,
          error: !res.ok ? String(data.message || data.error || text.slice(0, 120)) : undefined,
        },
        null,
        2,
      ),
    )
    app.exit(res.ok ? 0 : 1)
  } catch (e) {
    console.error(e?.cause?.message || e?.message || e)
    app.exit(1)
  }
})
