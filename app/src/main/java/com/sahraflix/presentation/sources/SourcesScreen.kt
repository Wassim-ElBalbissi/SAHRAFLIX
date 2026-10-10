package com.sahraflix.presentation.sources

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.sahraflix.presentation.components.SahraButton
import com.sahraflix.presentation.components.SahraText
import com.sahraflix.presentation.player.LocalPlayerViewModel
import com.sahraflix.presentation.theme.TextSecondary

@Composable
fun SourcesScreen(onSettings: () -> Unit, viewModel: SourcesViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    val player = LocalPlayerViewModel.current
    val context = LocalContext.current
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { SahraText(state.title, fontSize = 28.sp, fontWeight = FontWeight.Bold) }
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                SahraButton(onClick = viewModel::search, enabled = !state.loading && !state.searching) { SahraText("Find streams") }
                SahraButton(onClick = onSettings) { SahraText("Source settings") }
            }
        }
        if (state.seasons.isNotEmpty()) item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.seasons, key = { it.id }) { season ->
                    SahraButton(onClick = { viewModel.selectSeason(season.season_number) }) {
                        SahraText((if (state.season == season.season_number) "✓ " else "") + "Season ${season.season_number}")
                    }
                }
            }
        }
        if (state.episodes.isNotEmpty()) item {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.episodes, key = { it.id }) { episode ->
                    SahraButton(onClick = { viewModel.selectEpisode(episode.episode_number) }) {
                        SahraText((if (state.episode == episode.episode_number) "✓ " else "") + "${episode.episode_number}. ${episode.name.orEmpty()}",
                            modifier = Modifier.widthIn(max = 220.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        if (state.loading || state.searching) item {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                CircularProgressIndicator(Modifier.size(24.dp))
                SahraText(if (state.loading) "Loading title…" else "Searching sources · ${state.streams.size} streams found")
            }
        }
        state.error?.let { message -> item {
            SahraText(message, color = TextSecondary)
            SahraButton(onClick = { if (state.title == "Find streams" || (viewModel.isSeries && state.episodes.isEmpty())) viewModel.load() else viewModel.search() }) { SahraText("Try again") }
        } }
        if (!state.loading && viewModel.isSeries && state.episodes.isEmpty() && state.error == null) item {
            SahraText("No aired episodes are available in this season yet.", color = TextSecondary)
        }
        if (!state.loading && !state.searching && viewModel.preferences.definitions().none { viewModel.preferences.enabled(it.id) }) item {
            SahraText("Enable a source in Source settings to find streams.", color = TextSecondary)
        }
        if (state.subtitles.isNotEmpty()) item {
            SahraText("Subtitle track", fontWeight = FontWeight.Bold)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                item { SahraButton(onClick = { viewModel.selectSubtitle(null) }) { SahraText(if (state.selectedSubtitle == null) "✓ Off" else "Off") } }
                items(state.subtitles, key = { it.url }) { subtitle ->
                    SahraButton(onClick = { viewModel.selectSubtitle(subtitle) }) {
                        SahraText((if (state.selectedSubtitle == subtitle) "✓ " else "") + subtitle.label,
                            modifier = Modifier.widthIn(max = 240.dp), maxLines = 2)
                    }
                }
            }
        }
        items(state.streams, key = { it.url }) { stream ->
            SahraButton(onClick = {
                if (stream.isTorrent) {
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(stream.url))) }
                        .onFailure { Toast.makeText(context, "Install a torrent app to open this result, or choose a direct stream.", Toast.LENGTH_LONG).show() }
                } else viewModel.play(stream, player::playResolved)
            }, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth()) {
                    SahraText("${stream.source} · ${stream.quality}", fontWeight = FontWeight.Bold)
                    SahraText(stream.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (stream.isTorrent) SahraText("Open in torrent app", color = TextSecondary)
                }
            }
        }
        if (!state.loading && !state.searching && state.streams.isEmpty() && state.progress.isNotEmpty()) item {
            SahraText("No streams found for this selection. Try another episode or change the enabled sources.", color = TextSecondary)
        }
        if (state.progress.isNotEmpty()) item {
            val names = viewModel.preferences.definitions().associate { it.id to it.name }
            SahraText(state.progress.entries.joinToString("\n") { (id, status) ->
                "${names[id] ?: id}: ${when (status) { "searching" -> "Searching…"; "found" -> "Available"; "failed" -> "Unavailable"; else -> "No results" }}"
            }, color = TextSecondary, fontSize = 13.sp)
        }
    }
}
