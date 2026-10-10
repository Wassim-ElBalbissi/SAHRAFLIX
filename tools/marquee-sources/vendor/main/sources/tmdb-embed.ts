import { RANK, type SourceConnector, type SourceCost, type SourceScope } from './types'
import { BROWSER_UA } from './embed'
import { resolveViaBrowser } from './browser-resolve'
import { withTimeout } from './match'
import type { Stream, StreamQuery, Subtitle, SubtitleFormat } from '@shared/types'
import { httpFetch } from '../net'

/**
 * Shared machinery for the TMDB-id-keyed embed sites.
 *
 * Sites like boredflix.tv aren't stream hosts. They're TMDB metadata wrapped
 * around a handful of third-party providers, each addressed by TMDB id:
 * `/movie/<id>` and `/tv/<id>/<season>/<episode>`. A connector built here calls
 * those providers directly, which is the same thing the site does minus the
 * site.
 *
 * That id-keying is why these connectors are a fraction of the size of the
 * title-searching scrapers. There is no search step, no alias list, no sitemap
 * fallback and no title scoring, because there is no title involved — and
 * crucially no `absoluteEpisodeNumber()`, because these providers are indexed by
 * TMDB's own per-season numbering rather than a broadcaster's continuous count.
 * They are also the only built-ins that cover films.
 *
 * A provider is reached one of two ways, and the difference is most of the cost
 * model here:
 *
 * - **`api`** — a JSON endpoint handing back the playlist (and usually subtitle
 *   tracks) directly. One request, no window, and the only way to get subtitles
 *   out of these hosts. Always preferred.
 * - **`movie`/`tv`** — an embed page that must be *run* rather than read; see
 *   `browser-resolve.ts`. The playlist URL is built by the provider's own
 *   JavaScript at request time, so it exists in no HTTP response and
 *   `resolveEmbedStream` finds nothing no matter how well it unpacks.
 *
 * `getStreams` therefore fans the API providers out at once — they're cheap — and
 * only falls back to the browser providers when that yields nothing, running
 * those in small waves and stopping at the first success. Each browser attempt
 * costs a hidden Chromium window running untrusted third-party JavaScript, so
 * "try them all and collect spares" is not a trade worth making: the player's
 * failover already re-resolves, and these URLs expire in minutes anyway.
 *
 * Anything that can't be reduced to a direct `.m3u8`/`.mp4` is useless here: the
 * renderer plays through hls.js and the CSP has no frame-src for these hosts, so
 * the app can never simply embed them the way these sites do.
 */

export interface TmdbEmbedProvider {
  id: string
  name: string
  /** Embed page for a film, run in a hidden window. */
  movie?: (query: StreamQuery) => string | null
  /** Embed page for one episode, run in a hidden window. */
  tv?: (query: StreamQuery) => string | null
  /** JSON endpoint returning the playlist, and usually its subtitle tracks. */
  api?: (query: StreamQuery) => string | null
  /**
   * Custom resolution for hosts whose playlist takes more than one plain
   * request but still no browser — vixsrc's api-then-embed-then-token walk, for
   * instance. Counts as cheap: it runs alongside `api`, not in the wave loop.
   */
  resolve?: (query: StreamQuery) => Promise<StreamEntry[]>
  /** JSON endpoint returning subtitles only, for hosts that split the two. */
  subs?: (query: StreamQuery) => string | null
  /**
   * Referer to load the embed page with.
   *
   * These players check who is embedding them and the right answer differs per
   * provider — measurably so: 111movies only resolved when approached with its
   * own origin, while vidsrc.rip only resolved with boredflix's.
   */
  referer?: string
}

export interface TmdbEmbedOptions {
  id: string
  name: string
  providers: TmdbEmbedProvider[]
  /** Per-provider window budget. Three of these fit inside the registry's 20s. */
  browserResolveMs?: number
  /** How many hidden windows may exist at once. */
  waveSize?: number
  /** Passed through to the connector; see `tiers.ts`. */
  scope?: readonly SourceScope[]
  cost?: SourceCost
}

