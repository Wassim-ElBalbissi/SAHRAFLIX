package com.sahraflix.presentation.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LiveTv
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Text
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRailItemDefaults
import com.sahraflix.presentation.theme.NebulaCrimson
import com.sahraflix.presentation.theme.TextPrimary
import com.sahraflix.presentation.theme.TextSecondary
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.sahraflix.domain.model.CatalogEntry
import com.sahraflix.presentation.detail.DetailScreen
import com.sahraflix.presentation.epg.EpgGuideScreen
import com.sahraflix.presentation.home.HomeScreen
import com.sahraflix.presentation.iptv.IptvScreen
import com.sahraflix.presentation.pairing.PairingScreen
import com.sahraflix.presentation.player.SubtitleSettingsScreen
import com.sahraflix.presentation.search.SearchScreen
import com.sahraflix.presentation.settings.SettingsScreen
import com.sahraflix.presentation.sources.SourcesScreen
import com.sahraflix.presentation.sources.SourceSettingsScreen
import com.sahraflix.presentation.LocalUiEnvironment
import android.net.Uri

object AppRoutes {
    const val HOME = "home"
    const val IPTV = "iptv"
    const val GUIDE = "guide"
    const val SEARCH = "search"
    const val SETTINGS = "settings"
    const val PAIR = "pair"
    const val SUBTITLES = "subtitles"
    const val DETAIL = "detail/{id}"
    const val SOURCE_SETTINGS = "source-settings"
    const val SOURCES = "sources/{type}/{tmdbId}?season={season}&episode={episode}"
    fun detail(entry: CatalogEntry) = "detail/" + Uri.encode(entry.id)
    fun sources(entry: CatalogEntry.Tmdb) = "sources/${if (entry.isSeries) "tv" else "movie"}/${entry.tmdbId}"
    fun resumeSource(id: String): String? {
        val match = Regex("tmdb-(movie|tv)-(\\d+)(?::s(\\d+):e(\\d+))?").matchEntire(id) ?: return null
        val (type, tmdbId, season, episode) = match.destructured
        return "sources/$type/$tmdbId" + if (season.isNotEmpty()) "?season=$season&episode=$episode" else ""
    }
}

private data class Dest(val route: String, val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector)
private val destinations = listOf(
    Dest(AppRoutes.HOME, "Home", Icons.Default.Home),
    Dest(AppRoutes.IPTV, "IPTV", Icons.Default.LiveTv),
    Dest(AppRoutes.GUIDE, "Guide", Icons.Default.DateRange),
    Dest(AppRoutes.SEARCH, "Search", Icons.Default.Search),
    Dest(AppRoutes.SETTINGS, "Settings", Icons.Default.Settings)
)

@Composable
fun AppNavigation() {
    val env = LocalUiEnvironment.current
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val current = entry?.destination?.route
    val go: (String) -> Unit = { route ->
        nav.navigate(route) {
            // Selecting a top-level destination must leave its detail/source subpage.
            popUpTo(nav.graph.findStartDestination().id)
            launchSingleTop = true
        }
    }
    
    if (env.isTv) {
        TvNavigationScaffold(nav = nav, currentRoute = current, onNavigate = go) {
            Graph(nav, Modifier.fillMaxSize())
        }
    } else {
        PhoneNavigationScaffold(nav = nav, currentRoute = current, onNavigate = go) {
            Graph(nav, Modifier.weight(1f))
        }
    }
}

@Composable
private fun TvNavigationScaffold(
    nav: NavHostController,
    currentRoute: String?,
    onNavigate: (String) -> Unit,
    content: @Composable () -> Unit
) {
    // Basic NavigationRail for TV (can be upgraded to tv.material3.NavigationDrawer later per Claude's plan)
    Row(Modifier.fillMaxSize()) {
        NavigationRail {
            destinations.forEach { d ->
                NavigationRailItem(
                    selected = currentRoute == d.route, 
                    onClick = { onNavigate(d.route) },
                    icon = { Icon(d.icon, d.label) }, 
                    label = { Text(d.label) },
                    colors = NavigationRailItemDefaults.colors(
                        indicatorColor        = NebulaCrimson,
                        selectedIconColor     = TextPrimary,
                        selectedTextColor     = TextPrimary,
                        unselectedIconColor   = TextSecondary,
                        unselectedTextColor   = TextSecondary
                    )
                )
            }
        }
        Box(Modifier.weight(1f)) {
            content()
        }
    }
}

@Composable
private fun PhoneNavigationScaffold(
    nav: NavHostController,
    currentRoute: String?,
    onNavigate: (String) -> Unit,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(Modifier.fillMaxSize()) {
        content()
        NavigationBar {
            destinations.forEach { d ->
                NavigationBarItem(
                    selected = currentRoute == d.route, 
                    onClick = { onNavigate(d.route) },
                    icon = { Icon(d.icon, d.label) }, 
                    label = { Text(d.label) },
                    colors = NavigationBarItemDefaults.colors(
                        indicatorColor        = NebulaCrimson,
                        selectedIconColor     = TextPrimary,
                        selectedTextColor     = TextPrimary,
                        unselectedIconColor   = TextSecondary,
                        unselectedTextColor   = TextSecondary
                    )
                )
            }
        }
    }
}

@Composable
private fun Graph(nav: NavHostController, modifier: Modifier) {
    val openDetail: (CatalogEntry) -> Unit = { nav.navigate(AppRoutes.detail(it)) }
    NavHost(nav, startDestination = AppRoutes.HOME, modifier = modifier) {
        composable(AppRoutes.HOME) { HomeScreen(onOpenDetail = openDetail, onAddPlaylist = { nav.navigate(AppRoutes.SETTINGS) },
            onResumeSource = { id -> AppRoutes.resumeSource(id)?.let { nav.navigate(it) } },
            onSources = { nav.navigate(AppRoutes.SOURCE_SETTINGS) }) }
        composable(AppRoutes.IPTV) { IptvScreen(onOpenDetail = openDetail) }
        composable(AppRoutes.GUIDE) { EpgGuideScreen() }
        composable(AppRoutes.SEARCH) { SearchScreen(onOpenDetail = openDetail) }
        composable(AppRoutes.SETTINGS) {
            SettingsScreen(onPair = { nav.navigate(AppRoutes.PAIR) }, onSubtitles = { nav.navigate(AppRoutes.SUBTITLES) },
                onSources = { nav.navigate(AppRoutes.SOURCE_SETTINGS) })
        }
        composable(AppRoutes.SOURCE_SETTINGS) { SourceSettingsScreen() }
        composable(AppRoutes.SOURCES, arguments = listOf(
            navArgument("type") { type = NavType.StringType }, navArgument("tmdbId") { type = NavType.StringType },
            navArgument("season") { type = NavType.IntType; defaultValue = 0 },
            navArgument("episode") { type = NavType.IntType; defaultValue = 0 }
        )) { SourcesScreen(onSettings = { nav.navigate(AppRoutes.SOURCE_SETTINGS) }) }
        composable(AppRoutes.PAIR) { PairingScreen(onDone = { nav.popBackStack(AppRoutes.HOME, inclusive = false) }) }
        composable(AppRoutes.SUBTITLES) { SubtitleSettingsScreen() }
        composable(AppRoutes.DETAIL, arguments = listOf(navArgument("id") { type = NavType.StringType })) {
            DetailScreen(onOpenDetail = openDetail, onFindSources = { nav.navigate(AppRoutes.sources(it)) })
        }
    }
}
