import { RANK, type SourceConnector } from './types'
import { fetchPage, fetchText, resolveEmbedStream, decodeEntities } from './embed'
import { getSearchAliases } from './aliases'
import { withTimeout, EMBED_TIMEOUT_MS, MAX_SEARCH_TERMS, episodeOffset } from './match'
import { titleSimilarity } from './parse'
import type { Stream, StreamQuery } from '@shared/types'

/**
 * Scraper connector for ماي سيما / MYCIMA (mywecima.life).
 *
 * The same PHPMotion CMS as برستيج (`prstej.ts`) — `search.php?keywords=`,
 * `watch.php?vid=<hex>` results whose `title` attribute is the whole label, and
 * `play.php?vid=` for the player — so the walk is prstej's. It is its own file
 * rather than a shared factory because the two sites diverge in every place
 * that matters and prstej is measured and working; nothing here touches it.
 *
 * Where it diverges, and why each is load-bearing:
 *
 * - **The catalogue is everything, not Turkish drama.** Arabic, foreign, Asian,
 *   Indian and Turkish series, films in all of those, and anime. So there is no
 *   `isTurkishTitle` gate and no `scope` — it runs for every title, and it can
 *   afford to because a miss is one search request (`cost: 'cheap'`, the trade
 *   prstej and anikoto already make). It is also the first title-searching
 *   connector that serves **movies**.
 * - **Seasons are Arabic ordinal words**, not digits: `مسلسل Star Trek: Strange
 *   New Worlds الموسم الرابع الحلقة 4 الرابعة مترجمة`. prstej's `الموسم N` regex
 *   matches none of them, hence `ORDINALS` below.
 * - **`play.php` lists several servers**, as a `list_servers` block of
 *   `<iframe src='…'>` (single-quoted) — measured seven on one episode: vidara,
 *   vibuxer, dhtpre, bysesukior, mxdrop, uqload, dsvplay. They are all resolved
 *   through `resolveEmbedStream` under one settle, and whichever unpacks plays.
 *   The fan-out is capped at `MAX_EMBEDS` so a slow day cannot push the
 *   connector past the registry's 20s ceiling.
 * - **Foreign series keep their Latin titles**, so TMDB's own `title` and
 *   `originalTitle` usually hit directly; Arabic-titled shows depend on the
 *   alternative titles exactly as prstej does. Matching stays exact (0.98): a
 *   search for "Fight Club" returns "They Fight 2026", and a fuzzy accept would
 *   play it.
 *
 * Like prstej it publishes an ECH config and is reachable only under
 * `secureDns: 'secure'`; from a plain shell the TLS handshake times out. Check
 * DNS before assuming the site changed.
 */

/** `/` 301s to `/main`; `fetchPage` keeps whichever origin answered. */
const BASES = ['https://mywecima.life']

const BASE_TTL_MS = 60 * 60_000
let contentBase: { at: number; url: string } | null = null

/** Resolved streams are cached briefly — embed tokens are time-limited. */
const CACHE_TTL_MS = 10 * 60_000
const cache = new Map<string, { at: number; streams: Stream[] }>()

/**
 * Ceiling on the whole search phase, leaving the rest of the registry's 20s
 * for the embed resolves. Hits are one to three requests; this only bites on
 * a site that is failing anyway.
 */
const SEARCH_BUDGET_MS = 10_000

/** Require an exact or spacing-equivalent title; a lone fuzzy result may be wrong. */
const MATCH_THRESHOLD = 0.98

/**
 * How many of the play page's servers to resolve. Each is bounded by
 * `EMBED_TIMEOUT_MS` and they settle in parallel, so this is about not hammering
 * seven hosts for one episode rather than about time.
 */
const MAX_EMBEDS = 5

