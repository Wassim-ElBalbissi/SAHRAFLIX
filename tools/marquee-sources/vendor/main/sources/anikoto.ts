import { get } from '../db'
import { RANK, type SourceConnector } from './types'
import { fetchText, decodeEntities } from './embed'
import { getSearchAliases } from './aliases'
import { registerHostHeaders } from './headers'
import { capPerLanguage, formatOf, langOf } from './tmdb-embed'
import { animeSlugTitle, pickAnimeEntry, seasonAliases, type AnimeCandidate } from './anime-match'
import type { Stream, StreamQuery, Subtitle } from '@shared/types'

/**
 * Scraper connector for anikototv.to.
 *
 * Six plain requests, no obfuscation anywhere, ending at a JSON endpoint that
 * hands over a multi-bitrate master playlist *and* a full softsub list —
 * measured 2026-08-07 on Frieren S1E1: 1080p/720p/360p and nine tracks
 * including **Arabic**, which is the scarce half for this app.
 *
 *   1. GET /search?keyword=<term>                → server-rendered result cards
 *   2. GET /ajax/episode/list/<animeId>          → one <a data-num data-ids> per episode
 *   3. GET /ajax/server/list?servers=<data-ids>  → <li data-link-id>, split sub/dub
 *   4. GET /ajax/server?get=<data-link-id>       → { result: { url: megaplay embed } }
 *   5. GET <that embed>                          → a 2.8 KB shell carrying data-id
 *   6. GET <origin>/stream/getSources?id=<id>    → { sources: { file }, tracks: [...] }
 *
 * Three things about that chain are load-bearing and none are documented by the
 * site:
 *
 * - **Every `/ajax/` call needs `X-Requested-With: XMLHttpRequest`.** Without it
 *   the site answers `{"status":500,"result":"Bad request"}` and step 6 answers
 *   `{"error":"Forbidden"}`. The `vrf` token the page's own JS computes is *not*
 *   required — verified, identical bodies with and without it — so it isn't
 *   implemented here.
 * - **Step 5 cannot be `resolveEmbedStream`.** The megaplay page has no iframe,
 *   no packed JWPlayer and no media URL in it at all; its player is 173 KB of
 *   self-decrypting `eval` with no literal routes. `extractPlayable` is
 *   guaranteed to find nothing, so there is deliberately no "cheap pass first"
 *   here — it could only ever cost a request and fail.
 * - **The playlist 403s without a megaplay referer, and so do the subtitles**,
 *   from a *different* host. See `getSubtitles`.
 *
 * Note this connector runs for every title, not just anime: unlike the four
 * Arabic scrapers there is no origin gate. A total miss was measured at ~0.7s
 * for four parallel searches and opens no browser window, which the
 * browser-backed connectors hide entirely.
 */

const BASE = 'https://anikototv.to'

/** What the whole `/ajax/` surface refuses to answer without. */
const AJAX_HEADERS = { 'x-requested-with': 'XMLHttpRequest' }

/**
 * Search terms per lookup. Four rather than `MAX_SEARCH_TERMS`' five because
 * they run in parallel — the fifth alias is reliably the weakest and would only
 * widen the slowest path.
 */
const MAX_TERMS = 4

/** Resolved playlists are CDN URLs with the usual short lifetime. */
const RESULT_TTL_MS = 10 * 60_000
/** Which entry a show is costs a search; that answer is good for much longer. */
const MATCH_TTL_MS = 30 * 60_000

interface AnikotoEntry extends AnimeCandidate {
  /** `data-tip` on the search card, and `data-id` on the watch page. */
  animeId: string
  /** Highest `data-num` in the entry's episode list — set once fetched. */
  totalEpisodes?: number
}

interface Resolved {
  streams: Stream[]
  subtitles: Subtitle[]
}

const matchCache = new Map<string, { at: number; entry: AnikotoEntry | null }>()
const resultCache = new Map<string, { at: number; value: Resolved }>()

