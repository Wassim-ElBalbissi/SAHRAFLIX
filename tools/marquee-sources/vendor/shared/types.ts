/**
 * Types shared across the IPC boundary.
 *
 * The renderer is sandboxed and never touches the network or disk directly, so
 * everything it knows about the outside world arrives through these shapes.
 */

import type { CatalogRowKey } from './catalog'
import type { PersonalRating } from './rating'
import type { AccentKey } from './theme'

/* ------------------------------------------------------------------ media */

export type MediaType = 'series' | 'movie'

/**
 * How far through a title you are, as far as the local tables can honestly say.
 *
 * `completed` is a weaker claim than it looks, and deliberately so — see the
 * predicate in `library.ts`. It counts against the episodes this app has
 * *stored*, not TMDB's declared total, because the sync only guarantees the
 * latest season plus any that came up short.
 */
export type WatchStatus = 'unwatched' | 'in-progress' | 'completed'

/** A show/movie as the UI consumes it. Flattened from TMDB + local state. */
export interface Show {
  tmdbId: number
  imdbId?: string
  type: MediaType
  /** Resolved ar -> tr -> en. */
  title: string
  originalTitle?: string
  overview?: string
  posterUrl?: string
  backdropUrl?: string
  logoUrl?: string
  firstAirDate?: string
  lastAirDate?: string
  status?: string
  genres?: string[]
  voteAverage?: number
  numberOfSeasons?: number
  numberOfEpisodes?: number
  /** ISO-3166 codes from TMDB. Undefined until the detail fetch fills it in. */
  originCountry?: string[]
  /**
   * ISO-639-1 of the language the work was made in.
   *
   * Present on every TMDB list item, so a search hit carries it immediately —
   * unlike `originCountry`, which films only get from the detail fetch. That's
   * what makes it the reliable half of `classifyTitle`. Undefined on rows
   * cached before migration 15.
   */
  originalLanguage?: string
  /**
   * TMDB genre ids. Ids rather than the `genres` names above, because names are
   * stored localised and a test against them breaks off-English.
   */
  genreIds?: number[]
  /**
   * Expected length in minutes, films only — from TMDB `/movie/{id}`, cached on
   * the shows row by the detail fetch. Series carry per-episode runtimes on
   * `Episode.runtime` instead. The player compares this against the stream's
   * real duration to flag wrong-content sources.
   */
  runtime?: number
  /**
   * Dollars, films only — from TMDB `/movie/{id}`, cached on the shows row by
   * the detail fetch like `runtime`. Absent when TMDB doesn't know (it reports
   * 0, which main maps to null before it gets here).
   */
  budget?: number
  revenue?: number
  /** Local library state, joined in by the main process. */
  isFavorite?: boolean
  inWatchlist?: boolean
  /** What you thought of it. Undefined means unrated — never "disliked". */
  myRating?: PersonalRating
  /**
   * How far through the title you are, derived from `watch_progress`.
   *
   * Only attached by the library reads that need it (favourites, watchlist),
   * not by `SHOW_SELECT` — it costs two correlated subqueries per row, and
   * three screens want it against every read in the app. Undefined therefore
   * means "not computed here", not "unwatched".
   */
  watchStatus?: WatchStatus
  /**
   * AniList's romaji name, when we have one.
   *
   * Anime only. TMDB's `original_title` for an anime is the native script, and
   * a poster grid of 葬送のフリーレン is harder to scan than one of "Sousou no
   * Frieren" — this is the name people actually use.
   */
  romajiTitle?: string
}

/**
 * How mature a title is, and — the part that matters — why.
 *
 * TMDB has no single "is this NSFW" field worth trusting. Its own `adult` flag
 * means pornography and essentially nothing in the general catalogue carries it,
 * while the signals that actually describe a film's content are spread across
 * two other endpoints and a keyword vocabulary. So the answer is assembled from
 * all three, and every reason keeps the evidence that produced it: a bare
 * "flagged" badge is a claim the user can't check, and these signals are wrong
 * often enough that being able to see "because it's rated R" matters.
 */
export type ContentLevel = 'unknown' | 'clean' | 'mature' | 'explicit'

/**
 * What a title actually contains, as independently filterable categories.
 *
 * A single "is this NSFW" boolean was the old model and it could not answer the
 * question people actually ask, which is *which* kind of content. These are
 * deliberately orthogonal: a title can carry several, and each is excluded or
 * allowed on its own.
 *
 * `same-sex` and `lgbt-theme` are split on purpose and the distinction is the
 * whole point of having both. TMDB and IMDb tag LGBT as a *theme* far more often
 * than as explicit content, so collapsing them would mean excluding "gay content"
 * hides every title that merely has a gay character. `same-sex` therefore
 * requires evidence of explicit content — a sex scene or nudity — while
 * `lgbt-theme` is what's left when a title is tagged LGBT with no such evidence.
 * See `sameSexEvidence()` in `main/metadata/content-flags.ts`.
 */
