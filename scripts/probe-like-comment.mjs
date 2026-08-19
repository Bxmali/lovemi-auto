import { app, safeStorage } from 'electron'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))
const PROXY = process.env.LOVEMI_PROXY || 'http://127.0.0.1:7890'
const API = 'https://api.lovemi.ai'

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
  const d = new ProxyAgent(PROXY)
  const listRes = await undiciFetch(
    `${API}/v1/community-listings?scope=public&listing_type=character_listing&page=1&limit=8&gender_expression=female&character_sort=popular_week`,
    {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        Origin: 'https://app.lovemi.ai',
        Referer: 'https://app.lovemi.ai/',
      },
      dispatcher: d,
    },
  )
  const list = await listRes.json()
  const item =
    (list.items || []).find((i) => i.engagement?.viewer_liked === false) || list.items?.[0]
  const listingId = item.listing_id
  const assetId = item.engagement?.asset_id || item.preview_assets?.[0]?.asset_id
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: 'https://app.lovemi.ai',
    Referer: 'https://app.lovemi.ai/',
    'Content-Type': 'application/json',
  }
  const likeRes = await undiciFetch(
    `${API}/v1/community-listings/${listingId}/assets/${assetId}/likes`,
    { method: 'PUT', headers, body: '{}', dispatcher: d },
  )
  const likeText = await likeRes.text()
  let likeData
  try {
    likeData = JSON.parse(likeText)
  } catch {
    likeData = { raw: likeText.slice(0, 200) }
  }
  const idem = `asset-comment:${listingId}:${assetId}:${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 32)}`
  const commentRes = await undiciFetch(
    `${API}/v1/community-listings/${listingId}/assets/${assetId}/comments`,
    {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': idem },
      body: JSON.stringify({ body: 'hi' }),
      dispatcher: d,
    },
  )
  const commentText = await commentRes.text()
  let commentData
  try {
    commentData = JSON.parse(commentText)
  } catch {
    commentData = { raw: commentText.slice(0, 200) }
  }
  console.log(
    JSON.stringify(
      {
        title: item.title || item.characters?.[0]?.display_name,
        listingId,
        assetId,
        alreadyLiked: item.engagement?.viewer_liked,
        like: {
          status: likeRes.status,
          keys: likeData && typeof likeData === 'object' ? Object.keys(likeData) : [],
          error: likeData.error_code || likeData.message,
        },
        comment: {
          status: commentRes.status,
          keys: commentData && typeof commentData === 'object' ? Object.keys(commentData) : [],
          id: commentData.id || commentData.comment_id,
          body: commentData.body,
          error: commentData.error_code || commentData.message,
        },
      },
      null,
      2,
    ),
  )
  app.exit(0)
})
