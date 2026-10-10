import { createTmdbEmbedConnector, type TmdbEmbedProvider } from './tmdb-embed'
import type { StreamQuery } from '@shared/types'

/**
 * Movish — the backend boredflix.tv now plays through.
 *
 * boredflix stopped shipping its server list in its bundle: the page iframes
 * `movish.to/player/<type>/<id>` and that player fetches its own sources at
 * runtime. Which turns out to be the good news, because the endpoint it fetches
 * is plain JSON:
 *
 *     /player-sources/<key>/movie/<tmdbId>
 *     /player-sources/<key>/tv/<tmdbId>/<season>/<episode>
 *
 * returning `{streams: [{url, label, type, quality}], subtitles: [...]}`. No
 * hidden window, no obfuscation to keep up with, several entries per request,
 * and — unlike anything resolved through `browser-resolve.ts` — subtitle tracks,
 * Arabic among them. It is the cheapest source in the app by a wide margin.
 *
 * The three keys are the player's own server buttons, read out of its inline
 * script rather than guessed. Measured against Fight Club (550), Game of Thrones
 * S01E01 and four series from the real library on 2026-08-05:
 *
 *   rigel  movie + tv, HLS 1080p plus progressive mp4 ladders   (api.dlproxy.com)
 *   storm  movie + tv, HLS                                      (orion / 1shows)
 *   flux   every stream it returned was dead, on every title tried
 *
 * **flux is wired for subtitles only**, which is why it carries `subs` rather
 * than `api`. Its mp4 CDN answered 403 to every probe across six titles, but its
 * payload still lists a full Arabic track for shows where the other two list
 * none — and subtitles resolve independently of streams in this app, so the two
 * halves can be taken separately. Returning its streams as well would be
 * actively harmful, not merely useless: they are labelled 720p, the registry
 * sorts by resolution, and they would therefore sort *above* Rigel's working
 * 480p and be the first thing the player tried.
 *
 * Not every rigel/storm entry plays either, and that is expected rather than a
 * defect — `hanna427def.com` links 403 and one entry arrived with an entire HTML
 * document stuffed into its proxy `?url=` parameter. `isUsableStreamUrl` in
 * `tmdb-embed.ts` drops the malformed shape; the rest is what failover is for.
 */

const STREAM_KEYS = [
  { key: 'rigel', name: 'Rigel' },
  { key: 'storm', name: 'Storm' }
] as const

const BASE = 'https://movish.to/player-sources'

function sourceUrl(key: string, query: StreamQuery): string | null {
  if (query.type === 'movie') return `${BASE}/${key}/movie/${query.tmdbId}`
  if (query.episode == null) return null
  return `${BASE}/${key}/tv/${query.tmdbId}/${query.season ?? 1}/${query.episode}`
}

const PROVIDERS: TmdbEmbedProvider[] = [
  ...STREAM_KEYS.map(({ key, name }) => ({
    id: key,
    name,
    api: (query: StreamQuery) => sourceUrl(key, query)
  })),
  { id: 'flux', name: 'Flux', subs: (query) => sourceUrl('flux', query) }
]

export const movishConnector = createTmdbEmbedConnector({
  id: 'movish',
  name: 'Movish',
  providers: PROVIDERS
})