export const anikotoConnector: SourceConnector = {
  id: 'anikoto',
  name: 'Anikoto (anime)',
  kind: 'scraper',
  // Declared, but left `cheap` — so it is never actually demoted. A total miss
  // is ~0.6s and opens no window, which is less than the tier machinery would
  // save by skipping it, and running it anyway keeps a Turkish-anime edge case
  // reachable. The scope is here for what it says, not for what it gates.
  scope: ['anime'],

  async getStreams(query: StreamQuery): Promise<Stream[]> {
    return (await resolveCached(query)).streams
  },

  /**
   * Shares `resolveCached` with `getStreams` deliberately. The registry resolves
   * streams and subtitles independently, so without the shared cache a single
   * episode would walk all six hops twice.
   */
  async getSubtitles(query: StreamQuery): Promise<Subtitle[]> {
    return (await resolveCached(query)).subtitles
  },

  async test() {
    try {
      const results = await search('frieren')
      return results.length > 0
        ? { ok: true, message: `Reachable — ${results.length} results for a test search.` }
        : { ok: false, message: 'anikototv.to answered but listed no results.' }
    } catch (err) {
      // Reported rather than swallowed: "not reachable" and "the markup moved"
      // are different problems and Settings should be able to tell them apart.
      return { ok: false, message: `anikototv.to: ${(err as Error).message}` }
    }
  }
}

/* ------------------------------------------------------------------ steps */

async function resolveCached(query: StreamQuery): Promise<Resolved> {
  if (query.type === 'series' && query.episode == null) return EMPTY

  const key = `${query.type}:${query.tmdbId}:${query.season ?? 1}:${query.episode ?? 0}`
  const hit = resultCache.get(key)
  if (hit && Date.now() - hit.at < RESULT_TTL_MS) return hit.value

  const value = await resolve(query).catch(() => EMPTY)
  resultCache.set(key, { at: Date.now(), value })
  return value
}

const EMPTY: Resolved = { streams: [], subtitles: [] }

async function resolve(query: StreamQuery): Promise<Resolved> {
  const entry = await findEntry(query)
  if (!entry) return EMPTY

  const episodes = await getEpisodes(entry.animeId)
  if (episodes.length === 0) return EMPTY

  const wanted = pickEpisode(query, entry, episodes)
  if (!wanted) return EMPTY

  const servers = await getServers(wanted.dataIds)
  if (servers.length === 0) return EMPTY

  const streams: Stream[] = []
  const subtitles: Subtitle[] = []
  const seenFiles = new Set<string>()

  for (const server of servers) {
    const sources = await getSources(server.linkId).catch(() => null)
    if (!sources?.file) continue

    // HD-1 and Vidstream-2 resolve to the *same* file for a given episode and
    // audio, so without this the player's Servers menu would offer a "next
    // server" byte-identical to the one that just failed.
    if (seenFiles.has(sources.file)) continue
    seenFiles.add(sources.file)

    streams.push(toStream(sources.file, sources.origin, server, query))
    subtitles.push(...toSubtitles(sources.tracks, sources.origin, server.audio))
  }

  return { streams, subtitles: capPerLanguage(subtitles) }
}

/* ----------------------------------------------------------------- search */

