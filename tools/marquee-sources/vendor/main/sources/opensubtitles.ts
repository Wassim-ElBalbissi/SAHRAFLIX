import { getSettings, wantedSubtitleLanguages } from '../settings'
import { type SourceConnector } from './types'
import type { Stream, StreamQuery, Subtitle, SubtitleFormat } from '@shared/types'
import { httpFetch } from '../net'

/**
 * OpenSubtitles, as a subtitles-only connector.
 *
 * Subtitles are the scarce resource for this library — the scrapers find video
 * far more reliably than they find a matching track, and the boredflix providers
 * supply none at all. The registry already resolves subtitles independently of
 * streams (`resolveSubtitles`), so a connector that implements only
 * `getSubtitles` slots in and its tracks become available whichever source the
 * video ends up coming from.
 *
 * Needs a free API key from https://www.opensubtitles.com/consumers — there is
 * no keyless endpoint worth relying on. Without one this reports unconfigured
 * rather than failing every lookup.
 *
 * Search is by TMDB/IMDB id, never by title: these are the same ids the rest of
 * the app is keyed on, and id lookup sidesteps the entire matching problem that
 * makes the Arabic scrapers fragile.
 */

const BASE = 'https://api.opensubtitles.com/api/v1'

/**
 * OpenSubtitles requires a descriptive User-Agent and rejects generic browser
 * ones, so this deliberately isn't `BROWSER_UA`.
 */
const USER_AGENT = 'Marquee v1.0.0'

const TIMEOUT_MS = 12_000

/**
 * How many tracks to keep per language.
 *
 * The cap has to be *per language*, which is the whole reason this connector
 * searches one language at a time. A single `languages=ar,en` search ordered by
 * download count returns one flat list, and on any title with a large English
 * catalogue the entire first page is English — an Arabic track with 300
 * downloads sorts below fifty English ones with 3000. Truncating that list gave
 * back zero Arabic rows for titles that had plenty, which read in the player as
 * "no Arabic subtitles exist" rather than "they were sorted off the end".
 */
const PER_LANGUAGE_LIMIT = 8

