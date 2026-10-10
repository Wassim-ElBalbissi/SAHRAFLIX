import type { ConnectorKind, Stream, StreamQuery, Subtitle } from '@shared/types'

/**
 * The contract every source implements.
 *
 * Connectors run in the main process, so they may use the network and (for the
 * local ones) the filesystem. The renderer only ever sees the resulting
 * `Stream[]`.
 */
export type SourceScope = 'turkish' | 'anime' | 'general'

/**
 * What a *miss* costs when this connector runs.
 *
 * `expensive` means seconds of wall clock the whole resolve waits on — in
 * practice a hidden Chromium window, or a full sitemap scan. Only expensive
 * connectors are ever demoted to the second tier: gating a sub-second one buys
 * nothing measurable and only adds a way to be wrong.
 */
export type SourceCost = 'cheap' | 'expensive'

export interface SourceConnector {
  readonly id: string
  readonly name: string
  readonly kind: ConnectorKind

  /**
   * What this source's catalogue actually covers.
   *
   * **Absent means "unknown, therefore universal"** — a connector with no
   * declared scope is in the first tier for every kind of title, always. That
   * default is what makes user-added Stremio addons and plugins safe: nothing
   * the user installs can be demoted by a guess the app made about a title.
   * See `tiers.ts`.
   */
  readonly scope?: readonly SourceScope[]

  /**
   * Finds an episode by searching the show's *title* and reading the site's
   * own episode number, rather than by TMDB/IMDb id. For an episode that has
   * not aired yet such a connector can only ever match a different episode,
   * so `resolveStreams` skips it then. Absent means id-keyed.
   */
  readonly titleMatched?: boolean

  /** Defaults to `cheap`, so forgetting to declare it fails safe. */
  readonly cost?: SourceCost

  /** Resolve playable streams for a movie or a specific episode. */
  getStreams(query: StreamQuery): Promise<Stream[]>

  /** Optional extra subtitle tracks beyond those attached to a stream. */
  getSubtitles?(query: StreamQuery): Promise<Subtitle[]>

  /** Optional connectivity/config check surfaced in Settings. */
  test?(): Promise<{ ok: boolean; message?: string }>
}

/** Ranks used when merging results, so official sources sort first. */
export const RANK = {
  official: 100,
  local: 80,
  addon: 50,
  plugin: 40,
  unknown: 0
} as const
