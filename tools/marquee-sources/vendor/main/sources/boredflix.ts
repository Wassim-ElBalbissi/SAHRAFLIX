import { createTmdbEmbedConnector, type TmdbEmbedProvider } from './tmdb-embed'

/**
 * Boredflix — the providers boredflix.tv fronts.
 *
 * The mechanism this connector uses lives in `tmdb-embed.ts`; this file is only
 * the list of hosts and the order to try them in. See `movish.ts` for what the
 * site itself now plays through, which is a separate connector because it is a
 * separate (and much cheaper) way in.
 *
 * The list was lifted from boredflix's own JS bundle rather than guessed: the
 * site built its server list client-side, so the hosts were in the shipped
 * chunks. An earlier version assembled from search results was wrong on six of
 * seven entries — several domains didn't resolve at all.
 *
 * **That trick no longer works.** boredflix moved the list server-side: its
 * page now iframes `movish.to/player/...` and that player fetches its sources at
 * runtime, so the current bundle names none of these hosts. If this needs
 * revisiting, load a watch page in an offscreen window and record what it
 * requests — reading the bundle will come back empty and say nothing.
 *
 * Measured end to end on 2026-08-05, each resolved through a real renderer and
 * then probed for a playlist:
 *
 *   vidrock   PLAYS   movie + tv      orion1.workers.dev / cdn1.1shows.app
 *   vidfast   PLAYS   movie + tv      moon.ironwallnet.net
 *   vidcore   PLAYS   movie + tv      moon.ironwallnet.net (same file as vidfast)
 *   vidking   PLAYS   movie + tv      moon.ironwallnet.net
 *
 * Four entries were dropped in that pass, and the reason is budget rather than
 * tidiness. `vidvault.ru`, `vidsrc.mov` and `peachify.top` all load but never
 * fetch a playlist, even given 25 seconds. Waves are cut three at a time and
 * each attempt is allowed 11s, so with seven providers a total miss ran 27s —
 * past the registry's 20s ceiling, which discards the connector's result
 * wholesale. Anything in a third wave can therefore never contribute, and a dead
 * provider in the first two only delays the live ones behind it. Four providers
 * is two waves, which fits. If these domains come back — they rotate — the URL
 * shapes are `/movie/<id>` and `/tv/<id>/<s>/<e>` for vidvault, and
 * `/embed/...` for the other two.
 *
 * The fourth, `vixsrc.to`, was never dead — it was in the wrong place. Its
 * playlist only exists after a token exchange the embed page doesn't reach on
 * its own, so it never resolved here in a hidden window. `vixsrc.ts` now
 * performs that exchange with three plain requests instead.
 *
 * Note vidfast and vidcore return byte-identical URLs: one backend, two
 * front-ends, so they are not independent redundancy. `dedupe` in
 * `tmdb-embed.ts` collapses them.
 */
const PROVIDERS: TmdbEmbedProvider[] = [
  {
    id: 'vidrock',
    name: 'VidRock',
    movie: (q) => `https://vidrock.net/movie/${q.tmdbId}`,
    tv: (q) => `https://vidrock.net/tv/${q.tmdbId}/${q.season ?? 1}/${q.episode}`
  },
  {
    id: 'vidfast',
    name: 'VidFast',
    movie: (q) => `https://vidfast.pro/movie/${q.tmdbId}`,
    tv: (q) => `https://vidfast.pro/tv/${q.tmdbId}/${q.season ?? 1}/${q.episode}`
  },
  {
    id: 'vidcore',
    name: 'VidCore',
    movie: (q) => `https://vidcore.net/movie/${q.tmdbId}`,
    tv: (q) => `https://vidcore.net/tv/${q.tmdbId}/${q.season ?? 1}/${q.episode}`
  },
  {
    id: 'vidking',
    name: 'VidKing',
    movie: (q) => `https://www.vidking.net/embed/movie/${q.tmdbId}`,
    tv: (q) => `https://www.vidking.net/embed/tv/${q.tmdbId}/${q.season ?? 1}/${q.episode}`
  }
]

// No per-provider referer: these are boredflix's own providers and expect to be
// embedded by it, which is what `browser-resolve.ts` sends by default.
export const boredflixConnector = createTmdbEmbedConnector({
  id: 'boredflix',
  name: 'Boredflix',
  providers: PROVIDERS,
  // Every provider here is a hidden window, and none of them carries Turkish
  // dizi or the anime catalogues — so this is exactly what the second tier is
  // for. See `tiers.ts`.
  scope: ['general'],
  cost: 'expensive'
})
