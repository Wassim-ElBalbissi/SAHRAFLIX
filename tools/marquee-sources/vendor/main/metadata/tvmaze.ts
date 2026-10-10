import { titleSimilarity } from '../sources/parse'
import { httpFetch } from '../net'

/**
 * TVmaze client — a second opinion on episode lists.
 *
 * TMDB is authoritative for everything this app displays except one thing it is
 * reliably late on: whether a currently-airing show has a new episode. Its
 * episode data is contributor-entered, and Turkish weeklies air faster than
 * anyone enters them. Measured 2026-08-06, TMDB listed 8 episodes of Doğanın
 * Kanunu while episode 9 had aired the day before and was already streaming on
 * 3isq; TVmaze had it.
 *
 * TVmaze fits the gap unusually well:
 *
 *   - No API key and no quota, so nothing here goes through `recordApiUsage()`.
 *   - Per-season numbering, the same convention TMDB uses and the same one the
 *     scrapers' slugs use (`doganin-kanunu-2026-s01e09`). No absolute-episode
 *     translation, which is the trap every Turkish source hits.
 *   - Future air dates, which TMDB withheld entirely here — its
 *     `next_episode_to_air` was null for a show airing weekly.
 *
 * It is deliberately *only* used to add episodes TMDB lacks. Artwork,
 * overviews, ids and everything else stay TMDB's, so this can never overwrite
 * good data with worse.
 */

const BASE = 'https://api.tvmaze.com'

/** TVmaze asks for ~20 requests per 10s; one at a time is plenty here. */
const TIMEOUT_MS = 10_000

export interface TvmazeEpisode {
  id: number
  season: number
  number: number | null
  name?: string
  airdate?: string
  runtime?: number | null
  summary?: string | null
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await httpFetch(url, { signal: controller.signal })
    // 404 is the documented "no match" answer for /lookup, not a failure.
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolves a show to its TVmaze id.
 *
 * The IMDb id is tried first because it is exact — of six followed series here
 * it matched five outright. The one it missed was the newest show in the
 * library, which is the pattern: TVmaze carries the episodes before it carries
 * the cross-reference. So the fallback matters more than it looks, and it
 * searches the **original** title, since that is the name TVmaze files Turkish
 * shows under ("Doğanın Kanunu", not "The Law of Nature" — searching the
 * English title returns nothing at all).
 */
export async function resolveTvmazeId(
  imdbId: string | undefined,
  originalTitle: string | undefined,
  title: string | undefined,
  firstAirYear: string | undefined
): Promise<number | null> {
  if (imdbId) {
    const hit = await fetchJson<{ id: number }>(`${BASE}/lookup/shows?imdb=${encodeURIComponent(imdbId)}`)
    if (hit?.id) return hit.id
  }

  const name = originalTitle || title
  if (!name) return null

  const results = await fetchJson<{ score: number; show: { id: number; name: string; premiered?: string } }[]>(
    `${BASE}/search/shows?q=${encodeURIComponent(name)}`
  )
  if (!results?.length) return null

  // TVmaze's own score is about text overlap and happily returns loose matches,
  // so confirm the name really is the same show rather than trusting position.
  // Same folding as the scrapers use, which is what makes the Turkish
  // diacritics (ğ, ı, ş) line up against an ASCII-ish query.
  let best: { id: number; score: number } | null = null
  for (const r of results) {
    const similarity = Math.max(
      titleSimilarity(r.show.name, name),
      title ? titleSimilarity(r.show.name, title) : 0
    )
    // A year that disagrees is a different show with a recycled name — Turkish
    // remakes make this a real case rather than a theoretical one.
    const year = r.show.premiered?.slice(0, 4)
    if (firstAirYear && year && year !== firstAirYear) continue
    if (similarity >= 0.8 && (!best || similarity > best.score)) {
      best = { id: r.show.id, score: similarity }
    }
  }

  return best?.id ?? null
}

/** Every episode TVmaze knows for a show, including ones not yet aired. */
export async function getTvmazeEpisodes(tvmazeId: number): Promise<TvmazeEpisode[]> {
  const episodes = await fetchJson<TvmazeEpisode[]>(`${BASE}/shows/${tvmazeId}/episodes`)
  if (!Array.isArray(episodes)) return []
  // `number` is null for specials, which have no place in a season's numbering.
  return episodes.filter((e) => typeof e.number === 'number' && e.season > 0)
}