async function findEntry(query: StreamQuery): Promise<AnikotoEntry | null> {
  const season = query.season ?? 1
  const key = `${query.tmdbId}:${season}`
  const hit = matchCache.get(key)
  if (hit && Date.now() - hit.at < MATCH_TTL_MS) return hit.entry

  // Latin-script names only: measured, this site returns nothing for either
  // "فريرن" or "葬送のフリーレン" but 30 results for "Sousou no Frieren" — and for
  // an anime TMDB's own `title`/`originalTitle` are exactly those two dead ones.
  const aliases = await getSearchAliases(query, { prefer: 'latin' })
  const latin = aliases.filter((a) => /[A-Za-z]/.test(a))
  if (latin.length === 0) {
    matchCache.set(key, { at: Date.now(), entry: null })
    return null
  }

  const terms = latin.slice(0, MAX_TERMS)
  // In parallel: each search is one stateless GET, and doing these serially the
  // way the Arabic scrapers do would turn 0.7s into 3s on every miss.
  const pages = await Promise.all(terms.map((term) => search(term).catch(() => [])))

  const candidates = new Map<string, AnikotoEntry>()
  for (const page of pages) {
    for (const entry of page) if (!candidates.has(entry.animeId)) candidates.set(entry.animeId, entry)
  }

  const picked = pickAnimeEntry([...candidates.values()], seasonAliases(latin, season), {
    wantMovie: query.type === 'movie'
  })

  const entry = picked?.candidate ?? null
  matchCache.set(key, { at: Date.now(), entry })
  return entry
}

/**
 * Parses the search page's result cards.
 *
 * Split-then-extract rather than one ordered regex across the whole card:
 * attribute order is the likeliest thing to change silently under a theme
 * update, and a single pattern would start returning nothing with no clue why.
 */
async function search(term: string): Promise<AnikotoEntry[]> {
  const html = await fetchText(`${BASE}/search?keyword=${encodeURIComponent(term)}`)
  const out: AnikotoEntry[] = []

  for (const block of html.split('<div class="item ').slice(1)) {
    const animeId = block.match(/data-tip="(\d+)"/)?.[1]
    const href = block.match(/href="(https?:\/\/[^"]*\/watch\/[^"/]+)\/ep-/)?.[1]
    if (!animeId || !href) continue

    const english = decodeEntities(
      block.match(/class="name d-title"[^>]*>([^<]*)</)?.[1] ??
        block.match(/<img[^>]+alt="([^"]*)"/)?.[1] ??
        ''
    ).trim()
    const romaji = decodeEntities(block.match(/data-jp="([^"]*)"/)?.[1] ?? '').trim()
    const format = block.match(/<div class="right">([^<]*)<\/div>/)?.[1]?.trim()
    const total = block.match(/ep-status total"><span>\s*(\d+)\s*</)?.[1]

    const slug = href.split('/watch/')[1] ?? ''

    out.push({
      key: animeId,
      animeId,
      // The slug carries the title too and is worth scoring, but its trailing
      // short id (`…-season-2-cp7ym`) would dilute every score it appears in.
      titles: [english, romaji, animeSlugTitle(slug, true)].filter(Boolean),
      format,
      totalEpisodes: total ? Number(total) : undefined
    })
  }

  return out
}

/* --------------------------------------------------------------- episodes */

interface AnikotoEpisode {
  number: number
  dataIds: string
}

async function getEpisodes(animeId: string): Promise<AnikotoEpisode[]> {
  // The largest single transfer this connector makes — One Piece's 1172
  // episodes are ~660 KB. Acceptable once per lookup, and cached above.
  const payload = await fetchJson(`${BASE}/ajax/episode/list/${animeId}`)
  const html = typeof payload?.result === 'string' ? payload.result : ''

  const out: AnikotoEpisode[] = []
  for (const tag of html.match(/<a\b[^>]*data-num="[^"]*"[^>]*>/g) ?? []) {
    const number = Number(tag.match(/data-num="(\d+)"/)?.[1])
    const dataIds = tag.match(/data-ids="([^"]+)"/)?.[1]
    if (Number.isFinite(number) && dataIds) out.push({ number, dataIds })
  }
  return out
}

/**
 * Which episode number this site files the request under.
 *
 * **The Arabic scrapers' `[episode, absolute]` order is wrong here**, and it
 * fails silently. Measured: Frieren season 2 is a *separate* entry numbered
 * 1…10, while One Piece is one entry numbered 1…1172. For One Piece S2E1 both
 * `1` and `62` exist in the same list, so trying the bare number first plays
 * episode 1 of the whole series with no error anywhere.
 *
 * So decide from evidence instead. If the matched entry is itself the season
 * (its title carries the marker, or its episode list is too short to span
 * seasons) the bare number is right. Only when one entry demonstrably spans
 * more seasons than this one does the absolute number win.
 */
