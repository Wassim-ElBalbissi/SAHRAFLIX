import { RANK, type SourceConnector } from './types'
import { fetchText, fetchPage, resolveEmbedStream, decodeEntities } from './embed'
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
  pickEpisode,
  episodeOffset,
  type SeriesCandidate
} from './match'
import type { Stream, StreamQuery } from '@shared/types'

/**
 * Scraper connector for 3isq (قصة عشق) — Turkish series subtitled in Arabic.
 *
 * Like krmzy this is a WordPress front end, but its player works differently:
 * each episode has a `/see/` sub-page that lists its "servers" directly as
 * `<li data-watch="<embed url>">` items — no external player, no base64. This
 * connector walks search -> series -> episode -> `/see/`, then resolves the
 * embed hosts that expose a direct `.m3u8`/`.mp4` (MegaMax, uqload, VOE, …) so
 * episodes play through the app's own HLS pipeline.
 *
 * The site rotates its serving domain (e.g. `3g.<random>.shop`); we start from
 * the stable brand domain and follow whatever absolute URLs it returns.
 *
 * Iframe-only or token-gated hosts (ok.ru, VK, videa.hu, DoodStream) have no
 * extractable direct stream and are skipped.
 */

/**
 * Entry points, best first.
 *
 * `3isq.top` is a pure portal — it holds no content and ignores `?s=` — while
 * the `.cam` hosts serve the real site and also rotate (`3g.<random>.shop` is
 * the current throwaway). The `http://` entries are not redundant: when a
 * middlebox is filtering on cleartext SNI, plain HTTP still gets through and
 * the page it returns names the host that is live today.
 */
const PORTALS = [
  'https://b.3isq.cam',
  'https://3isq.cam',
  'https://3isq.top',
  'http://b.3isq.cam',
  'http://3isq.cam'
]

/**
 * The discovered content host. Rediscovery is cheap relative to how often the
 * domain rotates, but not free — an hour keeps a dead domain from being retried
 * on every single episode.
 */
const BASE_TTL_MS = 60 * 60_000
let contentBase: { at: number; url: string } | null = null

/**
 * The site's whole series list, from its sitemap.
 *
 * Worth the extra request because the site's own search is far narrower than
 * its catalogue: the sitemap lists ~370 series including "المؤسس عثمان", which
 * searching for that exact name returns nothing for. Keyed by content host so a
 * domain rotation doesn't serve a stale list.
 */
const CATALOG_TTL_MS = 60 * 60_000
let catalog: { at: number; base: string; entries: SeriesCandidate[] } | null = null

/** Resolved streams are cached briefly — the m3u8 tokens are time-limited. */
const CACHE_TTL_MS = 10 * 60_000
const cache = new Map<string, { at: number; streams: Stream[] }>()

/** Hosts we know are iframe-only / token-gated — never worth fetching. */
const SKIP_HOSTS = [
  'ok.ru',
  'odnoklassniki',
  'vk.com',
  'vkvideo.ru',
  'videa.hu',
  'myvidplay.com',
  'dood',
  'facebook.com',
  'youtube.com',
  'youtu.be'
]

export const isqConnector: SourceConnector = {
  id: '3isq',
  name: 'قصة عشق (3isq)',
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
    const base = await discoverBase()
    return base
      ? { ok: true, message: `Reachable — currently serving from ${new URL(base).host}.` }
      : { ok: false, message: 'No 3isq content domain reachable.' }
  }
}

/* ------------------------------------------------------- domain discovery */

/**
 * Finds whichever host is serving 3isq right now.
 *
 * Walks the entry points until one returns a page containing `/series/` links,
 * and takes the host of those links rather than the host that served the page —
 * that is what makes the rotation self-healing, since a reachable mirror always
 * links the live domain even when it isn't the live domain itself.
 *
 * Deliberately narrow: only hosts that actually appear in a `/series/` link are
 * ever probed. An earlier version collected every URL on the page and spent
 * minutes timing out on analytics and CDN domains.
 */
async function discoverBase(): Promise<string | null> {
  if (contentBase && Date.now() - contentBase.at < BASE_TTL_MS) return contentBase.url

  for (const portal of PORTALS) {
    const page = await fetchPage(portal).catch(() => null)
    if (!page) continue

    const candidates = seriesLinkOrigins(page.text)

    // The page that served us is worth trying too, but only after the hosts it
    // points at: a stale mirror still serves old pages.
    const served = originOf(page.url)
    if (served && !candidates.includes(served)) candidates.push(served)

    for (const candidate of candidates) {
      if (await servesContent(candidate)) {
        contentBase = { at: Date.now(), url: candidate }
        return candidate
      }
    }
  }
  return null
}