/**
 * Resolved streams are cached briefly.
 *
 * Same reason as the other scrapers: these are tokenised CDN URLs bound to an IP
 * and a clock, so caching them for long produces a link that 403s exactly when
 * the user presses play. Ten minutes covers a failover round-trip and no more.
 */
const CACHE_TTL_MS = 10 * 60_000

const DEFAULT_BROWSER_RESOLVE_MS = 9_000
const DEFAULT_WAVE_SIZE = 3
const API_TIMEOUT_MS = 8_000

export function createTmdbEmbedConnector(options: TmdbEmbedOptions): SourceConnector {
  const { id, name, providers } = options
  const browserResolveMs = options.browserResolveMs ?? DEFAULT_BROWSER_RESOLVE_MS
  const waveSize = options.waveSize ?? DEFAULT_WAVE_SIZE

  const cache = new Map<string, { at: number; streams: Stream[] }>()

  const context: Context = { connectorId: id, connectorName: name, browserResolveMs }

  return {
    id,
    name,
    kind: 'scraper',
    scope: options.scope,
    cost: options.cost,

    async getStreams(query: StreamQuery): Promise<Stream[]> {
      if (query.type === 'series' && query.episode == null) return []

      const key = cacheKey(query)
      const hit = cache.get(key)
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.streams

      const streams = await resolve(context, providers, query, waveSize)
      cache.set(key, { at: Date.now(), streams })
      return streams
    },

    /**
     * Only the JSON providers are asked for subtitles.
     *
     * Deliberately never the browser path: that costs a hidden window, and the
     * registry runs subtitle resolution independently of streams — so including
     * it here would open a second set of windows for the same title, moments
     * after `getStreams` closed the first.
     */
    async getSubtitles(query: StreamQuery): Promise<Subtitle[]> {
      if (query.type === 'series' && query.episode == null) return []

      const withJson = providers.filter((provider) => provider.api || provider.subs)
      if (withJson.length === 0) return []

      const results = await Promise.allSettled(
        withJson.map((provider) =>
          withTimeout(subtitlesFrom(context, provider, query), API_TIMEOUT_MS, [])
        )
      )

      const subtitles: Subtitle[] = []
      for (const result of results) {
        if (result.status === 'fulfilled') subtitles.push(...result.value)
      }
      return subtitles
    },

    /**
     * Resolves one provider rather than all of them.
     *
     * This is the Settings "test" button. Where the first provider needs a
     * window, checking all of them would open one each and take the better part
     * of a minute for a green tick. One real resolve answers the question that
     * matters — can this connector still produce a playable URL at all — and the
     * rest is what `npm run verify:sources` is for.
     */
    async test() {
      const probe: StreamQuery = {
        // Fight Club — old and ubiquitous, so a miss means the provider is down
        // rather than the title being obscure.
        tmdbId: 550,
        imdbId: 'tt0137523',
        type: 'movie',
        title: 'Fight Club'
      }

      const first = providers.find(
        (provider) => provider.api || provider.resolve || urlFor(provider, probe)
      )
      if (!first) return { ok: false, message: 'No provider handles films.' }

      const streams = await withTimeout(
        fromProvider(context, first, probe),
        browserResolveMs + 2_000,
        []
      )

      return streams.length > 0
        ? { ok: true, message: `Resolved ${streams.length} stream(s) via ${first.name}.` }
        : { ok: false, message: `No stream from ${first.name}. Run verify:sources for the rest.` }
    }
  }
}

/* ------------------------------------------------------------------ steps */

interface Context {
  connectorId: string
  connectorName: string
  browserResolveMs: number
}

/**
 * API providers first, browser providers only if they came up empty.
 *
 * The asymmetry is deliberate. A JSON provider costs one request, so all of them
 * run at once and everything they return is kept — more entries mean more for
 * the player to fail over between. A browser provider costs a hidden Chromium
 * window, so those are a fallback, run a few at a time, and stop as soon as one
 * of them works.
 */
