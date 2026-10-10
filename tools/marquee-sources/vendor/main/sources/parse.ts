/**
 * Title parsing and matching, shared by every source.
 *
 * Two jobs: pull season/episode numbers out of a free-form title (local file
 * names, scraped episode labels), and score how well two titles refer to the
 * same show. Turkish and Arabic sources each label episodes their own way:
 *
 *   Turkish  "Kuruluş Osman 45. Bölüm"            -> S?E45
 *            "2. Sezon 12. Bölüm"                 -> S2E12
 *   Arabic   "مسلسل قيامة عثمان الحلقة 45 مترجمة"  -> S?E45
 *            "الموسم 2 الحلقة 12"                  -> S2E12
 *   English  "Episode 45" / "S02E12"              -> S?E45 / S2E12
 */

import { NOT_ALPHANUMERIC_OR_SPACE, foldDiacritics } from '../unicode'

export interface ParsedTitle {
  seasonNumber?: number
  episodeNumber?: number
  /** True when the video is a trailer/recap rather than a full episode. */
  isExtra: boolean
  /** True when the title advertises Arabic subtitles. */
  hasArabicSubs: boolean
  /** Title with episode markers stripped, useful for matching a show name. */
  cleanTitle: string
}

/**
 * Trailers, recaps and behind-the-scenes clips vastly outnumber full episodes
 * on most official channels. Without this filter the episode list fills with
 * 2-minute promos that look like real episodes.
 */
const EXTRA_MARKERS = [
  // Turkish
  'fragman', 'fragmanı', 'özet', 'ozet', 'tanıtım', 'tanitim', 'klip',
  'sahne', 'sahnesi', 'kamera arkası', 'müzik', 'muzik', 'jenerik',
  // Arabic
  'إعلان', 'اعلان', 'برومو', 'مقطع', 'ملخص', 'كواليس', 'أغنية', 'اغنية',
  // English
  'trailer', 'teaser', 'promo', 'recap', 'behind the scenes', 'bts',
  'preview', 'clip', 'soundtrack', 'opening'
]

const ARABIC_SUB_MARKERS = ['مترجم', 'مترجمة', 'ترجمة', 'arabic sub', 'مدبلج']

/** Converts Arabic-Indic digits (٠-٩ and ۰-۹) to ASCII. */
function normalizeDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (char) => {
    const code = char.charCodeAt(0)
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660
    return String(code - base)
  })
}

interface Pattern {
  regex: RegExp
  season?: number
  episode: number
}

/** Ordered most-specific first, so "S02E12" wins over a bare "12". */
const PATTERNS: Pattern[] = [
  // S02E12 / s2e12
  { regex: /\bs(\d{1,2})\s*[ex](\d{1,4})\b/i, season: 1, episode: 2 },
  // Turkish: "2. Sezon 12. Bölüm"
  { regex: /(\d{1,2})\s*\.?\s*sezon[^\d]{0,12}(\d{1,4})\s*\.?\s*bölüm/i, season: 1, episode: 2 },
  { regex: /(\d{1,2})\s*\.?\s*sezon[^\d]{0,12}(\d{1,4})\s*\.?\s*bolum/i, season: 1, episode: 2 },
  // Arabic: "الموسم 2 الحلقة 12"
  { regex: /الموسم\s*(\d{1,2})[^\d]{0,12}الحلقة\s*(\d{1,4})/, season: 1, episode: 2 },
  // English: "Season 2 Episode 12"
  { regex: /season\s*(\d{1,2})[^\d]{0,12}episode\s*(\d{1,4})/i, season: 1, episode: 2 },
  // Turkish episode only: "45. Bölüm"
  { regex: /(\d{1,4})\s*\.?\s*bölüm/i, episode: 1 },
  { regex: /(\d{1,4})\s*\.?\s*bolum/i, episode: 1 },
  // Arabic episode only: "الحلقة 45"
  { regex: /الحلقة\s*(\d{1,4})/, episode: 1 },
  // English episode only
  { regex: /\bepisode\s*(\d{1,4})\b/i, episode: 1 },
  { regex: /\bep\.?\s*(\d{1,4})\b/i, episode: 1 }
]

