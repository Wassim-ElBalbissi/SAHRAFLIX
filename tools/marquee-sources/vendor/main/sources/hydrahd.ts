import { createTmdbEmbedConnector, type TmdbEmbedProvider } from './tmdb-embed'

/**
 * HydraHD — the providers hydrahd.ru fronts.
 *
 * Same shape as `boredflix.ts` and `mirrors.ts`: a TMDB-id-keyed site that is
 * not itself a stream host, so this file is only the list of hosts behind it.
 * The mechanism lives in `tmdb-embed.ts`.
 *
 * **Where the list came from, and how to refresh it.** Unlike boredflix — whose
 * server list went server-side, leaving its bundle naming none of its providers
 * — HydraHD still hands the whole list out in one request, and it is keyed by
 * TMDB id:
 *
 *   /ajax/mov_0.php?t=<tmdbId>
 *   /ajax/tv_0.php?t=<tmdbId>&s=<season>&e=<episode>
 *
 * Both answer with HTML carrying one `data-link="<embed url>"` per provider.
 * The pages also pass an IMDb id as `i`, but it is optional — measured
 * 2026-08-06, `t` alone returns all twelve entries for both types, which is what
 * makes this connector possible at all: the app has TMDB ids and no IMDb ids.
 *
 * Note the site's own page URLs (`/movie/53470-watch-fight-club-1999-online`)
 * carry an *internal* id, not a TMDB one — 53470 is Fight Club, whose TMDB id is
 * 550. Only the ajax endpoint above is TMDB-keyed. Don't try to build a page URL
 * from a TMDB id; it 404s into the SPA shell, which answers 200 with the
 * homepage and so looks like a hit.
 *
 * Use `hydrahd.ru`. The status page at hydrahd.info advertises six domains;
 * measured 2026-08-06, only `.ru` and `.com` load at all, and `.com` refuses the
 * `/movie/...` and ajax paths while `.ru` serves them.
 *
 * Of the twelve providers it listed, two were already in the app (`vixsrc.to`,
 * `vidking.net`) and one is IMDb-keyed with a broken TV URL (`ythd.org`, which
 * emits `/embed//1-1/` — no id). The remaining nine were run through the
 * offscreen resolver on 2026-08-06 and probed, twice: once with HydraHD as the
 * referer and once with each provider's own origin. **Both sweeps gave identical
 * results**, so unlike vidzee and vidsrc.rip these do not care who embeds them
 * and no per-provider `referer` is set here.
 *
 *   xpass       PLAYS   movie + tv   ~1.0s   tik.1x2.space
 *   moviesapi   PLAYS   movie        ~2.9s   bx.netrocdn.site
 *
 * The other seven never fetched a playlist within 11s on either sweep:
 * airflix1.com, embedmaster.link, peachify.top, player.videasy.net,
 * player.vidlove.cc, primesrc.me and 2embed.cc. (peachify was already known dead
 * from the 2026-08-05 boredflix pass, which is a useful check on the method
 * rather than a new finding.) moviesapi's TV shape — `/tv/<id>-<s>-<e>`, taken
 * from HydraHD's own markup rather than guessed — failed on both sweeps while
 * its movie URL worked every time, so it is registered movie-only. That is the
 * same treatment vidsrc.rip gets in `mirrors.ts`.
 *
 * **This is real redundancy, which is the only reason it earns a connector.**
 * Both surviving backends are new to the app: nothing else here serves from
 * tik.1x2.space or bx.netrocdn.site, where the existing connectors sit on
 * orion1.workers.dev / cdn1.1shows.app (vidrock, vidzee, 111movies),
 * moon.ironwallnet.net (vidfast, vidcore, vidking) and api.dlproxy.com (movish).
 * A third front-end onto one of those backends would add latency and no
 * coverage.
 *
 * Two providers is one wave for either query type — a film sees both, an episode
 * sees only xpass, since providers with no URL for the type are dropped before
 * waves are cut — so this stays far inside the registry's 20s ceiling on the
 * default 9s budget. If more of these come back to life, mind that arithmetic
 * before appending: three per wave at 11s each means a third wave can never
 * contribute.
 */
const PROVIDERS: TmdbEmbedProvider[] = [
  {
    id: 'xpass',
    name: 'XPass',
    movie: (q) => `https://play.xpass.top/e/movie/${q.tmdbId}`,
    tv: (q) => `https://play.xpass.top/e/tv/${q.tmdbId}/${q.season ?? 1}/${q.episode}`
  },
  {
    id: 'moviesapi',
    name: 'MoviesAPI',
    movie: (q) => `https://moviesapi.to/movie/${q.tmdbId}`
  }
]

export const hydrahdConnector = createTmdbEmbedConnector({
  id: 'hydrahd',
  name: 'HydraHD',
  providers: PROVIDERS,
  scope: ['general'],
  cost: 'expensive'
})
