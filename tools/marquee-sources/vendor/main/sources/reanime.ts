import type { SourceConnector } from './types'
import { fetchText } from './embed'
import { getSearchAliases } from './aliases'
import { capPerLanguage, langOf } from './tmdb-embed'
import { pickAnimeEntry, seasonAliases, type AnimeCandidate } from './anime-match'
import type { Stream, StreamQuery, Subtitle, SubtitleFormat } from '@shared/types'

/**
 * Connector for reanime.to.
 *
 * The site is a SvelteKit SPA, but it has a plain internal JSON API and no auth
 * on any of it:
 *
 *   GET /api/v1/search?q=<term>&limit=20  → candidates with anilist_id + titles
 *   GET /api/v1/anime/<anime_id>          → themoviedb_id + external_seasons
 *   GET /api/flix/<anilist_id>/<episode>  → servers, each a flixcloud embed
 *
 * The middle call is the reason this connector is more reliable than a title
 * scrape: it returns **TMDB's own id** plus which TMDB season the entry is, so a
 * candidate can be *confirmed* rather than merely scored. That matters because
 * the search is a fuzzy Meilisearch index — "Game of Thrones" answers with
 * twenty unrelated anime — so its top hit means nothing on its own.
 *
 * **This is a subtitles-only connector, and that was measured rather than
 * assumed.** `getStreams` returns nothing on purpose. Its subtitles are the
 * point: the flixcloud embed is server-rendered and lists its tracks in the
 * clear, and they are real BD-encode fansub ASS releases (9volt, EMBER,
 * Kaizoku) that nothing else in the app carries, rendered through JASSUB, and
 * fetched with no Referer at all. That makes this the same shape as Movish's
 * `flux` — wired for subtitles because its video doesn't work.
 *
 * The full stream investigation, 2026-08-07, so nobody repeats it:
 *
 * - The playlist URL is not in any HTTP response. It sits in
 *   `obfuscated_crypto_data`, AES-256-CBC under per-response *randomised* key
 *   names with an inline WASM blob deriving the key. Not worth reversing, and
 *   `browser-resolve.ts` exists precisely so it doesn't have to be.
 * - The offscreen resolver **does** capture a URL, quickly and reliably —
 *   `fetch.flixcloud.cc/_v7/<video_id>/master.m3u8?token=<jwt>` in ~1.6s. So
 *   this is *not* the 67movies failure where nothing is captured at all.
 * - That URL fetches **200** with `Referer: https://flixcloud.cc/` (403 bare,
 *   403 with reanime's own origin), Range request included.
 * - **But the body is not a playlist.** It is ~1.6 KB of base64 ciphertext with
 *   no `#EXTM3U` anywhere: the same scheme that hides the URL also encrypts the
 *   manifest, and only flixcloud's own player holds the key. hls.js would
 *   receive exactly that blob and fail to parse it.
 *
 * So a stream half would cost a hidden Chromium window per lookup to produce a
 * URL that cannot play. Hence none. If flixcloud ever serves a plaintext
 * manifest, the resolver half is a small addition — the capture already works.
 *
 * `/api/flix/0/<ep>?tmdb=<id>&season=<s>` exists in the site's own bundle as a
 * TMDB-keyed fallback and is **dead** — it answered `{"success":true,
 * "servers":[]}` for every id probed. Deliberately not implemented.
 */

const BASE = 'https://reanime.to'
const EMBED_REFERER = `${BASE}/`

/** Search terms per lookup; each is one cheap JSON GET. */
const MAX_TERMS = 3
/** How many candidates are worth spending a detail request on. */
const MAX_DETAILS = 4

const RESULT_TTL_MS = 10 * 60_000
const MATCH_TTL_MS = 30 * 60_000

interface ReanimeCandidate extends AnimeCandidate {
  animeId: string
  anilistId: number
}

interface ReanimeMatch {
  anilistId: number
  /** True when `themoviedb_id` confirmed it, so no title heuristic was trusted. */
  confirmed: boolean
}

const matchCache = new Map<string, { at: number; match: ReanimeMatch | null }>()
const serverCache = new Map<string, { at: number; links: string[] }>()

