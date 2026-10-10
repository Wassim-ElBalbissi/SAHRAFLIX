import { fetchText } from './embed'
import { createTmdbEmbedConnector, type StreamEntry } from './tmdb-embed'
import type { StreamQuery } from '@shared/types'

/**
 * VixSrc — the one TMDB-id-keyed host that hands over a real master playlist to
 * a plain HTTP client.
 *
 * It was already listed in `boredflix.ts` as one of that site's providers and
 * has never resolved there: loaded as an embed page it fetched no playlist
 * inside 25 seconds, because the URL only exists after a token exchange the
 * offscreen window never gets far enough to make. Approached directly it is
 * three ordinary requests and no window at all:
 *
 *   1. `GET /api/movie/<tmdbId>` (or `/api/tv/<id>/<season>/<episode>`)
 *      → `{"src": "/embed/<internalId>?token=…&expires=…"}`
 *   2. `GET` that embed page → its HTML carries, in the clear,
 *      `window.masterPlaylist = { params: { token, expires }, url: '…' }`
 *   3. playlist = `<url>?token=<token>&expires=<expires>&h=1`
 *
 * Nothing is encrypted or packed — this is the one place in the app where
 * reading the page is genuinely enough, so don't "upgrade" it to
 * `browser-resolve.ts`. The two hops must happen back to back, though: the
 * step-1 token is short-lived, and fetching the embed a few minutes later
 * answers **410 Gone**. That is also why the result is worth caching only as
 * briefly as everything else here.
 *
 * What comes back is the best-quality stream in the app: a real multi-bitrate
 * master (480/720/1080) with alternate audio renditions and a long
 * `EXT-X-MEDIA:TYPE=SUBTITLES` list, Turkish among them. Those subtitles are
 * not surfaced as `Subtitle[]` on purpose — they are HLS sub-playlists rather
 * than fetchable `.vtt` files, while `Subtitle[]` is a list of things that can be
 * fetched and decoded. The player does read in-stream tracks (they are its
 * "In-stream" group, in both players — an earlier version of this comment said
 * only `LivePlayer` did, and that was wrong); they just don't travel through
 * here. The video is the value; subtitles keep coming from the other connectors.
 *
 * Its catalogue is Italian-first — Italian is the default audio rendition — so
 * treat it as broad international coverage that happens to carry English and
 * Turkish tracks, not as a replacement for the Arabic scrapers. That default is
 * also the case the player's `audioPreference` exists for: without it an anime
 * or a dizi from here opens in Italian.
 */

const ORIGIN = 'https://vixsrc.to'

function apiUrl(query: StreamQuery): string | null {
  if (query.type === 'movie') return `${ORIGIN}/api/movie/${query.tmdbId}`
  if (query.episode == null) return null
  return `${ORIGIN}/api/tv/${query.tmdbId}/${query.season ?? 1}/${query.episode}`
}

async function resolve(query: StreamQuery): Promise<StreamEntry[]> {
  const api = apiUrl(query)
  if (!api) return []

  const raw = await fetchText(api, `${ORIGIN}/`).catch(() => '')
  if (!raw) return []

  let src: string | undefined
  try {
    src = (JSON.parse(raw) as { src?: string }).src
  } catch {
    return []
  }
  if (!src) return []

  const html = await fetchText(new URL(src, ORIGIN).href, `${ORIGIN}/`).catch(() => '')
  const at = html.indexOf('window.masterPlaylist')
  if (at < 0) return []
  const block = html.slice(at)

  const token = block.match(/'token'\s*:\s*'([^']+)'/)?.[1]
  const expires = block.match(/'expires'\s*:\s*'([^']+)'/)?.[1]
  const base = block.match(/url\s*:\s*'([^']+)'/)?.[1]
  if (!token || !expires || !base) return []

  const separator = base.includes('?') ? '&' : '?'
  return [
    {
      url: `${base}${separator}token=${token}&expires=${expires}&h=1`,
      // `h=1` asks for the full ladder; the master tops out at 1080p.
      quality: '1080p',
      type: 'hls'
    }
  ]
}

export const vixsrcConnector = createTmdbEmbedConnector({
  id: 'vixsrc',
  name: 'VixSrc',
  providers: [{ id: 'vixsrc', name: 'VixSrc', referer: `${ORIGIN}/`, resolve }]
})
