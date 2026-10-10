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
  pickEpisode,
  episodeOffset,
  type SeriesCandidate
} from './match'
import type { Stream, StreamQuery } from '@shared/types'

/**
 * Scraper connector for krmzy.org (موقع قرمزي) — Turkish series subtitled in
 * Arabic.
 *
 * The site is a WordPress front end whose episode pages hand a base64 payload
 * to a shared player (qesen.net). That payload lists the "servers" for the
 * episode, each of which is a JWPlayer embed on a third-party host. This
 * connector walks search -> series -> episode, decodes the payload, then
 * resolves the JWPlayer embeds down to their direct `.m3u8`, so episodes play
 * through the app's own HLS pipeline rather than a foreign iframe.
 *
 * Only the HLS-based hosts are surfaced: they map cleanly to a playable URL.
 * YouTube-backed servers are skipped along with the rest of the app's YouTube
 * support, as are hosts like ok.ru / mail.ru with no extractable stream.
 */

/**
 * The site answers on both spellings and its canonical tags point at krmzi.org,
 * so keep both: whichever resolves first wins and the other is the safety net
 * when one is taken down.
 */
const BASES = ['https://krmzy.org', 'https://krmzi.org']
const BASE = BASES[0]

/** Resolved streams are cached briefly — the m3u8 tokens are time-limited. */
const CACHE_TTL_MS = 10 * 60_000
const cache = new Map<string, { at: number; streams: Stream[] }>()

/**
 * The full series list, from the sitemap.
 *
 * The site's own search is close to useless — it matches on the exact Arabic
 * wording and returns nothing for a title spelled even slightly differently —
 * but the sitemap lists all ~180 series, so fuzzy-matching locally finds shows
 * that no search term would have. Cached for an hour: new series appear rarely.
 */
const CATALOG_TTL_MS = 60 * 60_000
let catalog: { at: number; entries: SeriesCandidate[] } | null = null

interface Server {
  name: string
  id: string
}

export const krmzyConnector: SourceConnector = {
  id: 'krmzy',
  name: 'قرمزي (krmzy.org)',
  kind: 'scraper',
  titleMatched: true,
  scope: ['turkish'],
  cost: 'expensive',

  async getStreams(query: StreamQuery): Promise<Stream[]> {
    // The site only carries Turkish series, numbered by absolute episode.
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
    for (const base of BASES) {
      try {
        const res = await fetchText(`${base}/`)
        if (res.includes('قرمزي')) {
          const size = (await getCatalog()).length
          return { ok: true, message: `Reachable via ${new URL(base).host} — ${size} series listed.` }
        }
      } catch {
        /* try the other spelling */
      }
    }
    return { ok: false, message: 'No krmzy mirror reachable.' }
  }
}

/* ------------------------------------------------------------------ steps */

async function resolve(query: StreamQuery): Promise<Stream[]> {
  const seriesUrl = await findSeries(query)
  if (!seriesUrl) return []

  const episodeUrl = await findEpisodeUrl(seriesUrl, query)
  if (!episodeUrl) return []

  const servers = await getServers(episodeUrl)
  if (servers.length === 0) return []

  const results = await Promise.allSettled(
    servers.map((s) => withTimeout(toStream(s), EMBED_TIMEOUT_MS, null))
  )
  const streams: Stream[] = []
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) streams.push(result.value)
  }
  return streams
}

/**
 * Finds the series page, first via the site's search and then — because that
 * search only matches near-exact Arabic wording — against the whole sitemap.
 */
async function findSeries(query: StreamQuery): Promise<string | null> {
  const aliases = await getSearchAliases(query)
  const catalog = await getCatalog()
  const exact = exactCandidateMatch(catalog, aliases)
  if (exact) return exact

  const searchResults: SeriesCandidate[] = []

  for (const term of aliases.slice(0, MAX_SEARCH_TERMS)) {
    const html = await fetchText(`${BASE}/?s=${encodeURIComponent(term)}`).catch(() => '')
    searchResults.push(...parseSearchResults(html))
  }

  return bestMatch(mergeCandidates(searchResults, catalog), aliases)
}

function parseSearchResults(html: string): SeriesCandidate[] {
  const links = new Map<string, SeriesCandidate>()
  const re = /<a\s+href="(https:\/\/krmz[yi]\.org\/series\/[^"]+)"\s+title="([^"]*?)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const url = match[1]
    const title = decodeEntities(match[2]).replace(/\s*-\s*(?:موقع\s*)?قرمزي\s*$/, '').trim()
    if (!links.has(url)) links.set(url, { url, title })
  }
  return [...links.values()]
}