export type ContentFacet =
  | 'nudity'
  | 'sex'
  | 'sexual-violence'
  /** Explicit same-sex nudity or sex scenes. */
  | 'same-sex'
  /** LGBT characters or plot with no explicit content found. */
  | 'lgbt-theme'
  | 'violence'
  | 'profanity'
  | 'drugs'

/** How a single facet is treated. Anything not named is `allow`. */
export type FacetRule = 'allow' | 'exclude' | 'only'

export type FacetRules = Partial<Record<ContentFacet, FacetRule>>

/** IMDb parents-guide categories, by the ids its API returns. */
export type ImdbCategory = 'NUDITY' | 'VIOLENCE' | 'PROFANITY' | 'ALCOHOL' | 'FRIGHTENING'

/** IMDb severity, the median of its users' votes. */
export type ImdbSeverity = 'None' | 'Mild' | 'Moderate' | 'Severe'

/**
 * Browse's quick preset. Expands into `FacetRules`; kept because a three-option
 * dropdown is the right control for "just hide the obvious stuff".
 */
export type ContentFilter = 'all' | 'safe' | 'nsfw'

export interface ContentReason {
  /** Grouping key: `certification`, or a `ContentFacet`. */
  code: string
  /** One line, already human-readable — "Rated R (US)". */
  label: string
  /** Where it came from: "TMDB certification", "TMDB keywords", "IMDb parents guide". */
  source: string
}

export interface ContentAdvisory {
  tmdbId: number
  level: ContentLevel
  /** True when something specifically indicates nudity or sexual content. */
  nsfw: boolean
  /** Everything this title was found to contain. */
  facets: ContentFacet[]
  /** IMDb's per-category severity, when it had enough votes to be worth showing. */
  severity?: Partial<Record<ImdbCategory, ImdbSeverity>>
  reasons: ContentReason[]
}

export interface Season {
  seasonNumber: number
  name: string
  episodeCount: number
  airDate?: string
  posterUrl?: string
}

export interface Episode {
  tmdbId: number
  showTmdbId: number
  seasonNumber: number
  episodeNumber: number
  title: string
  overview?: string
  stillUrl?: string
  airDate?: string
  runtime?: number
  voteAverage?: number
  /**
   * Known only from TVmaze, because TMDB hasn't published it yet.
   *
   * Carries an air date and a number but no overview or still. Shown with a
   * marker rather than hidden — for a weekly dizi the episode existing at all
   * is the fact worth having, and it becomes a normal row as soon as TMDB
   * catches up.
   */
  provisional?: boolean
  /** Joined from watch_progress. */
  progress?: WatchProgress
  /** What you thought of this episode. Undefined means unrated. */
  myRating?: PersonalRating
}

/** An episode surfaced in the "New Episodes" feed, carrying its show context. */
export interface FeedEpisode extends Episode {
  showTitle: string
  /** Turkish original name, shown alongside the resolved (often Arabic) title. */
  showOriginalTitle?: string
  showPosterUrl?: string
}

/* --------------------------------------------------------------- playback */

/**
 * What a Play button on a title should start, decided main-side from local rows.
 *
 * - `resume`: an episode (or the film) that was left part-way through.
 * - `next`: the first aired episode after the last one finished.
 * - `start`: nothing watched yet — S1E1, or the film from the top.
 * - `caught-up`: every aired episode is finished; `episode` is the next one
 *   scheduled, if the schedule is known.
 *
 * `show` is the full detail row, so a card's partial list item never reaches
 * the player — stream resolution wants `imdbId` and the language/genre facts.
 */
export interface NextUp {
  kind: 'resume' | 'next' | 'start' | 'caught-up'
  show: Show
  episode?: Episode
  progress?: WatchProgress
}

export interface WatchProgress {
  positionSeconds: number
  durationSeconds: number
  /** 0..1 */
  percent: number
  completed: boolean
  updatedAt: number
}

/**
 * One thing watched, with what was watched of it.
 *
 * `episode` is absent for a film, and that is the whole shape of it: the
 * progress row for a movie carries a NULL season and episode, which used to be
 * treated as "no episode row, drop it" — so films were written to
 * `watch_progress` correctly and then never surfaced anywhere.
 */
export interface HistoryEntry {
  show: Show
  episode?: Episode
  progress: WatchProgress
}

/** Continue Watching is history filtered to what is part-way through. */
export type ContinueWatchingItem = HistoryEntry

export type SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'ssa'

export interface Subtitle {
  id: string
  /** BCP-47-ish. "ar" for Arabic. */
  lang: string
  label: string
  format: SubtitleFormat
  /** Remote URL, or a local absolute path when `isLocal`. */
  url: string
  isLocal?: boolean
}

/**
 * What `player:remux` returns: a local file Chromium couldn't decode,
 * converted to HLS the built-in player can play. The playlist is live the
 * moment this resolves — the encode races ahead of the playhead from there.
 */