interface SearchResponse {
  data?: {
    attributes?: {
      language?: string
      release?: string
      download_count?: number
      hearing_impaired?: boolean
      files?: { file_id?: number; file_name?: string }[]
    }
  }[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const key = getSettings().openSubtitlesApiKey.trim()
  if (!key) throw new Error('No OpenSubtitles API key configured.')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await httpFetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Api-Key': key,
        'User-Agent': USER_AGENT,
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers
      }
    })

    if (response.status === 401 || response.status === 403) {
      throw new Error('OpenSubtitles rejected the API key.')
    }
    if (response.status === 429) {
      throw new Error('OpenSubtitles rate limit reached — try again later.')
    }
    if (!response.ok) throw new Error(`OpenSubtitles error ${response.status}`)

    return (await response.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

function formatOf(name: string | undefined): SubtitleFormat {
  const lower = (name ?? '').toLowerCase()
  if (lower.endsWith('.ass')) return 'ass'
  if (lower.endsWith('.ssa')) return 'ssa'
  if (lower.endsWith('.vtt')) return 'vtt'
  return 'srt'
}

/** OpenSubtitles wants the numeric form, so `tt0903747` goes in as `903747`. */
function imdbNumber(imdbId: string | undefined): string | null {
  const digits = (imdbId ?? '').trim().replace(/^tt/i, '')
  return /^\d+$/.test(digits) ? String(Number(digits)) : null
}

/**
 * Search params for one language, keyed either by TMDB or by IMDb id.
 *
 * Series are searched by the *parent* id plus season/episode — that's what
 * `parent_tmdb_id`/`parent_imdb_id` exist for, and the episode's own id is not
 * what the index is keyed on.
 */
function searchParams(query: StreamQuery, lang: string, imdb: string | null): URLSearchParams {
  const params = new URLSearchParams({
    languages: lang,
    // `moviehash` matching would be better, but the app streams rather than
    // holding a file to hash — id matching is the only option here.
    order_by: 'download_count',
    order_direction: 'desc'
  })

  if (query.type === 'series') {
    params.set(imdb ? 'parent_imdb_id' : 'parent_tmdb_id', imdb ?? String(query.tmdbId))
    params.set('season_number', String(query.season ?? 1))
    params.set('episode_number', String(query.episode ?? 1))
    params.set('type', 'episode')
  } else {
    params.set(imdb ? 'imdb_id' : 'tmdb_id', imdb ?? String(query.tmdbId))
    params.set('type', 'movie')
  }
  return params
}

/**
 * Every track for one language, best-downloaded first.
 *
 * Falls back to the IMDb id when the TMDB search comes back empty. The two
 * indexes are not the same index: OpenSubtitles is an IMDb-native catalogue and
 * its `tmdb_id` mapping is filled in per-entry, so older uploads — and episodes
 * especially — are frequently reachable by one id and invisible to the other.
 * The fallback costs a request only on titles that found nothing anyway.
 */
async function searchLanguage(query: StreamQuery, lang: string): Promise<Subtitle[]> {
  const byTmdb = await request<SearchResponse>(`/subtitles?${searchParams(query, lang, null)}`)

  let results = byTmdb.data ?? []
  const imdb = imdbNumber(query.imdbId)
  if (results.length === 0 && imdb) {
    const byImdb = await request<SearchResponse>(`/subtitles?${searchParams(query, lang, imdb)}`)
    results = byImdb.data ?? []
  }

  const subtitles: Subtitle[] = []
  for (const entry of results.slice(0, PER_LANGUAGE_LIMIT)) {
    const attrs = entry.attributes
    const file = attrs?.files?.[0]
    if (!file?.file_id) continue

    // Trust the row's own language over the one requested: `languages=ar` is a
    // filter, but the response is what actually says what the file is.
    const resolved = attrs?.language ?? lang
    const release = attrs?.release?.trim()
    const label = [
      release && release.length < 40 ? release : resolved.toUpperCase(),
      attrs?.hearing_impaired ? 'SDH' : null
    ]
      .filter(Boolean)
      .join(' · ')

    subtitles.push({
      id: `opensubtitles:${file.file_id}`,
      lang: resolved,
      label: `${label} · OpenSubtitles`,
      format: formatOf(file.file_name),
      // Resolved lazily — see `resolveDownloadUrl`. The download endpoint is
      // quota-metered per key, so turning every search hit into a download
      // would exhaust the daily allowance on tracks nobody selects.
      url: `opensubtitles://${file.file_id}`
    })
  }
  return subtitles
}

export const openSubtitlesConnector: SourceConnector = {
  id: 'opensubtitles',
  name: 'OpenSubtitles',
  kind: 'scraper',

  /** Subtitles only — this connector has no video. */
  async getStreams(): Promise<Stream[]> {
    return []
  },

  async getSubtitles(query: StreamQuery): Promise<Subtitle[]> {
    if (!getSettings().openSubtitlesApiKey.trim()) return []

    // One search per wanted language, concurrently, so each gets its own slice
    // of the result cap — see PER_LANGUAGE_LIMIT. `allSettled` because a
    // language that errors shouldn't cost the others their tracks.
    const languages = wantedSubtitleLanguages()
    const results = await Promise.allSettled(
      languages.map((lang) => searchLanguage(query, lang))
    )

    const subtitles: Subtitle[] = []
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') subtitles.push(...result.value)
      else console.error(`[opensubtitles] ${languages[index]} search failed`, result.reason)
    }
    return subtitles
  },

  async test() {
    if (!getSettings().openSubtitlesApiKey.trim()) {
      return { ok: false, message: 'Add an API key from opensubtitles.com/consumers.' }
    }
    try {
      // Fight Club — present in any subtitle index worth using.
      const body = await request<SearchResponse>('/subtitles?tmdb_id=550&languages=en&type=movie')
      const count = body.data?.length ?? 0
      return count > 0
        ? { ok: true, message: `Reachable — ${count} tracks for the test title.` }
        : { ok: false, message: 'Reachable, but the test search returned nothing.' }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  }
}

/**
 * Turns an `opensubtitles://<file_id>` placeholder into a real download URL.
 *
 * Deferred to selection time on purpose: `/download` is metered against a daily
 * quota per key, so resolving every search result up front would spend the
 * allowance listing tracks rather than watching one. The returned link is
 * short-lived, which is the other reason not to resolve early.
 */
export async function resolveDownloadUrl(url: string): Promise<string> {
  const fileId = url.startsWith('opensubtitles://') ? url.slice('opensubtitles://'.length) : null
  if (!fileId) return url

  const body = await request<{ link?: string; message?: string }>('/download', {
    method: 'POST',
    body: JSON.stringify({ file_id: Number(fileId) })
  })

  if (!body.link) {
    throw new Error(body.message ?? 'OpenSubtitles returned no download link.')
  }
  return body.link
}

/** Whether a subtitle URL still needs `resolveDownloadUrl` before fetching. */
export function isDeferredSubtitle(url: string): boolean {
  return url.startsWith('opensubtitles://')
}
