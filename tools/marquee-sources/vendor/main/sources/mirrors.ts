import { createTmdbEmbedConnector, type TmdbEmbedProvider } from './tmdb-embed'
import type { StreamQuery } from '@shared/types'

/**
 * Embed mirrors — TMDB-id-keyed players approached directly, without a site in
 * front of them.
 *
 * Same shape as `boredflix.ts`, different hosts, and deliberately a separate
 * connector rather than more entries in boredflix's list. That connector stops
 * at its first success, and its first wave currently works, so anything appended
 * to it would essentially never run. A connector of its own gets its own 20s
 * budget from the registry and searches concurrently, which is the only way
 * these actually add coverage.
 *
 * The list is short because almost nothing survived checking. Of twenty-two
 * candidate hosts probed on 2026-08-05 — the usual vidsrc/embed/autoembed family
 * — six no longer resolve in DNS at all (vidsrc.xyz, moviesapi.club,
 * player.autoembed.cc, vidsrc.vip, xprime.tv, rivestream.org) and most of the
 * rest served a page that never fetched a playlist, even given 25 seconds and
 * their own origin as the referer. These three are what actually produced a
 * playable URL:
 *
 *   vidzee      movie + tv   ~4.5s   img1.klcxm.com / cdn1.1shows.app
 *   vidsrc.rip  movie        ~9s     gallery.vcmdiawe.com (progressive mp4)
 *   111movies   tv           ~5.2s   cdn1.1shows.app
 *
 * vidzee is worth the most: its movie backend is the only one in the app not
 * shared with something else — boredflix's live providers sit on
 * moon.ironwallnet.net and orion/1shows, and Movish on api.dlproxy.com — so it
 * is real redundancy rather than the same file relabelled.
 *
 * **The referer is per-provider and was measured, not chosen.** vidzee and
 * 111movies only resolve when approached with their own origin; vidsrc.rip only
 * resolves with boredflix's, and returned nothing across a 25s budget with its
 * own. These players check who is embedding them and they do not agree on the
 * answer, so don't normalise this to one value.
 */

const PROVIDERS: TmdbEmbedProvider[] = [
  {
    id: 'vidzee',
    name: 'VidZee',
    movie: (q) => `https://player.vidzee.wtf/embed/movie/${q.tmdbId}`,
    tv: (q) => `https://player.vidzee.wtf/embed/tv/${q.tmdbId}/${q.season ?? 1}/${q.episode}`,
    referer: 'https://player.vidzee.wtf/',
    /*
     * Its streams API returns an encrypted blob (`{"c": "<base64>"}`) and is not
     * worth reversing — the browser path already produces the URL for free, and
     * that scheme can rotate whenever they like. Its *subtitles* API is plain
     * JSON, needs no window, and carries several Arabic tracks per title, which
     * is the scarce resource for this app. So: streams by running the page,
     * subtitles by asking.
     */
    subs: subsUrl
  },
  {
    id: 'vidsrc-rip',
    name: 'VidSrc.rip',
    movie: (q) => `https://vidsrc.rip/embed/movie/${q.tmdbId}`,
    referer: 'https://boredflix.tv/'
  },
  {
    id: '111movies',
    name: '111Movies',
    tv: (q) => `https://111movies.com/tv/${q.tmdbId}/${q.season ?? 1}/${q.episode}`,
    referer: 'https://111movies.com/'
  }
]

function subsUrl(query: StreamQuery): string | null {
  if (query.type === 'movie') return `https://core.vidzee.wtf/subs/movie/${query.tmdbId}`
  if (query.episode == null) return null
  return `https://core.vidzee.wtf/subs/tv/${query.tmdbId}/${query.season ?? 1}/${query.episode}`
}

export const mirrorsConnector = createTmdbEmbedConnector({
  id: 'mirrors',
  name: 'Embed Mirrors',
  providers: PROVIDERS,
  /*
   * vidsrc.rip took 9.0s to produce a URL, so the 9s default would have missed
   * it by a hair. Two providers per wave keeps a lookup to a single wave — only
   * vidzee handles both types, so a film sees [vidzee, vidsrc.rip] and an
   * episode sees [vidzee, 111movies] — which keeps the whole connector inside
   * the registry's 20s even at the slow end.
   */
  browserResolveMs: 11_000,
  waveSize: 2,
  scope: ['general'],
  cost: 'expensive'
})
