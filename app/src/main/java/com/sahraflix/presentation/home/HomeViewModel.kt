package com.sahraflix.presentation.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.paging.PagingData
import androidx.paging.cachedIn
import com.sahraflix.BuildConfig
import com.sahraflix.core.NetworkMonitor
import com.sahraflix.data.local.dao.EpgDao
import com.sahraflix.data.local.dao.StreamDao
import com.sahraflix.data.local.dao.dashboard.DashboardDao
import com.sahraflix.data.local.entity.PlaylistEntity
import com.sahraflix.data.repository.PlaylistRepository
import com.sahraflix.data.repository.UnifiedContentRepository.Companion.toEntry
import com.sahraflix.domain.model.CatalogEntry
import com.sahraflix.domain.model.StreamItem
import com.sahraflix.domain.model.StreamType
import com.sahraflix.domain.model.ContentSource
import com.sahraflix.domain.repository.ContentRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

data class ContinueItem(val entry: CatalogEntry.Iptv, val progress: Float)
data class NowItem(val entry: CatalogEntry.Iptv, val programme: String, val progress: Float)

@HiltViewModel
@OptIn(ExperimentalCoroutinesApi::class)
class HomeViewModel @Inject constructor(
    repository: ContentRepository,
    dashboardDao: DashboardDao,
    streamDao: StreamDao,
    epgDao: EpgDao,
    playlistRepository: PlaylistRepository,
    networkMonitor: NetworkMonitor,
    sources: com.sahraflix.data.sources.SourcePreferences
) : ViewModel() {
    val isOnline: StateFlow<Boolean> = networkMonitor.isOnline
    val tmdbConfigured = sources.tmdbConfigured.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), sources.tmdbKey.isNotBlank())

    val playlists: StateFlow<List<PlaylistEntity>?> = playlistRepository.playlists
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    // Previously all three rows were the same unfiltered stream list.
    val live: Flow<PagingData<CatalogEntry>> = repository.iptv(StreamType.LIVE).cachedIn(viewModelScope)
    val movies: Flow<PagingData<CatalogEntry>> = repository.iptv(StreamType.MOVIE).cachedIn(viewModelScope)
    val series: Flow<PagingData<CatalogEntry>> = repository.iptv(StreamType.SERIES).cachedIn(viewModelScope)
    val trendingMovies: Flow<PagingData<CatalogEntry>> = repository.tmdbMovies().cachedIn(viewModelScope)
    val trendingSeries: Flow<PagingData<CatalogEntry>> = repository.tmdbSeries().cachedIn(viewModelScope)

    val continueWatching: StateFlow<List<ContinueItem>> = dashboardDao.observeContinueWatching().map { rows ->
        rows.map { p ->
            // Episodes are stored as "<seriesId>:ep:<episodeId>"; play resumes via the stored URL.
            val stream = StreamItem(p.contentId, p.title, p.streamUrl, p.posterUrl, StreamType.MOVIE, "continue", "history")
            ContinueItem(CatalogEntry.Iptv(stream, ContentSource.IPTV_M3U), p.positionMs.toFloat() / p.durationMs)
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val favorites: StateFlow<List<CatalogEntry>> = dashboardDao.observeFavorites()
        .flatMapLatest { favs ->
            if (favs.isEmpty()) flowOf(emptyList())
            else streamDao.observeByIds(favs.map { it.streamId }).map { rows ->
                val order = favs.withIndex().associate { it.value.streamId to it.index }
                rows.sortedBy { order[it.id] ?: Int.MAX_VALUE }.map { it.toEntry() }
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    /** Re-evaluated every minute so "on now" stays current. */
    val onNow: StateFlow<List<NowItem>> = flow {
        while (true) { emit(System.currentTimeMillis()); delay(60_000) }
    }.flatMapLatest { now ->
        epgDao.observeNowPlaying(now, 40).map { rows ->
            rows.map { r ->
                val stream = StreamItem(r.streamId, r.streamName, "", r.logoUrl, StreamType.LIVE, "", "")
                NowItem(
                    CatalogEntry.Iptv(stream, ContentSource.IPTV_M3U),
                    r.title,
                    ((now - r.startTime).toFloat() / (r.endTime - r.startTime).coerceAtLeast(1)).coerceIn(0f, 1f)
                )
            }
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
}
