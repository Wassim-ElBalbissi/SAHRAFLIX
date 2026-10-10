package com.sahraflix.presentation.iptv

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LiveTv
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.paging.LoadState
import androidx.paging.compose.collectAsLazyPagingItems
import coil.compose.AsyncImage
import com.sahraflix.domain.model.CatalogEntry
import com.sahraflix.presentation.components.SahraFocusCard
import com.sahraflix.presentation.components.SahraText
import com.sahraflix.presentation.components.SahraButton
import com.sahraflix.presentation.LocalUiEnvironment
import com.sahraflix.presentation.components.StreamCard
import com.sahraflix.presentation.player.LocalPlayerViewModel
import com.sahraflix.presentation.theme.AbyssBlue
import com.sahraflix.presentation.theme.CrimsonLight
import com.sahraflix.presentation.theme.InkCard
import com.sahraflix.presentation.theme.NebulaCrimson
import com.sahraflix.presentation.theme.SlateElevated
import com.sahraflix.presentation.theme.TextMuted
import com.sahraflix.presentation.theme.TextPrimary
import com.sahraflix.presentation.theme.TextSecondary
import com.sahraflix.presentation.theme.VoidBlack

@Composable
fun IptvScreen(
    onOpenDetail: (CatalogEntry) -> Unit,
    viewModel: IptvViewModel = hiltViewModel()
) {
    val categories by viewModel.categories.collectAsState()
    val selectedCatId by viewModel.selectedCategoryId.collectAsState()
    val selectedTab by viewModel.selectedTab.collectAsState()
    val channels = viewModel.channels.collectAsLazyPagingItems()
    val player = LocalPlayerViewModel.current
    val isTv = LocalUiEnvironment.current.isTv

    Row(modifier = Modifier.fillMaxSize().background(VoidBlack)) {
        if (isTv) CategorySidebar(
            categories = categories.map { it.id to it.name },
            allLabel = "All ${selectedTab.name.lowercase().replace("live", "channels")}",
            selectedCategoryId = selectedCatId,
            onSelectCategory = viewModel::selectCategory
        )
        Column(modifier = Modifier.weight(1f).fillMaxSize()) {
            TabStrip(
                selectedTab = selectedTab,
                onSelectTab = viewModel::selectTab,
                modifier = Modifier.padding(start = 24.dp, top = 24.dp, end = 24.dp)
            )
            if (!isTv) {
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    item {
                        SahraButton(onClick = { viewModel.selectCategory(null) }) {
                            SahraText("All", color = if (selectedCatId == null) TextPrimary else TextSecondary)
                        }
                    }
                    items(categories, key = { it.id }) { category ->
                        SahraButton(onClick = { viewModel.selectCategory(category.id) }) {
                            SahraText(category.name, color = if (selectedCatId == category.id) TextPrimary else TextSecondary)
                        }
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
            when {
                channels.loadState.refresh is LoadState.Loading -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(color = NebulaCrimson)
                    }
                }
                channels.loadState.refresh is LoadState.Error -> {
                    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        SahraText("Couldn't load your library.", color = TextSecondary)
                        SahraButton(onClick = { channels.retry() }) { SahraText("Try again") }
                    }
                }
                channels.itemCount == 0 && channels.loadState.refresh is LoadState.NotLoading -> {
                    EmptyChannelState(tab = selectedTab)
                }
                else -> {
                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(
                            minSize = if (selectedTab == IptvTab.LIVE) 220.dp else 160.dp
                        ),
                        horizontalArrangement = Arrangement.spacedBy(16.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                        modifier = Modifier.fillMaxSize().padding(horizontal = 24.dp),
                        contentPadding = PaddingValues(bottom = 32.dp)
                    ) {
                        items(channels.itemCount) { index ->
                            val entry = channels[index]
                            if (entry is CatalogEntry.Iptv) {
                                if (selectedTab == IptvTab.LIVE) {
                                    ChannelCard(
                                        channel = entry,
                                        onClick = { player.play(entry) },
                                        onLongClick = { player.toggleFavorite(entry) }
                                    )
                                } else {
                                    StreamCard(
                                        entry = entry,
                                        onClick = onOpenDetail
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CategorySidebar(
    categories: List<Pair<String, String>>,
    allLabel: String,
    selectedCategoryId: String?,
    onSelectCategory: (String?) -> Unit
) {
    Box(
        modifier = Modifier
            .widthIn(min = 220.dp, max = 260.dp)
            .fillMaxHeight()
            .background(AbyssBlue)
    ) {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(vertical = 24.dp)
        ) {
            item {
                SidebarItem(
                    name = allLabel,
                    isSelected = selectedCategoryId == null,
                    onClick = { onSelectCategory(null) }
                )
            }
            items(categories) { (id, name) ->
                SidebarItem(
                    name = name,
                    isSelected = selectedCategoryId == id,
                    onClick = { onSelectCategory(id) }
                )
            }
        }
    }
}

@Composable
private fun SidebarItem(
    name: String,
    isSelected: Boolean,
    onClick: () -> Unit
) {
    val interactionSource = remember { MutableInteractionSource() }
    val isFocused by interactionSource.collectIsFocusedAsState()

    val bgColor by animateColorAsState(
        targetValue = when {
            isFocused -> NebulaCrimson.copy(alpha = 0.75f)
            isSelected -> SlateElevated
            else -> Color.Transparent
        },
        label = "sidebarBg"
    )
    val textColor by animateColorAsState(
        targetValue = if (isSelected || isFocused) TextPrimary else TextSecondary,
        label = "sidebarText"
    )

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 3.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(bgColor)
            .clickable(interactionSource = interactionSource, indication = null, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (isSelected) {
            Box(Modifier.size(4.dp).background(NebulaCrimson, CircleShape))
            Spacer(Modifier.width(10.dp))
        } else {
            Spacer(Modifier.width(14.dp))
        }
        SahraText(
            text = name,
            color = textColor,
            fontSize = 15.sp,
            fontWeight = if (isSelected || isFocused) FontWeight.SemiBold else FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun TabStrip(
    selectedTab: IptvTab,
    onSelectTab: (IptvTab) -> Unit,
    modifier: Modifier = Modifier
) {
    LazyRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        items(IptvTab.entries.toTypedArray()) { tab ->
            TabChip(
                label = when (tab) {
                    IptvTab.LIVE -> "Live TV"
                    IptvTab.MOVIES -> "Movies"
                    IptvTab.SERIES -> "Series"
                },
                icon = when (tab) {
                    IptvTab.LIVE -> Icons.Default.LiveTv
                    IptvTab.MOVIES -> Icons.Default.Movie
                    IptvTab.SERIES -> Icons.Default.Tv
                },
                isSelected = selectedTab == tab,
                onClick = { onSelectTab(tab) }
            )
        }
    }
}

@Composable
private fun TabChip(
    label: String,
    icon: ImageVector,
    isSelected: Boolean,
    onClick: () -> Unit
) {
    val interactionSource = remember { MutableInteractionSource() }
    val isFocused by interactionSource.collectIsFocusedAsState()

    val bgColor by animateColorAsState(
        targetValue = when {
            isSelected -> NebulaCrimson
            isFocused -> SlateElevated
            else -> InkCard
        },
        label = "tabBg"
    )

    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(24.dp))
            .background(bgColor)
            .then(
                if (isFocused && !isSelected)
                    Modifier.border(2.dp, CrimsonLight, RoundedCornerShape(24.dp))
                else Modifier
            )
            .clickable(interactionSource = interactionSource, indication = null, onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = TextPrimary,
            modifier = Modifier.size(16.dp)
        )
        SahraText(
            text = label,
            color = TextPrimary,
            fontSize = if (isSelected) 16.sp else 14.sp,
            fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium
        )
    }
}

@Composable
private fun ChannelCard(
    channel: CatalogEntry.Iptv,
    onClick: () -> Unit,
    onLongClick: () -> Unit
) {
    SahraFocusCard(
        onClick = onClick,
        onLongClick = onLongClick,
        modifier = Modifier.fillMaxWidth().height(120.dp)
    ) {
        if (!channel.stream.logoUrl.isNullOrBlank()) {
            AsyncImage(
                model = channel.stream.logoUrl,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 24.dp, vertical = 16.dp)
            )
        } else {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(
                        Brush.radialGradient(
                            listOf(NebulaCrimson.copy(alpha = 0.08f), Color.Transparent)
                        )
                    ),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = Icons.Default.LiveTv,
                    contentDescription = null,
                    tint = TextMuted,
                    modifier = Modifier.size(36.dp)
                )
            }
        }

        // Bottom scrim with channel name
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .align(Alignment.BottomStart)
                .background(
                    Brush.verticalGradient(
                        listOf(Color.Transparent, VoidBlack.copy(alpha = 0.85f))
                    )
                )
                .padding(horizontal = 12.dp, vertical = 10.dp)
        ) {
            SahraText(
                text = channel.title,
                color = TextPrimary,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }

        // LIVE badge
        Box(
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(8.dp)
                .clip(RoundedCornerShape(4.dp))
                .background(NebulaCrimson)
                .padding(horizontal = 6.dp, vertical = 2.dp)
        ) {
            SahraText(
                text = "LIVE",
                color = Color.White,
                fontSize = 9.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.8.sp
            )
        }
    }
}

@Composable
private fun EmptyChannelState(tab: IptvTab) {
    val icon = when (tab) {
        IptvTab.LIVE -> Icons.Default.LiveTv
        IptvTab.MOVIES -> Icons.Default.Movie
        IptvTab.SERIES -> Icons.Default.Tv
    }
    val message = when (tab) {
        IptvTab.LIVE -> "No live channels in this category"
        IptvTab.MOVIES -> "No movies in this category"
        IptvTab.SERIES -> "No series in this category"
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = TextMuted,
                modifier = Modifier.size(56.dp)
            )
            Spacer(Modifier.height(16.dp))
            SahraText(text = message, color = TextSecondary, fontSize = 16.sp)
        }
    }
}
