/**
 * Dump explore item field shape (no secrets).
 */
import { app, safeStorage } from 'electron'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7897'

app.whenReady().then(async () => {
  app.dock?.hide()
  const db = new DatabaseSync(path.join(app.getPath('userData'), 'accounts.sqlite'))
  let token = ''
  for (const r of db.prepare('SELECT payload FROM accounts').all()) {
    const a = JSON.parse(safeStorage.decryptString(Buffer.from(r.payload, 'base64')))
    if (a.lovemiSessionToken) {
      token = a.lovemiSessionToken
      break
    }
  }
  db.close()
  const res = await undiciFetch(
    'https://api.lovemi.ai/v1/community/explore?sort=recommended&media=video&limit=2',
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        Origin: 'https://app.lovemi.ai',
        Referer: 'https://app.lovemi.ai/',
      },
      dispatcher: new ProxyAgent(PROXY),
      signal: AbortSignal.timeout(25_000),
    },
  )
  const data = await res.json()
  const it = data.items?.[0] || {}
  console.log(
    JSON.stringify(
      {
        status: res.status,
        itemKeys: Object.keys(it),
        listingKeys: it.listing && Object.keys(it.listing),
        mediaKeys: it.media && Object.keys(it.media),
        engagementKeys: it.engagement && Object.keys(it.engagement),
        creatorKeys: it.creator && Object.keys(it.creator),
        listing_id: it.listing?.listing_id || it.listing?.id,
        title: it.listing?.title || it.media?.title,
        asset_id: it.engagement?.asset_id || it.media?.asset_id || it.media?.pubasset_id,
        media_kind: it.media?.kind || it.media?.type || it.media?.media_type,
        viewer_liked: it.engagement?.viewer_liked,
        has_next_cursor: Boolean(data.next_cursor),
      },
      null,
      2,
    ),
  )
  app.exit(0)
})