export interface RemuxResult {
  jobId: string
  /** `tdmedia://transcode/<jobId>/index.m3u8` */
  playlistUrl: string
  /** From ffprobe, so seeking has a total before the encode finishes. */
  durationSeconds?: number
  /** Text subtitle tracks extracted from the container, as local files. */
  subtitles: Subtitle[]
}

/**
 * A playable stream. Exactly one of url/filePath is meaningful.
 *
 * Deliberately mirrors the Stremio stream shape so the Stremio connector maps
 * across without a translation layer — minus YouTube-backed streams, which
 * this app no longer plays and which every connector therefore drops.
 */
export interface Stream {
  /** Stable id for UI keys, built from connector id + payload. */
  id: string
  /** Which connector produced this. */
  connectorId: string
  connectorName: string
  /** Direct progressive or HLS (.m3u8) URL. */
  url?: string
  /** Absolute path to a local file. */
  filePath?: string
  /** Human label, e.g. "1080p - Official". */
  label: string
  quality?: string
  /** Subtitles the connector already knows about. */
  subtitles?: Subtitle[]
  /** Higher sorts first. Official sources outrank unknown ones. */
  rank?: number
  /** Extra request headers some hosts need (referer etc). */
  headers?: Record<string, string>
  /**
   * Force the hls.js path even when the URL lacks a `.m3u8` extension.
   * Live IPTV URLs are frequently extensionless, and Chromium can't play
   * HLS natively, so extension sniffing alone would dead-end them.
   */
  isHls?: boolean
  /**
   * Seeder count, torrent streams only, as the addon reported it. Undefined for
   * everything else *and* for a torrent whose addon gave no count — the
   * registry sinks a reported count below its floor to the end of the list,
   * and "unknown" must not be mistaken for that.
   */
  seeders?: number
}

/** What the player needs to start. */
export interface PlaybackRequest {
  stream: Stream
  show: Show
  episode?: Episode
}

/* -------------------------------------------------------------- connectors */

export type ConnectorKind = 'stremio' | 'plugin' | 'local' | 'scraper' | 'generated'

/* ------------------------------------------------- generated (site) sources */

/**
 * A connector expressed as data.
 *
 * `createTmdbEmbedConnector` already builds a whole working connector from a
 * provider list, and every field of a provider except `resolve` is a pure
 * `(query) => string | null`. That makes the useful half of it serialisable: a
 * URL template with `{tmdbId}`-style placeholders is exactly as expressive as
 * the arrow functions `boredflix.ts` writes by hand.
 *
 * Which is the whole point — a source added by pasting a website is **data**,
 * never code. Nothing here is evaluated. The only place a generated source runs
 * anything of the site's is the offscreen window the probe already uses.
 */
export interface GeneratedProvider {
  id: string
  name: string
  /** e.g. `https://example.tv/movie/{tmdbId}` — run in a hidden window. */
  movie?: string
  /** e.g. `https://example.tv/tv/{tmdbId}/{season}/{episode}`. */
  tv?: string
  /** JSON endpoint returning the playlist. An order of magnitude cheaper. */
  api?: string
  /** JSON endpoint returning subtitles only, for hosts that split the two. */
  subs?: string
  /** `''` means send no referer, matching `BrowserResolveOptions`. */
  referer?: string
}

export interface GeneratedSourceOptions {
  version: 1
  providers: GeneratedProvider[]
  browserResolveMs?: number
  waveSize?: number
  evidence?: ProbeEvidence
}

/** What the probe actually saw, kept so a claim can be checked rather than trusted. */
export interface ProbeEvidence {
  /** The winning template, with the origin trimmed off for display. */
  pattern: string
  /** `api` is a plain JSON fetch; `browser` costs a hidden window per play. */
  via: 'api' | 'browser'
  resolvedMs: number
  /** The backend the playlist actually came from. */
  streamHost: string
  referer: 'self' | 'none'
  /** Titles the template was confirmed against — two, so it's a pattern. */
  confirmedOn: string[]
  /** Films confirmed but the episode template inferred rather than tested. */
  tvUnverified: boolean
}

export interface ProbeProgress {
  stage: 'normalise' | 'reach' | 'cheap' | 'browser' | 'confirm' | 'done'
  state: 'running' | 'ok' | 'skip' | 'fail'
  /** Already user-facing prose; the UI renders it as-is. */
  message: string
  atMs: number
}

export interface ProbeSuggestion {
  id: string
  name: string
  /** The site origin — the human identity of the source. */
  target: string
  options: GeneratedSourceOptions
  evidence: ProbeEvidence
}

export type ProbeFailure =
  | 'unreachable'
  | 'not-id-keyed'
  | 'nothing-captured'
  | 'runtime-list'
  | 'blocked'

