package com.sahraflix.presentation.detail

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.sahraflix.presentation.components.SahraButton
import com.sahraflix.presentation.components.SahraText
import coil.compose.AsyncImage
import com.sahraflix.domain.model.ContentDetails
import com.sahraflix.domain.model.CatalogEntry
import com.sahraflix.domain.model.StreamType
import com.sahraflix.domain.model.WatchProvider
import com.sahraflix.presentation.components.RailTitle
import com.sahraflix.presentation.components.StreamCard
import com.sahraflix.presentation.LocalUiEnvironment
import com.sahraflix.presentation.player.LocalPlayerViewModel
import com.sahraflix.presentation.theme.DeepShadow
import com.sahraflix.presentation.theme.SahraGold

@Composable
fun DetailScreen(onOpenDetail: (CatalogEntry) -> Unit, onFindSources: (CatalogEntry.Tmdb) -> Unit, viewModel: DetailViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    Box(Modifier.fillMaxSize()) {
        when (val s = state) {
            DetailState.Loading -> CircularProgressIndicator(color = SahraGold, modifier = Modifier.align(Alignment.Center))
            is DetailState.Failed -> Column(Modifier.align(Alignment.Center), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SahraText(s.message, fontSize = 18.sp, color = Color.White)
                SahraButton(onClick = viewModel::load) { SahraText("Try again") }
            }
            is DetailState.Loaded -> DetailContent(s.details, onOpenDetail, onFindSources)
        }
    }
}

