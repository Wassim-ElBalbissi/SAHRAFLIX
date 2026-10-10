import { RANK, type SourceConnector } from './types'
import { registerTorrentStream } from '../torrents'
import type { Stream, StreamQuery, Subtitle, SubtitleFormat } from '@shared/types'
import { torrentStreamUrl } from '@shared/media-url'
import { httpFetch } from '../net'

/**
 * Client for the Stremio addon protocol.
 *
 * An addon is just an HTTP endpoint serving /manifest.json and
 * /{resource}/{type}/{id}.json, so speaking it lets the app reuse an entire
 * documented ecosystem instead of inventing a bespoke format.
 *
 * Torrent streams (`infoHash`) play through the built-in engine (`torrents.ts`)
 * — they map to a `tdmedia://torrent/…` URL and register their trackers/file
 * index in that module's side-registry. `externalUrl` entries (and the
 * long-gone YouTube-backed ones) still can't play and are dropped.
 */

export interface StremioManifest {
  id: string
  name: string
  version?: string
  description?: string
  resources?: (string | { name: string; types?: string[]; idPrefixes?: string[] })[]
  types?: string[]
  idPrefixes?: string[]
}

interface StremioStream {
  url?: string
  infoHash?: string
  /** Which file inside a multi-file torrent is the one to play. */
  fileIdx?: number
  /** Torrentio's tracker/DHT hints: `["tracker:udp://…", "dht:HASH"]`. */
  sources?: string[]
  externalUrl?: string
  name?: string
  title?: string
  description?: string
  subtitles?: { url?: string; lang?: string; id?: string }[]
  behaviorHints?: {
    notWebReady?: boolean
    proxyHeaders?: { request?: Record<string, string> }
    videoSize?: number
    filename?: string
    bingeGroup?: string
  }
}

function normalizeBase(url: string): string {
  let base = url.trim()
  if (base.endsWith('/manifest.json')) base = base.slice(0, -'/manifest.json'.length)
  return base.replace(/\/+$/, '')
}

async function fetchJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await httpFetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchManifest(url: string): Promise<StremioManifest> {
  const base = normalizeBase(url)
  return fetchJson<StremioManifest>(`${base}/manifest.json`)
}

function supportsResource(manifest: StremioManifest, name: string): boolean {
  for (const resource of manifest.resources ?? []) {
    if (typeof resource === 'string' && resource === name) return true
    if (typeof resource === 'object' && resource.name === name) return true
  }
  return false
}

function supportsStreams(manifest: StremioManifest): boolean {
  return supportsResource(manifest, 'stream')
}

/**
 * Builds the id an addon expects.
 *
 * The convention is IMDb-based ("tt123:1:5" for series, "tt123" for movies).
 * Addons that only know TMDB ids accept the "tmdb:" prefix, used as a fallback
 * when no IMDb id is available.
 */
function buildIds(query: StreamQuery): string[] {
  const ids: string[] = []
  const suffix = query.type === 'series' ? `:${query.season ?? 1}:${query.episode ?? 1}` : ''

  if (query.imdbId) ids.push(`${query.imdbId}${suffix}`)
  ids.push(`tmdb:${query.tmdbId}${suffix}`)
  return ids
}

function subtitleFormat(url: string): SubtitleFormat {
  const lower = url.toLowerCase()
  if (lower.includes('.ass')) return 'ass'
  if (lower.includes('.ssa')) return 'ssa'
  if (lower.includes('.vtt')) return 'vtt'
  return 'srt'
}