export interface ProbeResult {
  ok: boolean
  suggestion?: ProbeSuggestion
  reason?: ProbeFailure
  /** Every candidate tried, so a failure can be reported rather than shrugged at. */
  attempts: { url: string; via: 'api' | 'browser'; outcome: string; ms: number }[]
}

export interface ConnectorConfig {
  id: string
  kind: ConnectorKind
  name: string
  enabled: boolean
  /** Stremio manifest URL, plugin filename, or local folder path. */
  target?: string
  /** Free-form per-connector settings. */
  options?: Record<string, unknown>
  /** Populated at runtime; not persisted. */
  status?: 'ok' | 'error' | 'unconfigured'
  statusMessage?: string
}

/**
 * Result of checking whether a stream actually responds.
 *
 * `unknown` is not a failure — a probe that timed out still plays. Only `dead`
 * is a reason to skip a stream.
 */
export type StreamHealth = 'ok' | 'dead' | 'unknown'

export interface ProbedStream {
  id: string
  health: StreamHealth
}

/**
 * Live progress while sources are being searched.
 *
 * Resolution runs a dozen connectors concurrently and takes several seconds,
 * which is far too long to sit behind an unexplained spinner — so each one
 * reports as it starts and finishes.
 */
export interface ConnectorProgress {
  connectorId: string
  connectorName: string
  /**
   * `skipped` means the registry decided this connector's catalogue can't cover
   * this title and didn't run it. It is neither a failure nor an exclusion — if
   * the connectors that did run come back empty, the same connector is upgraded
   * to `searching` and runs after all. See `sources/tiers.ts`.
   */
  state: 'searching' | 'found' | 'none' | 'failed' | 'skipped'
  /** How many streams it returned, when `found`. */
  streams?: number
  /** Why it failed, when `failed`. */
  message?: string
}

/**
 * The streams one connector found, delivered the moment it finds them.
 *
 * This is what lets playback start on the first source to answer instead of on
 * the slowest, which used to mean a title prstej returns in 1.3s still waiting
 * out the browser-backed connectors' 14s. Every stream here also appears in the
 * array `streams:resolve` eventually returns — this is earlier, not extra.
 *
 * Deliberately not a fatter `ConnectorProgress`. That type is *narration state*:
 * one row per connector, held in a React array for the life of the screen, and
 * upserted by three different callers including `Availability`, which wants
 * counts and nothing else. Hanging full `Stream` objects — with their headers
 * and subtitle lists — off every progress row would retain all of it for all of
 * them. Note `ConnectorProgress.streams` is a *count*; this one is the array.
 */
export interface StreamBatch {
  connectorId: string
  streams: Stream[]
}

/** Context handed to a connector when resolving streams. */
export interface StreamQuery {
  tmdbId: number
  imdbId?: string
  type: MediaType
  title: string
  originalTitle?: string
  year?: number
  season?: number
  episode?: number
  /**
   * ISO-3166 codes, so a region-specific connector can decline immediately.
   *
   * Undefined means "not known yet", which the scrapers treat as worth trying —
   * see `isTurkishTitle` in sources/match.ts.
   */
  originCountry?: string[]
  /**
   * ISO-639-1 language and TMDB genre ids, carried for the same reason and
   * under the same contract as `originCountry`: **undefined means "not known
   * yet", never "no"**.
   *
   * The registry classifies the title from these to decide which connectors are
   * worth running first (`sources/tiers.ts`). A row cached before migration 15
   * carries none of the three, which must resolve to "run everything" — a
   * missing signal may never remove a connector from the first tier.
   */
  originalLanguage?: string
  genreIds?: number[]
}

/* ---------------------------------------------------------------- settings */

export type ThemeMode = 'dark' | 'light' | 'system'

