package com.sahraflix.data.remote

import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Path
import retrofit2.http.Query

/** TMDB v3. Authentication is added by an interceptor (api_key or Bearer token). */
interface TmdbApi {
    @GET("trending/movie/week")
    suspend fun trendingMovies(@Query("page") page: Int, @Query("language") language: String): Response<TmdbPageDto<TmdbMovieDto>>

    @GET("trending/tv/week")
    suspend fun trendingTv(@Query("page") page: Int, @Query("language") language: String): Response<TmdbPageDto<TmdbTvDto>>

    @GET("search/multi")
    suspend fun searchMulti(
        @Query("query") query: String,
        @Query("page") page: Int,
        @Query("language") language: String,
        @Query("include_adult") includeAdult: Boolean = false
    ): Response<TmdbPageDto<TmdbSearchDto>>

    @GET("movie/{id}")
    suspend fun movie(
        @Path("id") id: Int,
        @Query("language") language: String,
        @Query("append_to_response") append: String = "credits,videos,watch/providers,external_ids"
    ): Response<TmdbMovieDto>

    @GET("tv/{id}")
    suspend fun tv(
        @Path("id") id: Int,
        @Query("language") language: String,
        @Query("append_to_response") append: String = "credits,videos,watch/providers,external_ids"
    ): Response<TmdbTvDto>

    @GET("tv/{id}/season/{season}")
    suspend fun season(@Path("id") id: Int, @Path("season") season: Int,
        @Query("language") language: String): Response<TmdbSeasonDetailsDto>

    @GET("movie/{id}/similar")
    suspend fun similarMovies(
        @Path("id") id: Int,
        @Query("page") page: Int = 1,
        @Query("language") language: String
    ): Response<TmdbPageDto<TmdbSearchDto>>

    @GET("tv/{id}/similar")
    suspend fun similarTv(
        @Path("id") id: Int,
        @Query("page") page: Int = 1,
        @Query("language") language: String
    ): Response<TmdbPageDto<TmdbSearchDto>>
}

// Field names mirror the TMDB JSON (snake_case) so no annotations are needed.
data class TmdbPageDto<T>(val page: Int = 1, val total_pages: Int = 1, val results: List<T> = emptyList())

data class TmdbMovieDto(
    val id: Int,
    val title: String? = null,
    val original_title: String? = null,
    val original_language: String? = null,
    val imdb_id: String? = null,
    val overview: String? = null,
    val poster_path: String? = null,
    val backdrop_path: String? = null,
    val release_date: String? = null,
    val vote_average: Double? = null,
    val runtime: Int? = null,
    val genres: List<TmdbGenreDto> = emptyList(),
    val credits: TmdbCreditsDto? = null,
    val videos: TmdbVideosDto? = null,
    @com.squareup.moshi.Json(name = "watch/providers") val watchProviders: TmdbWatchProvidersDto? = null
)

data class TmdbTvDto(
    val id: Int,
    val name: String? = null,
    val original_name: String? = null,
    val original_language: String? = null,
    val origin_country: List<String> = emptyList(),
    val external_ids: TmdbExternalIdsDto? = null,
    val overview: String? = null,
    val poster_path: String? = null,
    val backdrop_path: String? = null,
    val first_air_date: String? = null,
    val vote_average: Double? = null,
    val episode_run_time: List<Int> = emptyList(),
    val seasons: List<TmdbSeasonDto> = emptyList(),
    val genres: List<TmdbGenreDto> = emptyList(),
    val credits: TmdbCreditsDto? = null,
    val videos: TmdbVideosDto? = null,
    @com.squareup.moshi.Json(name = "watch/providers") val watchProviders: TmdbWatchProvidersDto? = null
)

data class TmdbSeasonDto(
    val id: Int,
    val season_number: Int,
    val name: String? = null,
    val overview: String? = null,
    val poster_path: String? = null,
    val episode_count: Int = 0
)

data class TmdbGenreDto(val id: Int, val name: String)
data class TmdbExternalIdsDto(val imdb_id: String? = null)
data class TmdbSeasonDetailsDto(val episodes: List<TmdbEpisodeDto> = emptyList())
data class TmdbEpisodeDto(val id: Int, val episode_number: Int, val name: String?, val air_date: String? = null)
data class TmdbCreditsDto(val cast: List<TmdbCastDto> = emptyList())
data class TmdbCastDto(val id: Int, val name: String, val character: String? = null, val profile_path: String? = null)
data class TmdbVideosDto(val results: List<TmdbVideoDto> = emptyList())
data class TmdbVideoDto(val key: String, val site: String, val type: String, val official: Boolean = false)
data class TmdbWatchProvidersDto(val results: Map<String, TmdbRegionProvidersDto> = emptyMap())
data class TmdbRegionProvidersDto(
    val link: String? = null,
    val flatrate: List<TmdbProviderDto> = emptyList(),
    val rent: List<TmdbProviderDto> = emptyList(),
    val buy: List<TmdbProviderDto> = emptyList(),
    val free: List<TmdbProviderDto> = emptyList(),
    val ads: List<TmdbProviderDto> = emptyList()
)
data class TmdbProviderDto(val provider_id: Int, val provider_name: String, val logo_path: String? = null)

data class TmdbSearchDto(
    val id: Int,
    val media_type: String? = null,
    val title: String? = null,
    val name: String? = null,
    val overview: String? = null,
    val poster_path: String? = null,
    val backdrop_path: String? = null,
    val release_date: String? = null,
    val first_air_date: String? = null,
    val vote_average: Double? = null
)