export function createStremioConnector(config: {
  id: string
  name: string
  target: string
}): SourceConnector {
  const base = normalizeBase(config.target)

  return {
    id: config.id,
    name: config.name,
    kind: 'stremio',

    async getStreams(query: StreamQuery): Promise<Stream[]> {
      const type = query.type === 'series' ? 'series' : 'movie'

      for (const id of buildIds(query)) {
        try {
          const data = await fetchJson<{ streams?: StremioStream[] }>(
            `${base}/stream/${type}/${encodeURIComponent(id)}.json`
          )
          const streams = (data.streams ?? [])
            // A direct URL or a torrent both play; externalUrl/YouTube entries
            // carry neither and are dropped.
            .filter((s) => s.url || s.infoHash)
            .map((s, index) => toStream(s, config, index))

          if (streams.length > 0) return streams
        } catch {
          // Try the next id form before giving up.
        }
      }
      return []
    },

    /**
     * The protocol's `subtitles` resource, which many addons implement
     * independently of streams. Querying it separately is what lets the app
     * offer subtitles found via one addon while playing video from elsewhere.
     */
    async getSubtitles(query: StreamQuery): Promise<Subtitle[]> {
      const type = query.type === 'series' ? 'series' : 'movie'

      for (const id of buildIds(query)) {
        try {
          const data = await fetchJson<{ subtitles?: RawSubtitle[] }>(
            `${base}/subtitles/${type}/${encodeURIComponent(id)}.json`
          )
          const subs = (data.subtitles ?? [])
            .filter((s): s is RawSubtitle & { url: string } => Boolean(s.url))
            .map((s, index) => toSubtitle(s, config.id, index))

          if (subs.length > 0) return subs
        } catch {
          // Try the next id form.
        }
      }
      return []
    },

    async test() {
      try {
        const manifest = await fetchManifest(base)
        const streams = supportsStreams(manifest)
        const subs = supportsResource(manifest, 'subtitles')
        if (!streams && !subs) {
          return { ok: false, message: `"${manifest.name}" provides no streams or subtitles.` }
        }
        const provides = [streams && 'streams', subs && 'subtitles'].filter(Boolean).join(' + ')
        return { ok: true, message: `${manifest.name} — ${provides}` }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    }
  }
}

interface RawSubtitle {
  url?: string
  lang?: string
  id?: string
  name?: string
}

/** Maps a two/three-letter code to something readable, Arabic first. */
function langLabel(lang: string): string {
  const code = lang.toLowerCase().slice(0, 3)
  if (code.startsWith('ar')) return 'العربية'
  if (code.startsWith('tur') || code === 'tr') return 'Türkçe'
  if (code.startsWith('eng') || code === 'en') return 'English'
  return lang.toUpperCase()
}

function toSubtitle(raw: RawSubtitle & { url: string }, connectorId: string, index: number): Subtitle {
  const lang = raw.lang ?? 'und'
  return {
    id: `${connectorId}-sub-${raw.id ?? index}`,
    lang,
    label: raw.name?.trim() || langLabel(lang),
    format: subtitleFormat(raw.url),
    url: raw.url
  }
}

function toStream(
  raw: StremioStream,
  config: { id: string; name: string },
  index: number
): Stream {
  // Quality is sniffed over the full raw text, since the tag often rides on
  // `name`'s own line (Torrentio: "Torrentio\n1080p"). The *label* is cleaned
  // separately below — Torrentio packs newlines, filenames and emoji into
  // these fields, which read as garbage in the one-line Servers menu.
  const rawText = [raw.name, raw.title].filter(Boolean).join(' ')
  const label = cleanLabel(raw, index)
  const seeders = seederCount(raw)

  const subtitles: Subtitle[] = (raw.subtitles ?? [])
    .filter((s): s is { url: string; lang?: string; id?: string } => Boolean(s.url))
    .map((s, i) => ({
      id: s.id ?? `${config.id}-sub-${i}`,
      lang: s.lang ?? 'und',
      label: (s.lang ?? 'Subtitle').toUpperCase(),
      format: subtitleFormat(s.url),
      url: s.url
    }))

  let url = raw.url
  let id = `${config.id}:${raw.url ?? index}`

  if (!url && raw.infoHash) {
    const infoHash = raw.infoHash.toLowerCase()
    const fileIdx = raw.fileIdx ?? -1
    // Register before the batch goes out (the player may start this the instant
    // it arrives), the same before-the-event guarantee registerStreamHeaders
    // relies on. `dht:` entries in `sources` carry nothing past the infoHash we
    // already have, so only trackers are kept.
    registerTorrentStream(infoHash, {
      trackers: (raw.sources ?? [])
        .filter((s) => s.startsWith('tracker:'))
        .map((s) => s.slice('tracker:'.length)),
      fileIdx: raw.fileIdx,
      filename: raw.behaviorHints?.filename
    })
    url = torrentStreamUrl(infoHash, fileIdx)
    id = `${config.id}:${infoHash}:${fileIdx}`
  }

  return {
    id,
    connectorId: config.id,
    connectorName: config.name,
    url,
    label,
    quality: guessQuality(rawText),
    subtitles: subtitles.length > 0 ? subtitles : undefined,
    // Torrent streams carry no proxy headers; the engine talks to peers.
    headers: raw.behaviorHints?.proxyHeaders?.request,
    rank: RANK.addon,
    // Only meaningful for a torrent, and only when the addon said a number:
    // a debrid entry carries no 👤 line and must stay "unknown", not "zero".
    seeders: raw.infoHash && seeders !== undefined ? seeders : undefined
  }
}

/**
 * The 👤 line's number, when there is one.
 *
 * Kept separate from the label because it drives ordering as well as display:
 * `byRankThenQuality` sinks a count under its floor to the end of the list,
 * since a torrent nobody is seeding costs the full metadata-plus-first-byte
 * budget (~40s) to *fail*, and Torrentio's own `sort=qualityseeders` still
 * puts a 1-seeder 1080p ahead of a 30-seeder 720p.
 */
function seederCount(raw: StremioStream): number | undefined {
  const value = [raw.name, raw.title]
    .map((text) => text?.match(/👤\s*(\d+)/)?.[1])
    .find(Boolean)
  return value === undefined ? undefined : Number(value)
}

/**
 * One clean line out of an addon's messy name/title.
 *
 * Torrentio's `title` is a multi-line block — release name, then a 💾 size
 * line, a 👤 seeders line, an emoji-flag line. Take the release name (first
 * meaningful line, or the filename hint without extension), and lift the
 * seeder count into a "· N seeders" suffix because it's the one number worth
 * scanning. Everything else is collapsed away.
 */
function cleanLabel(raw: StremioStream, index: number): string {
  const firstLine = (value: string | undefined): string =>
    (value ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''

  const name =
    raw.behaviorHints?.filename?.replace(/\.[a-z0-9]{2,4}$/i, '') ||
    firstLine(raw.title) ||
    firstLine(raw.name) ||
    `Stream ${index + 1}`

  const seeders = seederCount(raw)

  // Torrentio marks debrid-cached results with e.g. "[RD+]" in `name`, which
  // is otherwise discarded here. Debrid entries carry no 👤 line, so the two
  // suffixes never stack.
  const cached = /\[\w{2,3}\+\]/.test(raw.name ?? '')

  const base = name.replace(/\s+/g, ' ').trim()
  if (seeders !== undefined) return `${base} · ${seeders} seeders`
  return cached ? `${base} · cached` : base
}

function guessQuality(text: string): string | undefined {
  const match = text.match(/\b(2160p|1440p|1080p|720p|480p|360p|4k)\b/i)
  return match ? match[1].toLowerCase() : undefined
}