export interface AppSettings {
  tmdbApiKey: string
  theme: ThemeMode
  /**
   * Subtitle size, as a percentage of the renderer's own default.
   *
   * A multiplier rather than a pixel size, because both rendering paths are
   * resolution-relative: Chromium derives a cue's size from the video's height,
   * and an ASS file's own sizes are in its declared PlayRes space. A percentage
   * therefore keeps meaning the same thing in a window and in fullscreen, which
   * an absolute size does not.
   *
   * This replaced a `subtitleFontSize: 42` that nothing ever read or wrote. The
   * name changed with the unit deliberately: a key called `…FontSize` holding
   * `100` is the next reader's trap.
   */
  subtitleTextScale: number
  /**
   * Opacity of the box behind native cues, as an integer percentage.
   *
   * Integer rather than the `0.35` float this used to default to, so the values
   * survive the `String()`/`Number()` round trip without formatting noise and
   * can be listed in a Select. The default is 55 rather than 35 because 55% is
   * what `main.css` has actually been rendering all along — this setting was
   * declared and never read, so wiring the old default through would have
   * lightened every existing user's subtitles as a side effect of adding a
   * control.
   *
   * Native only. ASS/SSA tracks carry their own borders and shadows as
   * typesetting, and overriding those is not a rendering preference.
   */
  subtitleBackgroundOpacity: number
  /**
   * Pull the preferred languages to disk on first play. 1 on, 0 off.
   *
   * A number rather than a boolean because settings are persisted as strings and
   * coerced back by the default's type, which only handles string and number.
   */
  subtitleAutoDownload: number
  /**
   * Languages to download and auto-select, best first — ISO-639-1, comma
   * separated. Also the order the player picks a starting track in.
   */
  subtitleLanguages: string
  /**
   * Audio languages to prefer, best first — the same CSV shape as
   * `subtitleLanguages`, plus one token.
   *
   * `original` stands for the title's own `originalLanguage`, and it is the
   * default and the whole point: without any preference hls.js plays whatever
   * rendition the manifest flags `DEFAULT=YES`, which for an Italian-first
   * catalogue like vixsrc means a Turkish drama opens in Italian. A token rather
   * than a separate boolean because "prefer the original, then Arabic" and
   * "prefer Arabic, then the original" are both reasonable and a single ordered
   * list expresses either without two settings that can contradict each other.
   *
   * A per-title choice, when one has been made, still wins over this list.
   * `shared/tracks.ts` resolves the whole ladder.
   */
  audioLanguages: string
  /** Hours between background metadata syncs. */
  syncIntervalHours: number
  lastSyncAt: number
  /**
   * DNS-over-HTTPS mode. `secure` is the default because several source
   * domains are blocked by cleartext-SNI filtering on ordinary ISP
   * connections, and only DoH-backed Encrypted ClientHello gets past it.
   * Set to `automatic` or `off` on networks that require the local resolver.
   */
  secureDns: SecureDnsMode
  /**
   * ISO-3166 region for the streaming-service filters in the sidebar.
   *
   * TMDB's `with_watch_providers` is meaningless without a region — what's on
   * Netflix differs entirely between countries — so this is a setting rather
   * than a constant.
   */
  watchRegion: string
  /**
   * ISO-639-1 language for titles, overviews and artwork.
   *
   * Was hard-coded to `ar` when the library was Turkish drama for an Arabic
   * audience. Subtitles are unaffected and still rank Arabic first — that's a
   * separate preference from what language the catalogue reads in.
   */
  metadataLanguage: string
  /** Free key from opensubtitles.com/consumers. Empty disables that connector. */
  openSubtitlesApiKey: string
  /**
   * Master switch for content filtering. 1 on, 0 off. **Off by default.**
   *
   * Opt-in rather than opt-out because the failure modes are asymmetric: a
   * filter nobody asked for that silently removes titles reads as the app being
   * broken, while an unused filter costs nothing. Coverage is also partial and
   * grows in the background, so filtering on by default would make the catalogue
   * appear to change on its own between sessions.
   *
   * When off, `contentFacetRules()` returns nothing at all and no filtering runs
   * anywhere — the saved facet choices are kept, just not applied.
   */
  contentFilterEnabled: number
  /**
   * `ContentFacet`s to hide, comma separated. Empty hides nothing.
   *
   * A CSV string rather than an array for the same reason `subtitleLanguages`
   * is: settings round-trip through TEXT rows and are coerced back by the
   * default's type, which only handles `string` and `number`.
   *
   * There is deliberately no saved counterpart for the `only` rule. "Show me
   * only X" is a way of exploring the catalogue for one query, not a standing
   * preference, and as a persistent setting it was a trap — a stray `only` left
   * saved looks exactly like the app being broken. Browse's dropdown covers it
   * per query instead.
   */
  contentExclude: string
  /**
   * Apply the facet rules to Home and Search as well as Browse. 1 on, 0 off.
   *
   * On by default: a filter that only covers one screen isn't a content filter,
   * and the rows on Home are the first thing the app shows.
   */
  contentFilterEverywhere: number
  /**
   * ETag of the AniList↔TMDB cross-reference we last downloaded.
   *
   * Sent back as `If-None-Match`, so a sync where nothing changed costs one
   * conditional request instead of re-downloading 7.5 MB.
   */
  animeXrefEtag: string
  /** When that download last succeeded, epoch ms. Refreshed weekly. */
  animeXrefFetchedAt: number
  /**
   * Accent hue. `default` keeps the theme's own near-white / near-black, which
   * is what the whole palette was before this existed.
   *
   * Typed as the union for the call sites, but `getSettings` coerces by the
   * default's *type* and validates nothing — the same hole `theme` and
   * `secureDns` have — so anything reading it must run `isAccent()` first.
   */
  accentColor: AccentKey
  /**
   * Installed family for the interface. Empty means the built-in stack.
   *
   * Only ever set to a family the renderer has measured as actually resolving.
   * A name that doesn't resolve renders identically to its fallback, so a wrong
   * value here is invisible rather than obviously broken — which is the worst
   * kind of setting to store.
   */
  uiFont: string
  /**
   * Absolute path of the picked background image. Empty is none.
   *
   * The path the *user* chose, kept for display and to derive the copy's
   * extension. What is actually served is a copy in `userData/backgrounds/`, so
   * the background survives the original being moved or deleted.
   */
  backgroundImage: string
  /**
   * Tint the window with the artwork on screen. 1 on, 0 off.
   *
   * A number rather than a boolean for the same reason `subtitleAutoDownload`
   * is: settings round-trip through TEXT and are coerced by the default's type.
   */
  ambientArtwork: number
  /**
   * Windows 11 system blur behind the window. 1 on, 0 off.
   *
   * Reserved. Nothing reads this yet — the material is mutually exclusive with
   * both the background image and the ambient artwork, since the scrim occludes
   * it completely, so it is its own piece of work rather than a fifth switch.
   */
  windowAcrylic: number
  /**
   * Name the connectors and hosts in the player. 1 on, **0 off by default.**
   *
   * With it off the player says "Source 3" and "Server 2" instead of naming
   * krmzy, Movish or Rigel. The names are only ever useful when something has
   * gone wrong, and until then they are a running commentary on where the video
   * is coming from — over anyone's shoulder, on a screen share, in a
   * screenshot. Numbering keeps the one thing the labels are actually for,
   * which is telling one source apart from another.
   *
   * Settings → Sources is unaffected; that page is *about* the sources.
   */
  showSourceNames: number
  /** Player volume, 0–1, restored across sources and launches. */
  playerVolume: number
  /**
   * Player mute state. 1 muted, 0 not.
   *
   * Persisted alongside the volume because `PlayerSurface` is remounted on
   * every failover, so without this a source switch silently reset both.
   */
  playerMuted: number
  /** Roll into the next episode when one ends. 1 on, 0 off. */
  autoplayNext: number
  /**
   * What closing the picture-in-picture window does while browsing the app:
   * 1 (default) returns to the full player, video still going — the browser's
   * own back-to-tab semantics; 0 stops playback where you are.
   */
  pipReturnToPlayer: number
  /**
   * Sidebar entries the user has hidden — CSV of ids from `SIDEBAR_TOGGLES` in
   * `Sidebar.tsx`. A hide-list rather than a show-list so a future nav entry
   * defaults to visible; Home is not listable, so the column can never empty
   * out. Unknown ids are inert, the same argument as removed settings keys.
   */
  sidebarHidden: string
  /**
   * Fine-grained GitHub PAT with Contents: Read-only on the (private) Marquee
   * repo — what lets the updater list and download releases. Empty disables
   * update checks entirely, stated as such in the UI rather than failing
   * silently. Never reaches the renderer beyond the settings screen.
   */
  githubToken: string
  /**
   * Which debrid service Torrentio should resolve through: '' (none, torrents
   * play peer-to-peer), 'realdebrid', 'premiumize', 'alldebrid', 'torbox' or
   * 'debridlink'. A union isn't used because settings values round-trip
   * through the string KV table; `torrentio.ts` treats unknown values as ''.
   */
  debridService: string
  /**
   * The debrid account's API key. The app never calls the debrid API itself —
   * the key goes into Torrentio's config URL and Torrentio returns direct
   * HTTPS links for cached releases. The key therefore appears inside those
   * resolve URLs handed to the player; that is the same trust boundary as the
   * other keys here (main process + the settings screen), not a new one.
   */
  debridApiKey: string
  /**
   * Base directory for the disposable torrent stream cache; '' means the
   * default, `userData`. The engine always caches under
   * `<base>/torrent-cache` rather than in the picked folder itself, because
   * the startup sweep deletes the cache root recursively — suffixing is what
   * guarantees it can never delete a folder the user owns.
   */
  torrentCachePath: string
  /**
   * Play the title's trailer muted inside the detail hero. 1 on, 0 off — a
   * number for the string/number coercion rule. Off also stops the YouTube
   * embed from ever mounting, which is the perf escape hatch.
   */
  trailerAutoplay: number
  /**
   * Hide episode stills and overviews until that episode has been watched.
   * 1 on, 0 off. For browsing the guide mid-season without being told what
   * happens next; watched episodes always show normally.
   */
  spoilerFreeMode: number
}

