package com.sahraflix.presentation.settings

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.sahraflix.BuildConfig
import com.sahraflix.data.local.entity.PlaylistEntity
import com.sahraflix.data.local.entity.PlaylistType
import com.sahraflix.data.local.entity.SyncState
import com.sahraflix.presentation.components.SahraButton
import com.sahraflix.presentation.components.SahraText
import com.sahraflix.presentation.theme.InkCard
import com.sahraflix.presentation.theme.NebulaCrimson
import com.sahraflix.presentation.theme.NeonTeal
import com.sahraflix.presentation.theme.SlateDivider
import com.sahraflix.presentation.theme.SlateElevated
import com.sahraflix.presentation.theme.TextMuted
import com.sahraflix.presentation.theme.TextPrimary
import com.sahraflix.presentation.theme.TextSecondary
import com.sahraflix.presentation.theme.VoidBlack
import java.text.DateFormat
import java.util.Date

@Composable
fun SettingsScreen(
    onPair: () -> Unit,
    onSubtitles: () -> Unit,
    onSources: () -> Unit,
    viewModel: SettingsViewModel = hiltViewModel()
) {
    val playlists by viewModel.playlistList.collectAsState()
    val tmdbConfigured by viewModel.tmdbConfigured.collectAsState()
    val refresh by viewModel.refreshEnabled.collectAsState()
    val interval by viewModel.updateIntervalHours.collectAsState()
    val uiMode by viewModel.uiMode.collectAsState()
    val busy by viewModel.busy.collectAsState()
    val message by viewModel.message.collectAsState()
    var showAddForm by rememberSaveable { mutableStateOf(false) }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(VoidBlack),
        contentPadding = PaddingValues(horizontal = 28.dp, vertical = 24.dp)
    ) {
        item {
            SahraText(
                "Settings",
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                color = TextPrimary,
                modifier = Modifier.padding(bottom = 24.dp)
            )
        }

        message?.let { m ->
            item {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 16.dp)
                        .clip(MaterialTheme.shapes.medium)
                        .background(NeonTeal.copy(alpha = 0.10f))
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    SahraText(m, color = NeonTeal, fontSize = 14.sp, modifier = Modifier.weight(1f))
                    SahraText(
                        "✕",
                        color = TextMuted,
                        fontSize = 16.sp,
                        modifier = Modifier
                            .clickable { viewModel.clearMessage() }
                            .padding(start = 12.dp)
                    )
                }
            }
        }

        // ── Playlists ─────────────────────────────────────────────────────────
        item { SettingsSection("Playlists") }
        item {
            SettingsSurface {
                playlists.forEach { p ->
                    PlaylistItemRow(p, viewModel::refresh, viewModel::remove)
                    HorizontalDivider(color = SlateDivider, thickness = 0.5.dp)
                }
                SettingsNavRow(
                    title = "Add playlist on this TV",
                    subtitle = if (showAddForm) "Tap again to close" else "M3U, Xtream or Stalker URL",
                    onClick = { showAddForm = !showAddForm }
                )
                AnimatedVisibility(visible = showAddForm) {
                    Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                        HorizontalDivider(
                            color = SlateDivider,
                            thickness = 0.5.dp,
                            modifier = Modifier.padding(bottom = 12.dp)
                        )
                        AddPlaylistForm(busy) { t, n, u, us, pw, mac, epg, ua ->
                            viewModel.addPlaylist(t, n, u, us, pw, mac, epg, ua)
                            showAddForm = false
                        }
                    }
                }
                HorizontalDivider(color = SlateDivider, thickness = 0.5.dp)
                SettingsNavRow(
                    title = "Pair from phone",
                    subtitle = "Scan a QR code to add a playlist wirelessly",
                    onClick = onPair
                )
                HorizontalDivider(color = SlateDivider, thickness = 0.5.dp)
                SettingsActionRow(
                    title = "Add demo server",
                    subtitle = "Connect to ${viewModel.demoServerUrl}",
                    onClick = viewModel::addDemoServer,
                    enabled = !busy
                )
            }
        }

        // ── Updates ───────────────────────────────────────────────────────────
        item { SettingsSection("Discovery & Sources") }
        item { SettingsSurface { SettingsNavRow("Marquee sources", onSources, subtitle = "Providers, TMDB, subtitles, debrid and Stremio addons") } }
        item { SettingsSection("Updates") }
        item {
            SettingsSurface {
                SettingsToggleRow(
                    title = "Automatic refresh",
                    subtitle = if (refresh) "Updates on Wi-Fi and Ethernet" else "Manual sync only",
                    checked = refresh,
                    onToggle = { viewModel.setRefreshEnabled(it) }
                )
                HorizontalDivider(color = SlateDivider, thickness = 0.5.dp)
                SettingsValueRow(
                    title = "Check interval",
                    subtitle = "Tap to cycle between 6 / 12 / 24 hours",
                    value = "Every ${interval}h",
                    onClick = { viewModel.cycleUpdateInterval() },
                    enabled = refresh
                )
            }
        }

        // ── Display & Playback ────────────────────────────────────────────────
        item { SettingsSection("Display & Playback") }
        item {
            SettingsSurface {
                SettingsValueRow(
                    title = "Layout mode",
                    subtitle = "Controls navigation style",
                    value = uiMode.name,
                    onClick = {
                        val next = UiMode.entries[(uiMode.ordinal + 1) % UiMode.entries.size]
                        viewModel.setUiMode(next)
                    }
                )
                HorizontalDivider(color = SlateDivider, thickness = 0.5.dp)
                SettingsNavRow(
                    title = "Subtitle style",
                    subtitle = "Font, size, colour and background",
                    onClick = onSubtitles
                )
                HorizontalDivider(color = SlateDivider, thickness = 0.5.dp)
                SettingsActionRow(
                    title = "Clear image cache",
                    subtitle = "Frees up disk space; artwork re-downloads on demand",
                    onClick = viewModel::clearCache
                )
            }
        }

        // ── About ─────────────────────────────────────────────────────────────
        item { SettingsSection("About") }
        item {
            SettingsSurface {
                SettingsInfoRow(title = "App version", value = "v${BuildConfig.VERSION_NAME}")
                HorizontalDivider(color = SlateDivider, thickness = 0.5.dp)
                SettingsInfoRow(
                    title = "TMDB",
                    value = if (tmdbConfigured) "Configured" else "Not configured"
                )
            }
        }
        item {
            val tmdbNote = if (!tmdbConfigured) " Add your TMDB API key in Source settings to enable discovery." else ""
            SahraText(
                "SahraFlix plays IPTV sources you provide. Movie & series info, artwork and \"where to watch\" data " +
                    "come from TMDB.$tmdbNote This product uses the TMDB API but is not endorsed or certified by TMDB.",
                color = TextMuted,
                fontSize = 12.sp,
                modifier = Modifier.padding(horizontal = 4.dp, vertical = 8.dp)
            )
        }

        item { Spacer(Modifier.height(48.dp)) }
    }
}