export const reanimeConnector: SourceConnector = {
  id: 'reanime',
  name: 'Reanime (anime)',
  kind: 'scraper',
  // Cheap by default, like anikoto — a miss here costs nothing at all, since
  // getStreams returns [] unconditionally and only the subtitle path does work.
  scope: ['anime'],

  /**
   * Always empty — see the file header. The playlist this site serves is
   * encrypted, so a captured URL is not a playable one.
   */
  async getStreams(): Promise<Stream[]> {
    return []
  },

  /** Plain requests only; this connector never opens a window. */
  async getSubtitles(query: StreamQuery): Promise<Subtitle[]> {
    const links = await getServerLinks(query)
    if (links.length === 0) return []

    const pages = await Promise.all(
      links.map((link) => fetchText(link, EMBED_REFERER).catch(() => ''))
    )

    const out: Subtitle[] = []
    const seen = new Set<string>()
    for (const html of pages) {
      for (const track of parseSubtitles(html)) {
        if (seen.has(track.url)) continue
        seen.add(track.url)
        out.push(track)
      }
    }
    return capPerLanguage(out)
  },

  async test() {
    try {
      // Frieren S1E1 by AniList id — one request, and it proves the path that
      // matters without depending on the fuzzy search.
      const payload = (await fetchJson(`${BASE}/api/flix/154587/1`)) as {
        servers?: unknown[]
      } | null
      const count = payload?.servers?.length ?? 0
      return count > 0
        ? { ok: true, message: `Reachable — ${count} server(s) for a known episode.` }
        : { ok: false, message: 'reanime.to answered but listed no servers.' }
    } catch (err) {
      return { ok: false, message: `reanime.to: ${(err as Error).message}` }
    }
  }
}

/* ------------------------------------------------------------- front half */

/** The embed links for this episode — shared by both halves, hence cached. */
async function getServerLinks(query: StreamQuery): Promise<string[]> {
  if (query.type === 'series' && query.episode == null) return []

  const key = `${query.type}:${query.tmdbId}:${query.season ?? 1}:${query.episode ?? 0}`
  const hit = serverCache.get(key)
  if (hit && Date.now() - hit.at < RESULT_TTL_MS) return hit.links

  const links = await resolveServerLinks(query).catch(() => [])
  serverCache.set(key, { at: Date.now(), links })
  return links
}

async function resolveServerLinks(query: StreamQuery): Promise<string[]> {
  const match = await findMatch(query)
  if (!match) return []

  const episode = query.type === 'movie' ? 1 : query.episode!
  const payload = (await fetchJson(`${BASE}/api/flix/${match.anilistId}/${episode}`)) as {
    servers?: { dataLink?: string }[]
  } | null

  // Sub and dub share a dataLink — the player switches audio internally — so
  // the unique links are the only thing worth resolving.
  const links: string[] = []
  for (const server of payload?.servers ?? []) {
    if (server.dataLink && !links.includes(server.dataLink)) links.push(server.dataLink)
  }
  return links
}

async function findMatch(query: StreamQuery): Promise<ReanimeMatch | null> {
  const season = query.season ?? 1
  const key = `${query.tmdbId}:${season}`
  const hit = matchCache.get(key)
  if (hit && Date.now() - hit.at < MATCH_TTL_MS) return hit.match

  const match = await searchAndConfirm(query, season)
  matchCache.set(key, { at: Date.now(), match })
  return match
}

