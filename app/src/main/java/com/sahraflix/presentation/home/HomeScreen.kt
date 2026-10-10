package com.sahraflix.presentation.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.paging.compose.collectAsLazyPagingItems
import androidx.tv.material3.Button
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import com.sahraflix.data.local.entity.SyncState
import com.sahraflix.domain.model.CatalogEntry
import com.sahraflix.domain.model.StreamType
import com.sahraflix.presentation.components.EntryRail
import com.sahraflix.presentation.components.PagedRail
import com.sahraflix.presentation.player.LocalPlayerViewModel

@Composable
fun HomeScreen(
    onOpenDetail: (CatalogEntry) -> Unit,
    onAddPlaylist: () -> Unit,
    onResumeSource: (String) -> Unit,
    onSources: () -> Unit,
    viewModel: HomeViewModel = hiltViewModel()
) {
    val player = LocalPlayerViewModel.current
    val tmdbConfigured by viewModel.tmdbConfigured.collectAsState()
    val isOnline by viewModel.isOnline.collectAsState()
    val playlists by viewModel.playlists.collectAsState()
    val continueWatching by viewModel.continueWatching.collectAsState()
    val favorites by viewModel.favorites.collectAsState()
    val movies = viewModel.movies.collectAsLazyPagingItems()
    val series = viewModel.series.collectAsLazyPagingItems()
    val trendingMovies = viewModel.trendingMovies.collectAsLazyPagingItems()
    val trendingSeries = viewModel.trendingSeries.collectAsLazyPagingItems()

    // Movies play immediately; series and TMDB titles open their detail page.
    val open: (CatalogEntry) -> Unit = { entry ->
        when (entry) {
            is CatalogEntry.Iptv -> if (entry.stream.streamType == StreamType.SERIES) onOpenDetail(entry) else player.play(entry)
            is CatalogEntry.Tmdb -> onOpenDetail(entry)
        }
    }
    val details: (CatalogEntry) -> Unit = { entry ->
        onOpenDetail(entry)
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 36.dp, end = 24.dp, top = 24.dp, bottom = 48.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp)
    ) {
        if (!isOnline) item {
            Banner("You're offline. Showing saved channels; playback needs a connection.", Color(0xFF8B1E1E))
        }
        playlists?.firstOrNull { it.syncState == SyncState.RUNNING }?.let { p ->
            item(key = "sync") { Banner("Updating ${p.name}: ${p.syncMessage ?: "working…"}", Color(0xFF263447)) }
        }
        playlists?.filter { it.syncState == SyncState.FAILED }?.forEach { p ->
            item(key = "fail-${p.id}") { Banner("${p.name} failed to update: ${p.syncMessage}", Color(0xFF5A2A10)) }
        }

        if (playlists?.isEmpty() == true) {
            item(key = "welcome") { Welcome(onAddPlaylist) }
        }

        item(key = "continue") {
            EntryRail(
                title = "Continue watching",
                entries = continueWatching.map { it.entry },
                onClick = { if (it.id.startsWith("tmdb-")) onResumeSource(it.id) else player.resume(it.id) },
                progress = { e -> continueWatching.firstOrNull { it.entry.id == e.id }?.progress }
            )
        }
        item(key = "movies") { PagedRail("Movies", movies, open, onLongClick = details) }
        item(key = "series") { PagedRail("Series", series, open) }
        item(key = "tm") { PagedRail("Trending movies", trendingMovies, open) }
        item(key = "ts") { PagedRail("Trending series", trendingSeries, open) }
        if (!tmdbConfigured) item(key = "tmdb-hint") {
            Text(
                "Add your TMDB API key in Source settings to browse titles and search Marquee sources.",
                style = MaterialTheme.typography.bodySmall
            )
            com.sahraflix.presentation.components.SahraButton(onClick = onSources) {
                com.sahraflix.presentation.components.SahraText("Source settings")
            }
        }
        if (playlists?.isNotEmpty() == true) item(key = "hint") {
            Text("Long-press a channel to add it to favourites. Menu key in the player opens audio/subtitle options.",
                style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun Banner(text: String, color: Color) {
    Box(Modifier.fillMaxWidth().background(color, MaterialTheme.shapes.small).padding(14.dp)) {
        Text(text, color = Color.White, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun Welcome(onAddPlaylist: () -> Unit) {
    Column(
        Modifier.widthIn(max = 720.dp).padding(vertical = 40.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text("Welcome to SahraFlix", style = MaterialTheme.typography.displaySmall)
        Text(
            "Add your IPTV subscription (M3U link, Xtream Codes login or Stalker portal). " +
                "You can type it on the TV, or pair from your phone by scanning a QR code.",
            style = MaterialTheme.typography.bodyLarge
        )
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = onAddPlaylist) { Text("Add playlist") }
            OutlinedButton(onClick = onAddPlaylist) { Text("Try the demo server") }
        }
    }
}