export type SecureDnsMode = 'secure' | 'automatic' | 'off'

/* ----------------------------------------------------------------- updates */

/**
 * Where the in-app updater is in its life. `disabled` means no GitHub token is
 * saved — the feed is a private repo, so without one there is nothing to ask.
 */
export type UpdateState =
  | { kind: 'disabled' }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'none'; checkedAt: number }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

export interface UpdateStatus {
  appVersion: string
  state: UpdateState
}

/** The background image as the renderer needs it: what to draw, and what to name. */
export interface BackgroundState {
  /** The file the user picked, for display. May no longer exist. */
  path: string
  /** `tdimg://` URL of this app's copy, or null when there is none. */
  url: string | null
}

/** A streaming service the sidebar can filter by. */
export interface WatchProvider {
  /** TMDB provider id, passed as `with_watch_providers`. */
  id: number
  name: string
  /** Short label for the sidebar. */
  short: string
  /** `tdimg://` URL for the service's logo, cached like any other TMDB image. */
  logoUrl?: string
}

export interface SyncStatus {
  running: boolean
  lastSyncAt: number
  lastError?: string
  /** Rolling count so the UI can show real usage rather than a guess. */
  tmdbRequestsToday: number
}

/* ---------------------------------------------------------------- live tv */

/**
 * `m3u` fetches and parses the URL as a playlist; `xtream` treats it as an
 * Xtream Codes server base and pulls channels from its player_api instead.
 */
