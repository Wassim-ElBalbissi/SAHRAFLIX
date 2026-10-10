package com.sahraflix.presentation.player

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sahraflix.data.local.dao.dashboard.DashboardDao
import com.sahraflix.data.local.entity.FavoriteEntity
import com.sahraflix.data.local.entity.WatchProgressEntity
import com.sahraflix.data.repository.PlaylistSyncer
import com.sahraflix.domain.model.CatalogEntry
import com.sahraflix.domain.model.IptvEpisode
import com.sahraflix.domain.model.PlayRequest
import com.sahraflix.domain.model.StreamType
import com.sahraflix.domain.repository.ContentRepository
import com.sahraflix.domain.repository.IptvVideoPlayer
import com.sahraflix.domain.repository.PlayerState
import com.sahraflix.player.PlaybackService
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Activity-scoped. Provided to every screen through [LocalPlayerViewModel] — the previous code
 * called hiltViewModel() inside each NavHost destination, which creates a *separate* instance per
 * back-stack entry, so screens were driving a ViewModel that MainActivity never observed.
 */
val LocalPlayerViewModel = staticCompositionLocalOf<PlayerViewModel> { error("PlayerViewModel not provided") }

@HiltViewModel
class PlayerViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    val player: IptvVideoPlayer,
    private val repository: ContentRepository,
    private val dashboardDao: DashboardDao
) : ViewModel() {

    /** True while the full-screen player is shown. */
    private val _isPlayerVisible = MutableStateFlow(false)
    val isPlayerVisible: StateFlow<Boolean> = _isPlayerVisible.asStateFlow()
    private val _isResolving = MutableStateFlow(false)
    val isResolving: StateFlow<Boolean> = _isResolving.asStateFlow()
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    val favoriteIds: StateFlow<Set<String>> = dashboardDao.observeFavorites()
        .map { list -> list.map { it.streamId }.toSet() }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptySet())

    private var progressJob: Job? = null

    init {
        // Persist progress for VOD while playing; also when playback pauses/ends.
        viewModelScope.launch {
            player.playerState.collect { state ->
                if (state == PlayerState.PAUSED || state == PlayerState.ENDED) saveProgress()
            }
        }
    }

    /** Opens an IPTV live channel / movie. Series are handled by the detail screen. */
    fun play(entry: CatalogEntry.Iptv) = launchPlayback { repository.playRequest(entry) }

    fun playEpisode(series: CatalogEntry.Iptv, episode: IptvEpisode) =
        launchPlayback { repository.playRequest(series, episode) }

    fun playResolved(request: PlayRequest) = launchPlayback {
        request.copy(resumePositionMs = dashboardDao.getProgress(request.contentId)?.positionMs ?: 0L)
    }

    fun playCatchup(streamId: String, startMs: Long, endMs: Long) = launchPlayback {
        repository.catchupRequest(streamId, startMs, endMs)
            ?: throw IllegalStateException("Catch-up isn't available for this channel")
    }

    /** Resumes a Continue Watching item (movie, episode or catch-up) straight from its saved progress. */
    fun resume(contentId: String) = launchPlayback {
        val p = dashboardDao.getProgress(contentId) ?: throw IllegalStateException("Nothing to resume")
        val baseId = contentId.substringBefore(":ep:").substringBefore(":catchup:")
        val base = repository.iptvEntry(baseId)
        PlayRequest(
            url = p.streamUrl, title = p.title, contentId = p.contentId, isLive = false,
            posterUrl = p.posterUrl, resumePositionMs = p.positionMs,
            headers = if (base != null && baseId == contentId) repository.playRequest(base).headers else emptyMap()
        )
    }

    fun playFromStart(entry: CatalogEntry.Iptv) = launchPlayback {
        repository.playRequest(entry).copy(resumePositionMs = 0)
    }

    private fun launchPlayback(build: suspend () -> PlayRequest) {
        viewModelScope.launch {
            _isResolving.value = true
            _message.value = null
            runCatching { build() }
                .onSuccess { start(it) }
                .onFailure { _message.value = PlaylistSyncer.describe(it) }
            _isResolving.value = false
        }
    }

    private fun start(request: PlayRequest) {
        saveProgress() // for whatever was playing before
        // Plain startService: Media3 promotes the session service to foreground when needed.
        runCatching { context.startService(Intent(context, PlaybackService::class.java)) }
        player.play(request)
        _isPlayerVisible.value = true
        progressJob?.cancel()
        if (!request.isLive) {
            progressJob = viewModelScope.launch {
                while (isActive) { delay(15_000); saveProgress() }
            }
        }
    }

    fun retry() = player.retry()

    /** Leaves the full-screen player. Live TV stops (saves bandwidth / provider connection slots). */
    fun closePlayer() {
        saveProgress()
        progressJob?.cancel()
        _isPlayerVisible.value = false
        player.stop()
    }

    fun clearMessage() { _message.value = null }

    fun toggleFavorite(entry: CatalogEntry) {
        val iptv = entry as? CatalogEntry.Iptv ?: return
        viewModelScope.launch {
            val id = iptv.stream.id
            if (id in favoriteIds.value) {
                dashboardDao.removeFavorite(id)
                _message.value = "Removed \"${iptv.title}\" from favourites"
            } else {
                dashboardDao.addFavorite(FavoriteEntity(id))
                _message.value = "Added \"${iptv.title}\" to favourites"
            }
        }
    }

    fun openExternally() {
        val request = player.current.value ?: return
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(Uri.parse(request.url), "video/*")
            putExtra("title", request.title)
            request.headers["User-Agent"]?.let { putExtra("headers", arrayOf("User-Agent", it)) }
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            context.startActivity(Intent.createChooser(intent, "Open with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            player.player.pause()
        } catch (e: ActivityNotFoundException) {
            _message.value = "No external video player installed (try VLC or MX Player)"
        }
    }

    private fun saveProgress() {
        val request = player.current.value ?: return
        if (request.isLive) return
        val position = player.player.currentPosition
        val duration = player.player.duration
        if (duration <= 0 || position <= 0) return
        viewModelScope.launch {
            dashboardDao.saveProgress(
                WatchProgressEntity(request.contentId, request.title, request.posterUrl, request.url, position, duration)
            )
        }
    }

    override fun onCleared() {
        saveProgress()
        super.onCleared()
    }
}
