package com.sahraflix.data.remote

import com.sahraflix.core.AppConfig
import com.sahraflix.domain.model.TmdbCastMember
import com.sahraflix.domain.model.TmdbSeason
import com.sahraflix.domain.model.WatchProvider
import com.sahraflix.domain.model.WatchProviders
import kotlinx.coroutines.delay
import retrofit2.Response
import java.io.IOException
import java.util.Locale

class TmdbNotConfiguredException : IllegalStateException(
    "Add your TMDB API key in Source settings to enable movie and series discovery."
)

class TmdbClient(private val api: TmdbApi, private val configured: () -> Boolean) {
    constructor(api: TmdbApi, isConfigured: Boolean) : this(api, { isConfigured })
    val isConfigured: Boolean get() = configured()

    private val language: String get() = Locale.getDefault().toLanguageTag()
    val region: String get() = Locale.getDefault().country.ifBlank { "US" }

    suspend fun trendingMovies(page: Int) = request { api.trendingMovies(page, language) }
    suspend fun trendingTv(page: Int) = request { api.trendingTv(page, language) }
    suspend fun search(query: String) = request { api.searchMulti(query, 1, language) }
    suspend fun movie(id: Int) = request { api.movie(id, language) }
    suspend fun tv(id: Int) = request { api.tv(id, language) }
    suspend fun season(id: Int, season: Int) = request { api.season(id, season, language) }
    suspend fun similarMovies(id: Int) = request { api.similarMovies(id = id, language = language) }
    suspend fun similarTv(id: Int) = request { api.similarTv(id = id, language = language) }

    fun trailerKey(videos: TmdbVideosDto?): String? = videos?.results
        ?.filter { it.site.equals("YouTube", true) }
        ?.sortedWith(compareByDescending<TmdbVideoDto> { it.type == "Trailer" }.thenByDescending { it.official })
        ?.firstOrNull()?.key

    fun providers(dto: TmdbWatchProvidersDto?): WatchProviders? {
        val r = dto?.results?.get(region) ?: return null
        fun List<TmdbProviderDto>.map() = map { WatchProvider(it.provider_id, it.provider_name, image(it.logo_path, AppConfig.TMDB_IMAGE_LOGO)) }
        return WatchProviders(
            region = region,
            link = r.link,
            stream = (r.flatrate + r.free + r.ads).distinctBy { it.provider_id }.map(),
            rent = r.rent.map(),
            buy = r.buy.map()
        )
    }

    fun cast(dto: TmdbCreditsDto?): List<TmdbCastMember> = dto?.cast.orEmpty().take(15).map {
        TmdbCastMember(it.id, it.name, it.character, image(it.profile_path, AppConfig.TMDB_IMAGE_POSTER))
    }

    fun seasons(list: List<TmdbSeasonDto>): List<TmdbSeason> = list.filter { it.season_number > 0 }.map {
        TmdbSeason(it.id, it.season_number, it.name.orEmpty(), it.overview, image(it.poster_path, AppConfig.TMDB_IMAGE_POSTER), it.episode_count)
    }

    fun image(path: String?, base: String = AppConfig.TMDB_IMAGE_POSTER): String? =
        path?.takeIf { it.isNotBlank() }?.let { base + it }

    fun year(date: String?): Int? = date?.take(4)?.toIntOrNull()

    /** Retries 429 (rate-limit) and 5xx / network errors with exponential backoff. */
    private suspend fun <T> request(call: suspend () -> Response<T>): T {
        if (!isConfigured) throw TmdbNotConfiguredException()
        var backoff = 500L
        var lastError: Exception? = null
        repeat(MAX_ATTEMPTS) { attempt ->
            try {
                val response = call()
                if (response.isSuccessful) return response.body() ?: throw IOException("TMDB returned an empty body")
                if (response.code() == 401) throw IllegalStateException("TMDB rejected the API key (401)")
                if (response.code() == 404) throw NoSuchElementException("Not found on TMDB")
                if (response.code() != 429 && response.code() < 500) throw IOException("TMDB error ${response.code()}")
                lastError = IOException("TMDB error ${response.code()}")
            } catch (e: IOException) {
                lastError = e
            }
            if (attempt < MAX_ATTEMPTS - 1) { delay(backoff); backoff *= 2 }
        }
        throw lastError ?: IOException("TMDB request failed")
    }

    private companion object { const val MAX_ATTEMPTS = 3 }
}