export type IptvPlaylistKind = 'm3u' | 'xtream'

/**
 * A channel subscription. The iptv-org catalogue ships as a built-in row
 * (seeded like the built-in sources); everything else is user-added — either
 * a plain M3U URL or an Xtream Codes login.
 */
export interface IptvPlaylist {
  /** 'iptv-org' for the built-in, a UUID for custom playlists. */
  id: string
  name: string
  /** M3U playlist URL, or the Xtream server base for `kind: 'xtream'`. */
  url: string
  kind: IptvPlaylistKind
  /** Xtream account name, for display. The password never leaves main. */
  username?: string
  builtIn: boolean
  enabled: boolean
  /** Epoch ms of the last successful refresh; 0 = never. */
  lastRefreshed: number
  channelCount: number
  lastError?: string
}

/**
 * One channel out of a playlist. Channels are a cache of the playlist body —
 * a refresh wholesale-replaces them, so `id` is only stable until then.
 * `favorite` survives refreshes: it's keyed on tvg-id/url, not on `id`.
 */
export interface IptvChannel {
  id: number
  playlistId: string
  name: string
  url: string
  /** `tdimg://remote/...` URL built main-side; undefined when the playlist has no logo. */
  logoUrl?: string
  group?: string
  tvgId?: string
  language?: string
  country?: string
  headers?: Record<string, string>
  favorite?: boolean
}

export interface IptvChannelQuery {
  search?: string
  group?: string
  playlistId?: string
  favoritesOnly?: boolean
  offset: number
  limit: number
}

/** A movie from an Xtream account's VOD catalogue. */
export interface IptvMovie {
  /** Row id — stable only until the playlist refreshes. */
  id: number
  playlistId: string
  /** The provider's stream id — stable across refreshes; keys VOD resume. */
  streamId: string
  name: string
  posterUrl?: string
  group?: string
  rating?: number
}

/** A series from an Xtream account, before its episodes are fetched. */
export interface IptvSeries {
  id: number
  playlistId: string
  /** The provider's series id — stable across refreshes; keys episode resume. */
  seriesId: string
  name: string
  posterUrl?: string
  group?: string
  rating?: number
}

export interface IptvMoviePage {
  movies: IptvMovie[]
  total: number
}

export interface IptvSeriesPage {
  series: IptvSeries[]
  total: number
}

export interface IptvEpisode {
  /** The provider's episode id, used to build the stream URL. */
  id: string
  title: string
  season: number
  episode: number
  containerExt: string
  durationSeconds?: number
  plot?: string
  stillUrl?: string
}

export interface IptvSeason {
  season: number
  episodes: IptvEpisode[]
}

/** Which of the three Xtream catalogues a groups/list call is about. */
export type IptvSection = 'live' | 'movie' | 'series'

export interface IptvChannelPage {
  channels: IptvChannel[]
  total: number
}

export interface IptvGroup {
  /** Empty string for channels with no group-title. */
  name: string
  count: number
}

export interface IptvRefreshResult {
  playlistId: string
  channelCount: number
  error?: string
}

/* --------------------------------------------------------------- IPC types */

/** Uniform result wrapper so the renderer never sees a thrown main-process error. */
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

export interface Genre {
  id: number
  name: string
}

/**
 * A TMDB keyword — the closest thing it has to "what this is about".
 *
 * Structurally identical to `Genre` and deliberately its own type: genres are a
 * closed list of ~20 per media type, keywords are an open crowd-maintained
 * vocabulary of tens of thousands, and the two are filtered by different
 * discover parameters. A `Keyword[]` typed as `Genre[]` on the preload surface
 * reads as a bug six months out.
 */
export interface Keyword {
  id: number
  name: string
}

/**
 * A committed theme query, read as widely as the app honestly can.
 *
 * `keywords` is what the user's words matched and is what the heading quotes
 * back; `keywordIds` is larger, because a query reading as a content facet also
 * pulls in that facet's curated tag vocabulary — which is the only thing that
 * connects "gay" to "homosexuality", since no amount of substring matching does.
 * Naming both separately is what keeps the heading honest about the difference.
 */