async function searchAndConfirm(query: StreamQuery, season: number): Promise<ReanimeMatch | null> {
  const aliases = await getSearchAliases(query, { prefer: 'latin' })
  const latin = aliases.filter((a) => /[A-Za-z]/.test(a))
  if (latin.length === 0) return null

  const terms = seasonAliases(latin, season).slice(0, MAX_TERMS)
  const pages = await Promise.all(terms.map((term) => search(term).catch(() => [])))

  const candidates = new Map<string, ReanimeCandidate>()
  for (const page of pages) {
    for (const entry of page) if (!candidates.has(entry.animeId)) candidates.set(entry.animeId, entry)
  }
  if (candidates.size === 0) return null

  // Score first, but only to decide which candidates are worth a detail
  // request — the answer comes from `themoviedb_id`, not from the score.
  const ranked = [...candidates.values()]
    .map((candidate) => ({
      candidate,
      score: pickAnimeEntry([candidate], seasonAliases(latin, season), {
        wantMovie: query.type === 'movie',
        threshold: 0
      })?.score ?? 0
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DETAILS)

  const details = await Promise.all(
    ranked.map(async (entry) => ({
      entry,
      detail: await getDetail(entry.candidate.animeId).catch(() => null)
    }))
  )

  // Exact: the right show *and* the right season. Nothing beats this.
  for (const { entry, detail } of details) {
    if (detail?.themoviedb_id === query.tmdbId && detail.external_seasons?.tmdb === season) {
      return { anilistId: entry.candidate.anilistId, confirmed: true }
    }
  }

  // Right show, season unmapped (`0`). Trust it only for season 1 — for a later
  // season an unmapped entry is as likely to be the first cour, and playing
  // someone else's episode is worse than returning nothing.
  for (const { entry, detail } of details) {
    if (detail?.themoviedb_id === query.tmdbId && !detail.external_seasons?.tmdb && season === 1) {
      return { anilistId: entry.candidate.anilistId, confirmed: true }
    }
  }

  // No TMDB confirmation anywhere — fall back to the title score, at the full
  // threshold. reanime's index is fuzzy enough that anything weaker is noise.
  const picked = pickAnimeEntry([...candidates.values()], seasonAliases(latin, season), {
    wantMovie: query.type === 'movie'
  })
  return picked ? { anilistId: picked.candidate.anilistId, confirmed: false } : null
}

async function search(term: string): Promise<ReanimeCandidate[]> {
  const payload = (await fetchJson(
    `${BASE}/api/v1/search?q=${encodeURIComponent(term)}&limit=20`
  )) as {
    results?: {
      anime_id?: string
      anilist_id?: number
      format?: string
      title?: { english?: string; romaji?: string; native?: string }
    }[]
  } | null

  const out: ReanimeCandidate[] = []
  for (const result of payload?.results ?? []) {
    if (!result.anime_id || !result.anilist_id) continue
    out.push({
      key: result.anime_id,
      animeId: result.anime_id,
      anilistId: result.anilist_id,
      // `native` is scored too: for anime it and TMDB's `originalTitle` are both
      // the Japanese original and are frequently identical, which the
      // token-based similarity never sees but exact equality catches outright.
      titles: [result.title?.english, result.title?.romaji, result.title?.native].filter(
        (t): t is string => Boolean(t && t.trim())
      ),
      format: result.format
    })
  }
  return out
}

interface ReanimeDetail {
  themoviedb_id?: number
  external_seasons?: { tmdb?: number }
}

async function getDetail(animeId: string): Promise<ReanimeDetail | null> {
  return (await fetchJson(`${BASE}/api/v1/anime/${encodeURIComponent(animeId)}`)) as ReanimeDetail | null
}

/* --------------------------------------------------------------- mapping */

/**
 * Pulls the track list out of the embed's hydration payload.
 *
 * Parsed with a regex rather than `JSON.parse` because it isn't JSON — the
 * payload is a JS object literal with unquoted keys
 * (`subtitles:[{url:"…",language:"…",format:"ass",default:true}]`).
 */
function parseSubtitles(html: string): Subtitle[] {
  // Closed on `}]` rather than the first `]`, and that is not fussiness: the
  // language labels are fansub credits that contain brackets — "English
  // (Signs/Songs [9volt])" — so a plain non-greedy `[...]` ends inside the
  // first label and leaves no complete object to parse. That returned zero
  // tracks while looking like the site had simply stopped listing any.
  const block = html.match(/subtitles\s*:\s*\[(.*?\})\s*\]/s)?.[1]
  if (!block) return []

  const out: Subtitle[] = []
  for (const entry of block.match(/\{[^{}]*\}/g) ?? []) {
    const url = entry.match(/url\s*:\s*"([^"]+)"/)?.[1]
    if (!url) continue
    const language = entry.match(/language\s*:\s*"([^"]+)"/)?.[1] ?? 'Unknown'
    const declared = entry.match(/format\s*:\s*"([^"]+)"/)?.[1]

    out.push({
      id: `reanime:${url}`,
      lang: langOf(language),
      label: `${language} · Reanime`,
      // The payload states its own format; sniffing the extension would get the
      // hash-named `.srt` wrong.
      format: subtitleFormat(declared, url),
      url
    })
  }
  return out
}

function subtitleFormat(declared: string | undefined, url: string): SubtitleFormat {
  const value = (declared ?? url).toLowerCase()
  if (value.includes('ass')) return 'ass'
  if (value.includes('ssa')) return 'ssa'
  if (value.includes('srt')) return 'srt'
  return 'vtt'
}

/* ------------------------------------------------------------- utilities */

async function fetchJson(url: string): Promise<unknown | null> {
  const text = await fetchText(url, EMBED_REFERER, { accept: 'application/json' })
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}