async function resolve(
  context: Context,
  providers: TmdbEmbedProvider[],
  query: StreamQuery,
  waveSize: number
): Promise<Stream[]> {
  const cheap = providers.filter((provider) => provider.api || provider.resolve)

  if (cheap.length > 0) {
    const results = await Promise.allSettled(
      cheap.map((provider) =>
        withTimeout(fromRequests(context, provider, query), API_TIMEOUT_MS, [])
      )
    )

    const found: Stream[] = []
    for (const result of results) {
      if (result.status === 'fulfilled') found.push(...result.value)
    }
    if (found.length > 0) return dedupe(found)
  }

  // Providers with no embed URL for this query type are dropped before the
  // waves are cut, so a movie-only provider never occupies a slot in a TV
  // lookup — otherwise a wave could be entirely no-ops.
  const viaBrowser = providers.filter(
    (provider) => !provider.api && !provider.resolve && urlFor(provider, query)
  )

  for (let start = 0; start < viaBrowser.length; start += waveSize) {
    const wave = viaBrowser.slice(start, start + waveSize)

    const results = await Promise.allSettled(
      wave.map((provider) =>
        withTimeout(fromEmbed(context, provider, query), context.browserResolveMs + 2_000, [])
      )
    )

    const found: Stream[] = []
    for (const result of results) {
      if (result.status === 'fulfilled') found.push(...result.value)
    }
    if (found.length > 0) return dedupe(found)
  }

  return []
}

async function fromProvider(
  context: Context,
  provider: TmdbEmbedProvider,
  query: StreamQuery
): Promise<Stream[]> {
  if (provider.api || provider.resolve) return fromRequests(context, provider, query)
  return fromEmbed(context, provider, query)
}

/** Everything that reaches a playlist with plain requests: `api` or `resolve`. */
async function fromRequests(
  context: Context,
  provider: TmdbEmbedProvider,
  query: StreamQuery
): Promise<Stream[]> {
  if (provider.resolve) {
    const entries = (await provider.resolve(query).catch(() => [])).filter((entry) =>
      isUsableStreamUrl(entry.url)
    )
    if (entries.length === 0) return []

    // Its own site is what these CDNs expect in the Referer; fall back to the
    // stream's own host when the provider didn't name one.
    const origin = originOf(provider.referer) ?? originOf(entries[0].url) ?? ''
    return entries.map((entry, index) => toStream(context, provider, query, entry, origin, index))
  }
  return fromApi(context, provider, query)
}

function urlFor(provider: TmdbEmbedProvider, query: StreamQuery): string | null {
  const build = query.type === 'movie' ? provider.movie : provider.tv
  return build ? build(query) : null
}

/** The JSON path: a playlist, and usually a set of subtitle tracks with it. */
async function fromApi(
  context: Context,
  provider: TmdbEmbedProvider,
  query: StreamQuery
): Promise<Stream[]> {
  const endpoint = provider.api?.(query)
  if (!endpoint) return []

  const body = await fetchJson(endpoint)
  if (!body) return []

  const origin = new URL(endpoint).origin
  return pickStreams(body).map((entry, index) =>
    toStream(context, provider, query, entry, origin, index)
  )
}

/**
 * Runs the embed in an offscreen window and takes the playlist it fetches.
 *
 * `resolveEmbedStream` is deliberately not tried first. It was, and it returned
 * null for every one of these providers on every title — their HTML is a shell
 * with no stream in it — so a "cheap pass first" would only add a wasted request
 * per provider to a path that is already the expensive one.
 */
async function fromEmbed(
  context: Context,
  provider: TmdbEmbedProvider,
  query: StreamQuery
): Promise<Stream[]> {
  const url = urlFor(provider, query)
  if (!url) return []

  const resolved = await resolveViaBrowser(url, context.browserResolveMs, {
    referer: provider.referer
  }).catch(() => null)
  if (!resolved) return []

  // No label: one stream per provider here, so `toStream` naming it after the
  // provider reads better than "VidRock · VidRock".
  return [toStream(context, provider, query, { url: resolved.file }, resolved.pageOrigin, 0)]
}

