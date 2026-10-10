import { get } from '../db'
import { getTvmazeId, setTvmazeId } from '../metadata/library'
import { getTvmazeEpisodes, resolveTvmazeId } from '../metadata/tvmaze'
import { titleSimilarity, normalizeForMatch } from './parse'
import type { StreamQuery } from '@shared/types'

/**
 * Shared "which of these links is the show I want" scoring.
 *
 * Every scraper here faces the same problem: a search page (or a sitemap) gives
 * a pile of series links, and one of them — maybe — is the requested show under
 * a name that only loosely resembles any title TMDB knows. Keeping the scoring
 * in one place means a matching fix benefits every connector at once.
 */

export interface SeriesCandidate {
  url: string
  /** Link text / title attribute, when the page provides one. */
  title?: string
}

/** Only an exact title or spacing-equivalent title can identify a scraper entry. */
export const MATCH_THRESHOLD = 0.98

/** The slug carries the title on these WordPress sites, so it scores too. */
export function slugText(url: string): string {
  try {
    const slug = decodeURIComponent(url.replace(/\/$/, '').split('/').pop() ?? '')
    return normalizeForMatch(slug.replace(/-/g, ' '))
  } catch {
    // Malformed percent-encoding — fall back to the raw slug.
    return normalizeForMatch((url.replace(/\/$/, '').split('/').pop() ?? '').replace(/-/g, ' '))
  }
}

/** Best score for one candidate across every name the show is known by. */
export function scoreCandidate(candidate: SeriesCandidate, aliases: string[]): number {
  const texts = [candidate.title, slugText(candidate.url)].filter(
    (t): t is string => Boolean(t && t.trim())
  )

  let best = 0
  for (const text of texts) {
    // Catalogue slugs often append the show's premiere year. Ignore a trailing
    // year only when it follows an actual title, so a title such as "1899"
    // remains intact.
    const candidateName = stripTrailingYear(text)
    for (const alias of aliases) {
      const score = titleSimilarity(candidateName, stripTrailingYear(alias))
      if (score > best) best = score
    }
  }
  return best
}

function stripTrailingYear(text: string): string {
  const normalized = normalizeForMatch(text)
  const words = normalized.split(' ')
  if (words.length > 1 && /^(?:19|20)\d{2}$/.test(words[words.length - 1])) words.pop()
  return words.join(' ')
}

/** Merge search and catalogue results without losing a useful result title. */
export function mergeCandidates(...groups: SeriesCandidate[][]): SeriesCandidate[] {
  const merged = new Map<string, SeriesCandidate>()
  for (const candidate of groups.flat()) {
    const previous = merged.get(candidate.url)
    if (!previous || (!previous.title && candidate.title)) merged.set(candidate.url, candidate)
  }
  return [...merged.values()]
}

/** A title or catalogue slug that exactly matches one of the known names. */
export function exactCandidateMatch(candidates: SeriesCandidate[], aliases: string[]): string | null {
  return candidates.find((candidate) => scoreCandidate(candidate, aliases) === 1)?.url ?? null
}

/** Highest-scoring candidate, or null when nothing clears the threshold. */
export function bestMatch(
  candidates: SeriesCandidate[],
  aliases: string[],
  threshold = MATCH_THRESHOLD
): string | null {
  let best: { url: string; score: number } | null = null

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, aliases)
    if (!best || score > best.score) best = { url: candidate.url, score }
  }

  return best && best.score >= threshold ? best.url : null
}

/** Parses `<loc>` entries out of a sitemap. */
export function parseSitemap(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1])
}

/**
 * Resolves to `fallback` if `work` hasn't settled in time.
 *
 * The registry gives each connector 20 seconds total. Resolving embeds without
 * a per-embed bound spends that budget on whichever host is slowest and returns
 * nothing at all, when two of the three hosts had answered in a second — so
 * every individual embed gets its own, much shorter, deadline.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    work
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(fallback)
      })
  })
}

/**
 * How long one embed host gets. Comfortably inside the registry's 20s budget so
 * the fast hosts still make it into the results.
 */
export const EMBED_TIMEOUT_MS = 8_000

/**
 * Cap on how many names to search before giving up. TMDB lists ten alternative
 * titles for some shows; searching them all would blow the connector's budget
 * long before the catalogue fallback ever ran.
 */
export const MAX_SEARCH_TERMS = 5

/**
 * How many regular-season episodes TMDB lists before `season`. The fallback
 * for `episodeOffset` when TVmaze knows nothing about the show. Season 0 is
 * specials and never part of the broadcast run.
 */
