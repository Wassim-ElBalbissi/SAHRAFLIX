package com.sahraflix.domain.model

sealed interface ContentDetails {
    val title: String
    val description: String?
    val posterUrl: String?
    val backdropUrl: String?

    /** An IPTV item; series carry their episode list (Xtream get_series_info). */
    data class Iptv(
        val entry: CatalogEntry.Iptv,
        override val description: String? = null,
        override val backdropUrl: String? = null,
        val seasons: Map<Int, List<IptvEpisode>> = emptyMap(),
        val rating: Double? = null,
        val releaseYear: Int? = null,
        val tmdbMatch: Tmdb? = null,
        val cast: String? = null,
        val director: String? = null
    ) : ContentDetails {
        override val title: String get() = entry.title
        override val posterUrl: String? get() = entry.posterUrl
    }

    data class Tmdb(
        val entry: CatalogEntry.Tmdb,
        override val description: String?,
        override val backdropUrl: String?,
        val rating: Double?,
        val releaseYear: Int?,
        val runtimeMinutes: Int?,
        val genres: List<String>,
        val cast: List<TmdbCastMember>,
        val seasons: List<TmdbSeason>,
        /** Legal availability for the user's region (TMDB watch/providers, data by JustWatch). */
        val watchProviders: WatchProviders?,
        /** YouTube key of the official trailer, if any. */
        val trailerYoutubeKey: String?,
        /** Matching titles found in the user's own IPTV VOD library. */
        val libraryMatches: List<CatalogEntry.Iptv>,
        /** Similar movies/series recommendations from TMDB. */
        val similar: List<CatalogEntry.Tmdb> = emptyList()
    ) : ContentDetails {
        override val title: String get() = entry.title
        override val posterUrl: String? get() = entry.posterUrl
    }
}

data class IptvEpisode(
    val id: String,
    val season: Int,
    val episode: Int,
    val title: String,
    val streamUrl: String,
    val plot: String? = null,
    val imageUrl: String? = null,
    val durationSecs: Int? = null
)

data class WatchProviders(
    val region: String,
    val link: String?,
    val stream: List<WatchProvider>,
    val rent: List<WatchProvider>,
    val buy: List<WatchProvider>
) {
    val isEmpty: Boolean get() = stream.isEmpty() && rent.isEmpty() && buy.isEmpty()
}

data class WatchProvider(val id: Int, val name: String, val logoUrl: String?)
