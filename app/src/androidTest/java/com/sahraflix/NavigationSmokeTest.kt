package com.sahraflix

import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.room.Room
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sahraflix.data.local.ALL_MIGRATIONS
import com.sahraflix.data.local.IptvDatabase
import com.sahraflix.data.local.entity.*
import com.sahraflix.data.local.secureUserPreferences
import com.sahraflix.domain.model.StreamType
import com.sahraflix.presentation.MainActivity
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Real Room -> ViewModel -> navigation smoke test using only a local fixture server. */
@RunWith(AndroidJUnit4::class)
class NavigationSmokeTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun moviesSeriesAndGuideAreReachable() = runBlocking<Unit> {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val preferences = context.secureUserPreferences()
        val previousMode = preferences.getString("ui_mode")
        preferences.putString("ui_mode", "TV")
        val db = Room.databaseBuilder(context, IptvDatabase::class.java, "iptv.db")
            .addMigrations(*ALL_MIGRATIONS).build()
        val server = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl?.queryParameter("action")) {
                    "get_series_info" -> MockResponse().setBody("""{"episodes":{"1":[{"id":"101","season":1,"episode_num":1,"title":"First episode"}]}}""")
                    "get_vod_info" -> MockResponse().setBody("""{"info":{"plot":"Movie details from your provider","cast":"Fixture Actor","releasedate":"2010"}}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
            start()
        }
        val playlist = PlaylistEntity("smoke", "Smoke library", server.url("/").toString(), "demo", "demo", PlaylistType.XTREAM, 0)
        val profileId = db.userProfileDao().insert(UserProfileEntity(name = "Smoke viewer"))
        try {
            db.playlistDao().upsert(playlist)
            db.streamDao().upsertStreams(listOf(
                StreamItemEntity("smoke:series+%", "Fixture Series", "xtream-series:42", null, StreamType.SERIES, "smoke:series", "smoke", providerId = "42"),
                StreamItemEntity("smoke:movie", "Fixture Movie", server.url("/movie.mp4").toString(), null, StreamType.MOVIE, "smoke:movies", "smoke", providerId = "43")
            ))
            ActivityScenario.launch(MainActivity::class.java).use {
                waitFor("Smoke viewer")
                activate("Smoke viewer")
                waitFor("IPTV")
                activate("IPTV")
                waitFor("Series")
                activate("Series")
                waitFor("Fixture Series")
                compose.onNode(hasText("Fixture Series") and hasClickAction()).performSemanticsAction(SemanticsActions.OnClick) { it() }
                waitFor("1. First episode")
                compose.onNodeWithText("Season 1").assertIsDisplayed()
                screenshot("series-details.png")

                activate("IPTV")
                waitFor("Movies")
                activate("Movies")
                waitFor("Fixture Movie")
                compose.onNode(hasText("Fixture Movie") and hasClickAction()).performSemanticsAction(SemanticsActions.OnClick) { it() }
                waitFor("Movie details from your provider")
                compose.onNodeWithText("Play").assertIsDisplayed()
                compose.onNodeWithText("Cast: Fixture Actor").assertIsDisplayed()
                screenshot("movie-details.png")

                activate("Guide")
                waitFor("TV guide")
                compose.onNodeWithText("TV guide").assertIsDisplayed()
                activate("Settings")
                waitFor("Marquee sources")
                compose.onNodeWithText("Marquee sources").performScrollTo()
                activate("Marquee sources")
                waitFor("TMDB key or read token")
                screenshot("source-settings.png")
            }
        } finally {
            db.playlistDao().delete(playlist)
            db.userProfileDao().getById(profileId)?.let { db.userProfileDao().delete(it) }
            if (previousMode == null) preferences.remove("ui_mode") else preferences.putString("ui_mode", previousMode)
            db.close()
            server.shutdown()
        }
    }

    private fun waitFor(text: String) {
        try {
            compose.waitUntil(15_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
        } catch (error: ComposeTimeoutException) {
            screenshot("navigation-failure.png")
            throw AssertionError("Missing $text\n${compose.onRoot().printToString()}", error)
        }
    }

    private fun activate(text: String) {
        compose.onNode(hasText(text) and hasClickAction()).performSemanticsAction(SemanticsActions.OnClick) { it() }
    }

    private fun screenshot(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getExternalFilesDir(null), name).outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
