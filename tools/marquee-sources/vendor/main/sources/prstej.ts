import { RANK, type SourceConnector } from './types'
import { fetchPage, fetchText, resolveEmbedStream, decodeEntities } from './embed'
import { getSearchAliases } from './aliases'
import { withTimeout, EMBED_TIMEOUT_MS, MAX_SEARCH_TERMS, episodeOffset } from './match'
import { titleSimilarity } from './parse'
import type { Stream, StreamQuery } from '@shared/types'

/**
 * Scraper connector for برستيج (prstej.net).
 *
 * The cheapest of the Arabic scrapers by some margin: search -> `play.php` ->
 * one embed, all plain requests, no sitemap scan and no hidden Chromium window.
 * Measured 2026-08-09 against TMDB 322499.
 *
 * Its search is what makes that possible — it indexes **episodes**, not series,
 * so one request returns `watch.php?vid=<hex>` links whose titles already carry
 * the episode number (`مسلسل احتمال حب الحلقة 3 الثالثة مدبلج`). None of the
 * series-page walking the other four do is needed. The `vid` is opaque and
 * derives from nothing, which is also why the paste-a-website flow in Settings
 * cannot express this site: `generated.ts` templates are keyed by TMDB id.
 *
 * The chain past search is `resolveEmbedStream` verbatim — `play.php?vid=` is a
 * shell that iframes `hd1.hdup20.com/embed-<id>.html`, and that page is a packed
 * JWPlayer wrapping an `.m3u8` on a rotating `*.cdn-hd.com` host. Both hops are
 * already handled, hence no site-specific unpacking here.
 *
 * **No `getSubtitles`.** The resolved playlists carry no text tracks at all
 * (`tracks: []` on every one measured), so there is nothing to return.
 *
 * If this connector suddenly finds nothing, check DNS before assuming the site
 * changed. `a.prstej.net` resolves fine and then has its TLS handshake reset;
 * over plain HTTP it redirects to an ISP block page. Its DNS publishes an ECH
 * config, so it is reachable only with `secureDns: 'secure'` — the same case
 * `main/dns.ts` documents for `b.3isq.cam`.
 */

/** The bare domain 301s to `a.`; `fetchPage` keeps whichever host answered. */
const BASES = ['https://a.prstej.net', 'https://prstej.net']

const BASE_TTL_MS = 60 * 60_000
let contentBase: { at: number; url: string } | null = null

/** Resolved streams are cached briefly — the m3u8 tokens are time-limited. */
const CACHE_TTL_MS = 10 * 60_000
const cache = new Map<string, { at: number; streams: Stream[] }>()

/**
 * Ceiling on the whole search phase.
 *
 * Five aliases times up to three requests each is fifteen, and `fetchText`
 * allows any one of them 15s — so an unresponsive site could spend far past the
 * registry's 20s budget and have the result thrown away wholesale, which reads
 * as "found nothing" rather than as "ran too long". This leaves room for the
 * embed resolve after it. Hits measure 1.2–2.1s, so it only ever bites on a
 * site that is failing anyway.
 */
const SEARCH_BUDGET_MS = 10_000

/** Require an exact or spacing-equivalent title; a lone fuzzy result may be wrong. */
const MATCH_THRESHOLD = 0.98

export const prstejConnector: SourceConnector = {
  id: 'prstej',
  name: 'برستيج (prstej)',
  kind: 'scraper',
  titleMatched: true,
  scope: ['turkish'],
  /**
   * A miss is one search request, so this never earns demotion — see `tiers.ts`,
   * where only `expensive` connectors are moved to the second tier.
   */
  cost: 'cheap',

  async getStreams(query: StreamQuery): Promise<Stream[]> {
    if (query.type !== 'series' || query.episode == null) return []

    // Deliberately **no** `isTurkishTitle` gate, unlike the other four Arabic
    // scrapers. That gate exists because a miss there costs an alias fetch plus
    // a sitemap scan; here it costs one search. Dropping it is what makes the
    // site's Egyptian, Gulf and Levantine catalogue reachable — nothing else in
    // the app covers those — and it is the trade `anikoto` already makes.

    const key = `${query.tmdbId}:${query.season ?? 1}:${query.episode}`
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
      : { ok: false, message: 'prstej is not reachable. Check that Secure DNS is on.' }
  }
}

