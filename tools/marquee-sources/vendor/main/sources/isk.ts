import { RANK, type SourceConnector } from './types'
import { fetchText, resolveEmbedStream, decodeEntities } from './embed'
import { getSearchAliases } from './aliases'
import {
  bestMatch,
  exactCandidateMatch,
  mergeCandidates,
  parseSitemap,
  withTimeout,
  EMBED_TIMEOUT_MS,
  MAX_SEARCH_TERMS,
  isTurkishTitle,
  episodeOffset,
  type SeriesCandidate
} from './match'
import type { Stream, StreamQuery } from '@shared/types'

/**
 * Scraper connector for 3isk (قصة عشق, the `.news` brand).
 *
 * Worth having alongside krmzy and 3isq because it indexes by *Turkish* title:
 * its slugs are `3isk-se-<turkish-name>-watch`, so a show is findable from
 * TMDB's `original_title` alone. That is precisely the case the Arabic sites
 * fail — searching them for "Esaret" or "Muhtemel Aşk" returns nothing, and
 * their Arabic naming often disagrees with TMDB's.
 *
 * Episode URLs are derived rather than scraped: the series page mixes its own
 * episodes with promo links for other shows, but the slug shape is regular
 * enough (`episode-3isk-<name>-season-N-episode-M-watch`) to build directly and
 * confirm with a fetch.
 *
 * Playback goes through AlbaPlayer, which only shells the real embed: the
 * `data-watch` value is a `play.php?url=<player>` wrapper whose player page
 * iframes a packed JWPlayer host. `resolveEmbedStream` follows that iframe.
 */

const BASES = ['https://z.3isk.news', 'https://3isk.news']

/** Resolved streams are cached briefly — the m3u8 tokens are time-limited. */
const CACHE_TTL_MS = 10 * 60_000
const cache = new Map<string, { at: number; streams: Stream[] }>()

/** The catalogue is ~536 series and changes slowly. */
const CATALOG_TTL_MS = 60 * 60_000
let catalog: { at: number; entries: SeriesCandidate[] } | null = null

