import { RANK, type SourceConnector } from './types'
import { fetchPage, fetchText, resolveEmbedStream, decodeEntities } from './embed'
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
 * Scraper connector for قصة عشق at qisat (a rotating host, `v1.qisat.cfd` on
 * 2026-09-26; canonical `www.qisat.tv`) — a WordPress dizi site of the krmzy/qrmzi shape (its theme
 * even ships `Kirmizi.css`), with a small all-Turkish, subtitled catalogue:
 * 95 series in its sitemap on 2026-09-20.
 *
 * The walk is qrmzi's: series → `/episode/<series-slug>-الحلقة-N/` → iframe →
 * `resolveEmbedStream`. Four things are its own:
 *
 * - **The sitemap names the canonical domain**, `www.qisat.tv`, while the
 *   listing that answers is `w1.qisat.website`. Every `<loc>` is re-homed onto
 *   the base that answered before it is used, so nothing fetches a host that
 *   was never checked.
 * - **Search is tried before the sitemap**, unlike qrmzi. `/?s=` answered
 *   `حب محتمل` with exactly one series and its result titles carry the Arabic
 *   display name, which the slug-only sitemap lacks for the Latin-slugged
 *   entries (`omur-usta`, `ask-ve-taht`).
 * - **Episodes are numbered continuously across seasons** (Yargı listed 1–42
 *   flat, no `الموسم` anywhere), so the bare number and the series-wide one
 *   are both tried, as on the other Turkish scrapers.
 * - **The episode page has one iframe — an AlbaPlayer shell** on
 *   `w.anaplayer.online`, whose `aplr-menu` links `?serv=1..6` (CDNPlus,
 *   MP4Plus, AnaFast, Vidoba, VidSpeed, OK), each iframing a different host.
 *   qrmzi follows only the shell's default iframe; here the menu is enumerated
 *   so one episode yields several independent servers. Fetching that shell
 *   with the site as `Referer` answers `ERR_BLOCKED_BY_CLIENT`; bare and with
 *   its own origin it answers 200, which is what `resolveEmbedStream` sends.
 *
 * Both hosts publish an ECH config and are reachable only under
 * `secureDns: 'secure'`; from a plain shell the handshake times out.
 */

/** Entry points, not content hosts — see `discoverBase`. */
const BASES = ['https://w1.qisat.website', 'https://www.qisat.tv', 'https://v1.qisat.cfd']

const BASE_TTL_MS = 60 * 60_000
let contentBase: { at: number; url: string } | null = null

/** Resolved streams are cached briefly — the m3u8 tokens are time-limited. */
const CACHE_TTL_MS = 10 * 60_000
const cache = new Map<string, { at: number; streams: Stream[] }>()

const CATALOG_TTL_MS = 60 * 60_000
let catalog: { at: number; entries: SeriesCandidate[] } | null = null

/**
 * Servers resolved per episode. They settle in parallel under
 * `EMBED_TIMEOUT_MS`, so the cap is about not opening six embeds for one play.
 */
const MAX_SERVERS = 4

export const qisatConnector: SourceConnector = {
  id: 'qisat',
  name: 'قصة عشق (qisat)',
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
      : { ok: false, message: 'qisat is not reachable. Check that Secure DNS is on.' }
  }
}

/* ------------------------------------------------------------------- base */

/**
 * Finds whichever host is serving qisat right now.
 *
 * The host rotates, and a retired one does not go dark: on 2026-09-26 both
 * `w1.qisat.website` and `www.qisat.tv` answered *every* path, sitemap and
 * search included, with the same front page, which links its episodes on the
 * live `v1.qisat.cfd`. Taking the host that served the page found no series and
 * no episodes for anything. So the candidates are the hosts of the page's
 * `/episode/` links first, and a host counts only once its sitemap lists
 * series — the one thing a front-page-for-everything host cannot fake.
 */
async function discoverBase(): Promise<string | null> {
  if (contentBase && Date.now() - contentBase.at < BASE_TTL_MS) return contentBase.url

  const tried = new Set<string>()
  for (const entry of BASES) {
    const page = await fetchPage(entry).catch(() => null)
    if (!page) continue

    const candidates = episodeLinkOrigins(page.text)
    const served = originOf(page.url)
    if (!candidates.includes(served)) candidates.push(served)

    for (const candidate of candidates) {
      if (tried.has(candidate)) continue
      tried.add(candidate)
      if (await servesCatalog(candidate)) {
        contentBase = { at: Date.now(), url: candidate }
        return candidate
      }
    }
  }

  return null
}

/** Distinct origins of the `/episode/` links on a page, in first-seen order. */
function episodeLinkOrigins(html: string): string[] {
  const origins: string[] = []
  for (const match of html.matchAll(/href="(https?:\/\/[^"]+\/episode\/[^"]+)"/g)) {
    const origin = originOf(match[1])
    if (!origins.includes(origin)) origins.push(origin)
  }
  return origins
}

async function servesCatalog(origin: string): Promise<boolean> {
  const xml = await fetchText(`${origin}/series-sitemap.xml`).catch(() => '')
  return parseSitemap(xml).some((url) => /\/series\/[^/]+\/?$/.test(url))
}

/* ------------------------------------------------------------------ steps */

