package com.sahraflix.presentation.sources

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.sahraflix.presentation.components.SahraButton
import com.sahraflix.presentation.components.SahraText
import com.sahraflix.presentation.theme.TextSecondary

@Composable
fun SourceSettingsScreen(viewModel: SourceSettingsViewModel = hiltViewModel()) {
    val sources by viewModel.sources.collectAsState()
    val message by viewModel.message.collectAsState()
    val busy by viewModel.busy.collectAsState()
    var tmdb by remember { mutableStateOf(viewModel.preferences.tmdbKey) }
    var subtitles by remember { mutableStateOf(viewModel.preferences.subtitleKey) }
    var debrid by remember { mutableStateOf(viewModel.preferences.debridKey) }
    var service by remember { mutableStateOf(viewModel.preferences.debridService) }
    var addon by remember { mutableStateOf("") }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { SahraText("Sources", fontSize = 28.sp, fontWeight = FontWeight.Bold) }
        item { SahraText("Choose which Marquee sources to search for movies and episodes.", color = TextSecondary) }
        message?.let { item { SahraText(it) } }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SahraText("API keys", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                SecretField("TMDB key or read token", tmdb) { tmdb = it }
                SecretField("OpenSubtitles API key (optional)", subtitles) { subtitles = it }
                SahraText("Torrentio", fontWeight = FontWeight.Bold)
                SahraText("Direct debrid links play here. Torrent links open your installed torrent app.", color = TextSecondary)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(listOf("" to "No debrid", "realdebrid" to "Real-Debrid", "alldebrid" to "AllDebrid", "premiumize" to "Premiumize", "torbox" to "TorBox", "debridlink" to "Debrid-Link")) { (id, label) ->
                        SahraButton(onClick = { service = id }) { SahraText((if (service == id) "✓ " else "") + label) }
                    }
                }
                if (service.isNotEmpty()) SecretField("Debrid API key", debrid) { debrid = it }
                SahraButton(onClick = { viewModel.saveKeys(tmdb, subtitles, service, debrid) }) { SahraText("Save keys") }
            }
        }
        item { SahraText("Enabled sources", fontSize = 20.sp, fontWeight = FontWeight.Bold) }
        items(sources, key = { it.first.id }) { (source, enabled) ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    SahraText(source.name, fontWeight = FontWeight.Bold)
                    SahraText(source.description, color = TextSecondary, fontSize = 13.sp)
                }
                Switch(checked = enabled, onCheckedChange = { viewModel.toggle(source.id, it) })
                if (source.id.startsWith("addon-")) SahraButton(onClick = { viewModel.remove(source.id) }) { SahraText("Remove") }
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SahraText("Add a Stremio addon", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                OutlinedTextField(value = addon, onValueChange = { addon = it }, label = { SahraText("Manifest URL") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
                SahraButton(onClick = { viewModel.addAddon(addon) }, enabled = !busy && addon.isNotBlank()) {
                    SahraText(if (busy) "Checking addon…" else "Add addon")
                }
            }
        }
    }
}

@Composable
private fun SecretField(label: String, value: String, onChange: (String) -> Unit) {
    OutlinedTextField(value, onChange, label = { SahraText(label) }, singleLine = true,
        visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
}
