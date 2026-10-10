package com.sahraflix.data.repository

import androidx.paging.Pager
import androidx.paging.PagingConfig
import androidx.paging.PagingData
import androidx.paging.map
import com.sahraflix.core.AppConfig
import com.sahraflix.data.local.dao.PlaylistDao
import com.sahraflix.data.local.dao.StreamDao
import com.sahraflix.data.local.dao.StreamingItemDao
import com.sahraflix.data.local.dao.dashboard.DashboardDao
import com.sahraflix.data.local.entity.PlaylistEntity
import com.sahraflix.data.local.entity.PlaylistType
import com.sahraflix.data.local.entity.StreamItemEntity
import com.sahraflix.data.local.entity.StreamingItemEntity
import com.sahraflix.data.parser.TitleMatcher
import com.sahraflix.data.remote.TmdbClient
import com.sahraflix.domain.model.CatalogEntry
import com.sahraflix.domain.model.ContentDetails
import com.sahraflix.domain.model.ContentSource
import com.sahraflix.domain.model.IptvEpisode
import com.sahraflix.domain.model.PlayRequest
import com.sahraflix.domain.model.StreamItem
import com.sahraflix.domain.model.StreamType
import com.sahraflix.domain.repository.ContentRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.CancellationException
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class UnifiedContentRepository @Inject constructor(
    private val streamDao: StreamDao,
    private val playlistDao: PlaylistDao,
    private val tmdbDao: StreamingItemDao,
    private val dashboardDao: DashboardDao,
    private val tmdb: TmdbClient,
    private val xtream: XtreamProviderImpl,
    private val stalker: StalkerProviderImpl
) : ContentRepository {

    private val pagingConfig = PagingConfig(pageSize = 40, prefetchDistance = 20, enablePlaceholders = false)

    override fun iptv(type: StreamType, categoryId: String?): Flow<PagingData<CatalogEntry>> =
        Pager(pagingConfig) {
            if (categoryId != null) streamDao.pagingByCategory(categoryId) else streamDao.pagingByType(type)
        }.flow.map { page -> page.map { it.toEntry() as CatalogEntry } }

    override fun searchIptv(query: String): Flow<PagingData<CatalogEntry>> =
        Pager(pagingConfig) { streamDao.pagingSearch(query) }.flow.map { page -> page.map { it.toEntry() as CatalogEntry } }

    override fun tmdbMovies() = tmdbPaging(TYPE_MOVIE)
    override fun tmdbSeries() = tmdbPaging(TYPE_SERIES)

    private fun tmdbPaging(type: String): Flow<PagingData<CatalogEntry>> =
        Pager(pagingConfig) { tmdbDao.pagingByType(type) }.flow.map { page ->
            page.map { item ->
                CatalogEntry.Tmdb(item.tmdbId, item.title, item.posterUrl, item.contentType == TYPE_SERIES,
                    item.overview, item.releaseYear, item.rating, item.backdropUrl) as CatalogEntry
            }
        }

    suspend fun syncTrending(pages: Int) {
        val now = System.currentTimeMillis()
        var rank = 0
        for (page in 1..pages) {
            tmdbDao.upsertAll(tmdb.trendingMovies(page).results.map {
                StreamingItemEntity("tmdb:movie:${it.id}", it.title.orEmpty(), tmdb.image(it.poster_path), TYPE_MOVIE,
                    it.overview, tmdb.year(it.release_date), it.vote_average, it.id, now,
                    tmdb.image(it.backdrop_path, com.sahraflix.core.AppConfig.TMDB_IMAGE_BACKDROP), rank++)
            })
        }
        rank = 0
        for (page in 1..pages) {
            tmdbDao.upsertAll(tmdb.trendingTv(page).results.map {
                StreamingItemEntity("tmdb:tv:${it.id}", it.name.orEmpty(), tmdb.image(it.poster_path), TYPE_SERIES,
                    it.overview, tmdb.year(it.first_air_date), it.vote_average, it.id, now,
                    tmdb.image(it.backdrop_path, com.sahraflix.core.AppConfig.TMDB_IMAGE_BACKDROP), rank++)
            })
        }
    }

    override suspend fun searchTmdb(query: String): List<CatalogEntry.Tmdb> {
        if (!tmdb.isConfigured || query.length < 2) return emptyList()
        return tmdb.search(query).results.mapNotNull {
            val series = when (it.media_type) { "movie" -> false; "tv" -> true; else -> return@mapNotNull null }
            CatalogEntry.Tmdb(it.id, it.title ?: it.name.orEmpty(), tmdb.image(it.poster_path), series, it.overview,
                tmdb.year(it.release_date ?: it.first_air_date), it.vote_average)
        }
    }

    override suspend fun iptvEntry(streamId: String): CatalogEntry.Iptv? = streamDao.getById(streamId)?.toEntry()

    override suspend fun iptvDetails(streamId: String): ContentDetails.Iptv {
        val entity = streamDao.getById(streamId) ?: throw NoSuchElementException("This item is no longer in your playlist")
        val entry = entity.toEntry()
        val playlist = playlistDao.getById(entity.playlistId)
        
        var tmdbFull: ContentDetails.Tmdb? = null
        if (tmdb.isConfigured && entity.streamType != StreamType.LIVE) {
            val fragment = TitleMatcher.searchFragment(TitleMatcher.parse(entity.name).key)
            if (fragment.length >= 2) {
                val match = optionalMetadata { searchTmdb(fragment) }.orEmpty()
                    .filter { it.isSeries == (entity.streamType == StreamType.SERIES) }
                    .map { it to TitleMatcher.score(it.title, it.releaseYear, entity.name) }
                    .filter { it.second >= 80 }
                    .maxByOrNull { it.second }?.first
                if (match != null) {
                    tmdbFull = optionalMetadata { tmdbDetails(match.tmdbId, match.isSeries) }
                }
            }
        }

        if (entity.streamType != StreamType.SERIES) {
            val info = if (entity.streamType == StreamType.MOVIE && playlist?.type == PlaylistType.XTREAM && entity.providerId != null) {
                optionalMetadata { xtream.movieInfo(playlist, entity.providerId) }
            } else null
            return ContentDetails.Iptv(
                entry = entry.copy(stream = entry.stream.copy(logoUrl = info?.poster ?: entry.posterUrl)),
                description = info?.plot ?: tmdbFull?.description,
                backdropUrl = info?.backdrop ?: tmdbFull?.backdropUrl,
                rating = info?.rating ?: tmdbFull?.rating,
                releaseYear = info?.year ?: tmdbFull?.releaseYear,
                tmdbMatch = tmdbFull,
                cast = info?.cast,
                director = info?.director
            )
        }
        if (playlist == null) return ContentDetails.Iptv(
            entry, tmdbFull?.description, tmdbFull?.backdropUrl, emptyMap(), tmdbFull?.rating, tmdbFull?.releaseYear, tmdbFull
        )
        if (playlist.type != PlaylistType.XTREAM || entity.providerId == null) {
            // M3U "series" rows are individual episodes; play them directly.
            return ContentDetails.Iptv(
                entry = entry, 
                description = tmdbFull?.description, 
                backdropUrl = tmdbFull?.backdropUrl,
                seasons = mapOf(1 to listOf(IptvEpisode(entity.id, 1, 1, entity.name, entity.streamUrl))),
                rating = tmdbFull?.rating,
                releaseYear = tmdbFull?.releaseYear,
                tmdbMatch = tmdbFull
            )
        }
        val info = xtream.seriesEpisodes(playlist, entity.providerId)
        return ContentDetails.Iptv(
            entry, 
            info.plot ?: tmdbFull?.description, 
            info.backdrop ?: tmdbFull?.backdropUrl, 
            info.episodes.groupBy { it.season }, 
            info.rating ?: tmdbFull?.rating, 
            info.year ?: tmdbFull?.releaseYear,
            tmdbFull
        )
    }

    override suspend fun tmdbDetails(tmdbId: Int, isSeries: Boolean): ContentDetails.Tmdb {
        return if (isSeries) {
            val tv = tmdb.tv(tmdbId)
            val similarTv = optionalMetadata { tmdb.similarTv(tmdbId) }
            val entry = CatalogEntry.Tmdb(tv.id, tv.name.orEmpty(), tmdb.image(tv.poster_path), true, tv.overview,
                tmdb.year(tv.first_air_date), tv.vote_average, tmdb.image(tv.backdrop_path, AppConfig.TMDB_IMAGE_BACKDROP))
            
            val similarEntries = similarTv?.results.orEmpty().map {
                CatalogEntry.Tmdb(it.id, it.name.orEmpty(), tmdb.image(it.poster_path), true, it.overview,
                    tmdb.year(it.first_air_date), it.vote_average)
            }
                
            ContentDetails.Tmdb(entry, tv.overview, entry.backdropUrl, tv.vote_average, entry.releaseYear,
                tv.episode_run_time.firstOrNull(), tv.genres.map { it.name }, tmdb.cast(tv.credits), tmdb.seasons(tv.seasons),
                tmdb.providers(tv.watchProviders), tmdb.trailerKey(tv.videos),
                libraryMatches(entry.title, null, StreamType.SERIES), similarEntries)
        } else {
            val m = tmdb.movie(tmdbId)
            val similarMovies = optionalMetadata { tmdb.similarMovies(tmdbId) }
            val entry = CatalogEntry.Tmdb(m.id, m.title.orEmpty(), tmdb.image(m.poster_path), false, m.overview,
                tmdb.year(m.release_date), m.vote_average, tmdb.image(m.backdrop_path, AppConfig.TMDB_IMAGE_BACKDROP))
                
            val similarEntries = similarMovies?.results.orEmpty().map {
                CatalogEntry.Tmdb(it.id, it.title.orEmpty(), tmdb.image(it.poster_path), false, it.overview,
                    tmdb.year(it.release_date), it.vote_average)
            }
                
            ContentDetails.Tmdb(entry, m.overview, entry.backdropUrl, m.vote_average, entry.releaseYear, m.runtime,
                m.genres.map { it.name }, tmdb.cast(m.credits), emptyList(),
                tmdb.providers(m.watchProviders), tmdb.trailerKey(m.videos),
                libraryMatches(entry.title, entry.releaseYear, StreamType.MOVIE), similarEntries)
        }
    }

    /** Finds this title in the user's own IPTV VOD library. */
    private suspend fun <T> optionalMetadata(load: suspend () -> T): T? = try {
        load()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        null // Artwork/recommendations must never prevent access to an IPTV episode or movie.
    }

    private suspend fun libraryMatches(title: String, year: Int?, type: StreamType): List<CatalogEntry.Iptv> {
        val fragment = TitleMatcher.searchFragment(title)
        if (fragment.length < 2) return emptyList()
        return streamDao.findVodCandidates(type, fragment)
            .map { it to TitleMatcher.score(title, year, it.name) }
            .filter { it.second >= 80 }
            .sortedByDescending { it.second }
            .take(5)
            .map { it.first.toEntry() }
    }

    override suspend fun playRequest(entry: CatalogEntry.Iptv): PlayRequest {
        val entity = streamDao.getById(entry.stream.id) ?: throw IOException("This item is no longer in your playlist")
        if (entity.streamType == StreamType.SERIES && entity.streamUrl.startsWith("xtream-series:")) {
            throw IllegalStateException("Choose an episode to play")
        }
        val url = resolveUrl(entity)
        val resume = if (entity.streamType == StreamType.LIVE) 0L else dashboardDao.getProgress(entity.id)?.positionMs ?: 0L
        return PlayRequest(url, entity.name, entity.id, entity.streamType == StreamType.LIVE, entity.logoUrl,
            headers(entity), resume)
    }

    override suspend fun playRequest(series: CatalogEntry.Iptv, episode: IptvEpisode): PlayRequest {
        val contentId = "${series.stream.id}:ep:${episode.id}"
        val entity = streamDao.getById(series.stream.id)
        return PlayRequest(
            url = episode.streamUrl,
            title = "${series.title} · S${episode.season}E${episode.episode} ${episode.title}".trim(),
            contentId = contentId,
            isLive = false,
            posterUrl = episode.imageUrl ?: series.posterUrl,
            headers = entity?.let(::headers).orEmpty(),
            resumePositionMs = dashboardDao.getProgress(contentId)?.positionMs ?: 0L
        )
    }

    override suspend fun catchupRequest(streamId: String, startMs: Long, endMs: Long): PlayRequest? {
        val entity = streamDao.getById(streamId) ?: return null
        val base = resolveUrl(entity)
        val url = CatchupUrlFormatter.format(entity.catchupSource, entity.catchupType, base, startMs, endMs) ?: return null
        return PlayRequest(url, "${entity.name} (catch-up)", "$streamId:catchup:$startMs", isLive = false,
            posterUrl = entity.logoUrl, headers = headers(entity))
    }

    private suspend fun resolveUrl(entity: StreamItemEntity): String {
        if (!entity.streamUrl.startsWith(StalkerProviderImpl.STALKER_SCHEME)) return entity.streamUrl
        val playlist = playlistDao.getById(entity.playlistId) ?: throw IOException("Playlist removed")
        return stalker.createLink(playlist, entity.streamUrl)
    }

    private fun headers(entity: StreamItemEntity): Map<String, String> = buildMap {
        entity.userAgent?.takeIf { it.isNotBlank() }?.let { put("User-Agent", it) }
        entity.referrer?.takeIf { it.isNotBlank() }?.let { put("Referer", it) }
    }

    companion object {
        const val TYPE_MOVIE = "MOVIE"
        const val TYPE_SERIES = "SERIES"

        fun StreamItemEntity.toEntry(): CatalogEntry.Iptv = CatalogEntry.Iptv(
            StreamItem(id, name, streamUrl, logoUrl, streamType, categoryId, playlistId, providerId,
                catchupType, catchupSource, epgChannelId),
            ContentSource.IPTV_M3U // refined by the UI via playlist type when needed
        )
    }
}

