package com.sahraflix.data

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sahraflix.data.local.IptvDatabase
import com.sahraflix.data.local.entity.PlaylistEntity
import com.sahraflix.data.local.entity.PlaylistType
import com.sahraflix.data.local.entity.StreamItemEntity
import com.sahraflix.data.remote.TmdbApi
import com.sahraflix.data.remote.TmdbClient
import com.sahraflix.data.repository.StalkerProviderImpl
import com.sahraflix.data.repository.UnifiedContentRepository
import com.sahraflix.data.repository.XtreamProviderImpl
import com.sahraflix.domain.model.StreamType
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.io.IOException
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class XtreamDetailsTest {
    private lateinit var server: MockWebServer
    private lateinit var db: IptvDatabase
    private val client = OkHttpClient.Builder().callTimeout(5, TimeUnit.SECONDS).build()
    private val provider = XtreamProviderImpl(client)
    private lateinit var playlist: PlaylistEntity

    @Before fun setup() {
        server = MockWebServer().apply { start() }
        db = Room.inMemoryDatabaseBuilder(
            InstrumentationRegistry.getInstrumentation().targetContext, IptvDatabase::class.java
        ).build()
        playlist = PlaylistEntity("p", "Test", server.url("/").toString(), "a+b", "p/&", PlaylistType.XTREAM, 0)
    }

    @After fun cleanup() { db.close(); server.shutdown() }

    private fun repository(tmdbEnabled: Boolean = false): UnifiedContentRepository {
        val api = Retrofit.Builder().baseUrl(server.url("/tmdb/"))
            .client(client)
            .addConverterFactory(MoshiConverterFactory.create(Moshi.Builder().addLast(KotlinJsonAdapterFactory()).build()))
            .build().create(TmdbApi::class.java)
        return UnifiedContentRepository(db.streamDao(), db.playlistDao(), db.streamingItemDao(), db.dashboardDao(),
            TmdbClient(api, tmdbEnabled), provider, StalkerProviderImpl(client))
    }

    private suspend fun seed(type: StreamType = StreamType.MOVIE) {
        db.playlistDao().upsert(playlist)
        db.streamDao().upsertStreams(listOf(StreamItemEntity("s", "Sintel (2010)",
            if (type == StreamType.SERIES) "xtream-series:42" else server.url("/movie.mp4").toString(),
            null, type, "c", "p", providerId = "42")))
    }

    @Test fun movieDetailsUseProviderWithoutTmdbKey() = runBlocking {
        seed()
        server.enqueue(MockResponse().setBody("""{"info":{"plot":"A dragon story","movie_image":"https://example.test/poster.jpg","backdrop_path":["https://example.test/backdrop.jpg"],"rating":"7.5","releasedate":"2010-01-01","cast":"Actor One","director":"Director One"}}"""))
        val details = repository().iptvDetails("s")
        assertEquals("A dragon story", details.description)
        assertEquals(2010, details.releaseYear)
        assertEquals(7.5, details.rating)
        assertEquals("Actor One", details.cast)
        assertEquals("Director One", details.director)
        assertEquals("https://example.test/poster.jpg", details.posterUrl)
        val request = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("get_vod_info", request.requestUrl!!.queryParameter("action"))
        assertEquals("42", request.requestUrl!!.queryParameter("vod_id"))
        assertEquals("a+b", request.requestUrl!!.queryParameter("username"))
        assertEquals("p/&", request.requestUrl!!.queryParameter("password"))
    }

    @Test fun optionalMetadataFailureDoesNotPreventPlayback() = runBlocking {
        seed()
        server.enqueue(MockResponse().setResponseCode(401)) // TMDB search
        server.enqueue(MockResponse().setResponseCode(500)) // provider metadata
        val repo = repository(tmdbEnabled = true)
        val details = repo.iptvDetails("s")
        assertNull(details.description)
        assertEquals(server.url("/movie.mp4").toString(), repo.playRequest(details.entry).url)
    }

    @Test fun seriesSupportsArrayShapedEpisodesAndSortsThem() = runBlocking {
        seed(StreamType.SERIES)
        server.enqueue(MockResponse().setBody("""{"episodes":[[{"id":2,"season":1,"episode_num":2,"title":"Second","container_extension":"mkv"},{"id":"1","season":1,"episode_num":1,"title":"First"}]]}"""))
        val details = repository().iptvDetails("s")
        assertEquals(listOf("First", "Second"), details.seasons[1]!!.map { it.title })
        assertTrue(details.seasons[1]!![1].streamUrl.endsWith("/series/a%2Bb/p%2F%26/2.mkv"))
        assertTrue(details.seasons[1]!![0].streamUrl.endsWith("/1.mp4"))
    }

    @Test fun nullMovieFieldsDoNotRenderAsLiteralNull() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"info":{"plot":null,"cast":"null","rating":"NaN","releasedate":null,"movie_image":"javascript:bad"}}"""))
        val info = provider.movieInfo(playlist, "42")
        assertNull(info.plot); assertNull(info.cast); assertNull(info.rating); assertNull(info.year); assertNull(info.poster)
    }

    @Test fun authenticationRequiresExplicitSuccess() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"user_info":{"status":"Active"}}"""))
        try {
            provider.authenticate(provider.account(playlist))
            fail("Missing auth must be rejected")
        } catch (_: IOException) { }
    }

    @Test fun zeroExpiryMeansUnlimitedSubscription() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"user_info":{"auth":"1","exp_date":"0","allowed_output_formats":["ts"]}}"""))
        assertEquals("ts", provider.authenticate(provider.account(playlist)).liveExtension)
    }
}