async function subtitlesFrom(
  context: Context,
  provider: TmdbEmbedProvider,
  query: StreamQuery
): Promise<Subtitle[]> {
  const endpoint = provider.subs?.(query) ?? provider.api?.(query)
  const body = await fetchJson(endpoint)
  if (!body) return []

  const subtitles = pickTracks(body).map((track) => ({
    id: `${context.connectorId}:${provider.id}:${track.url}`,
    lang: langOf(track.lang ?? track.label),
    label: `${track.label} · ${provider.name}`,
    format: formatOf(track.url, track.format),
    url: track.url
  }))

  return capPerLanguage(subtitles)
}

/**
 * Keeps a handful of tracks per language rather than everything on offer.
 *
 * These hosts return their whole catalogue for a title — one returned 119 tracks
 * for a single episode, sixteen of them English — and every one becomes a row in
 * the player's subtitle menu. A few alternates per language is genuinely useful
 * (the first Arabic file is sometimes a bad rip); a hundred is a list nobody can
 * use. The cap is per language rather than overall so that trimming English
 * never costs the one Arabic track the user came for.
 */
const MAX_PER_LANGUAGE = 3

export function capPerLanguage(subtitles: Subtitle[]): Subtitle[] {
  const counts = new Map<string, number>()
  const out: Subtitle[] = []

  for (const subtitle of subtitles) {
    const seen = counts.get(subtitle.lang) ?? 0
    if (seen >= MAX_PER_LANGUAGE) continue
    counts.set(subtitle.lang, seen + 1)
    out.push(subtitle)
  }
  return out
}

async function fetchJson(url: string | null | undefined): Promise<unknown | null> {
  if (!url) return null

  const origin = new URL(url).origin
  const response = await httpFetch(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json', referer: `${origin}/` }
  }).catch(() => null)

  if (!response || !response.ok) return null
  return response.json().catch(() => null)
}

/**
 * Drops providers that resolved to the same file.
 *
 * Several of these front a shared backend and hand back a byte-identical URL, so
 * both would appear in the player's Servers menu as separate entries. That is
 * worse than cosmetic: failover would "try the next server" and re-request a
 * stream that just failed, burning a retry on a guaranteed repeat.
 */
function dedupe(streams: Stream[]): Stream[] {
  const seen = new Set<string>()
  const out: Stream[] = []

  for (const stream of streams) {
    const key = stream.url ?? stream.id
    if (seen.has(key)) continue
    seen.add(key)
    out.push(stream)
  }
  return out
}

export function cacheKey(query: StreamQuery): string {
  return query.type === 'movie'
    ? `movie:${query.tmdbId}`
    : `tv:${query.tmdbId}:${query.season ?? 1}:${query.episode}`
}

function toStream(
  context: Context,
  provider: TmdbEmbedProvider,
  query: StreamQuery,
  entry: StreamEntry,
  pageOrigin: string,
  index: number
): Stream {
  const hls = entry.type === 'hls' || /\.m3u8(\?|$)/i.test(entry.url)

  return {
    id: `${context.connectorId}:${provider.id}:${index}:${cacheKey(query)}`,
    connectorId: context.connectorId,
    connectorName: context.connectorName,
    url: entry.url,
    label: entry.label ? `${entry.label} · ${provider.name}` : provider.name,
    quality: entry.quality ?? (/master\.m3u8|1080|hd/i.test(entry.url) ? 'HD' : 'auto'),
    // Several of these hand back extensionless proxy URLs, which the renderer
    // would otherwise hand to Chromium — which cannot play HLS natively.
    isHls: hls || undefined,
    // These CDNs check the request against the embed page they expect to be
    // inside; the registry records them per host and the main process attaches
    // them to what hls.js sends.
    headers: { Referer: `${pageOrigin}/`, Origin: pageOrigin },
    rank: RANK.addon
  }
}

/* ------------------------------------------------------------- API shapes */

export interface StreamEntry {
  url: string
  label?: string
  quality?: string
  type?: string
}