async function resolve(query: StreamQuery): Promise<Stream[]> {
  const base = await discoverBase()
  if (!base) return []

  const seriesUrl = await findSeries(base, query)
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

/** Search first, then the sitemap; both are scored together. */
async function findSeries(base: string, query: StreamQuery): Promise<string | null> {
  const aliases = await getSearchAliases(query)
  if (aliases.length === 0) return null

  const found: SeriesCandidate[] = []
  for (const alias of aliases.slice(0, MAX_SEARCH_TERMS)) {
    found.push(...(await search(base, alias)))
    const exact = exactCandidateMatch(found, aliases)
    if (exact) return exact
  }

  return bestMatch(mergeCandidates(found, await getCatalog()), aliases)
}

async function search(base: string, term: string): Promise<SeriesCandidate[]> {
  const html = await fetchText(`${base}/?s=${encodeURIComponent(term)}`).catch(() => '')
  const out = new Map<string, SeriesCandidate>()
  const re = /<a\s+href="(https?:\/\/[^"]*\/series\/[^"]+)"[^>]*\stitle="([^"]*)"/g
  for (const match of html.matchAll(re)) {
    const url = rehome(decodeEntities(match[1]), base)
    if (!out.has(url)) out.set(url, { url, title: decodeEntities(match[2]).replace(/\s*قصة عشق\s*$/, '') })
  }
  return [...out.values()]
}

async function getCatalog(): Promise<SeriesCandidate[]> {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.entries

  const base = await discoverBase()
  if (!base) return catalog?.entries ?? []

  const xml = await fetchText(`${base}/series-sitemap.xml`).catch(() => '')
  const entries = parseSitemap(xml)
    .filter((url) => /\/series\/[^/]+\/?$/.test(url))
    .map((url) => ({ url: rehome(url, base) }))

  if (entries.length > 0) catalog = { at: Date.now(), entries }
  return catalog?.entries ?? []
}

/** The same path on the base that answered — the sitemap names the canonical host. */
function rehome(url: string, base: string): string {
  try {
    const parsed = new URL(url)
    return `${base}${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

/**
 * Finds the requested episode's page (see `pickEpisode` for which number). The
 * number is read off the slug (`…-الحلقة-42`), the one part of the page that
 * doesn't change with the theme.
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
  if (prior === null) return null
  const picked = pickEpisode(listed, query.episode!, prior)
  if (picked) return picked

  // The series page links only its latest episode or two — Çirkin's linked 9
  // and nothing else — so build the slug for the rest. Absolute number, since
  // the site numbers continuously. Confirmed by a 200 that stayed on an
  // episode page and carries a player; a missing slug 404s or redirects home.
  const origin = originOf([...listed.values()][0] ?? seriesUrl)
  const slug = `${lastSegment(seriesUrl)}-الحلقة-${prior + query.episode!}`
  const built = `${origin}/episode/${encodeURIComponent(slug)}/`
  const page = await fetchPage(built).catch(() => null)
  if (!page || !page.url.includes('/episode/') || !/<iframe[^>]+src=/i.test(page.text)) return null
  return built
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
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
 * The episode page's iframes, with every AlbaPlayer shell expanded into the
 * servers its menu lists. A shell's `?serv=N` pages each iframe a different
 * host, so they are the real server list; the shell itself is dropped once
 * expanded, since it would only duplicate its default server.
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

  const servers = new Set<string>()
  for (const url of urls) {
    if (!/\/albaplayer\//.test(url)) {
      servers.add(url)
      continue
    }
    const menu = await albaServers(url)
    if (menu.length === 0) servers.add(url)
    for (const server of menu) servers.add(server)
  }

  return [...servers].slice(0, MAX_SERVERS)
}

/** The `?serv=N` links of an AlbaPlayer shell's menu, in the site's own order. */
async function albaServers(shellUrl: string): Promise<string[]> {
  const origin = new URL(shellUrl).origin
  const html = await fetchText(shellUrl, `${origin}/`).catch(() => '')
  const out: string[] = []
  for (const match of html.matchAll(/href="([^"]*\?serv=\d+)"/g)) {
    const url = decodeEntities(match[1])
    if (!out.includes(url)) out.push(url)
  }
  return out
}

/* -------------------------------------------------------------- resolvers */

async function toStream(embedUrl: string, episodeUrl: string): Promise<Stream | null> {
  // AlbaPlayer is a shell around the real embed; resolveEmbedStream follows the
  // iframe down to the packed player that actually holds the playlist.
  const resolved = await resolveEmbedStream(embedUrl, 4).catch(() => null)
  if (!resolved) return null

  // Labelled by the host that holds the playlist, not the shell — every server
  // of one episode sits behind the same `w.anaplayer.online`.
  const host = new URL(resolved.pageOrigin).host.replace(/^www\./, '')
  return {
    id: `qisat:${host}:${episodeUrl}`,
    connectorId: 'qisat',
    connectorName: 'قصة عشق (qisat)',
    url: resolved.file,
    label: host,
    quality: /master\.m3u8|1080|hd/i.test(resolved.file) ? 'HD' : 'auto',
    // The CDN checks these against the embed page it expects to be inside.
    headers: { Referer: `${resolved.pageOrigin}/`, Origin: resolved.pageOrigin },
    rank: RANK.addon
  }
}
