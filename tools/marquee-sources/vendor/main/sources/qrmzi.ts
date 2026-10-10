import { RANK, type SourceConnector } from './types'
import { fetchText, resolveEmbedStream, decodeEntities } from './embed'
import { getSearchAliases } from './aliases'
import {
  bestMatch,
  parseSitemap,
  withTimeout,
  EMBED_TIMEOUT_MS,
  isTurkishTitle,
  pickEpisode,
  episodeOffset,
  type SeriesCandidate
} from './match'
import type { Stream, StreamQuery } from '@shared/types'

/**
 * Scraper connector for qrmzi.tv — the same brand as krmzy, but a separate
 * deployment with its own catalogue and, more usefully, a completely different
 * player chain.
 *
 * The catalogues overlap heavily (~90%), so this is not really about breadth.
 * It is about redundancy: krmzy resolves through packed JWPlayer embeds on
 * arabhd/arabveturk/iplayerhls, while this site serves AlbaPlayer, which iframes
 * a packed embed on cdnplus. When one of those host families is down or has
 * rotated its tokens, the other usually still plays the same episode.
 *
 * The listing site and the episode host are split: series pages live on
 * qrmzi.tv, and the episodes they link to live on `w<n>.qrmzi.site`, which
 * rotates. Every episode link is absolute, so following them self-heals.
 */

const BASES = ['https://qrmzi.tv', 'https://www.qrmzi.tv']

/** Resolved streams are cached briefly — the m3u8 tokens are time-limited. */
const CACHE_TTL_MS = 10 * 60_000
const cache = new Map<string, { at: number; streams: Stream[] }>()

const CATALOG_TTL_MS = 60 * 60_000
let catalog: { at: number; entries: SeriesCandidate[] } | null = null

export const qrmziConnector: SourceConnector = {
  id: 'qrmzi',
  name: 'قرمزي (qrmzi.tv)',
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
      : { ok: false, message: 'qrmzi.tv not reachable.' }
  }
}

/* ------------------------------------------------------------------ steps */

async function resolve(query: StreamQuery): Promise<Stream[]> {
  const aliases = await getSearchAliases(query)

  // Straight to the catalogue: this site's search adds nothing the sitemap
  // doesn't already list, and the sitemap is one request instead of several.
  const seriesUrl = bestMatch(await getCatalog(), aliases)
  if (!seriesUrl) return []

  const episodeUrl = await findEpisodeUrl(seriesUrl, query)
  if (!episodeUrl) return []

  const embeds = await getServers(episodeUrl)
  if (embeds.length === 0) return []

  const results = await Promise.allSettled(
    embeds.map((e) => withTimeout(toStream(e, episodeUrl), EMBED_TIMEOUT_MS, null))
  )

  const streams: Stream[] = []
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) streams.push(result.value)
  }
  return streams
}

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

/**
 * Finds the requested episode's page (see `pickEpisode` for which number).
 *
 * The number is read out of the slug (`…-الحلقة-9`) rather than the surrounding
 * markup: it's the one part of the page that doesn't change with the theme.
 */
async function findEpisodeUrl(seriesUrl: string, query: StreamQuery): Promise<string | null> {
  const listed = new Map<number, string>()
  const html = await fetchText(seriesUrl).catch(() => '')

  for (const match of html.matchAll(/href="(https?:\/\/[^"]*\/episode\/[^"]*)"/g)) {
    const url = decodeEntities(match[1])
    const number = episodeNumberOf(url)
    if (number === null || listed.has(number) || !belongsTo(url, seriesUrl)) continue
    listed.set(number, url)
  }
  const prior = await episodeOffset(query)
  return prior === null ? null : pickEpisode(listed, query.episode!, prior)
}

/**
 * Whether an episode link is one of *this* series' episodes.
 *
 * The series page also carries a "latest episodes" block for the whole site —
 * on qisat most of the `/episode/` links on Çirkin's page were other shows',
 * Alıkara's among them — so a bare number match played another show's episode
 * of that number. The episode slug is the series slug plus `-الحلقة-N`.
 */
function belongsTo(episodeUrl: string, seriesUrl: string): boolean {
  const stem = lastSegment(episodeUrl).replace(/-الحلقة-\d{1,4}$/, '')
  return stem !== '' && stem === lastSegment(seriesUrl)
}

function lastSegment(url: string): string {
  const raw = url.replace(/\/$/, '').split('/').pop() ?? ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function episodeNumberOf(url: string): number | null {
  let slug: string
  try {
    slug = decodeURIComponent(url)
  } catch {
    slug = url
  }
  const match = slug.replace(/\/$/, '').match(/(\d{1,4})$/)
  return match ? Number(match[1]) : null
}

/**
 * The player embeds on this site are plain iframes rather than a payload, so the
 * iframe target is the whole server list.
 */
async function getServers(episodeUrl: string): Promise<string[]> {
  const html = await fetchText(episodeUrl).catch(() => '')

  const urls = new Set<string>()
  for (const match of html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) {
    const raw = decodeEntities(match[1]).trim()
    if (!raw || raw.includes('${')) continue

    try {
      const abs = new URL(raw, episodeUrl)
      if (/^https?:$/.test(abs.protocol)) urls.add(abs.href)
    } catch {
      /* not a usable URL */
    }
  }
  return [...urls]
}

/* -------------------------------------------------------------- resolvers */

async function toStream(embedUrl: string, episodeUrl: string): Promise<Stream | null> {
  let host: string
  try {
    host = new URL(embedUrl).host
  } catch {
    return null
  }

  // AlbaPlayer is a shell around the real embed; resolveEmbedStream follows the
  // iframe down to the packed player that actually holds the playlist.
  const resolved = await resolveEmbedStream(embedUrl, 4).catch(() => null)
  if (!resolved) return null

  return {
    id: `qrmzi:${host}:${episodeUrl}`,
    connectorId: 'qrmzi',
    connectorName: 'قرمزي (qrmzi)',
    url: resolved.file,
    label: host.replace(/^www\./, ''),
    quality: /master\.m3u8|1080|hd/i.test(resolved.file) ? 'HD' : 'auto',
    // The CDN checks these against the embed page it expects to be inside.
    headers: { Referer: `${resolved.pageOrigin}/`, Origin: resolved.pageOrigin },
    rank: RANK.addon
  }
}
