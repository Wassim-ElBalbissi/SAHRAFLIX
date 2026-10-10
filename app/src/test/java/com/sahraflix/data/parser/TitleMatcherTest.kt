package com.sahraflix.data.parser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TitleMatcherTest {
    @Test fun matchesDecoratedIptvNames() {
        assertTrue(TitleMatcher.score("The Matrix", 1999, "EN - The Matrix (1999) [4K]") >= 80)
        assertTrue(TitleMatcher.score("The Matrix", 1999, "|FR| Matrix 1999 FHD") >= 80)
        assertTrue(TitleMatcher.score("Amélie", 2001, "Amelie 2001 HD") >= 80)
        assertTrue(TitleMatcher.score("Fast & Furious", null, "Fast and Furious") >= 80)
    }

    @Test fun rejectsSequelsWrongYearsAndSubstrings() {
        assertTrue(TitleMatcher.score("The Matrix", 1999, "The Matrix Reloaded (2003)") < 80)
        assertTrue(TitleMatcher.score("Dune", 2021, "Dune (1984)") < 80)
        assertTrue(TitleMatcher.score("The Matrix", 1999, "The Matrix Reloaded (1999)") < 80)
        assertEquals(0, TitleMatcher.score("Up", 2009, "Upgrade (2018)"))
    }

    @Test fun searchFragmentIsLongestWord() = assertEquals("rings", TitleMatcher.searchFragment("The Lord of the Rings"))

    @Test fun preservesArabicAndTurkishTitles() {
        assertTrue(TitleMatcher.score("قيامة عثمان", 2019, "AR - قِيَامَة عُثْمَان (2019) HD") >= 80)
        assertTrue(TitleMatcher.score("Kuruluş Osman", 2019, "TR - Kurulus Osman (2019) FHD") >= 80)
        assertEquals("قيامة", TitleMatcher.searchFragment("قيامة عثمان"))
        assertEquals(0, TitleMatcher.score("قيامة عثمان", null, "قيامة أرطغرل"))
    }

    @Test fun preservesNumericTitles() {
        assertTrue(TitleMatcher.score("1917", 2019, "1917 (2019) HD") >= 80)
        assertTrue(TitleMatcher.score("1899", null, "1899 HD") >= 80)
        assertEquals(null, TitleMatcher.parse("1917").year)
        assertTrue(TitleMatcher.score("2001: A Space Odyssey", 1968, "2001: A Space Odyssey HD") >= 80)
        assertTrue(TitleMatcher.score("1917", 2019, "1917 (2020)") < 80)
    }
}