function tmdbPriorCount(tmdbId: number, season: number): number {
  if (season <= 1) return 0
  const row = get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM episodes
     WHERE show_tmdb_id = ? AND season_number < ? AND season_number > 0`,
    [tmdbId, season]
  )
  return Number(row?.total ?? 0)
}

/** Broadcast order per TMDB id, from TVmaze; `null` once looked for and not found. */
interface BroadcastEpisode {
  season: number
  airdate?: string
  /** 1-based position in the whole run — the broadcaster's "N. Bölüm". */
  index: number
}
const TVMAZE_TTL_MS = 6 * 60 * 60_000
const broadcasts = new Map<number, { at: number; episodes: BroadcastEpisode[] | null }>()

async function broadcastOrder(query: StreamQuery): Promise<BroadcastEpisode[] | null> {
  const hit = broadcasts.get(query.tmdbId)
  if (hit && Date.now() - hit.at < TVMAZE_TTL_MS) return hit.episodes

  let episodes: BroadcastEpisode[] | null = null
  try {
    let id = getTvmazeId(query.tmdbId) ?? null
    if (id == null) {
      id = await resolveTvmazeId(
        query.imdbId,
        query.originalTitle,
        query.title,
        query.year ? String(query.year) : undefined
      )
      if (id != null) setTvmazeId(query.tmdbId, id)
    }
    if (id != null) {
      const list = (await getTvmazeEpisodes(id)).sort(
        (a, b) => a.season - b.season || (a.number ?? 0) - (b.number ?? 0)
      )
      if (list.length > 0) {
        episodes = list.map((e, i) => ({ season: e.season, airdate: e.airdate || undefined, index: i + 1 }))
      }
    }
  } catch {
    // Offline or rate-limited: TMDB's count is the fallback, not a failure.
  }
  broadcasts.set(query.tmdbId, { at: Date.now(), episodes })
  return episodes
}

/**
 * The offset between TMDB's per-season numbering and the broadcaster's
 * continuous one ("9. Bölüm" is S2E1 when season 1 ran eight) — or `null`
 * when the requested TMDB episode has no broadcast counterpart at all.
 *
 * TVmaze's broadcast order, not TMDB's seasons, because TMDB's are the ones
 * that drift: it lists Çirkin's season 1 with a ninth episode (24 May) that
 * never aired, TVmaze and the broadcaster have eight, and every site files the
 * season 2 premiere as episode 9. Counting TMDB's seasons asked for episode 10
 * on S2E1 and found nothing, while TMDB's phantom S1E9 played the premiere.
 *
 * Aligned by air date first, since TVmaze may cut seasons differently from
 * TMDB; by season counts when the date is unknown on either side; by TMDB's own
 * count only when TVmaze doesn't have the show or the season.
 */
export async function episodeOffset(query: StreamQuery): Promise<number | null> {
  const season = query.season ?? 1
  const episode = query.episode ?? 1
  const order = await broadcastOrder(query)
  if (!order) return tmdbPriorCount(query.tmdbId, season)

  const row = get<{ air_date: string | null }>(
    `SELECT air_date FROM episodes
     WHERE show_tmdb_id = ? AND season_number = ? AND episode_number = ?`,
    [query.tmdbId, season, episode]
  )
  const sameDay = row?.air_date ? order.filter((e) => e.airdate === row.air_date) : []
  // Two episodes on one date (a double bill) can't say which is which; the
  // season-count reading below handles those.
  if (sameDay.length === 1) return sameDay[0].index - episode

  const inSeason = order.filter((e) => e.season === season).length
  if (inSeason === 0) return tmdbPriorCount(query.tmdbId, season)

  // A number past the end of a season the broadcaster has already closed (a
  // later season exists) is TMDB's invention. Answering with the next season's
  // premiere is the one wrong answer; nothing is better.
  const closed = order.some((e) => e.season > season)
  if (closed && episode > inSeason) return null

  return order.filter((e) => e.season < season).length
}

/**
 * Picks the requested episode out of the numbers a series page lists.
 *
 * A site may number continuously (S2E1 is "10") or restart per season on a
 * separate series entry (S2E1 is "1" on "<name> 2"). Accepting *either* number
 * used to be the rule, and on a continuous page it plays the wrong video with
 * no error: Çirkin S2E5 — unaired — found "5" and played S1E5 to the end.
 *
 * So the absolute number wins when listed; the in-season number is only
 * trusted when the page never reaches the earlier seasons' count, i.e. the
 * page demonstrably restarts. A page that does reach it is continuous and "5"
 * there is season 1's. A miss lets another connector answer; a wrong hit
 * cannot be detected at all.
 */
export function pickEpisode<T>(listed: Map<number, T>, episode: number, prior: number): T | null {
  if (prior === 0) return listed.get(episode) ?? null
  const absolute = listed.get(prior + episode)
  if (absolute !== undefined) return absolute
  let highest = 0
  for (const n of listed.keys()) if (n > highest) highest = n
  if (highest >= prior) return null
  return listed.get(episode) ?? null
}

/**
 * Whether the Turkish-catalogue scrapers should bother with this title.
 *
 * They index dizi and nothing else, so for anything else the honest answer is
 * "no" — but the cost of asking is what matters. `resolveStreams` waits for
 * every connector to settle before playback starts, and a miss here isn't cheap:
 * it's an alias fetch plus a full sitemap scan against four sites, four times
 * over, for a title none of them can have.
 *
 * Unknown origin deliberately counts as Turkish. Rows cached before the
 * `origin_country` column existed have none, and treating those as "not
 * Turkish" would quietly break the existing library until every row's detail
 * was refetched — a wrong answer that looks exactly like the source being down.
 * Wasting one search on an unknown title is much the cheaper mistake.
 */
export function isTurkishTitle(query: StreamQuery): boolean {
  if (!query.originCountry || query.originCountry.length === 0) return true
  return query.originCountry.includes('TR')
}