// ── Section primitives ────────────────────────────────────────────────────────

@Composable
private fun SettingsSection(title: String) {
    SahraText(
        text = title.uppercase(),
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.2.sp,
        color = TextMuted,
        modifier = Modifier.padding(start = 4.dp, top = 24.dp, bottom = 8.dp)
    )
}

@Composable
private fun SettingsSurface(content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(InkCard),
        content = content
    )
}

@Composable
private fun SettingsNavRow(
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            SahraText(title, fontSize = 16.sp, fontWeight = FontWeight.Medium, color = TextPrimary)
            if (subtitle != null) SahraText(subtitle, fontSize = 13.sp, color = TextSecondary)
        }
        SahraText("›", fontSize = 22.sp, color = TextMuted, modifier = Modifier.padding(start = 8.dp))
    }
}

@Composable
private fun SettingsToggleRow(
    title: String,
    checked: Boolean,
    onToggle: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable { onToggle(!checked) }
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            SahraText(title, fontSize = 16.sp, fontWeight = FontWeight.Medium, color = TextPrimary)
            if (subtitle != null) SahraText(subtitle, fontSize = 13.sp, color = TextSecondary)
        }
        Switch(
            checked = checked,
            onCheckedChange = onToggle,
            colors = SwitchDefaults.colors(
                checkedThumbColor = TextPrimary,
                checkedTrackColor = NebulaCrimson,
                uncheckedThumbColor = TextSecondary,
                uncheckedTrackColor = SlateElevated
            )
        )
    }
}

@Composable
private fun SettingsValueRow(
    title: String,
    value: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    enabled: Boolean = true
) {
    val alpha = if (enabled) 1f else 0.38f
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            SahraText(title, fontSize = 16.sp, fontWeight = FontWeight.Medium, color = TextPrimary.copy(alpha = alpha))
            if (subtitle != null) SahraText(subtitle, fontSize = 13.sp, color = TextSecondary.copy(alpha = alpha))
        }
        SahraText(
            text = value,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            color = NebulaCrimson.copy(alpha = alpha),
            modifier = Modifier
                .clip(MaterialTheme.shapes.small)
                .background(NebulaCrimson.copy(alpha = 0.12f * alpha))
                .padding(horizontal = 10.dp, vertical = 4.dp)
        )
    }
}

