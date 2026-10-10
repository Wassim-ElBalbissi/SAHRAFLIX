package com.sahraflix.presentation.sources

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sahraflix.data.remote.TmdbClient
import com.sahraflix.data.remote.TmdbEpisodeDto
import com.sahraflix.data.remote.TmdbSeasonDto
import com.sahraflix.data.sources.*
import com.sahraflix.domain.model.PlayRequest
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import javax.inject.Inject

data class SourceSearchState(
    val title: String = "Find streams", val loading: Boolean = true, val searching: Boolean = false,
    val error: String? = null, val seasons: List<TmdbSeasonDto> = emptyList(),
    val episodes: List<TmdbEpisodeDto> = emptyList(), val season: Int = 1, val episode: Int? = null,
    val streams: List<SourceStream> = emptyList(), val subtitles: List<SourceSubtitle> = emptyList(),
    val selectedSubtitle: SourceSubtitle? = null, val progress: Map<String, String> = emptyMap()
)

@HiltViewModel
class SourcesViewModel @Inject constructor(
    savedState: SavedStateHandle, private val tmdb: TmdbClient,
    private val runtime: MarqueeSourceRuntime, val preferences: SourcePreferences,
    private val subtitleLoader: SourceSubtitleLoader
) : ViewModel() {
    private val id = savedState.get<String>("tmdbId")?.toIntOrNull() ?: 0
    val isSeries = savedState.get<String>("type") == "tv"
    private val _state = MutableStateFlow(SourceSearchState())
    val state = _state.asStateFlow()
    private var query = JSONObject()
    private var poster: String? = null
    private var searchJob: Job? = null
    private var metadataJob: Job? = null
    private var playbackJob: Job? = null
    private var resumeSeason = savedState.get<Int>("season") ?: 0
    private var resumeEpisode = savedState.get<Int>("episode") ?: 0

    init { load() }

    fun load() {
        metadataJob?.cancel()
        searchJob?.cancel()
        metadataJob = viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                query = JSONObject().put("tmdbId", id).put("type", if (isSeries) "series" else "movie")
                if (isSeries) {
                    val tv = tmdb.tv(id)
                    query.put("title", tv.name).put("originalTitle", tv.original_name).put("imdbId", tv.external_ids?.imdb_id)
                        .put("originCountry", JSONArray(tv.origin_country)).put("originalLanguage", tv.original_language)
                        .put("year", tmdb.year(tv.first_air_date)).put("genreIds", JSONArray(tv.genres.map { it.id }))
                        .put("seasonEpisodeCounts", JSONObject(tv.seasons.associate { it.season_number.toString() to it.episode_count }))
                    poster = tmdb.image(tv.poster_path)
                    val seasons = tv.seasons.filter { it.season_number > 0 && it.episode_count > 0 }
                    _state.update { it.copy(title = tv.name.orEmpty(), seasons = seasons, loading = false) }
                    (seasons.firstOrNull { it.season_number == resumeSeason } ?: seasons.firstOrNull())?.let {
                        loadSeason(it.season_number)
                        if (resumeEpisode > 0 && state.value.episodes.any { episode -> episode.episode_number == resumeEpisode }) selectEpisode(resumeEpisode)
                        resumeSeason = 0
                        resumeEpisode = 0
                    }
                } else {
                    val movie = tmdb.movie(id)
                    query.put("title", movie.title).put("originalTitle", movie.original_title).put("imdbId", movie.imdb_id)
                        .put("year", tmdb.year(movie.release_date)).put("originalLanguage", movie.original_language)
                        .put("genreIds", JSONArray(movie.genres.map { it.id }))
                    poster = tmdb.image(movie.poster_path)
                    _state.update { it.copy(title = movie.title.orEmpty(), loading = false) }
                    search()
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { _state.update { it.copy(loading = false, error = error.message ?: "Unable to load title") } }
        }
    }

    fun selectSeason(season: Int) {
        playbackJob?.cancel()
        metadataJob?.cancel()
        searchJob?.cancel()
        metadataJob = viewModelScope.launch {
            try { loadSeason(season) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { _state.update { it.copy(loading = false, error = "Couldn't load episodes. Try again.") } }
        }
    }
    private suspend fun loadSeason(season: Int) {
        _state.update { it.copy(loading = true, searching = false, error = null, season = season, episode = null, episodes = emptyList(), streams = emptyList(), subtitles = emptyList(), selectedSubtitle = null, progress = emptyMap()) }
        val today = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.ROOT).format(java.util.Date())
        val episodes = tmdb.season(id, season).episodes.filter { it.air_date.isNullOrBlank() || it.air_date <= today }
        _state.update { it.copy(loading = false, episodes = episodes, episode = episodes.firstOrNull()?.episode_number) }
    }
    fun selectEpisode(episode: Int) {
        playbackJob?.cancel()
        searchJob?.cancel()
        _state.update { it.copy(episode = episode, streams = emptyList(), subtitles = emptyList(), selectedSubtitle = null, progress = emptyMap(), searching = false) }
        search()
    }
    fun selectSubtitle(subtitle: SourceSubtitle?) { _state.update { it.copy(selectedSubtitle = subtitle) } }

    fun search() {
        if (state.value.loading || (isSeries && state.value.episode == null)) return
        searchJob?.cancel()
        val selection = state.value
        val request = JSONObject(query.toString()).apply {
            if (isSeries) {
                put("season", selection.season).put("episode", selection.episode)
                put("episodeAirDate", selection.episodes.firstOrNull { it.episode_number == selection.episode }?.air_date)
            }
        }
        _state.update { it.copy(searching = true, error = null, streams = emptyList(), subtitles = emptyList(), selectedSubtitle = null, progress = emptyMap()) }
        searchJob = viewModelScope.launch {
            try {
                withTimeout(50_000) {
                    runtime.resolve(request).collect { event ->
                        when (event.optString("type")) {
                            "streams" -> _state.update { current -> current.copy(streams = (current.streams + event.optJSONArray("streams").objects().mapNotNull(SourceStream::parse)).distinctBy { it.url }) }
                            "subtitles" -> _state.update { current -> current.copy(subtitles = (current.subtitles + event.optJSONArray("subtitles").objects().mapNotNull(SourceSubtitle::parse)).distinctBy { it.url }.sortedBy { if (it.language.startsWith("ar")) 0 else 1 }) }
                            "progress" -> _state.update { it.copy(progress = it.progress + (event.getString("id") to event.getString("state"))) }
                            "error" -> _state.update { it.copy(error = event.optString("message")) }
                        }
                    }
                }
            } catch (_: TimeoutCancellationException) { _state.update { it.copy(error = "Some sources timed out. Available streams are ready to play.") } }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { _state.update { it.copy(error = "Source search failed. Try again.") } }
            _state.update { it.copy(searching = false) }
        }
    }

    fun play(stream: SourceStream, onReady: (PlayRequest) -> Unit) {
        val selection = state.value
        playbackJob?.cancel()
        playbackJob = viewModelScope.launch {
            try {
                val subtitle = selection.selectedSubtitle?.let { subtitleLoader.load(it) }
                val suffix = if (isSeries) ":s${selection.season}:e${selection.episode}" else ""
                onReady(PlayRequest(stream.url, selection.title + if (isSeries) " · S${selection.season}E${selection.episode}" else "",
                    "tmdb-${if (isSeries) "tv" else "movie"}-$id$suffix", false, poster, stream.headers,
                    mimeType = if (stream.isHls) "application/x-mpegURL" else null, subtitles = listOfNotNull(subtitle)))
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { _state.update { it.copy(error = "Couldn't load that subtitle. Choose another track or turn subtitles off.") } }
        }
    }
}
