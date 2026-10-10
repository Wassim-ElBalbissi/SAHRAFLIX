package com.sahraflix.presentation.settings

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sahraflix.BuildConfig
import com.sahraflix.data.local.entity.PlaylistEntity
import com.sahraflix.data.local.entity.PlaylistType
import com.sahraflix.data.local.secureUserPreferences
import com.sahraflix.data.repository.PlaylistRepository
import com.sahraflix.data.repository.PlaylistSyncer
import com.sahraflix.data.worker.PlaylistSyncWorker
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject

enum class UiMode { AUTO, TV, MOBILE }

@HiltViewModel
class SettingsViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val playlists: PlaylistRepository,
    sources: com.sahraflix.data.sources.SourcePreferences
) : ViewModel() {
    private val preferences = context.secureUserPreferences()

    val playlistList: StateFlow<List<PlaylistEntity>> = playlists.playlists
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    val refreshEnabled: StateFlow<Boolean> = preferences.observeBoolean(KEY_REFRESH, true)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), true)
    val updateIntervalHours: StateFlow<Int> = preferences.observeString(KEY_INTERVAL, "12")
        .map { it.toIntOrNull() ?: 12 }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 12)
    val uiMode: StateFlow<UiMode> = preferences.observeString("ui_mode", UiMode.AUTO.name)
        .map { runCatching { UiMode.valueOf(it) }.getOrDefault(UiMode.AUTO) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, UiMode.AUTO)

    val modeChosen: StateFlow<Boolean> = preferences.observeString("ui_mode", "")
        .map { it.isNotBlank() }
        .stateIn(viewModelScope, SharingStarted.Eagerly, false)

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()
    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    val tmdbConfigured = sources.tmdbConfigured.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), sources.tmdbKey.isNotBlank())
    val demoServerUrl = "http://${BuildConfig.TEST_SERVER_HOST}:8000"

    fun addPlaylist(type: PlaylistType, name: String, url: String, user: String, pass: String, mac: String, epg: String, ua: String) {
        viewModelScope.launch {
            _busy.value = true
            runCatching { playlists.add(type, name, url, user, pass, mac, epg, ua) }
                .onSuccess { _message.value = "Added \"${it.name}\". Downloading channels…" }
                .onFailure { _message.value = PlaylistSyncer.describe(it) }
            _busy.value = false
        }
    }

    /** Bundled mock Xtream server (tools/test-server). 10.0.2.2 = host machine from the emulator. */
    fun addDemoServer() = addPlaylist(PlaylistType.XTREAM, "SahraFlix demo server", demoServerUrl, "demo", "demo", "", "", "")

    fun refresh(p: PlaylistEntity) { playlists.refresh(p.id); _message.value = "Refreshing ${p.name}…" }
    fun remove(p: PlaylistEntity) { viewModelScope.launch { playlists.remove(p); _message.value = "Removed ${p.name}" } }

    fun setRefreshEnabled(enabled: Boolean) {
        preferences.putBoolean(KEY_REFRESH, enabled)
        PlaylistSyncWorker.schedulePeriodic(context, updateIntervalHours.value.toLong(), enabled)
    }

    fun cycleUpdateInterval() {
        val next = when (updateIntervalHours.value) { 6 -> 12; 12 -> 24; else -> 6 }
        preferences.putString(KEY_INTERVAL, next.toString())
        PlaylistSyncWorker.schedulePeriodic(context, next.toLong(), refreshEnabled.value)
    }

    fun setUiMode(mode: UiMode) = preferences.putString("ui_mode", mode.name)

    fun clearCache() {
        viewModelScope.launch {
            withContext(Dispatchers.IO) { context.cacheDir.listFiles()?.forEach { it.deleteRecursively() } }
            _message.value = "Image cache cleared"
        }
    }

    fun clearMessage() { _message.value = null }

    private companion object {
        const val KEY_REFRESH = "background_refresh_enabled"
        const val KEY_INTERVAL = "update_interval_hours"
    }
}