/** Distinct origins of the `/series/` links on a page, in first-seen order. */
function seriesLinkOrigins(html: string): string[] {
  const origins: string[] = []
  for (const match of html.matchAll(/href="(https?:\/\/[^"]+\/series\/[^"]+)"/g)) {
    const origin = originOf(match[1])
    if (origin && !origins.includes(origin)) origins.push(origin)
  }
  return origins
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** A real content host answers `?s=` with series links; a portal does not. */
async function servesContent(origin: string): Promise<boolean> {
  const html = await fetchText(`${origin}/?s=${encodeURIComponent('مسلسل')}`).catch(() => '')
  return parseSearchResults(html).length > 0
}

/* ------------------------------------------------------------------ steps */

async function resolve(query: StreamQuery): Promise<Stream[]> {
  const seriesUrl = await findSeries(query)
  if (!seriesUrl) return []

  const episodeUrl = await findEpisodeUrl(seriesUrl, query)
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

/** Searches the site and returns the best-matching series page URL. */
async function findSeries(query: StreamQuery): Promise<string | null> {
  const base = await discoverBase()
  if (!base) return null
  const aliases = await getSearchAliases(query)
  const catalog = await getCatalog(base)
  const exact = exactCandidateMatch(catalog, aliases)
  if (exact) return exact

  const searchResults: SeriesCandidate[] = []

  for (const term of aliases.slice(0, MAX_SEARCH_TERMS)) {
    const html = await fetchText(`${base}/?s=${encodeURIComponent(term)}`).catch(() => '')
    searchResults.push(...parseSearchResults(html))
  }

  return bestMatch(mergeCandidates(searchResults, catalog), aliases)
}

/** Every series on the site, from its sitemap. Only the slug carries the name. */
async function getCatalog(base: string): Promise<SeriesCandidate[]> {
  if (catalog && catalog.base === base && Date.now() - catalog.at < CATALOG_TTL_MS) {
    return catalog.entries
  }

  const xml = await fetchText(`${base}/series-sitemap.xml`).catch(() => '')
  const entries = parseSitemap(xml)
    .filter((url) => /\/series\/[^/]+\/?$/.test(url))
    .map((url) => ({ url, title: seriesName(url) }))

  if (entries.length > 0) catalog = { at: Date.now(), base, entries }
  return entries
}

function parseSearchResults(html: string): SeriesCandidate[] {
  const links = new Map<string, SeriesCandidate>()
  const re = /<a\s+[^>]*href="(https?:\/\/[^"]+\/series\/[^"]+)"[^>]*?(?:\stitle="([^"]*)")?[^>]*>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const url = match[1]
    const title = decodeEntities(match[2] ?? '')
      .replace(/\s*-\s*قصة عشق\s*$/, '')
      .replace(/^مسلسل\s+/, '')
      .replace(/\s+مترجمة?$/, '')
      .trim()
    // Result anchors carry no `title` any more; the slug is then the only name.
    if (!links.has(url)) links.set(url, { url, title: title || seriesName(url) })
  }
  return [...links.values()]
}

/**
 * The show name inside a series slug.
 *
 * Every entry is filed as `مسلسل-<name>-مترجم` ("series <name>, subtitled").
 * `normalizeForMatch` drops the `مسلسل` but not the marker, so "القبيحة مترجم"
 * scored 0.67 against "القبيحة" — under the exact-match bar for every show on
 * the site, which is how 3isq came to return nothing for anything.
 */
function seriesName(url: string): string {
  let slug = url.replace(/\/$/, '').split('/').pop() ?? ''
  try {
    slug = decodeURIComponent(slug)
  } catch {
    /* malformed escape — the raw slug still scores */
  }
  return slug
    .replace(/^مسلسل-/, '')
    .replace(/-مترجمة?$/, '')
    .replace(/-/g, ' ')
}

/** Finds the episode page URL on a series page for any of the given numbers. */
async function findEpisodeUrl(seriesUrl: string, query: StreamQuery): Promise<string | null> {
  const listed = new Map<number, string>()
  const html = await fetchText(seriesUrl).catch(() => '')

  // Episode blocks: <a href="..." ...> ... <em>N</em> ... </a>
  const re = /<a\s+href="(https?:\/\/[^"]+)"[^>]*class="recent--block"[^>]*>[\s\S]*?<em>\s*(\d{1,4})\s*<\/em>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const n = Number(match[2])
    if (!listed.has(n)) listed.set(n, match[1])
  }
  const prior = await episodeOffset(query)
  return prior === null ? null : pickEpisode(listed, query.episode!, prior)
}

/** Pulls the embed URLs out of the episode's `/see/` player page. */
async function getServers(episodeUrl: string): Promise<string[]> {
  const seeUrl = episodeUrl.replace(/\/?$/, '/') + 'see/'
  const html = await fetchText(seeUrl, episodeUrl).catch(() => '')

  const urls = new Set<string>()
  const re = /data-watch="([^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const raw = decodeEntities(match[1]).trim()
    if (raw) urls.add(raw.startsWith('//') ? `https:${raw}` : raw)
  }
  return [...urls]
}

/* -------------------------------------------------------------- resolvers */

async function toStream(embedUrl: string): Promise<Stream | null> {
  let host: string
  try {
    host = new URL(embedUrl).host
  } catch {
    return null
  }

  if (SKIP_HOSTS.some((h) => host.includes(h))) return null

  // Handles VOE's JS redirect + obfuscated payload and the packed-JWPlayer
  // hosts alike.
  const resolved = await resolveEmbedStream(embedUrl)
  if (!resolved) return null

  const label = host.replace(/^www\./, '')
  return {
    id: `3isq:${host}:${embedUrl}`,
    connectorId: '3isq',
    connectorName: 'قصة عشق',
    url: resolved.file,
    label,
    quality: /master\.m3u8|1080|hd/i.test(resolved.file) ? 'HD' : 'auto',
    // The CDN checks these against the embed page it expects to be inside.
    headers: { Referer: `${resolved.pageOrigin}/`, Origin: resolved.pageOrigin },
    rank: RANK.addon
  }
}