export const mycimaConnector: SourceConnector = {
  id: 'mycima',
  name: 'ماي سيما (mycima)',
  kind: 'scraper',
  titleMatched: true,
  cost: 'cheap',

  async getStreams(query: StreamQuery): Promise<Stream[]> {
    const isMovie = query.type === 'movie'
    if (!isMovie && (query.type !== 'series' || query.episode == null)) return []

    const key = isMovie
      ? `movie:${query.tmdbId}`
      : `${query.tmdbId}:${query.season ?? 1}:${query.episode}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.streams

    const streams = await resolve(query)
    cache.set(key, { at: Date.now(), streams })
    return streams
  },

  async test() {
    const base = await discoverBase()
    return base
      ? { ok: true, message: `Reachable — currently serving from ${new URL(base).host}.` }
      : { ok: false, message: 'mycima is not reachable. Check that Secure DNS is on.' }
  }
}

/* ------------------------------------------------------------------- base */

async function discoverBase(): Promise<string | null> {
  if (contentBase && Date.now() - contentBase.at < BASE_TTL_MS) return contentBase.url

  for (const candidate of BASES) {
    const page = await fetchPage(candidate).catch(() => null)
    // `search.php` is the one thing this connector needs to exist.
    if (!page || !page.text.includes('search.php')) continue
    const url = new URL(page.url).origin
    contentBase = { at: Date.now(), url }
    return url
  }

  return null
}

/* ------------------------------------------------------------------ steps */

async function resolve(query: StreamQuery): Promise<Stream[]> {
  const base = await discoverBase()
  if (!base) return []

  const vid = await withTimeout(
    query.type === 'movie' ? findMovieVid(base, query) : findEpisodeVid(base, query),
    SEARCH_BUDGET_MS,
    null
  )
  if (!vid) return []

  // `watch.php` and `play.php` take the same id; only `play.php` carries the
  // server iframes.
  return toStreams(base, vid)
}

interface Result {
  vid: string
  /** The show's name with every label stripped, so entries of one show share it. */
  name: string
  /** Season from an explicit `الموسم …`, digits or ordinal word. */
  season: number | null
  episode: number
  dubbed: boolean
}

interface MovieResult {
  vid: string
  name: string
  year: number | null
  dubbed: boolean
}

/**
 * Finds the `vid` for the requested episode. Both the series and the episode
 * number are verified: search returns episodes of everything it thinks is
 * relevant, and accepting on either alone plays the wrong thing silently.
 */
async function findEpisodeVid(base: string, query: StreamQuery): Promise<string | null> {
  const aliases = await getSearchAliases(query)
  if (aliases.length === 0) return null

  const prior = await episodeOffset(query)
  if (prior === null) return null
  const absolute = prior + query.episode!
  // Both readings are worth searching for; `pick` decides which may be accepted.
  const searchNumbers = [...new Set([query.episode!, absolute])]

  const results: Result[] = []
  for (const alias of aliases.slice(0, MAX_SEARCH_TERMS)) {
    results.push(...parseResults(await search(base, alias)))
    if (bestNameScore(results, aliases)?.score === 1) break
  }

  const name = bestName(results, aliases)
  if (!name) return null

  const direct = pick(results, name, query, absolute)
  if (direct) return direct

  // Long runs scatter across pages; asking for the number outright finds it.
  for (const number of searchNumbers) {
    const targeted = parseResults(await search(base, episodeTerm(name, query, results, number)))
    const found = pick(targeted, name, query, absolute)
    if (found) return found
  }

  return null
}

/**
 * Finds the `vid` for a film: exact title, and the year within one of TMDB's
 * when both are known — the site lists remakes and same-named films side by
 * side, and the year is the only thing telling them apart.
 */
async function findMovieVid(base: string, query: StreamQuery): Promise<string | null> {
  const aliases = await getSearchAliases(query)
  if (aliases.length === 0) return null

  for (const alias of aliases.slice(0, MAX_SEARCH_TERMS)) {
    const results = parseMovieResults(await search(base, alias))
    for (const result of results) {
      if (result.dubbed) continue
      if (query.year && result.year && Math.abs(result.year - query.year) > 1) continue
      const score = Math.max(...aliases.map((a) => titleSimilarity(result.name, a)))
      if (score >= MATCH_THRESHOLD) return result.vid
    }
  }

  return null
}

function episodeTerm(name: string, query: StreamQuery, results: Result[], number: number): string {
  return results.some((r) => r.season != null)
    ? `${name} الموسم ${query.season ?? 1} الحلقة ${number}`
    : `${name} الحلقة ${number}`
}

/** One page of the site's search, raw. */
async function search(base: string, term: string): Promise<string> {
  const url = `${base}/search.php?keywords=${encodeURIComponent(term)}`
  return fetchText(url).catch(() => '')
}

/**
 * Every `watch.php` result on a page with its label. Each item renders twice —
 * a thumbnail link with no text and a title link with it — so results are
 * keyed by `vid` and the first non-empty label wins.
 */
function parseLabels(html: string): Map<string, string> {
  const found = new Map<string, string>()
  const re = /<a\s+[^>]*href="[^"]*watch\.php\?vid=([A-Za-z0-9]+)"([^>]*)>([\s\S]*?)<\/a>/g

  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const [, vid, attrs, inner] = match
    if (found.has(vid)) continue

    const titleAttr = /\stitle="([^"]*)"/.exec(attrs)?.[1] ?? ''
    const text = decodeEntities(titleAttr || inner.replace(/<[^>]*>/g, ''))
      .replace(/\s+/g, ' ')
      .trim()
    if (text) found.set(vid, text)
  }

  return found
}

function parseResults(html: string): Result[] {
  const results: Result[] = []
  for (const [vid, text] of parseLabels(html)) {
    const episode = /الحلقة\s*(\d{1,4})/.exec(text)
    if (!episode) continue

    // Everything before `الحلقة` names the show; the tail is the number, its
    // Arabic ordinal, and the dub/sub and quality markers.
    const head = text.slice(0, episode.index)
    results.push({
      vid,
      name: baseName(head),
      season: seasonOf(head),
      episode: Number(episode[1]),
      dubbed: /مدبلج/.test(text)
    })
  }
  return results
}

/**
 * `فيلم <name> <year> مترجم`, sometimes prefixed `مشاهدة`. A label carrying
 * `الحلقة` is an episode however it starts, and is not a film.
 */
function parseMovieResults(html: string): MovieResult[] {
  const results: MovieResult[] = []
  for (const [vid, text] of parseLabels(html)) {
    if (/الحلقة/.test(text)) continue
    const match = /^(?:مشاهدة\s+)?(?:فيلم|فلم)\s+(.+)$/.exec(text)
    if (!match) continue

    const year = /(?:^|\s)((?:19|20)\d{2})(?=\s|$)/.exec(match[1])
    const name = (year ? match[1].slice(0, year.index) : match[1])
      .replace(MARKERS, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!name) continue

    results.push({
      vid,
      name,
      year: year ? Number(year[1]) : null,
      dubbed: /مدبلج/.test(text)
    })
  }
  return results
}

/**
 * Dub/sub and quality markers that trail a title. Whitespace anchors rather
 * than `\b`: Arabic letters are not `\w`, so a word boundary never sits beside
 * them and `\bمترجم\b` matches nothing.
 */
const MARKERS = /(?:^|\s)(?:مترجمة?|مدبلجة?|كاملة?|HD|4K|BluRay|WEB-DL)(?=\s|$)/gi

/**
 * The name shared by every entry of one show: the leading category word, any
 * `الموسم …` statement and a trailing part digit all go. The digit is a part
 * label rather than a season on Turkish runs (`المؤسس عثمان 3` holds episode
 * 236), so only an explicit `الموسم` is believed — see `seasonOf`.
 */
function baseName(head: string): string {
  return head
    .replace(/^\s*(?:مشاهدة\s+)?(?:مسلسل|انمي|أنمي|برنامج)\s+/, '')
    .replace(SEASON_RE, ' ')
    .replace(MARKERS, ' ')
    .replace(/\s+\d{1,2}\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Season ordinals as this site writes them. Both the hamza-less and hamza
 * spellings occur (`الاول` / `الأول`), and the teens are two words.
 */
const ORDINALS: Record<string, number> = {
  الاول: 1,
  الأول: 1,
  الثاني: 2,
  الثانى: 2,
  الثالث: 3,
  الرابع: 4,
  الخامس: 5,
  السادس: 6,
  السابع: 7,
  الثامن: 8,
  التاسع: 9,
  العاشر: 10,
  'الحادي عشر': 11,
  'الحادى عشر': 11,
  'الثاني عشر': 12,
  'الثانى عشر': 12,
  'الثالث عشر': 13,
  'الرابع عشر': 14,
  'الخامس عشر': 15,
  'السادس عشر': 16,
  'السابع عشر': 17,
  'الثامن عشر': 18,
  'التاسع عشر': 19,
  العشرون: 20
}

/** `الموسم` followed by digits or by one of the ordinal words above. */
const SEASON_RE = new RegExp(
  `الموسم\\s*(\\d{1,2}|${Object.keys(ORDINALS)
    .sort((a, b) => b.length - a.length)
    .join('|')})`
)

function seasonOf(head: string): number | null {
  const match = SEASON_RE.exec(head)
  if (!match) return null
  const token = match[1]
  return /^\d+$/.test(token) ? Number(token) : (ORDINALS[token] ?? null)
}

/**
 * What the site calls this show. It must match one of TMDB's names; a lone
 * fuzzy search result is not evidence — see the header on "They Fight".
 */
function bestName(results: Result[], aliases: string[]): string | null {
  const best = bestNameScore(results, aliases)
  return best && best.score >= MATCH_THRESHOLD ? best.name : null
}

function bestNameScore(results: Result[], aliases: string[]): { name: string; score: number } | null {
  let best: { name: string; score: number } | null = null

  for (const result of results) {
    for (const alias of aliases) {
      const score = titleSimilarity(result.name, alias)
      if (!best || score > best.score) best = { name: result.name, score }
    }
  }

  return best
}

/**
 * The chosen show's entry for the requested episode. When the show's entries
 * carry a season the count restarts per season, so the season must match and
 * only the bare episode number means anything; with no marker the run is
 * continuous and *only* the absolute number does — past season 1 the bare
 * number there is an earlier season's episode, which is how Çirkin S2E5 played
 * S1E5.
 */
function pick(results: Result[], name: string, query: StreamQuery, absolute: number): string | null {
  // Same site, so the names should be identical — but a stray `HD` or a
  // spacing difference shouldn't lose the episode.
  const own = results.filter((r) => titleSimilarity(r.name, name) >= 0.9)
  const seasoned = own.some((r) => r.season != null)
  const number = seasoned ? query.episode! : absolute

  for (const result of own) {
    if (result.dubbed) continue
    if (result.episode !== number) continue
    if (seasoned && result.season !== (query.season ?? 1)) continue
    return result.vid
  }
  return null
}

/* -------------------------------------------------------------- resolvers */

/**
 * Every server the play page iframes, resolved in parallel. The page quotes
 * `src` with single quotes, so the iframe scan accepts either.
 */
async function toStreams(base: string, vid: string): Promise<Stream[]> {
  const playUrl = `${base}/play.php?vid=${vid}`
  const html = await fetchText(playUrl).catch(() => '')

  const embeds = new Set<string>()
  for (const match of html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) {
    const raw = decodeEntities(match[1]).trim()
    if (!raw || raw.includes('${')) continue
    try {
      const abs = new URL(raw, playUrl)
      if (/^https?:$/.test(abs.protocol)) embeds.add(abs.href)
    } catch {
      /* not a usable URL */
    }
  }

  const results = await Promise.allSettled(
    [...embeds].slice(0, MAX_EMBEDS).map((e) => withTimeout(toStream(e, vid), EMBED_TIMEOUT_MS, null))
  )

  const streams: Stream[] = []
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) streams.push(result.value)
  }
  return streams
}

async function toStream(embedUrl: string, vid: string): Promise<Stream | null> {
  let host: string
  try {
    host = new URL(embedUrl).host
  } catch {
    return null
  }

  const resolved = await resolveEmbedStream(embedUrl, 4).catch(() => null)
  if (!resolved) return null

  return {
    id: `mycima:${host}:${vid}`,
    connectorId: 'mycima',
    connectorName: 'ماي سيما',
    url: resolved.file,
    label: host.replace(/^www\./, ''),
    quality: /master\.m3u8|1080|hd/i.test(resolved.file) ? 'HD' : 'auto',
    // The CDN checks these against the embed page it expects to be inside.
    headers: { Referer: `${resolved.pageOrigin}/`, Origin: resolved.pageOrigin },
    rank: RANK.addon
  }
}