export function parseTitle(rawTitle: string): ParsedTitle {
  const title = normalizeDigits(rawTitle ?? '')
  const lower = title.toLowerCase()

  const isExtra = EXTRA_MARKERS.some((marker) => lower.includes(marker))
  const hasArabicSubs = ARABIC_SUB_MARKERS.some((marker) => lower.includes(marker))

  let seasonNumber: number | undefined
  let episodeNumber: number | undefined
  let matchedText = ''

  for (const pattern of PATTERNS) {
    const match = title.match(pattern.regex)
    if (!match) continue

    if (pattern.season !== undefined) {
      const value = Number(match[pattern.season])
      if (Number.isFinite(value)) seasonNumber = value
    }
    const value = Number(match[pattern.episode])
    if (Number.isFinite(value)) episodeNumber = value
    matchedText = match[0]
    break
  }

  const cleanTitle = matchedText
    ? title.replace(matchedText, ' ').replace(/\s+/g, ' ').trim()
    : title.trim()

  return { seasonNumber, episodeNumber, isExtra, hasArabicSubs, cleanTitle }
}

/**
 * Folds the Arabic letter forms that are written interchangeably in practice.
 *
 * The scraper sites and TMDB routinely spell the same title differently —
 * أ/إ/آ vs ا, ة vs ه, ى vs ي — and copy-pasted titles carry stray harakat and
 * tatweel. Without this folding, two spellings of the same show compare as
 * completely different strings.
 */
function normalizeArabic(input: string): string {
  return input
    .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ -> ا
    .replace(/ؤ/g, 'و') // ؤ -> و
    .replace(/ئ/g, 'ي') // ئ -> ي
    .replace(/ة/g, 'ه') // ة -> ه
    .replace(/ى/g, 'ي') // ى -> ي
    .replace(/[ً-ْـٰ]/g, '') // harakat, tatweel, dagger alif
}

/**
 * Normalises a title for fuzzy comparison against a TMDB name: lowercased,
 * accent-folded, punctuation removed. Turkish dotted/dotless i, the Arabic
 * definite article and the Arabic letter variants are the ones that actually
 * bite in practice.
 */
export function normalizeForMatch(input: string): string {
  // `foldDiacritics` rather than `.normalize('NFD')` inline — see
  // `src/main/unicode.ts`.
  return foldDiacritics(normalizeArabic(normalizeDigits(input)))
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'i')
    .replace(/^(the|al|el)\s+/i, '')
    // Whitespace anchors, not `\b`: JS word boundaries are ASCII-only, so `\b`
    // never sits beside an Arabic letter and `\bمسلسل\b` matched nothing. The
    // containment rule in `titleSimilarity` used to hide that (0.9 for "حب
    // محتمل" inside "مسلسل حب محتمل"); with exact matching it was fatal.
    .replace(/(?:^|\s)مسلسل(?=\s|$)/g, ' ')
    .replace(NOT_ALPHANUMERIC_OR_SPACE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Words too short to carry meaning on their own. Two-letter words are kept:
 * Arabic titles lean on them (حب "love", ظل "shadow"), and dropping them was
 * enough to make "احتمال حب" and "حب محتمل" score zero against each other.
 */
function significantWords(text: string): Set<string> {
  return new Set(text.split(' ').filter((w) => w.length > 1))
}

/** Sørensen–Dice over a token set — symmetric, unlike shared/max. */
function diceCoefficient(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return (2 * shared) / (left.size + right.size)
}

/** Rough similarity in 0..1, used to match a video to a show. */
export function titleSimilarity(a: string, b: string): number {
  const left = normalizeForMatch(a)
  const right = normalizeForMatch(b)
  if (!left || !right) return 0
  if (left === right) return 1
  // A space or punctuation difference should not split one title, but a title
  // merely containing another is not evidence they refer to the same show.
  if (left.replace(/\s/g, '') === right.replace(/\s/g, '')) return 0.98

  return diceCoefficient(significantWords(left), significantWords(right))
}