export interface ThemeExpansion {
  keywords: Keyword[]
  keywordIds: number[]
  facets: ContentFacet[]
}

/** Filters behind the Browse grid. */
export interface BrowseQuery {
  type: MediaType
  /**
   * TMDB genre ids to require — ALL of them (comma-joined, TMDB's AND).
   * Deliberately the opposite join from `keywordIds` below: "Drama + Crime"
   * means the intersection, where a theme's keywords mean any-of. Empty or
   * absent means no genre filter — genres degrade to showing more, unlike
   * keywords.
   */
  genreIds?: number[]
  /** ISO-639-1 original language, e.g. `tr`. */
  language?: string
  /** TMDB watch-provider id, scoped by the `watchRegion` setting. */
  watchProvider?: number
  sortBy?: string
  page?: number
  /**
   * TMDB keyword ids to require, OR-ed together — the theme half of search.
   *
   * A field of its own rather than an entry in `BrowseParams.extra`, for two
   * independent reasons: `extra` is merged last in `discoverBy` and would
   * clobber the facet rules' own `with_keywords`, and `catalogRow` replaces
   * `extra` wholesale — so a `?row=` page, which every catalogue page is, would
   * silently lose it.
   */
  keywordIds?: number[]
  /** Hide or isolate titles tagged for nudity / sexual content. */
  contentFilter?: ContentFilter
  /**
   * Per-facet rules, which win over `contentFilter` where they overlap.
   *
   * Normally the saved settings default, but Browse can override per query.
   */
  facetRules?: FacetRules
  /**
   * Which catalogue view to draw from — trending, top rated and so on.
   *
   * Omitted for a plain filtered query. When set it supplies the sort and any
   * date window, which is why the catalogue page has view chips instead of a
   * sort dropdown: the view *is* the sort.
   */
  row?: CatalogRowKey
}

/**
 * A page of browse results plus whether TMDB itself had more.
 *
 * The distinction is load-bearing: local facet filtering can empty a page that
 * TMDB filled, and without this the infinite scroll would read that as the end
 * of the catalogue and stop.
 */
export interface BrowsePage {
  items: Show[]
  /** TMDB has further pages, whatever survived filtering on this one. */
  hasMore: boolean
}

/**
 * What else to watch, for the detail page's tabs.
 *
 * `collection` is films only, and that is TMDB's limit rather than a shortcut:
 * `belongs_to_collection` has no series equivalent, so there is no sequel,
 * prequel or spin-off relation to draw on for a show. Nothing here is inferred
 * from titles or keywords — an absent franchise means TMDB doesn't model one,
 * which is a different claim from "this title has no sequel".
 */
export interface RelatedTitles {
  recommendations: Show[]
  /** Every film of the franchise except the one being viewed, oldest first. */
  collection?: { id: number; name: string; parts: Show[] }
}

/**
 * One billed performer, for the detail page's Cast tab.
 *
 * `id` is a TMDB **person** id, a separate id space from titles — never pass one
 * to anything expecting a `tmdbId`. Its own type rather than a reuse of
 * `Keyword`'s `{ id, name }` for the reason that type's own comment gives: the
 * shapes coincide today and mean unrelated things.
 */
export interface CastMember {
  id: number
  name: string
  /** As credited. A series merges the roles played across every season. */
  character?: string
  profileUrl?: string
  /** Episodes appeared in. Series only — a film has no equivalent. */
  episodeCount?: number
}

/**
 * One person and what they have acted in.
 *
 * Acting credits only. We arrive here from a *cast* list, and folding in crew
 * would double-list everyone who does both and turn a filmography into a
 * résumé — if "who directed this" is wanted later it belongs on the Cast tab as
 * a line of text, not as more tiles here.
 */
export interface PersonCredits {
  id: number
  name: string
  profileUrl?: string
  /** TMDB's department enum ('Acting', 'Directing') — English at any language. */
  knownFor?: string
  /** Most popular first, deduped and capped. */
  credits: Show[]
}

/** Keys of the discover-backed rows. Mirrors DISCOVER_LISTS in tmdb.ts. */
export type DiscoverListKey =
  | 'trending-tv'
  | 'trending-movie'
  | 'new-tv'
  | 'new-movie'
  | 'top-tv'
  | 'top-movie'

export interface HomeFeed {
  continueWatching: ContinueWatchingItem[]
  /** Aired episodes of shows the user follows. */
  newEpisodes: FeedEpisode[]
  /** Most recent episode of every show in the library, followed or not. */
  latestEpisodes: FeedEpisode[]
  /**
   * The discover rows, keyed by list.
   *
   * A map rather than one field per row: Home renders whatever keys are present,
   * so adding a list is a change to DISCOVER_LISTS alone and not to three files.
   */
  lists: Partial<Record<DiscoverListKey, Show[]>>
}
