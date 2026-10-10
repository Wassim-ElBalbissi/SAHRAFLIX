package com.sahraflix.player

import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import com.sahraflix.domain.model.DrmScheme
import com.sahraflix.domain.model.PlayRequest
import com.sahraflix.domain.model.TrackInfo
import com.sahraflix.domain.repository.IptvVideoPlayer
import com.sahraflix.domain.repository.PlaybackFailure
import com.sahraflix.domain.repository.PlayerState
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.Locale
import javax.inject.Inject
import javax.inject.Singleton

@OptIn(UnstableApi::class)
@Singleton
class Media3PlayerImpl @Inject constructor(
    @ApplicationContext private val context: Context,
    okHttpClient: OkHttpClient
) : IptvVideoPlayer {

    // Shares the app's OkHttp stack: cookies, redirects (incl. http↔https, which ExoPlayer's
    // default HTTP stack refuses), connection pooling and timeouts.
    // No setUserAgent(): OkHttpDataSource would *add* a second User-Agent header on top of a per-stream
    // one. The shared client's interceptor supplies the default UA only when none is present.
    private val httpFactory = OkHttpDataSource.Factory(okHttpClient)
    private val dataSourceFactory = DefaultDataSource.Factory(context, httpFactory)

    private val trackSelector = DefaultTrackSelector(context).apply {
        parameters = buildUponParameters()
            .setPreferredAudioLanguage(Locale.getDefault().language)
            .setPreferredTextLanguage(null)
            .setSelectUndeterminedTextLanguage(false)
            .build()
    }

    private val mediaSourceFactory = DefaultMediaSourceFactory(dataSourceFactory)
        // Live IPTV servers drop segments regularly; be patient before surfacing an error.
        .setLoadErrorHandlingPolicy(DefaultLoadErrorHandlingPolicy(6))

    override val player: ExoPlayer = ExoPlayer.Builder(context)
        .setRenderersFactory(
            DefaultRenderersFactory(context)
                // Cheap TV SoCs often have a broken primary decoder for some profiles; fall back.
                .setEnableDecoderFallback(true)
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)
        )
        .setMediaSourceFactory(mediaSourceFactory)
        .setTrackSelector(trackSelector)
        .setLoadControl(
            DefaultLoadControl.Builder()
                // min, max, bufferForPlayback, bufferForPlaybackAfterRebuffer
                .setBufferDurationsMs(15_000, 50_000, 1_500, 3_000)
                .setPrioritizeTimeOverSizeThresholds(true)
                .build()
        )
        .setAudioAttributes(
            AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(),
            /* handleAudioFocus = */ true
        )
        .setHandleAudioBecomingNoisy(true)
        .setWakeMode(C.WAKE_MODE_NETWORK)
        .setSeekBackIncrementMs(10_000)
        .setSeekForwardIncrementMs(10_000)
        .build()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var positionJob: Job? = null
    private var retryJob: Job? = null
    private var retries = 0
    private var hlsFallbackTried = false

    private val _playerState = MutableStateFlow(PlayerState.IDLE)
    override val playerState: StateFlow<PlayerState> = _playerState.asStateFlow()
    private val _currentPosition = MutableStateFlow(0L)
    override val currentPosition: StateFlow<Long> = _currentPosition.asStateFlow()
    private val _duration = MutableStateFlow(0L)
    override val duration: StateFlow<Long> = _duration.asStateFlow()
    private val _lastError = MutableStateFlow<PlaybackFailure?>(null)
    override val lastError: StateFlow<PlaybackFailure?> = _lastError.asStateFlow()
    private val _current = MutableStateFlow<PlayRequest?>(null)
    override val current: StateFlow<PlayRequest?> = _current.asStateFlow()

    init {
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) = updateState()
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                updateState()
                if (isPlaying) {
                    retries = 0 // a healthy stream resets the retry budget
                    startPositionUpdates()
                } else {
                    publishPosition()
                }
            }
            override fun onPlayerError(error: PlaybackException) = handleError(error)
        })
    }

    override fun play(request: PlayRequest) {
        retryJob?.cancel()
        retries = 0
        hlsFallbackTried = false
        _lastError.value = null
        _current.value = request
        prepare(request, forceHls = false)
    }

    private fun prepare(request: PlayRequest, forceHls: Boolean) {
        httpFactory.setDefaultRequestProperties(request.headers)
        val item = MediaItem.Builder()
            .setUri(request.url)
            .setMediaId(request.contentId)
            .setMimeType(if (forceHls) MimeTypes.APPLICATION_M3U8 else request.mimeType ?: mimeFor(request.url))
            .setSubtitleConfigurations(request.subtitles.map { subtitle ->
                MediaItem.SubtitleConfiguration.Builder(Uri.parse(subtitle.url))
                    .setMimeType(subtitle.mimeType).setLanguage(subtitle.language).setLabel(subtitle.label)
                    .setSelectionFlags(C.SELECTION_FLAG_DEFAULT).build()
            })
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(request.title)
                    .setArtworkUri(request.posterUrl?.let(Uri::parse))
                    .build()
            )
            .apply {
                if (request.isLive) {
                    setLiveConfiguration(MediaItem.LiveConfiguration.Builder().setMaxPlaybackSpeed(1.04f).build())
                }
                request.drm?.let { drm ->
                    val uuid = when (drm.scheme) {
                        DrmScheme.WIDEVINE -> C.WIDEVINE_UUID
                        DrmScheme.PLAYREADY -> C.PLAYREADY_UUID
                        DrmScheme.CLEARKEY -> C.CLEARKEY_UUID
                    }
                    setDrmConfiguration(
                        MediaItem.DrmConfiguration.Builder(uuid)
                            .setLicenseUri(drm.licenseUrl)
                            .setLicenseRequestHeaders(drm.licenseHeaders)
                            .setMultiSession(true)
                            .build()
                    )
                }
            }
            .build()
        player.setMediaItem(item, if (request.isLive) C.TIME_UNSET else request.resumePositionMs)
        player.playbackParameters = PlaybackParameters.DEFAULT
        player.prepare()
        player.playWhenReady = true
    }

    override fun retry() {
        val request = _current.value ?: return
        _lastError.value = null
        retries = 0
        prepare(request, hlsFallbackTried)
    }

    override fun stop() {
        retryJob?.cancel()
        positionJob?.cancel()
        player.stop()
        player.clearMediaItems()
        _current.value = null
        _lastError.value = null
        updateState()
    }

    private fun handleError(error: PlaybackException) {
        val request = _current.value
        // Live stream fell behind the server's window (common after a stall): jump back to live edge.
        if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
            player.seekToDefaultPosition()
            player.prepare()
            return
        }
        // Extension-less Xtream/URL-shortened links are often HLS: try once as HLS before failing.
        if (request != null && !hlsFallbackTried && error.errorCode in FORMAT_ERRORS) {
            hlsFallbackTried = true
            prepare(request, forceHls = true)
            return
        }
        val failure = classify(error)
        if (request != null && failure.retryable && retries < MAX_AUTO_RETRIES) {
            val attempt = ++retries
            _playerState.value = PlayerState.BUFFERING
            retryJob?.cancel()
            retryJob = scope.launch {
                delay(1_000L shl (attempt - 1)) // 1s, 2s, 4s
                val position = player.currentPosition
                prepare(request.copy(resumePositionMs = if (request.isLive) 0 else position), hlsFallbackTried)
            }
            return
        }
        _lastError.value = failure
        _playerState.value = PlayerState.ERROR
    }

    private fun classify(e: PlaybackException): PlaybackFailure {
        val cause = e.cause
        val http = cause as? HttpDataSource.InvalidResponseCodeException
        return when {
            http != null && (http.responseCode == 401 || http.responseCode == 403) -> PlaybackFailure(
                PlaybackFailure.Kind.HTTP_AUTH,
                "The provider refused this stream (${http.responseCode}). Your subscription may have expired, or too many devices are connected.",
                e.message, retryable = false
            )
            http != null && http.responseCode == 404 -> PlaybackFailure(
                PlaybackFailure.Kind.HTTP_NOT_FOUND, "This channel or video is offline (404).", e.message, retryable = false
            )
            http != null && http.responseCode >= 500 -> PlaybackFailure(
                PlaybackFailure.Kind.HTTP_SERVER, "The provider's server is having problems (${http.responseCode}).", e.message, retryable = true
            )
            e.errorCode in NETWORK_ERRORS -> PlaybackFailure(
                PlaybackFailure.Kind.NETWORK, "Connection to the stream was lost.", e.message, retryable = true
            )
            e.errorCode in FORMAT_ERRORS -> PlaybackFailure(
                PlaybackFailure.Kind.UNSUPPORTED_FORMAT, "This stream format isn't supported. Try an external player.", e.message, retryable = false
            )
            e.errorCode in DECODER_ERRORS -> PlaybackFailure(
                PlaybackFailure.Kind.DECODER, "This device can't decode this video (codec not supported).", e.message, retryable = false
            )
            e.errorCode in DRM_ERRORS -> PlaybackFailure(
                PlaybackFailure.Kind.DRM, "Protected content could not be unlocked on this device.", e.message, retryable = false
            )
            else -> PlaybackFailure(PlaybackFailure.Kind.UNKNOWN, "Playback failed (${e.errorCodeName}).", e.message, retryable = true)
        }
    }

    private fun updateState() {
        _playerState.value = when {
            player.playerError != null -> PlayerState.ERROR
            player.playbackState == Player.STATE_BUFFERING -> PlayerState.BUFFERING
            player.playbackState == Player.STATE_ENDED -> PlayerState.ENDED
            player.playbackState == Player.STATE_READY && player.isPlaying -> PlayerState.PLAYING
            player.playbackState == Player.STATE_READY && !player.playWhenReady -> PlayerState.PAUSED
            player.playbackState == Player.STATE_READY -> PlayerState.READY
            else -> if (retryJob?.isActive == true) PlayerState.BUFFERING else PlayerState.IDLE
        }
        publishPosition()
    }

    /** Position updates only while actually playing (the old code polled 4×/s forever). */
    private fun startPositionUpdates() {
        positionJob?.cancel()
        positionJob = scope.launch {
            while (isActive && player.isPlaying) {
                publishPosition()
                delay(500)
            }
        }
    }

    private fun publishPosition() {
        _currentPosition.value = player.currentPosition.coerceAtLeast(0L)
        _duration.value = player.duration.takeUnless { it == C.TIME_UNSET }?.coerceAtLeast(0L) ?: 0L
    }

    override fun loadExternalSubtitle(subtitleUri: Uri, mimeType: String, language: String?) {
        val item = player.currentMediaItem ?: return
        val position = player.currentPosition
        val subtitle = MediaItem.SubtitleConfiguration.Builder(subtitleUri)
            .setMimeType(mimeType)
            .setLanguage(language)
            .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
            .build()
        player.setMediaItem(item.buildUpon().setSubtitleConfigurations(listOf(subtitle)).build(), position)
        player.prepare()
    }

    override fun getAvailableAudioTracks() = tracksOf(C.TRACK_TYPE_AUDIO)
    override fun getAvailableSubtitleTracks() = tracksOf(C.TRACK_TYPE_TEXT)
    override fun getAvailableVideoTracks() = tracksOf(C.TRACK_TYPE_VIDEO)

    override fun setAudioTrack(id: String) = applyOverride(C.TRACK_TYPE_AUDIO, id)
    override fun setVideoTrack(id: String?) = applyOverride(C.TRACK_TYPE_VIDEO, id)
    override fun setSubtitleTrack(id: String?) {
        trackSelector.parameters = trackSelector.buildUponParameters()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, id == null)
            .build()
        if (id != null) applyOverride(C.TRACK_TYPE_TEXT, id)
    }

    override fun setPlaybackSpeed(speed: Float) {
        if (_current.value?.isLive == true) return
        player.playbackParameters = PlaybackParameters(speed.coerceIn(0.25f, 3f))
    }

    private fun tracksOf(type: Int): List<TrackInfo> =
        player.currentTracks.groups.filter { it.type == type }.flatMapIndexed { groupIndex, group ->
            (0 until group.length).filter(group::isTrackSupported).map { i ->
                val f = group.getTrackFormat(i)
                TrackInfo("$type:$groupIndex:$i", f.displayName(type), f.language, group.isTrackSelected(i))
            }
        }

    /** null id = automatic selection (clears override). */
    private fun applyOverride(type: Int, id: String?) {
        val builder = trackSelector.buildUponParameters().clearOverridesOfType(type)
        if (id != null) {
            val (_, groupIndex, trackIndex) = id.split(':').map { it.toInt() }
            val group: Tracks.Group = player.currentTracks.groups.filter { it.type == type }.getOrNull(groupIndex) ?: return
            builder.setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, trackIndex))
        }
        trackSelector.parameters = builder.build()
    }

    private fun Format.displayName(type: Int): String {
        val lang = language?.let { Locale.forLanguageTag(it).displayLanguage }?.takeIf { it.isNotBlank() && it != "und" }
        return when (type) {
            C.TRACK_TYPE_VIDEO -> if (height > 0) "${height}p" + (if (bitrate > 0) " · ${bitrate / 1000} kbps" else "") else "Video"
            C.TRACK_TYPE_AUDIO -> listOfNotNull(label ?: lang, channelCount.takeIf { it > 0 }?.let { if (it >= 6) "5.1" else if (it == 2) "Stereo" else "${it}ch" })
                .joinToString(" · ").ifBlank { "Audio" }
            else -> label ?: lang ?: "Subtitles"
        }
    }

    override fun release() {
        scope.cancel()
        player.release()
    }

    companion object {
        private const val MAX_AUTO_RETRIES = 3

        fun mimeFor(url: String): String? {
            val path = url.substringBefore('?').lowercase()
            return when {
                path.endsWith(".m3u8") || path.endsWith(".m3u") -> MimeTypes.APPLICATION_M3U8
                path.endsWith(".mpd") -> MimeTypes.APPLICATION_MPD
                path.endsWith(".ts") -> MimeTypes.VIDEO_MP2T
                else -> null // let ExoPlayer sniff progressive containers (mp4, mkv, …)
            }
        }

        private val NETWORK_ERRORS = setOf(
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
            PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
            PlaybackException.ERROR_CODE_TIMEOUT
        )
        private val FORMAT_ERRORS = setOf(
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
            PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED,
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
            PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED
        )
        private val DECODER_ERRORS = setOf(
            PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
            PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED
        )
        private val DRM_ERRORS = (6000..6008).toSet()
    }
}