@Composable
private fun SettingsActionRow(
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    color: Color = TextPrimary,
    enabled: Boolean = true
) {
    val alpha = if (enabled) 1f else 0.38f
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            SahraText(title, fontSize = 16.sp, fontWeight = FontWeight.Medium, color = color.copy(alpha = alpha))
            if (subtitle != null) SahraText(subtitle, fontSize = 13.sp, color = TextSecondary.copy(alpha = alpha))
        }
    }
}

@Composable
private fun SettingsInfoRow(
    title: String,
    value: String,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        SahraText(title, fontSize = 16.sp, fontWeight = FontWeight.Medium, color = TextPrimary)
        SahraText(value, fontSize = 14.sp, color = TextSecondary)
    }
}

// ── Playlist card row ─────────────────────────────────────────────────────────

@Composable
private fun PlaylistItemRow(
    p: PlaylistEntity,
    onRefresh: (PlaylistEntity) -> Unit,
    onRemove: (PlaylistEntity) -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 14.dp)
    ) {
        SahraText(
            text = "${p.name}  ·  ${p.type.name}",
            fontSize = 15.sp,
            fontWeight = FontWeight.Medium,
            color = TextPrimary
        )
        val status = when (p.syncState) {
            SyncState.NEVER   -> "Waiting to sync"
            SyncState.RUNNING -> p.syncMessage ?: "Syncing…"
            SyncState.OK      -> "${p.itemCount} items · synced ${
                DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
                    .format(Date(p.lastUpdated))
            }${p.syncMessage?.let { " · $it" } ?: ""}"
            SyncState.FAILED  -> "Failed: ${p.syncMessage}"
        }
        SahraText(
            status,
            fontSize = 13.sp,
            color = TextSecondary,
            modifier = Modifier.padding(bottom = 10.dp)
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SahraButton(
                onClick = { onRefresh(p) },
                enabled = p.syncState != SyncState.RUNNING,
                modifier = Modifier.weight(1f)
            ) { SahraText("Refresh") }
            SahraButton(
                onClick = { onRemove(p) },
                modifier = Modifier.weight(1f)
            ) { SahraText("Remove") }
        }
    }
}

// ── Add playlist form ─────────────────────────────────────────────────────────

@Composable
private fun AddPlaylistForm(
    busy: Boolean,
    onSubmit: (PlaylistType, String, String, String, String, String, String, String) -> Unit
) {
    var type by rememberSaveable { mutableStateOf(PlaylistType.M3U) }
    var name by rememberSaveable { mutableStateOf("") }
    var url  by rememberSaveable { mutableStateOf("") }
    var user by rememberSaveable { mutableStateOf("") }
    var pass by rememberSaveable { mutableStateOf("") }
    var mac  by rememberSaveable { mutableStateOf("") }
    var epg  by rememberSaveable { mutableStateOf("") }
    var ua   by rememberSaveable { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PlaylistType.entries.forEach { t ->
                SahraButton(
                    onClick = { type = t },
                    modifier = Modifier.weight(1f)
                ) {
                    SahraText(t.name, color = if (t == type) TextPrimary else TextSecondary)
                }
            }
        }
        Field(name, { name = it }, "Name (optional)")
        Field(
            url, { url = it }, when (type) {
                PlaylistType.M3U     -> "Playlist URL  (http://…/playlist.m3u)"
                PlaylistType.XTREAM  -> "Server  (http://host:port)"
                PlaylistType.STALKER -> "Portal URL  (http://host:port/c/)"
            }, KeyboardType.Uri
        )
        if (type == PlaylistType.XTREAM) {
            Field(user, { user = it }, "Username")
            Field(pass, { pass = it }, "Password", password = true)
        }
        if (type == PlaylistType.STALKER) {
            Field(mac, { mac = it }, "MAC address  (00:1A:79:…)")
        }
        if (type != PlaylistType.XTREAM) {
            Field(epg, { epg = it }, "EPG / XMLTV URL (optional)", KeyboardType.Uri)
        }
        Field(ua, { ua = it }, "Custom User-Agent (optional)")
        SahraButton(
            onClick = { onSubmit(type, name, url, user, pass, mac, epg, ua) },
            enabled = !busy && url.isNotBlank(),
            modifier = Modifier.fillMaxWidth()
        ) {
            SahraText(if (busy) "Checking…" else "Save & sync")
        }
    }
}

@Composable
private fun Field(
    value: String,
    onChange: (String) -> Unit,
    label: String,
    keyboard: KeyboardType = KeyboardType.Text,
    password: Boolean = false
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        singleLine = true,
        label = { Text(label) },
        keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else keyboard),
        visualTransformation = if (password) PasswordVisualTransformation()
                               else VisualTransformation.None,
        modifier = Modifier.fillMaxWidth()
    )
}
