/**
 * Unicode property escapes, for a V8 that does not have them.
 *
 * Built with `new RegExp` from strings rather than written as literals, so a V8
 * without ICU (where a property-escape literal is a parse-time `SyntaxError`
 * that takes the whole module with it) gets an explicit range fallback instead
 * of a crash. Electron always takes the first branch.
 *
 * ## Why the fallback is not `[^a-z0-9]`
 *
 * Because of what these are for. `normalizeForMatch` in `sources/parse.ts` is
 * the function every Turkish connector matches titles with, and the token split
 * in `metadata/tmdb.ts` is how a thematic search is broken up. A Latin-only
 * class does not report an error on `الحلقة 45` or `Kuruluş Osman` — it quietly
 * reduces them to nothing and to `kurulu osman`, and the symptom is a connector
 * that finds the wrong episode. So the fallback enumerates the scripts this app
 * is actually used in, and errs towards keeping a character rather than
 * dropping it: keeping one too many costs a slightly worse match, dropping one
 * costs the wrong video.
 */

/**
 * The scripts a title in this library can be written in, as explicit ranges.
 *
 * Latin and its extensions (Turkish, Vietnamese, everything accented), Greek,
 * Cyrillic, Armenian, Hebrew, Arabic and its supplements and presentation
 * forms, Devanagari, Thai, Georgian, kana, CJK, and Hangul. Digits are included
 * per script — Arabic-Indic numerals live inside the Arabic block already.
 */
const LETTER_OR_DIGIT_RANGES =
  '0-9A-Za-z' +
  '\\u00C0-\\u024F' + // Latin-1 Supplement letters, Latin Extended-A and -B
  '\\u0370-\\u03FF' + // Greek
  '\\u0400-\\u052F' + // Cyrillic and its supplement
  '\\u0530-\\u058F' + // Armenian
  '\\u0590-\\u05FF' + // Hebrew
  '\\u0600-\\u06FF' + // Arabic
  '\\u0750-\\u077F' + // Arabic Supplement
  '\\u08A0-\\u08FF' + // Arabic Extended-A
  '\\u0900-\\u097F' + // Devanagari
  '\\u0E00-\\u0E7F' + // Thai
  '\\u10A0-\\u10FF' + // Georgian
  '\\u1E00-\\u1EFF' + // Latin Extended Additional
  '\\u2C60-\\u2C7F' + // Latin Extended-C
  '\\u3040-\\u30FF' + // Hiragana and Katakana
  '\\u3400-\\u4DBF' + // CJK Unified Ideographs Extension A
  '\\u4E00-\\u9FFF' + // CJK Unified Ideographs
  '\\uAC00-\\uD7AF' + // Hangul syllables
  '\\uFB50-\\uFDFF' + // Arabic Presentation Forms-A
  '\\uFE70-\\uFEFF' + // Arabic Presentation Forms-B
  '\\uFF00-\\uFFEF' // Halfwidth and fullwidth forms

/**
 * Compiles `preferred`, falling back to `fallback` on a platform that rejects
 * it. The `u` flag goes with the preferred form: the fallback is plain BMP
 * ranges and does not need it.
 */
function compile(preferred: string, fallback: string, flags: string): RegExp {
  try {
    return new RegExp(preferred, flags + 'u')
  } catch {
    return new RegExp(fallback, flags)
  }
}

/** Runs of anything that is not a letter or a digit — a token separator. */
export const NOT_ALPHANUMERIC_RUN = compile(
  '[^\\p{L}\\p{N}]+',
  `[^${LETTER_OR_DIGIT_RANGES}]+`,
  ''
)

/** Every character that is neither a letter, a digit, nor whitespace. */
export const NOT_ALPHANUMERIC_OR_SPACE = compile(
  '[^\\p{L}\\p{N}\\s]',
  `[^${LETTER_OR_DIGIT_RANGES}\\s]`,
  'g'
)

/**
 * Whether `String.prototype.normalize` does anything on this platform.
 *
 * Another casualty of a missing ICU, and a completely silent one: without it
 * `normalize('NFD')` returns its input unchanged rather than throwing.
 */
export const HAS_UNICODE_NORMALIZE = '\u00e9'.normalize('NFD').length === 2

/**
 * The accent fold, as an explicit table, for when NFD is a no-op.
 *
 * `normalizeForMatch` folds accents by decomposing and dropping the combining
 * marks, which is how `Kurulu\u015f Osman` and a scraped `Kurulus Osman` come out
 * as the same string. With NFD doing nothing that fold silently stops
 * happening, and the failure is not an error — it is a connector matching the
 * wrong title, which is the most expensive kind of bug this codebase has.
 *
 * **Generated from ICU rather than typed out**, and that is why it can be
 * trusted: every code point from U+00C0 to U+024F whose NFD form is a single
 * ASCII letter, and no others. So it folds exactly what the desktop folds —
 * not the Latin letters that have no decomposition at all (\u00f8, \u0111, \u0142, \u00e6, \u00df),
 * which the desktop leaves alone too.
 */
const FOLD_FROM =
  'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĨĩĪīĬĭĮįİĴĵĶķĹĺĻļĽľŃńŅņŇňŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžƠơƯưǍǎǏǐǑǒǓǔǕǖǗǘǙǚǛǜǞǟǠǡǦǧǨǩǪǫǬǭǰǴǵǸǹǺǻȀȁȂȃȄȅȆȇȈȉȊȋȌȍȎȏȐȑȒȓȔȕȖȗȘșȚțȞȟȦȧȨȩȪȫȬȭȮȯȰȱȲȳ'
const FOLD_TO =
  'AAAAAACEEEEIIIINOOOOOUUUUYaaaaaaceeeeiiiinooooouuuuyyAaAaAaCcCcCcCcDdEeEeEeEeEeGgGgGgGgHhIiIiIiIiIJjKkLlLlLlNnNnNnOoOoOoRrRrRrSsSsSsSsTtTtUuUuUuUuUuUuWwYyYZzZzZzOoUuAaIiOoUuUuUuUuUuAaAaGgKkOoOojGgNnAaAaAaEeEeIiIiOoOoRrRrUuUuSsTtHhAaEeOoOoOoOoYy'

const FOLD_PATTERN = new RegExp(`[${FOLD_FROM}]`, 'g')

/** Accent-folded, by whichever route this platform supports. */
export function foldDiacritics(input: string): string {
  if (HAS_UNICODE_NORMALIZE) {
    return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  }
  return input.replace(FOLD_PATTERN, (ch) => FOLD_TO[FOLD_FROM.indexOf(ch)] ?? ch)
}
