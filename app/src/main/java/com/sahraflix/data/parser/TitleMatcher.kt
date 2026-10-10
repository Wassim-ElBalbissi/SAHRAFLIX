package com.sahraflix.data.parser

import java.text.Normalizer
import java.util.Locale

/**
 * Matches TMDB titles against IPTV VOD names, which are typically decorated:
 * "EN - The Matrix (1999) [4K]", "|FR| Matrix 1999 FHD", "4K-The.Matrix.1999".
 */
object TitleMatcher {
    private val PREFIX = Regex("""^\s*(\|[^|]{1,6}\||\[[^]]{1,6}]|[A-Z]{2,3}\s*[-:|]|4K\s*[-:|]|VOD\s*[-:|])\s*""", RegexOption.IGNORE_CASE)
    private val YEAR = Regex("""\b(19[0-9]{2}|20[0-9]{2})\b""")
    private val NOISE = Regex(
        """\b(4k|uhd|fhd|hd|sd|hevc|h265|x265|x264|1080p|720p|2160p|multi|sub|subs|vostfr|dual|audio|web[- ]?dl|bluray|hdr|dv|imax|extended|remastered)\b""",
        RegexOption.IGNORE_CASE
    )

    data class Parsed(val key: String, val year: Int?)

    fun parse(raw: String): Parsed {
        var s = raw
        repeat(2) { s = PREFIX.replace(s, "") }
        val decorated = s
        // Only strip the final year when a title remains (1917 and 1899 are titles too).
        fun clean(raw: String) = normalize(NOISE.replace(raw.replace(Regex("""[\[(][^\])]*[\])]"""), " "), " "))
        val yearMatch = YEAR.findAll(s).lastOrNull()?.takeIf { clean(s.substring(it.range.last + 1)).isEmpty() }
        val withoutYear = clean(yearMatch?.let { s.removeRange(it.range) } ?: s)
        val title = withoutYear.ifBlank { clean(decorated) }
        val year = yearMatch?.value?.toIntOrNull()?.takeIf { withoutYear.isNotEmpty() }
        return Parsed(title, year)
    }

    fun normalize(value: String): String {
        // Adapted from Marquee's Unicode-aware matching: retain every script, fold accents.
        val folded = Normalizer.normalize(value, Normalizer.Form.NFKD).replace(Regex("\\p{Mn}+"), "")
        return folded.lowercase(Locale.ROOT)
            .replace("&", " and ")
            .replace(Regex("""^(the|a|an)\s+"""), "")
            .replace(Regex("[^\\p{L}\\p{N}]+"), " ")
            .trim()
            .replace(Regex("""^(the|a|an)\s+"""), "")
    }

    /** Score 0..100; ≥ 80 is considered the same title. */
    fun score(tmdbTitle: String, tmdbYear: Int?, candidate: String): Int {
        val want = normalize(tmdbTitle)
        val got = parse(candidate)
        if (want.isEmpty() || got.key.isEmpty()) return 0
        var score = when {
            got.key == want -> 90
            else -> return 0
        }
        if (tmdbYear != null && got.year != null) score += if (tmdbYear == got.year) 10 else -40
        return score.coerceIn(0, 100)
    }

    /** A short fragment for the SQL LIKE pre-filter. */
    fun searchFragment(title: String): String =
        normalize(title).split(' ').maxByOrNull { it.length }?.takeIf { it.length >= 3 } ?: normalize(title)
}
