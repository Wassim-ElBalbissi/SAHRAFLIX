package com.sahraflix.data

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sahraflix.data.sources.*
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Executes the shipped JS bundle inside a real Android WebView, against local fixtures. */
@RunWith(AndroidJUnit4::class)
class MarqueeRuntimeTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun bundledAddonResolvesEpisodeHeadersSubtitlesAndMagnet() = runBlocking<Unit> {
        val server = MockWebServer().apply { start() }
        val preferences = SourcePreferences(context)
        val enabled = preferences.definitions().associate { it.id to preferences.enabled(it.id) }
        try {
            enabled.keys.forEach { preferences.setEnabled(it, false) }
            preferences.saveAddon("test-fixture", "Fixture addon", server.url("/manifest.json").toString())
            preferences.setEnabled("test-fixture", true)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = when {
                    request.path!!.startsWith("/stream/series/tt123%3A2%3A3.json") -> MockResponse().setBody("""{"streams":[
                        {"url":"${server.url("/video.m3u8")}","name":"1080p","behaviorHints":{"proxyHeaders":{"request":{"Referer":"https://fixture.test/","X-Source":"fixture"}}},"subtitles":[{"url":"${server.url("/ar.vtt")}","lang":"ar"}]},
                        {"infoHash":"0123456789abcdef0123456789abcdef01234567","fileIdx":4,"sources":["tracker:udp://tracker.test:80/announce"],"name":"720p"}
                    ]}""")
                    request.path!!.startsWith("/subtitles/") -> MockResponse().setBody("""{"subtitles":[]}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
            val runtime = MarqueeSourceRuntime(context, OkHttpClient(), preferences, BrowserSourceResolver(context))
            val events = withTimeout(20_000) { runtime.resolve(JSONObject()
                .put("type", "series").put("tmdbId", 1).put("imdbId", "tt123").put("season", 2).put("episode", 3).put("title", "Fixture")).toList() }
            val streams = events.filter { it.optString("type") == "streams" }.flatMap { event ->
                val array = event.getJSONArray("streams")
                (0 until array.length()).mapNotNull { SourceStream.parse(array.getJSONObject(it)) }
            }
            assertEquals("Events: $events, requests: ${server.requestCount}", 2, streams.size)
            assertEquals("fixture", streams.first().headers["X-Source"])
            assertEquals("https://fixture.test/", streams.first().headers["Referer"])
            assertTrue(streams.last().isTorrent)
            assertTrue(streams.last().url.contains("so=4"))
            val subtitleEvent = events.first { it.optString("type") == "subtitles" }
            assertEquals("ar", subtitleEvent.getJSONArray("subtitles").getJSONObject(0).getString("lang"))
            assertEquals("complete", events.last().getString("type"))
        } finally {
            preferences.removeAddon("test-fixture")
            enabled.forEach { (id, value) -> preferences.setEnabled(id, value) }
            server.shutdown()
        }
    }

    @Test fun providerBrowserCapturesMediaWithoutNativeBridgeOrDownloadingVideo() = runBlocking<Unit> {
        val server = MockWebServer().apply { start() }
        try {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = if (request.path == "/embed")
                    MockResponse().setHeader("Content-Type", "text/html").setBody("""
                        <script>fetch('/bridge-' + typeof SahraBridge).then(() => fetch('/master.m3u8'));</script>
                    """.trimIndent()) else MockResponse().setBody("ok")
            }
            val result = withTimeout(15_000) { BrowserSourceResolver(context).resolve(server.url("/embed").toString(), 10_000, null) }
            assertEquals(server.url("/master.m3u8").toString(), result.getString("file"))
            val paths = (0 until server.requestCount).map { server.takeRequest().path }
            assertTrue(paths.contains("/bridge-undefined"))
            assertFalse(paths.contains("/master.m3u8"))
        } finally { server.shutdown() }
    }

    @Test fun selectedArabicSubtitleUsesOwnHeadersAndLocalUtf8File() = runBlocking<Unit> {
        val server = MockWebServer().apply { start() }
        try {
            val text = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nمرحبا بكم\n"
            server.enqueue(MockResponse().setHeader("Content-Type", "text/vtt; charset=utf-8").setBody(text))
            val result = SourceSubtitleLoader(context, OkHttpClient(), SourcePreferences(context)).load(
                SourceSubtitle(server.url("/ar.vtt").toString(), "العربية", "ar", "vtt", mapOf("Referer" to "https://subtitle.test/")))
            val file = File(java.net.URI(result.url))
            try {
                assertEquals(text, file.readText())
                assertEquals("text/vtt", result.mimeType)
                assertEquals("https://subtitle.test/", server.takeRequest().getHeader("Referer"))
            } finally { file.delete() }
        } finally { server.shutdown() }
    }
}
