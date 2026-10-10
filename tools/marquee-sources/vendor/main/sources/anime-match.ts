import { normalizeForMatch, titleSimilarity } from './parse'

/**
 * Picking the right entry on an anime site.
 *
 * `bestMatch` in `match.ts` is tuned for the Arabic sites and is wrong here, for
 * a reason that shows up on the very first title anyone tries. Anime catalogues
 * are full of "Title + something" entries, and token overlap alone can still
 * leave several specials close to the parent series:
 *
 *   shared tokens  One Piece: Episode of Luffy — Hand Island Adventure  <=>  One Piece
 *   shared tokens  One Piece: Barto's Secret Room                       <=>  One Piece
 *   exact          One Piece                                            <=>  One Piece
 *   shared tokens  Attack on Titan: Final Season, Part 2                <=>  Attack on Titan
 *
 * Anikoto's own relevance ranking puts "One Piece: Episode of Luffy" — a
 * 25-minute special — above the real series. The stricter threshold, token
 * length penalty and format filter keep that relevance order from winning.
 *
 * The length penalty and format filter belong here because anime listings
 * commonly mix films, specials and sequels with series under one name.
 */

/**
 * Reanime's fuzzy search answers "Game of Thrones" with unrelated anime rather
 * than nothing, so its scored, format-aware matcher has its own threshold.
 */
export const ANIME_MATCH_THRESHOLD = 0.75

/** How much each token of length difference costs, among the 0.9 crowd. */
const LENGTH_PENALTY = 0.05

export interface AnimeCandidate {
  /** Whatever the caller needs back — an id, a slug, a URL. */
  key: string
  /** Every name the site offers for this entry: English, romaji, native, slug. */
  titles: string[]
  /** The site's own format label, when it has one: TV / Movie / Special / ONA. */
  format?: string
}

export interface AnimeScored<T> {
  candidate: T
  score: number
}

function tokenCount(text: string): number {
  const normalized = normalizeForMatch(text)
  return normalized ? normalized.split(' ').length : 0
}

/**
 * Whether the site's format label can be the thing TMDB is asking about.
 *
 * An absent label means the site didn't say, and guessing would throw away real
 * matches — so unknown passes. What this catches is the commonest anime
 * cross-type collision there is: "Jujutsu Kaisen 0" is a film and "Jujutsu
 * Kaisen" is a series, and each scores ~0.9 against the other's name.
 */
export function formatMatches(format: string | undefined, wantMovie: boolean): boolean {
  if (!format) return true
  const value = format.trim().toLowerCase()
  if (!value) return true
  if (wantMovie) return value === 'movie'
  return value !== 'movie' && value !== 'special' && value !== 'music'
}

/**
 * Best score for one candidate, across every name it has and every alias.
 *
 * The length penalty is what separates the 0.9 ties: comparing "One Piece"
 * against "One Piece: Episode of Luffy — Hand Island Adventure" is a seven-token
 * gap and loses to the bare "One Piece", which is exact and scores 1.0 outright.
 */
export function scoreAnimeCandidate(candidate: AnimeCandidate, aliases: string[]): number {
  let best = 0

  for (const title of candidate.titles) {
    if (!title || !title.trim()) continue
    const titleTokens = tokenCount(title)

    for (const alias of aliases) {
      if (!alias || !alias.trim()) continue
      const raw = titleSimilarity(title, alias)
      if (raw === 0) continue
      const penalty = LENGTH_PENALTY * Math.abs(titleTokens - tokenCount(alias))
      const score = Math.max(0, raw - penalty)
      if (score > best) best = score
    }
  }

  return best
}

/**
 * The entry to use, or null when nothing is convincing enough.
 *
 * Returning null rather than a best guess is deliberate and matches the rest of
 * the app: a wrong entry plays somebody else's show, which is worse than a
 * source that simply reports nothing and lets the next connector answer.
 */
export function pickAnimeEntry<T extends AnimeCandidate>(
  candidates: T[],
  aliases: string[],
  opts: { wantMovie: boolean; threshold?: number }
): AnimeScored<T> | null {
  const threshold = opts.threshold ?? ANIME_MATCH_THRESHOLD
  let best: AnimeScored<T> | null = null

  for (const candidate of candidates) {
    if (!formatMatches(candidate.format, opts.wantMovie)) continue
    const score = scoreAnimeCandidate(candidate, aliases)
    if (!best || score > best.score) best = { candidate, score }
  }

  return best && best.score >= threshold ? best : null
}

/**
 * A slug turned back into something scoreable.
 *
 * `match.ts`'s `slugText` takes the *last* path segment, which on anikoto is
 * `ep-1` rather than the title — so these connectors need their own. The
 * trailing-id strip is for anikoto's `…-season-2-cp7ym` shape, where the short
 * id would otherwise dilute every score it appears in.
 */
export function animeSlugTitle(slug: string, dropTrailingId = false): string {
  let text = slug.replace(/\/+$/, '')
  if (dropTrailingId) text = text.replace(/-[a-z0-9]{4,7}$/i, '')
  return text.replace(/-/g, ' ').trim()
}

/**
 * The extra names a site files a later season under.
 *
 * Anime seasons are separate catalogue entries far more often than they are
 * extra seasons of one, and the sites disagree about how to spell that:
 * anikoto has both "Attack on Titan Season 2" and "Sousou no Frieren 2nd
 * Season", and "Attack on Titan: Final Season, Part 2" besides. TMDB's
 * alternative titles carry none of these, so without them a season-2 lookup
 * matches the season-1 entry and plays the wrong episode.
 */
export function seasonAliases(aliases: string[], season: number, limit = 3): string[] {
  if (season <= 1) return aliases

  const suffixes = [`Season ${season}`, `${ordinal(season)} Season`, `Part ${season}`]
  const expanded: string[] = []
  for (const alias of aliases.slice(0, limit)) {
    for (const suffix of suffixes) expanded.push(`${alias} ${suffix}`)
  }

  // Season-suffixed names first, then the bare ones: a site that files seasons
  // separately needs the suffix, and one that doesn't still matches the base.
  return [...expanded, ...aliases]
}

function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}
