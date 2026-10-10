import { getAlternativeTitles } from '../metadata/tmdb'
import { normalizeForMatch } from './parse'
import type { StreamQuery } from '@shared/types'

/**
 * The set of names a show might be listed under on a scraper site.
 *
 * The Arabic sites this app scrapes file a series under the name it aired with
 * in Arabic, which is regularly not TMDB's Arabic title: TMDB calls 322499
 * "احتمال حب!" while the sites call it "حب محتمل", and Kuruluş Osman is filed
 * as "قيامة عثمان" rather than "المؤسس عثمان". Searching only `title` /
 * `originalTitle` therefore misses most of the catalogue — and the Turkish
 * original is useless on an Arabic site, which returns nothing for "Esaret".
 *
 * TMDB's `alternative_titles` happens to carry exactly the names these sites
 * use, so it is the bridge between the two naming worlds.
 */

/** Aliases are a property of the title, not of the moment — cache them a day. */
const CACHE_TTL_MS = 24 * 60 * 60_000
const cache = new Map<number, { at: number; aliases: string[] }>()

const hasArabic = (text: string): boolean => /[؀-ۿ]/.test(text)
const hasLatin = (text: string): boolean => /[A-Za-z]/.test(text)

export interface AliasOptions {
  /**
   * Which script the target site actually indexes.
   *
   * Defaults to `arabic`, which is the existing behaviour and what the four
   * Arabic scrapers want. The anime sites are the opposite case and it is not a
   * preference but a hard requirement — measured against anikoto and reanime,
   * searching either one for "فريرن" or "葬送のフリーレン" returns nothing usable
   * while "Sousou no Frieren" returns the show. Worse, for an anime TMDB hands
   * us an Arabic `title` and a Japanese `originalTitle`, so *both* free names
   * are dead and a title with several Arabic alternates would otherwise fill
   * every search slot with terms that cannot succeed.
   */
  prefer?: 'arabic' | 'latin'
}

/**
 * Expands a single TMDB entry into every name it actually contains.
 *
 * TMDB contributors routinely pack a second name into parentheses — SA lists
 * Kuruluş Osman as "المؤسس عثمان (قيامة عثمان)" — and it is the parenthetical
 * that the sites use, so both halves have to become searchable in their own
 * right.
 *
 * The other packing is a dash-joined list with the dub/sub markers riding
 * along — Yargı's SA entry is "القضاء - مدبلج - مترجم" — which scores 0.5
 * against the "القضاء" every site actually files it under. Each dash part
 * becomes a name of its own and a part that is only a marker is dropped; the
 * whole string stays first, so a title that legitimately contains a dash
 * loses nothing.
 */
function expand(title: string): string[] {
  const trimmed = title.trim()
  if (!trimmed) return []

  const out = [trimmed]
  const paren = trimmed.match(/^(.*?)\s*[([]([^)\]]+)[)\]]\s*$/)
  if (paren) {
    out.push(paren[1].trim(), paren[2].trim())
  }
  const parts = trimmed.split(/\s+[-–|]\s+/)
  if (parts.length > 1) {
    out.push(...parts.map((p) => p.trim()).filter((p) => p && !MARKER_ONLY.test(p)))
  }
  return out.filter(Boolean)
}

/** A fragment that says how a title is presented rather than what it is. */
const MARKER_ONLY = /^(?:مدبلجة?|مترجمة?|MULTI|HD)$/i

/** Dedupes on the normalised form so spelling variants don't cost a request. */
function dedupe(titles: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const title of titles) {
    const key = normalizeForMatch(title)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(title)
  }
  return out
}

/**
 * Every name worth searching for this title, best first.
 *
 * Never throws: a missing or rate-limited TMDB key must degrade to the titles
 * we already have rather than taking the whole connector down with it.
 */
export async function getSearchAliases(
  query: StreamQuery,
  opts: AliasOptions = {}
): Promise<string[]> {
  const base = [query.title, query.originalTitle].filter(
    (t): t is string => Boolean(t && t.trim())
  )

  let alternates = cache.get(query.tmdbId)?.aliases
  if (!alternates || Date.now() - (cache.get(query.tmdbId)?.at ?? 0) >= CACHE_TTL_MS) {
    try {
      const raw = await getAlternativeTitles(
        query.tmdbId,
        query.type === 'movie' ? 'movie' : 'series'
      )
      alternates = raw.flatMap(expand)
    } catch {
      // No key, offline, or a 404 on an unknown id — the base titles still work.
      alternates = []
    }
    // Cached unordered, because the ordering depends on which site is asking.
    cache.set(query.tmdbId, { at: Date.now(), aliases: alternates })
  }

  if (opts.prefer === 'latin') {
    // Everything with Latin letters first, base titles included — unlike the
    // Arabic case there is no name we already hold that is worth trying first.
    const all = dedupe([...base, ...alternates])
    return [...all.filter(hasLatin), ...all.filter((t) => !hasLatin(t))]
  }

  // Arabic aliases first: every site this feeds is an Arabic one, and trying a
  // Latin-script name there costs a request that cannot succeed. The base
  // titles stay ahead of them — 3isk indexes by the *Turkish* name, so
  // demoting `originalTitle` below the Arabic alternates would break it.
  return dedupe([...base, ...alternates.filter(hasArabic), ...alternates.filter((t) => !hasArabic(t))])
}
