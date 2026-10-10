package com.sahraflix.presentation.detail

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sahraflix.data.repository.PlaylistSyncer
import com.sahraflix.domain.model.ContentDetails
import com.sahraflix.domain.repository.ContentRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed interface DetailState {
    data object Loading : DetailState
    data class Loaded(val details: ContentDetails) : DetailState
    data class Failed(val message: String) : DetailState
}

/** Route id is either an IPTV stream id or "tmdb-movie-<id>" / "tmdb-tv-<id>". */
@HiltViewModel
class DetailViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val repository: ContentRepository
) : ViewModel() {
    // Navigation has already decoded the route argument; decoding again corrupts '+' and '%' IDs.
    private val id: String = savedStateHandle.get<String>("id").orEmpty()
    private val _state = MutableStateFlow<DetailState>(DetailState.Loading)
    val state: StateFlow<DetailState> = _state.asStateFlow()

    init { load() }

    fun load() {
        _state.value = DetailState.Loading
        viewModelScope.launch {
            _state.value = runCatching {
                val tmdb = TMDB_ID.matchEntire(id)
                if (tmdb != null) repository.tmdbDetails(tmdb.groupValues[2].toInt(), tmdb.groupValues[1] == "tv")
                else repository.iptvDetails(id)
            }.fold({ DetailState.Loaded(it) }, { DetailState.Failed(PlaylistSyncer.describe(it)) })
        }
    }

    private companion object { val TMDB_ID = Regex("tmdb-(movie|tv)-(\\d+)") }
}