/* ------------------------------------------------------------------- base */

async function discoverBase(): Promise<string | null> {
  if (contentBase && Date.now() - contentBase.at < BASE_TTL_MS) return contentBase.url

  for (const candidate of BASES) {
    const page = await fetchPage(candidate).catch(() => null)
    // `search.php` is the one thing this connector actually needs to exist, so
    // it is a better liveness signal than the brand name in the markup.
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

  const vid = await withTimeout(findEpisodeVid(base, query), SEARCH_BUDGET_MS, null)
  if (!vid) return []

  // `watch.php` and `play.php` take the same id, and only `play.php` carries the
  // iframe — fetching the watch page first would buy a request and nothing else.
  const stream = await withTimeout(
    toStream(`${base}/play.php?vid=${vid}`),
    EMBED_TIMEOUT_MS,
    null
  )
  return stream ? [stream] : []
}

interface Result {
  vid: string
  /**
   * The series name with the `الحلقة …` tail, the leading `مسلسل`, any
   * `الموسم N` and any trailing part number removed — so every entry of one show
   * shares it. See `baseName`.
   */
  name: string
  /** Season from an explicit `الموسم N`, when the site states one. */
  season: number | null
  episode: number
  dubbed: boolean
}

/**
 * Finds the `vid` for the requested episode.
 *
 * Both the series **and** the episode number are verified before a result is
 * accepted, because search returns episodes of everything it thinks is relevant
 * and accepting on either alone is how a connector silently plays the wrong
 * thing.
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
    results.push(...(await search(base, alias)))
    if (bestNameScore(results, aliases)?.score === 1) break
  }

  // What the site calls this show. It must match one of TMDB's names; a lone
  // fuzzy search result is not enough evidence to play it.
  const name = bestName(results, aliases)
  if (!name) return null

  // Short runs are answered outright — the first page of a search for a show
  // with 30-odd episodes is often its whole episode list.
  const direct = pick(results, name, query, absolute)
  if (direct) return direct

  // Long runs are not, and paging is not the answer: asking for the requested
  // number directly finds it without walking a scattered list of episodes.
  for (const number of searchNumbers) {
    const targeted = await search(base, episodeTerm(name, query, results, number))
    const found = pick(targeted, name, query, absolute)
    if (found) return found
  }

  return null
}

/**
 * The search phrase for one specific episode.
 *
 * Season is included only when the site's own entries state one, since for a
 * continuously numbered run there is no season in its vocabulary to ask about.
 */
function episodeTerm(
  name: string,
  query: StreamQuery,
  results: Result[],
  number: number
): string {
  return results.some((r) => r.season != null)
    ? `${name} الموسم ${query.season ?? 1} الحلقة ${number}`
    : `${name} الحلقة ${number}`
}

/** One page of the site's search, parsed into episode results. */
async function search(base: string, term: string): Promise<Result[]> {
  const url = `${base}/search.php?keywords=${encodeURIComponent(term)}`
  const html = await fetchText(url).catch(() => '')
  return parseResults(html)
}

/**
 * Pulls the episode results out of a search page.
 *
 * Each item renders twice — a thumbnail link with no text and a title link with
 * it — so results are keyed by `vid` and the first non-empty title wins.
 */
function parseResults(html: string): Result[] {
  const found = new Map<string, Result>()
  const re = /<a\s+[^>]*href="[^"]*watch\.php\?vid=([A-Za-z0-9]+)"([^>]*)>([\s\S]*?)<\/a>/g

  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const [, vid, attrs, inner] = match
    if (found.has(vid)) continue

    const titleAttr = /\stitle="([^"]*)"/.exec(attrs)?.[1] ?? ''
    const text = decodeEntities(titleAttr || inner.replace(/<[^>]*>/g, ''))
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue

    const episode = /الحلقة\s*(\d{1,4})/.exec(text)
    if (!episode) continue

    // Everything before `الحلقة` names the show; the tail is the number, its
    // Arabic ordinal, and the dub/sub and quality markers.
    const head = text.slice(0, episode.index)

    found.set(vid, {
      vid,
      name: baseName(head),
      season: seasonOf(head),
      episode: Number(episode[1]),
      // Matches مدبلج and مدبلجة alike.
      dubbed: /مدبلج/.test(text)
    })
  }

  return [...found.values()]
}