function pickEpisode(
  query: StreamQuery,
  entry: AnikotoEntry,
  episodes: AnikotoEpisode[]
): AnikotoEpisode | null {
  const byNumber = new Map(episodes.map((e) => [e.number, e]))
  if (query.type === 'movie') return byNumber.get(1) ?? episodes[0] ?? null

  const season = query.season ?? 1
  const episode = query.episode!
  if (season <= 1) return byNumber.get(episode) ?? null

  const highest = Math.max(...episodes.map((e) => e.number))
  const absolute = absoluteEpisodeNumber(query.tmdbId, season, episode)
  const seasonSize = seasonEpisodeCount(query.tmdbId, season)

  const entrySaysSeason = entry.titles.some((t) =>
    new RegExp(`(season|part)\\s*0*${season}\\b|\\b0*${season}(st|nd|rd|th)\\s+season`, 'i').test(t)
  )

  // One entry, more episodes than this season alone has and enough to reach the
  // absolute number: this is the One Piece shape.
  const spansSeasons =
    !entrySaysSeason && absolute !== episode && highest >= absolute && highest > seasonSize

  const order = spansSeasons ? [absolute, episode] : [episode, absolute]
  for (const number of order) {
    const found = byNumber.get(number)
    if (found) return found
  }
  return null
}

/* ---------------------------------------------------------------- servers */

interface AnikotoServer {
  name: string
  linkId: string
  audio: 'sub' | 'dub'
}

async function getServers(dataIds: string): Promise<AnikotoServer[]> {
  const payload = await fetchJson(
    `${BASE}/ajax/server/list?servers=${encodeURIComponent(dataIds)}`
  )
  const html = typeof payload?.result === 'string' ? payload.result : ''

  const out: AnikotoServer[] = []
  // The sub/dub split is explicit in the markup, so it costs nothing to keep.
  for (const group of html.split('<div class="type"').slice(1)) {
    const audio = group.includes('data-type="dub"') ? 'dub' : 'sub'
    for (const item of group.match(/<li\b[^>]*data-link-id="[^"]*"[^>]*>[^<]*/g) ?? []) {
      const linkId = item.match(/data-link-id="([^"]+)"/)?.[1]
      if (!linkId) continue
      const name = decodeEntities(item.split('>').pop() ?? '').trim() || 'Anikoto'
      out.push({ name, linkId, audio })
    }
  }
  // Subtitled first: this app's audience wants original audio with subtitles,
  // and the player starts whatever sorts first.
  return out.sort((a, b) => (a.audio === b.audio ? 0 : a.audio === 'sub' ? -1 : 1))
}

interface Sources {
  file: string
  tracks: { file?: string; label?: string; kind?: string }[]
  /** The megaplay origin this episode resolved through — it rotates. */
  origin: string
}

async function getSources(linkId: string): Promise<Sources | null> {
  const payload = await fetchJson(`${BASE}/ajax/server?get=${encodeURIComponent(linkId)}`)
  const embedUrl =
    typeof payload?.result === 'object' && payload.result
      ? (payload.result as { url?: string }).url
      : undefined
  if (!embedUrl) return null

  // Never hardcode megaplay.buzz: the shell advertises its own
  // `data-domain="megaplay-1.buzz"`, so the host rotates and only the URL the
  // site just handed us is current.
  const origin = new URL(embedUrl).origin
  const shell = await fetchText(embedUrl, `${BASE}/`)
  const id = shell.match(/data-id="(\d+)"/)?.[1]
  if (!id) return null

  const sources = (await fetchJson(`${origin}/stream/getSources?id=${id}`, `${origin}/`)) as {
    sources?: { file?: string }
    tracks?: { file?: string; label?: string; kind?: string }[]
  } | null

  const file = sources?.sources?.file
  return file ? { file, tracks: sources?.tracks ?? [], origin } : null
}

