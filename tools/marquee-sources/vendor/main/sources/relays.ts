import { createTmdbEmbedConnector, type TmdbEmbedProvider } from './tmdb-embed'

/**
 * Embed relays — a third set of TMDB-id-keyed players, found on 2026-08-12.
 *
 * Same shape as `mirrors.ts` and for the same reason: a connector of its own
 * gets its own 20s budget from the registry and runs concurrently with the
 * others, where anything appended to `boredflix.ts` would sit behind a first
 * wave that already works and essentially never run.
 *
 * **Where the list came from, because the method is reusable.** These are not
 * sites someone recommended; they are the providers `download.duafile.com`
 * fronts, and it still publishes the whole list in the clear. Its `/post/<slug>`
 * page ships ~50 entries as templates carrying `{tmdb_id}` and `{imdb_id}`
 * placeholders — exactly the trick `boredflix.ts` records losing when boredflix
 * moved its own list server-side. When this connector rots, fetch a duafile post
 * page and re-read it rather than hunting for candidate sites one at a time; a
 * single request replaced what a twenty-two-site sweep produced last time.
 *
 * Of the ~50 listed, roughly half were already in the app or already recorded as
 * dead, and 26 genuinely new backends were probed against a film and an episode.
 * Five produced a playable URL. These three were kept:
 *
 *   vidstorm   movie + tv   1.1-2.2s   edge.bison-6d7.workers.dev
 *   cinesrc    movie + tv   2.2-2.9s   nebula.bright67.online
 *   nxsha      movie + tv   2.4-5.1s   proxy.itsnitrox.tech
 *
 * Every one of those backends is new to the app, which is the whole point — a
 * second front-end onto a host something else already reaches costs a hidden
 * window and buys nothing.
 *
 * **Two that worked and were cut for budget, so they need no re-probing.** Both
 * were measured playing, twice, on two titles:
 *
 *   goated.cx      `/watch/movie/{tmdbId}`      2.2-2.7s   cdn.reallyfast.xyz
 *   vidsrc.wtf     `/api/2/movie/?id={tmdbId}`  6.1-8.0s   i-arch-400.hanna427def.com
 *
 * goated is **movie-only** — its episode pages sit behind a Cloudflare challenge
 * the offscreen resolver cannot pass, the `moviesapi` case in `hydrahd.ts`. It
 * lost its slot to providers that cover both. vidsrc.wtf is simply the slowest by
 * a factor of three, and `nxsha` was observed resolving onto the same
 * `hanna427def.com` host on one episode, so it is not independent redundancy
 * either. If one of the three below dies, swap one of these in rather than
 * extending the list — see the budget note.
 *
 * **Budget.** Three providers at `waveSize: 3` is one wave, and one wave is
 * `browserResolveMs + 2_000` = 11s worst case, comfortably inside the registry's
 * 20s ceiling. A fourth would make it two waves and 22s, past the ceiling, where
 * the result is discarded wholesale and the connector reads as having found
 * nothing while having cost the full wait. That arithmetic — not taste — is why
 * the list is three long.
 *
 * **Referer is each provider's own origin, and that was measured.** All three
 * resolve with `self` and none of them needs boredflix's, unlike `vidsrc.rip` in
 * `mirrors.ts`. Do not normalise these to one value; the neighbouring connector
 * documents players that disagree about it.
 *
 * **No `api` provider may be added to this file.** `tmdb-embed.ts` runs every
 * cheap provider first and returns the moment one of them yields anything, so a
 * single JSON entry here would suppress all three browser providers on every
 * title it answered for — a coverage loss that reads as a speed improvement.
 * A JSON feed belongs in its own connector.
 */

const PROVIDERS: TmdbEmbedProvider[] = [
  {
    id: 'vidstorm',
    name: 'VidStorm',
    // Its own list gives an `{imdb_id}` template, and that form works, but the
    // bare TMDB id resolves to a byte-identical stream URL and is faster. Keyed
    // on TMDB deliberately: `StreamQuery.imdbId` is optional and absent for
    // plenty of rows, so an IMDb template would silently sit out those lookups.
    movie: (q) => `https://vidstorm.ru/movie/${q.tmdbId}`,
    tv: (q) => `https://vidstorm.ru/tv/${q.tmdbId}/${q.season ?? 1}/${q.episode}`,
    referer: 'https://vidstorm.ru/'
  },
  {
    id: 'cinesrc',
    name: 'CineSrc',
    movie: (q) => `https://cinesrc.st/embed/movie/${q.tmdbId}`,
    // Note the query-string episode form — this one does not take a path.
    tv: (q) => `https://cinesrc.st/embed/tv/${q.tmdbId}?s=${q.season ?? 1}&e=${q.episode}`,
    referer: 'https://cinesrc.st/'
  },
  {
    id: 'nxsha',
    name: 'Nxsha',
    // The query string is copied from duafile's own template rather than
    // trimmed: `sub=en` is what makes it request a subtitle track at all, and
    // these players routinely behave differently without the parameters their
    // embedder sends.
    movie: (q) => `https://nxsha.space/embed/movie/${q.tmdbId}?lang=en&autoplay=true&sub=en`,
    tv: (q) =>
      `https://nxsha.space/embed/tv/${q.tmdbId}/${q.season ?? 1}/${q.episode}` +
      `?lang=en&autoplay=true&sub=en`,
    referer: 'https://nxsha.space/'
  }
]

export const relaysConnector = createTmdbEmbedConnector({
  id: 'relays',
  name: 'Embed Relays',
  providers: PROVIDERS,
  waveSize: 3,
  scope: ['general'],
  cost: 'expensive'
})