export const iskConnector: SourceConnector = {
  id: '3isk',
  name: 'قصة عشق (3isk)',
  kind: 'scraper',
  titleMatched: true,
  scope: ['turkish'],
  cost: 'expensive',

  async getStreams(query: StreamQuery): Promise<Stream[]> {
    if (query.type !== 'series' || query.episode == null) return []
    if (!isTurkishTitle(query)) return []

    const key = `${query.tmdbId}:${query.season ?? 1}:${query.episode}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.streams

    const streams = await resolve(query)
    cache.set(key, { at: Date.now(), streams })
    return streams
  },

  async test() {
    const entries = await getCatalog()
    return entries.length > 0
      ? { ok: true, message: `Reachable — ${entries.length} series listed.` }
      : { ok: false, message: 'No 3isk mirror reachable.' }
  }
}

/* ------------------------------------------------------------------ steps */

async function resolve(query: StreamQuery): Promise<Stream[]> {
  const seriesUrl = await findSeries(query)
  if (!seriesUrl) return []

  const season = query.season ?? 1
  const prior = await episodeOffset(query)
  if (prior === null) return []
  const absolute = prior + query.episode!
  const episodeUrl = await findEpisodeUrl(seriesUrl, season, query.episode!, absolute)
  if (!episodeUrl) return []

  const embeds = await getServers(episodeUrl)
  if (embeds.length === 0) return []

  const results = await Promise.allSettled(
    embeds.map((e) => withTimeout(toStream(e), EMBED_TIMEOUT_MS, null))
  )

  const streams: Stream[] = []
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) streams.push(result.value)
  }
  return streams
}

async function findSeries(query: StreamQuery): Promise<string | null> {
  const aliases = await getSearchAliases(query)
  const catalog = await getCatalog()
  const exact = exactCandidateMatch(catalog, aliases)
  if (exact) return exact

  const searchResults: SeriesCandidate[] = []

  for (const term of aliases.slice(0, MAX_SEARCH_TERMS)) {
    const html = await fetchText(`${BASES[0]}/?s=${encodeURIComponent(term)}`).catch(() => '')
    searchResults.push(...parseSearchResults(html))
  }

  // Search pages can return approximate matches before the title's own entry.
  // Compare all names together, including the Turkish slugs from the catalogue.
  return bestMatch(mergeCandidates(catalog, searchResults), aliases)
}

function parseSearchResults(html: string): SeriesCandidate[] {
  const links = new Map<string, SeriesCandidate>()
  const re = /<a\s+[^>]*href="(https?:\/\/[^"]+\/series\/[^"]+)"[^>]*?(?:\stitle="([^"]*)")?[^>]*>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const url = match[1]
    const title = decodeEntities(match[2] ?? '')
      .replace(/^مسلسل\s+/, '')
      .trim()
    if (!links.has(url)) links.set(url, { url, title })
  }
  return [...links.values()]
}

async function getCatalog(): Promise<SeriesCandidate[]> {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.entries

  for (const base of BASES) {
    const xml = await fetchText(`${base}/series-sitemap.xml`).catch(() => '')
    const entries = parseSitemap(xml)
      .filter((url) => /\/series\/[^/]+\/?$/.test(url))
      .map((url) => ({ url, title: seriesName(url) }))

    if (entries.length > 0) {
      catalog = { at: Date.now(), entries }
      return entries
    }
  }
  return catalog?.entries ?? []
}

/**
 * The show name inside a series slug.
 *
 * `3isk-se-aynadaki-yabanci-watch` -> `aynadaki yabanci`. Stripping the fixed
 * affixes matters: left in, "3isk" and "watch" are shared by all 536 entries
 * and drag every candidate's similarity score toward the same value.
 */
function seriesName(url: string): string {
  const slug = decodeURIComponent(url.replace(/\/$/, '').split('/').pop() ?? '')
  return slugCore(slug).replace(/-/g, ' ')
}

function slugCore(slug: string): string {
  return slug
    .replace(/^3isk-se-/, '')
    .replace(/-watch(?:-esh-[a-z0-9]+)?$/, '')
    .replace(/-esh-[a-z0-9]+$/, '')
}

/**
 * Builds the episode URL from the series slug and confirms it exists.
 *
 * Turkish broadcasters number continuously across seasons while TMDB restarts
 * each season, and this site follows neither consistently. The slug carries a
 * season, so the sound readings are the requested season with its own number,
 * or the absolute number under season 1 or the requested season. Season 1 with the *in-season* number
 * is not — it is an earlier episode, and it is what played Çirkin S1E5 for a
 * request of S2E5.
 */
async function findEpisodeUrl(
  seriesUrl: string,
  season: number,
  episode: number,
  absolute: number
): Promise<string | null> {
  const origin = originOf(seriesUrl) ?? BASES[0]
  const slug = decodeURIComponent(seriesUrl.replace(/\/$/, '').split('/').pop() ?? '')
  const core = slugCore(slug)
  if (!core) return null

  const slots: Array<[number, number]> = [[season, episode]]
  if (season > 1) slots.push([1, absolute], [season, absolute])

  for (const [s, e] of slots) {
    const url = `${origin}/video/episode-3isk-${core}-season-${s}-episode-${e}-watch/`
    const html = await fetchText(url).catch(() => '')
    if (html.includes('data-watch=')) return url
  }
  return null
}

/** Pulls the embed URLs out of the episode page's player buttons. */
async function getServers(episodeUrl: string): Promise<string[]> {
  const html = await fetchText(episodeUrl).catch(() => '')

  const urls = new Set<string>()
  for (const match of html.matchAll(/data-watch="([^"]+)"/g)) {
    const raw = decodeEntities(match[1]).trim()
    if (!raw || raw.includes('${')) continue // unrendered template placeholder
    urls.add(unwrapPlayer(raw.startsWith('//') ? `https:${raw}` : raw))
  }
  return [...urls]
}

/**
 * Unwraps `…/play.php?url=<real player>`.
 *
 * The wrapper host is itself frequently unreachable, and it adds nothing — the
 * player it would redirect to is right there in the query string.
 */
function unwrapPlayer(url: string): string {
  try {
    const inner = new URL(url).searchParams.get('url')
    if (inner && /^https?:\/\//.test(inner)) return inner
  } catch {
    /* not a URL we can parse — use it as-is */
  }
  return url
}

/* -------------------------------------------------------------- resolvers */

async function toStream(embedUrl: string): Promise<Stream | null> {
  let host: string
  try {
    host = new URL(embedUrl).host
  } catch {
    return null
  }

  const resolved = await resolveEmbedStream(embedUrl)
  if (!resolved) return null

  return {
    id: `3isk:${host}:${embedUrl}`,
    connectorId: '3isk',
    connectorName: 'قصة عشق (3isk)',
    url: resolved.file,
    label: host.replace(/^www\./, ''),
    quality: /master\.m3u8|1080|hd/i.test(resolved.file) ? 'HD' : 'auto',
    // The CDN checks these against the embed page it expects to be inside.
    headers: { Referer: `${resolved.pageOrigin}/`, Origin: resolved.pageOrigin },
    rank: RANK.addon
  }
}

/* -------------------------------------------------------------- utilities */

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}