/* --------------------------------------------------------------- mapping */

function toStream(
  file: string,
  origin: string,
  server: AnikotoServer,
  query: StreamQuery
): Stream {
  return {
    id: `anikoto:${server.audio}:${server.name}:${query.tmdbId}:${query.season ?? 1}:${query.episode ?? 0}`,
    connectorId: 'anikoto',
    connectorName: 'Anikoto',
    url: file,
    label: `${server.name} · ${server.audio === 'dub' ? 'Dub' : 'Sub'}`,
    quality: /master\.m3u8/i.test(file) ? 'HD' : 'auto',
    // Measured: 403 without these, 200 with. The CDN host rotates per response,
    // so registering by the resolved URL's host is what makes this self-healing.
    headers: { Referer: `${origin}/`, Origin: origin },
    rank: RANK.addon
  }
}

/**
 * The tracks megaplay lists beside the playlist.
 *
 * These live on a **different host** from the stream and 403 without the same
 * megaplay referer — and `Subtitle` has no header field to carry that, so the
 * host is registered directly. Relying on the playlist-headers fallback isn't
 * enough: `subtitle-store.ts` downloads tracks from the main process and can
 * run before any playlist request has gone past to set it.
 */
function toSubtitles(
  tracks: { file?: string; label?: string; kind?: string }[],
  origin: string,
  audio: 'sub' | 'dub'
): Subtitle[] {
  const out: Subtitle[] = []

  for (const track of tracks) {
    // The same array carries thumbnail sprites on some hosts.
    if (!track.file || (track.kind && track.kind !== 'captions')) continue

    registerHostHeaders(track.file, { Referer: `${origin}/`, Origin: origin })

    out.push({
      id: `anikoto:${audio}:${track.file}`,
      lang: langOfTrack(track.file, track.label),
      label: `${track.label?.trim() || 'Subtitle'} · Anikoto`,
      format: formatOf(track.file),
      url: track.file
    })
  }

  return out
}

/**
 * Language for a track.
 *
 * Some payloads name the file by ISO-639-2 (`ara-6.vtt`, `eng-2.vtt`) and others
 * use a content hash with only a label, so both are tried — the filename first,
 * because it is unambiguous where a label like "Portuguese (- Portuguese(Brazil))"
 * is not.
 */
function langOfTrack(file: string, label?: string): string {
  const code = file.match(/\/([a-z]{3})-\d+\.[a-z]+(\?|$)/i)?.[1]?.toLowerCase()
  const mapped = code ? ISO_639_2[code] : undefined
  if (mapped) return mapped
  return langOf(label ?? code ?? '')
}

/** Only the codes these payloads actually use. */
const ISO_639_2: Record<string, string> = {
  ara: 'ar',
  eng: 'en',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  ita: 'it',
  por: 'pt',
  rus: 'ru',
  spa: 'es',
  tur: 'tr',
  jpn: 'ja'
}

/* -------------------------------------------------------------- utilities */

async function fetchJson(url: string, referer = `${BASE}/`): Promise<Record<string, unknown> | null> {
  const text = await fetchText(url, referer, AJAX_HEADERS)
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

function absoluteEpisodeNumber(tmdbId: number, season: number, episode: number): number {
  const row = get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM episodes
     WHERE show_tmdb_id = ? AND season_number < ? AND season_number > 0`,
    [tmdbId, season]
  )
  return Number(row?.total ?? 0) + episode
}

function seasonEpisodeCount(tmdbId: number, season: number): number {
  const row = get<{ total: number }>(
    'SELECT COUNT(*) AS total FROM episodes WHERE show_tmdb_id = ? AND season_number = ?',
    [tmdbId, season]
  )
  return Number(row?.total ?? 0)
}