/** Every series on the site, from its sitemap. Only the slug carries the name. */
async function getCatalog(): Promise<SeriesCandidate[]> {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.entries

  for (const base of BASES) {
    const xml = await fetchText(`${base}/series-sitemap.xml`).catch(() => '')
    const entries = parseSitemap(xml)
      .filter((url) => /\/series\/[^/]+\/?$/.test(url))
      .map((url) => ({ url }))

    if (entries.length > 0) {
      catalog = { at: Date.now(), entries }
      return entries
    }
  }
  return catalog?.entries ?? []
}

/** Finds the requested episode's page URL (see `pickEpisode` for which number). */
async function findEpisodeUrl(seriesUrl: string, query: StreamQuery): Promise<string | null> {
  const prior = await episodeOffset(query)
  if (prior === null) return null
  const listed = new Map<number, string>()
  const html = await fetchText(seriesUrl).catch(() => '')

  const re = /<a\s+href="(https:\/\/krmz[yi]\.org\/episode\/[^"]+)"[^>]*>[\s\S]*?<span>\s*(\d{1,4})\s*<\/span>\s*<\/div>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const n = Number(match[2])
    if (!listed.has(n)) listed.set(n, match[1])
  }
  const picked = pickEpisode(listed, query.episode!, prior)
  if (picked) return picked

  // Fallback: the episode slug is the series slug plus "الحلقة N". Built on the
  // series URL's own origin so a krmzi.org hit doesn't get rewritten to krmzy.
  const origin = originOf(seriesUrl)
  const slug = seriesUrl.replace(/\/$/, '').split('/').pop()
  // Absolute number only: this site numbers continuously, and a built URL for
  // the in-season number past season 1 would confirm season 1's episode instead.
  if (slug) {
    const url = `${origin}/episode/${slug}-${encodeURIComponent('الحلقة')}-${prior + query.episode!}/`
    const page = await fetchText(url).catch(() => '')
    if (page.includes('qesen.net/krmzi')) return url
  }
  return null
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return BASE
  }
}

/** Pulls the server list out of the episode page's player payload. */
async function getServers(episodeUrl: string): Promise<Server[]> {
  const html = await fetchText(episodeUrl).catch(() => '')
  const match = html.match(/qesen\.net\/krmzi\?post=([A-Za-z0-9+/=]+)/)
  if (!match) return []

  try {
    const json = Buffer.from(match[1], 'base64').toString('utf8')
    const payload = JSON.parse(json) as { servers?: Server[] }
    return (payload.servers ?? []).filter((s) => s && s.name && s.id)
  } catch {
    return []
  }
}

/* -------------------------------------------------------------- resolvers */

/** Third-party embed hosts that use the same packed-JWPlayer shape. */
const EMBED_HOSTS: Record<string, (id: string) => string> = {
  'Arab HD': (id) => `https://arabhd.onl/embed-${id}.html`,
  estream: (id) => `https://arabveturk.com/embed-${id}.html`,
  box: (id) => `https://youdboox.com/embed-${id}.html`,
  now: (id) => `https://extreamnow.org/embed-${id}.html`,
  'Red HD': (id) => `https://iplayerhls.com/e/${id}`
}

async function toStream(server: Server): Promise<Stream | null> {
  // YouTube-hosted servers are skipped along with the rest of the app's
  // YouTube support — there is no player left to hand them to.
  if (server.name === 'youtube' || server.name === 'youtube_in') return null

  const embedUrl = EMBED_HOSTS[server.name]?.(server.id)
  if (!embedUrl) return null

  const resolved = await resolveEmbedStream(embedUrl)
  if (!resolved) return null

  return {
    id: `krmzy:${server.name}:${server.id}`,
    connectorId: 'krmzy',
    connectorName: 'قرمزي',
    url: resolved.file,
    label: server.name,
    quality: /master\.m3u8|1080|hd/i.test(resolved.file) ? 'HD' : 'auto',
    // The CDN checks these against the embed page it expects to be inside.
    headers: { Referer: `${resolved.pageOrigin}/`, Origin: resolved.pageOrigin },
    rank: RANK.addon
  }
}