@Composable
@OptIn(ExperimentalLayoutApi::class)
private fun DetailContent(details: ContentDetails, onOpenDetail: (CatalogEntry) -> Unit, onFindSources: (CatalogEntry.Tmdb) -> Unit) {
    val player = LocalPlayerViewModel.current
    val context = LocalContext.current
    val isTv = LocalUiEnvironment.current.isTv
    Box(Modifier.fillMaxSize()) {
        details.backdropUrl?.let {
            AsyncImage(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop, alpha = 0.35f)
        }
        Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(DeepShadow, DeepShadow.copy(alpha = 0.6f), Color.Transparent))))
        LazyColumn(
            contentPadding = PaddingValues(if (isTv) 48.dp else 16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(28.dp)) {
                    details.posterUrl?.takeIf { isTv }?.let {
                        AsyncImage(it, details.title, Modifier.width(180.dp).height(270.dp), contentScale = ContentScale.Crop)
                    }
                    Column(Modifier.weight(1f).widthIn(max = 680.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        SahraText(details.title, fontSize = if (isTv) 36.sp else 28.sp, fontWeight = FontWeight.Bold, color = Color.White)
                        SahraText(metaLine(details), fontSize = 14.sp, color = Color.Gray)
                        details.description?.let { SahraText(it, maxLines = 6, overflow = TextOverflow.Ellipsis, fontSize = 16.sp, color = Color.LightGray) }
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            when (details) {
                                is ContentDetails.Iptv -> {
                                    if (details.entry.stream.streamType != StreamType.SERIES) {
                                        SahraButton(onClick = { player.play(details.entry) }) { SahraText("Play") }
                                        SahraButton(onClick = { player.playFromStart(details.entry) }) { SahraText("From start") }
                                        SahraButton(onClick = { player.toggleFavorite(details.entry) }) { SahraText("Favourite") }
                                    }
                                    details.tmdbMatch?.trailerYoutubeKey?.let { key ->
                                        SahraButton(onClick = {
                                            val app = Intent(Intent.ACTION_VIEW, Uri.parse("vnd.youtube:$key"))
                                            val web = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/watch?v=$key"))
                                            try { context.startActivity(app) } catch (_: ActivityNotFoundException) {
                                                runCatching { context.startActivity(web) }
                                            }
                                        }) { SahraText("Trailer") }
                                    }
                                }
                                is ContentDetails.Tmdb -> {
                                    SahraButton(onClick = { onFindSources(details.entry) }) {
                                        SahraText(if (details.entry.isSeries) "Choose episode & sources" else "Find streams")
                                    }
                                    details.libraryMatches.firstOrNull()?.let { match ->
                                        if (!details.entry.isSeries) SahraButton(onClick = { player.play(match) }) { SahraText("Play from your library") }
                                    }
                                    details.trailerYoutubeKey?.let { key ->
                                        SahraButton(onClick = {
                                            val app = Intent(Intent.ACTION_VIEW, Uri.parse("vnd.youtube:$key"))
                                            val web = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/watch?v=$key"))
                                            try { context.startActivity(app) } catch (_: ActivityNotFoundException) {
                                                runCatching { context.startActivity(web) }
                                            }
                                        }) { SahraText("Trailer") }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            when (details) {
                is ContentDetails.Iptv -> {
                    episodes(details, onPlay = { ep -> player.playEpisode(details.entry, ep) })
                    if (details.entry.stream.streamType == StreamType.SERIES && details.seasons.isEmpty()) {
                        item { SahraText("No episodes available from this provider yet.", color = Color.LightGray) }
                    }
                    details.cast?.let { cast -> item { SahraText("Cast: $cast", color = Color.LightGray) } }
                    details.director?.let { director -> item { SahraText("Director: $director", color = Color.LightGray) } }
                    details.tmdbMatch?.let { tmdbSections(it, skipLibrary = true, onOpenDetail) }
                }
                is ContentDetails.Tmdb -> tmdbSections(details, skipLibrary = false, onOpenDetail)
            }
        }
    }
}

private fun metaLine(d: ContentDetails): String = when (d) {
    is ContentDetails.Iptv -> listOfNotNull(d.releaseYear?.toString(), d.rating?.let { "★ %.1f".format(it) },
        d.seasons.takeIf { it.isNotEmpty() }?.let { "${it.size} season(s)" }).joinToString("  ·  ")
    is ContentDetails.Tmdb -> listOfNotNull(d.releaseYear?.toString(), d.rating?.let { "★ %.1f".format(it) },
        d.runtimeMinutes?.let { "${it} min" }, d.genres.take(3).joinToString(", ").ifBlank { null }).joinToString("  ·  ")
}

private fun androidx.compose.foundation.lazy.LazyListScope.episodes(
    d: ContentDetails.Iptv,
    onPlay: (com.sahraflix.domain.model.IptvEpisode) -> Unit
) {
    if (d.seasons.isEmpty()) return
    item(key = "episodes") {
        var selected by remember(d.entry.id) { mutableIntStateOf(d.seasons.keys.min()) }
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(d.seasons.keys.sorted()) { season ->
                    SahraButton(onClick = { selected = season }) { 
                        SahraText("Season $season", color = if (season == selected) Color.White else Color.Gray) 
                    }
                }
            }
            d.seasons[selected].orEmpty().forEach { ep ->
                SahraButton(onClick = { onPlay(ep) }, modifier = Modifier.fillMaxWidth()) {
                    Column {
                        SahraText("${ep.episode}. ${ep.title}", fontSize = 16.sp, fontWeight = FontWeight.Medium, color = Color.White)
                        ep.plot?.let { SahraText(it, maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 14.sp, color = Color.Gray) }
                    }
                }
            }
        }
    }
}

private fun LazyListScope.tmdbSections(d: ContentDetails.Tmdb, skipLibrary: Boolean, onOpenDetail: (CatalogEntry) -> Unit) {
    if (!skipLibrary && d.libraryMatches.isNotEmpty()) item(key = "lib") {
        val player = LocalPlayerViewModel.current
        Column {
            RailTitle("In your library")
            LazyRow(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                items(d.libraryMatches, key = { it.id }) { StreamCard(it, onClick = { e ->
                    val iptv = e as com.sahraflix.domain.model.CatalogEntry.Iptv
                    if (iptv.stream.streamType == StreamType.SERIES) onOpenDetail(iptv) else player.play(iptv)
                }) }
            }
        }
    }
    item(key = "where") {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            RailTitle("Where to watch")
            val wp = d.watchProviders
            if (wp == null || wp.isEmpty) {
                SahraText("No licensed streaming options found for your region.", fontSize = 14.sp, color = Color.Gray)
            } else {
                ProviderRow("Stream", wp.stream)
                ProviderRow("Rent", wp.rent)
                ProviderRow("Buy", wp.buy)
                SahraText("Availability data from JustWatch via TMDB (${wp.region}).", fontSize = 12.sp, color = Color.Gray)
            }
        }
    }
    if (d.cast.isNotEmpty()) item(key = "cast") {
        Column {
            RailTitle("Cast")
            LazyRow(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                items(d.cast, key = { it.id }) { c ->
                    Column(Modifier.width(110.dp)) {
                        AsyncImage(c.profileUrl, c.name, Modifier.size(110.dp, 150.dp), contentScale = ContentScale.Crop)
                        SahraText(c.name, maxLines = 1, fontSize = 14.sp, color = Color.White)
                        c.character?.let { SahraText(it, maxLines = 1, fontSize = 12.sp, color = Color.Gray) }
                    }
                }
            }
        }
    }
    if (d.seasons.isNotEmpty()) item(key = "seasons") {
        SahraText(d.seasons.joinToString("  ·  ") { "${it.name} (${it.episodeCount} ep)" }, fontSize = 14.sp, color = Color.Gray)
    }
    if (d.similar.isNotEmpty()) item(key = "similar") {
        Column {
            RailTitle(if (d.entry.isSeries) "Similar Shows" else "Similar Movies")
            LazyRow(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                items(d.similar, key = { it.id }) { similarItem -> 
                    StreamCard(
                        entry = similarItem, 
                        onClick = onOpenDetail
                    ) 
                }
            }
        }
    }
}

@Composable
private fun ProviderRow(label: String, providers: List<WatchProvider>) {
    if (providers.isEmpty()) return
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        SahraText(label, modifier = Modifier.width(70.dp), fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
        providers.take(8).forEach { p ->
            AsyncImage(p.logoUrl, p.name, Modifier.size(44.dp))
        }
    }
}