/**
 * The name shared by every entry of one show.
 *
 * The site splits long runs across entries and labels them two different ways,
 * which matters because only one of them restarts the episode count:
 *
 *   `المؤسس عثمان` / `المؤسس عثمان 2` / `المؤسس عثمان 3`  — one continuous run,
 *   episode 236 living in entry 3. A trailing digit here is a *part* label, not
 *   a season: Kuruluş Osman has six TMDB seasons and three entries, so reading
 *   it as one would be wrong in both directions.
 *
 *   `Game of Thrones الموسم 1` / `… الموسم 3` — a real season, numbered from 1.
 *
 * Both are stripped so grouping sees one show; `seasonOf` keeps the part that
 * can be trusted.
 */
function baseName(head: string): string {
  return head
    .replace(/^\s*مسلسل\s+/, '')
    .replace(/\s*الموسم\s*\d{1,2}\s*/, ' ')
    .replace(/\s+\d{1,2}\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** An explicit `الموسم N`, the only season statement worth believing. */
function seasonOf(head: string): number | null {
  const match = /الموسم\s*(\d{1,2})/.exec(head)
  return match ? Number(match[1]) : null
}

/**
 * The show on this page that we were looking for.
 *
 * Scores the **stripped** name rather than the raw result title, which is
 * load-bearing: the shared matcher scores token overlap, and stripping keeps
 * episode labels from diluting an otherwise exact match.
 *
 * **Scoring alone is not enough, and assuming it was is what made this connector
 * return nothing for Doğanın Kanunu.** The site indexes a show's Turkish name
 * but *displays* the Arabic one, so searching `Doğanın Kanunu` correctly returns
 * nine episodes of `قانون الطبيعة` — and every score between those two strings
 * is 0, because they share no script. Any title TMDB has no Arabic name for
 * fails this way, which is most of them.
 *
 * If no TMDB name matches, this connector now returns no stream. The site's
 * search can return one unrelated show for a new title, so result count alone
 * cannot establish identity.
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
 * The chosen show's entry for the requested episode.
 *
 * Which numbers those are depends on how the site split the show. When its
 * entries carry an explicit `الموسم N` the count restarts per season, so the
 * season has to match and only the bare episode number means anything — without
 * that check `الحلقة 1` exists in every season entry and the wrong one plays.
 * With no marker the run is continuous and *only* the absolute number means
 * anything — past season 1 the bare number there is an earlier season's
 * episode, which is how Çirkin S2E5 played S1E5.
 */
function pick(
  results: Result[],
  name: string,
  query: StreamQuery,
  absolute: number
): string | null {
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

async function toStream(playUrl: string): Promise<Stream | null> {
  const resolved = await resolveEmbedStream(playUrl)
  if (!resolved) return null

  const host = new URL(resolved.pageOrigin).host.replace(/^www\./, '')
  return {
    id: `prstej:${playUrl}`,
    connectorId: 'prstej',
    connectorName: 'برستيج',
    url: resolved.file,
    label: host,
    quality: /master\.m3u8|1080|hd/i.test(resolved.file) ? 'HD' : 'auto',
    // The CDN checks these against the embed page it expects to be inside.
    headers: { Referer: `${resolved.pageOrigin}/`, Origin: resolved.pageOrigin },
    rank: RANK.addon
  }
}