interface TrackEntry {
  url: string
  label: string
  lang?: string
  format?: string
}

/**
 * Digs the playlist entries out of whatever shape the provider returned.
 *
 * There is no shared schema across these hosts — the same information turns up
 * as `streams[]`, `sources[].file`, `stream.playlist` or a bare `url`, and the
 * shape changes without notice. Checking each known position is cheaper than a
 * per-provider parser and degrades to "no stream" rather than throwing.
 */
export function pickStreams(body: unknown): StreamEntry[] {
  const root = asRecord(body)
  if (!root) return []

  const lists = [root.streams, root.sources, root.source].filter(Array.isArray) as unknown[][]

  const out: StreamEntry[] = []
  for (const list of lists) {
    for (const item of list) {
      const record = asRecord(item)
      if (!record) continue
      const url = firstString(record.url, record.file, record.link)
      if (url && isUsableStreamUrl(url)) {
        out.push({
          url,
          label: firstString(record.label, record.name) ?? undefined,
          quality: firstString(record.quality, record.resolution) ?? undefined,
          type: firstString(record.type) ?? undefined
        })
      }
    }
  }
  if (out.length > 0) return out

  const single = firstString(
    asRecord(root.stream)?.playlist,
    asRecord(root.stream)?.file,
    root.file,
    root.url
  )
  return single && isUsableStreamUrl(single) ? [{ url: single }] : []
}

/**
 * Rejects entries that are not actually a stream URL.
 *
 * One of these backends returns proxy links of the form `?url=<target>`, and
 * has been observed putting an entire HTML player document in that parameter
 * instead of a URL. Handed to hls.js that becomes a mystery failure several
 * seconds into playback rather than an entry that was never playable.
 */
export function isUsableStreamUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  const proxied = parsed.searchParams.get('url')
  return proxied === null || /^https?:\/\//i.test(proxied)
}

/**
 * Same idea for subtitle tracks, which turn up under `subtitles`, `tracks`, or
 * as the whole response body.
 */
function pickTracks(body: unknown): TrackEntry[] {
  const lists: unknown[][] = []
  if (Array.isArray(body)) lists.push(body)

  const root = asRecord(body)
  if (root) {
    if (Array.isArray(root.subtitles)) lists.push(root.subtitles)
    if (Array.isArray(root.tracks)) lists.push(root.tracks)
  }

  const out: TrackEntry[] = []
  for (const list of lists) {
    for (const item of list) {
      const record = asRecord(item)
      if (!record) continue

      // `tracks` mixes subtitles with thumbnail sprites; only the former is
      // wanted.
      const kind = firstString(record.kind)
      if (kind && kind !== 'captions' && kind !== 'subtitles') continue

      const url = firstString(record.url, record.file, record.src)
      if (!url || !/^https?:\/\//i.test(url)) continue

      const lang = firstString(record.srclang, record.lang, record.language)
      const label = firstString(record.label, record.name) ?? lang ?? 'Unknown'
      out.push({ url, label, lang: lang ?? undefined, format: firstString(record.format) ?? undefined })
    }
  }
  return out
}

function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * Best-effort ISO code from a provider's label.
 *
 * These carry human labels ("Arabic", "English - SDH") rather than codes, and
 * the registry sorts subtitles by language prefix — so without this every track
 * would tie at the bottom and Arabic would stop sorting first.
 */
export function langOf(value: string): string {
  const text = value.toLowerCase()
  if (text.startsWith('ar') || text.includes('arab')) return 'ar'
  if (text.startsWith('tr') || text.includes('turk')) return 'tr'
  if (text.startsWith('en') || text.includes('engl')) return 'en'
  return text.slice(0, 2) || 'un'
}

export function formatOf(url: string, declared?: string): SubtitleFormat {
  const value = declared ?? url
  if (/\.?ass(\?|$)/i.test(value)) return 'ass'
  if (/\.?ssa(\?|$)/i.test(value)) return 'ssa'
  if (/\.?srt(\?|$)/i.test(value)) return 'srt'
  return 'vtt'
}