/** Playlist CRUD + sync triggers. */
@Singleton
class PlaylistRepository @Inject constructor(
    @dagger.hilt.android.qualifiers.ApplicationContext private val context: android.content.Context,
    private val playlistDao: PlaylistDao,
    private val xtream: XtreamProviderImpl
) {
    val playlists = playlistDao.observeAll()

    /** Validates (Xtream login) before saving, so the user gets immediate feedback. */
    suspend fun add(
        type: PlaylistType,
        name: String,
        url: String,
        username: String? = null,
        password: String? = null,
        mac: String? = null,
        epgUrl: String? = null,
        userAgent: String? = null
    ): PlaylistEntity {
        val cleanUrl = url.trim()
        require(cleanUrl.isNotEmpty()) { "Please enter an address" }
        val normalizedUrl = when (type) {
            PlaylistType.XTREAM -> XtreamProviderImpl.normalizeBaseUrl(cleanUrl)
            PlaylistType.M3U -> if (cleanUrl.contains("://")) cleanUrl else "http://$cleanUrl"
            PlaylistType.STALKER -> cleanUrl
        }
        if (type == PlaylistType.XTREAM) {
            require(!username.isNullOrBlank() && !password.isNullOrBlank()) { "Username and password are required" }
            xtream.authenticate(XtreamProviderImpl.Account(normalizedUrl, username.trim(), password.trim(), userAgent))
        }
        val id = "${type.name.lowercase()}:" + (normalizedUrl + "|" + username.orEmpty() + "|" + mac.orEmpty()).hashCode().toUInt().toString(16)
        val entity = PlaylistEntity(
            id = id,
            name = name.trim().ifBlank { defaultName(type, normalizedUrl) },
            url = normalizedUrl,
            username = username?.trim()?.ifBlank { null },
            password = password?.trim()?.ifBlank { null },
            type = type,
            lastUpdated = 0,
            epgUrl = epgUrl?.trim()?.ifBlank { null },
            macAddress = mac?.trim()?.uppercase()?.ifBlank { null },
            userAgent = userAgent?.trim()?.ifBlank { null }
        )
        playlistDao.upsert(entity)
        com.sahraflix.data.worker.PlaylistSyncWorker.syncNow(context, id)
        return entity
    }

    fun refresh(id: String) = com.sahraflix.data.worker.PlaylistSyncWorker.syncNow(context, id)

    suspend fun remove(playlist: PlaylistEntity) = playlistDao.delete(playlist)

    private fun defaultName(type: PlaylistType, url: String): String {
        val host = runCatching { java.net.URI(url).host }.getOrNull() ?: url.take(24)
        return "${type.name.lowercase().replaceFirstChar(Char::uppercase)} · $host"
    }
}
