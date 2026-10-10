package com.sahraflix.data.repository

import android.util.JsonReader
import android.util.JsonToken
import com.sahraflix.data.local.entity.CategoryEntity
import com.sahraflix.data.local.entity.PlaylistEntity
import com.sahraflix.data.local.entity.StreamItemEntity
import com.sahraflix.domain.model.IptvEpisode
import com.sahraflix.domain.model.StreamType
import com.sahraflix.domain.repository.PlaylistProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStreamReader
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Xtream Codes API (player_api.php).
 * Flow: authenticate → categories (live/vod/series) → streams → EPG via xmltv.php.
 * Series episodes are fetched lazily (get_series_info) when the user opens a series.
 */
@Singleton
class XtreamProviderImpl @Inject constructor(
    private val httpClient: OkHttpClient
) : PlaylistProvider {

    data class Account(val baseUrl: String, val username: String, val password: String, val userAgent: String?) {
        fun api(action: String? = null, vararg params: Pair<String, String>): HttpUrl {
            val base = baseUrl.toHttpUrlOrNull() ?: throw IOException("Invalid server address: $baseUrl")
            return base.newBuilder()
                .addPathSegment("player_api.php")
                .addQueryParameter("username", username)
                .addQueryParameter("password", password)
                .apply { action?.let { addQueryParameter("action", it) } }
                .apply { params.forEach { (k, v) -> addQueryParameter(k, v) } }
                .build()
        }
    }

    data class ServerInfo(val liveExtension: String, val timezone: String?)

    fun account(playlist: PlaylistEntity) = Account(
        baseUrl = normalizeBaseUrl(playlist.url),
        username = playlist.username.orEmpty(),
        password = playlist.password.orEmpty(),
        userAgent = playlist.userAgent
    )

    override fun defaultEpgUrl(playlist: PlaylistEntity): String? {
        val acc = account(playlist)
        return acc.baseUrl.toHttpUrlOrNull()?.newBuilder()
            ?.addPathSegment("xmltv.php")
            ?.addQueryParameter("username", acc.username)
            ?.addQueryParameter("password", acc.password)
            ?.build()?.toString()
    }

    override suspend fun sync(playlist: PlaylistEntity, writer: SyncWriter) = withContext(Dispatchers.IO) {
        val acc = account(playlist)
        val info = authenticate(acc)

        val sections = listOf(
            Triple(StreamType.LIVE, "get_live_categories", "get_live_streams"),
            Triple(StreamType.MOVIE, "get_vod_categories", "get_vod_streams"),
            Triple(StreamType.SERIES, "get_series_categories", "get_series")
        )
        for ((type, categoryAction, streamAction) in sections) {
            // Stream objects only carry category_id, so category names must be fetched separately.
            val categoryNames = fetchCategories(acc, categoryAction)
            categoryNames.forEach { (id, name) ->
                writer.category(CategoryEntity(categoryId(playlist.id, type, id), name, playlist.id, type))
            }
            writer.category(CategoryEntity(categoryId(playlist.id, type, UNCATEGORIZED), "Uncategorized", playlist.id, type))
            streamArray(acc, streamAction) { reader, index ->
                readStream(reader, playlist.id, type, acc, info, categoryNames.keys, index)?.let { writer.stream(it) }
            }
        }
    }

    /** Validates the account and returns server capabilities. Throws a user-readable error. */
    suspend fun authenticate(acc: Account): ServerInfo = withContext(Dispatchers.IO) {
        val body = get(acc, acc.api())
        val root = runCatching { JSONObject(body) }.getOrElse {
            throw IOException("This doesn't look like an Xtream Codes server (unexpected response).")
        }
        val user = root.optJSONObject("user_info") ?: throw IOException("Login failed: invalid username or password.")
        if (user.optInt("auth", 0) != 1) throw IOException("Login failed: invalid username or password.")
        val status = user.optString("status")
        if (status.isNotBlank() && !status.equals("Active", ignoreCase = true)) {
            throw IOException("Account status is \"$status\". Contact your provider.")
        }
        user.optString("exp_date").toLongOrNull()?.let { exp ->
            if (exp > 0 && exp < System.currentTimeMillis() / 1000) throw IOException("Your subscription has expired.")
        }
        val formats = user.optJSONArray("allowed_output_formats")?.let { arr -> (0 until arr.length()).map { arr.optString(it) } }.orEmpty()
        // HLS reconnects cleanly after network blips; fall back to MPEG-TS when the panel disallows it.
        val ext = if (formats.isEmpty() || "m3u8" in formats) "m3u8" else "ts"
        ServerInfo(ext, root.optJSONObject("server_info")?.optString("timezone")?.takeIf { it.isNotBlank() })
    }

    suspend fun seriesEpisodes(playlist: PlaylistEntity, seriesProviderId: String): SeriesInfo = withContext(Dispatchers.IO) {
        val acc = account(playlist)
        val root = JSONObject(get(acc, acc.api("get_series_info", "series_id" to seriesProviderId)))
        val info = root.optJSONObject("info")
        val episodesObj = root.opt("episodes")
        val episodes = mutableListOf<IptvEpisode>()
        fun addFrom(arr: JSONArray?, seasonKey: Int) {
            if (arr == null) return
            for (i in 0 until arr.length()) {
                val e = arr.optJSONObject(i) ?: continue
                val id = e.optString("id").takeIf { it.isNotBlank() } ?: continue
                val ext = e.optString("container_extension").ifBlank { "mp4" }
                val epInfo = e.optJSONObject("info")
                episodes += IptvEpisode(
                    id = id,
                    season = e.optInt("season", seasonKey),
                    episode = e.optInt("episode_num", i + 1),
                    title = e.optString("title").ifBlank { "Episode ${i + 1}" },
                    streamUrl = "${acc.baseUrl}/series/${enc(acc.username)}/${enc(acc.password)}/$id.$ext",
                    plot = epInfo?.optString("plot")?.takeIf { it.isNotBlank() },
                    imageUrl = epInfo?.optString("movie_image")?.takeIf { it.startsWith("http") },
                    durationSecs = epInfo?.optInt("duration_secs")?.takeIf { it > 0 }
                )
            }
        }
        // "episodes" is an object keyed by season number on most panels, an array of arrays on some.
        when (episodesObj) {
            is JSONObject -> episodesObj.keys().forEach { key -> addFrom(episodesObj.optJSONArray(key), key.toIntOrNull() ?: 1) }
            is JSONArray -> for (i in 0 until episodesObj.length()) addFrom(episodesObj.optJSONArray(i), i + 1)
        }
        SeriesInfo(
            plot = info?.optString("plot")?.takeIf { it.isNotBlank() },
            backdrop = info?.optJSONArray("backdrop_path")?.optString(0)?.takeIf { it.startsWith("http") },
            rating = info?.optString("rating")?.toDoubleOrNull(),
            year = info?.optString("releaseDate")?.take(4)?.toIntOrNull(),
            episodes = episodes.sortedWith(compareBy({ it.season }, { it.episode }))
        )
    }

    data class SeriesInfo(val plot: String?, val backdrop: String?, val rating: Double?, val year: Int?, val episodes: List<IptvEpisode>)

    /** Provider metadata also works when the optional TMDB key has not been configured. */
    suspend fun movieInfo(playlist: PlaylistEntity, providerId: String): MovieInfo = withContext(Dispatchers.IO) {
        val acc = account(playlist)
        val root = JSONObject(get(acc, acc.api("get_vod_info", "vod_id" to providerId)))
        val info = root.optJSONObject("info")
        val movie = root.optJSONObject("movie_data")
        MovieInfo(
            plot = info.text("plot") ?: info.text("description"),
            backdrop = (info?.optJSONArray("backdrop_path")?.optString(0) ?: info.text("backdrop_path"))
                ?.takeIf { it.toHttpUrlOrNull() != null },
            poster = (info.text("movie_image") ?: info.text("cover_big") ?: movie.text("stream_icon"))
                ?.takeIf { it.toHttpUrlOrNull() != null },
            rating = info.text("rating")?.toDoubleOrNull()?.takeIf { it.isFinite() && it in 0.0..10.0 },
            year = (info.text("releasedate") ?: info.text("releaseDate") ?: info.text("release_date")
                ?: info.text("year"))?.take(4)?.toIntOrNull(),
            cast = info.text("cast") ?: info.text("actors"),
            director = info.text("director")
        )
    }

    data class MovieInfo(
        val plot: String?, val backdrop: String?, val poster: String?, val rating: Double?,
        val year: Int?, val cast: String?, val director: String?
    )

    private fun JSONObject?.text(key: String): String? = this?.opt(key)
        ?.takeIf { it is String || it is Number }?.toString()?.trim()
        ?.takeIf { it.isNotEmpty() && !it.equals("null", true) }

    private fun fetchCategories(acc: Account, action: String): Map<String, String> {
        val body = runCatching { get(acc, acc.api(action)) }.getOrNull() ?: return emptyMap()
        val arr = runCatching { JSONArray(body) }.getOrNull() ?: return emptyMap()
        val result = LinkedHashMap<String, String>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val id = o.optString("category_id").takeIf { it.isNotBlank() } ?: continue
            result[id] = o.optString("category_name").ifBlank { "Category $id" }
        }
        return result
    }

    /** Streams a (potentially huge) JSON array without loading it into memory. */
    private suspend fun streamArray(acc: Account, action: String, onItem: suspend (JsonReader, Int) -> Unit) {
        val request = request(acc, acc.api(action))
        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("Server error ${response.code} on $action")
            val body = response.body ?: return
            JsonReader(InputStreamReader(body.byteStream(), Charsets.UTF_8)).use { reader ->
                if (reader.peek() != JsonToken.BEGIN_ARRAY) { reader.skipValue(); return } // panels return {} when empty
                reader.beginArray()
                var index = 0
                while (reader.hasNext()) {
                    if (reader.peek() == JsonToken.BEGIN_OBJECT) onItem(reader, index++) else reader.skipValue()
                }
                reader.endArray()
            }
        }
    }

    private fun readStream(
        reader: JsonReader,
        playlistId: String,
        type: StreamType,
        acc: Account,
        info: ServerInfo,
        knownCategories: Set<String>,
        index: Int
    ): StreamItemEntity? {
        var id: String? = null
        var name = "Unnamed"
        var icon: String? = null
        var categoryId: String? = null
        var epgId: String? = null
        var ext: String? = null
        var directSource: String? = null
        var archive = false
        var num: Int? = null
        reader.beginObject()
        while (reader.hasNext()) {
            when (reader.nextName()) {
                "stream_id", "series_id" -> id = reader.nextStringOrNull()
                "name" -> name = reader.nextStringOrNull()?.trim()?.ifBlank { null } ?: name
                "stream_icon", "cover" -> icon = reader.nextStringOrNull()?.takeIf { it.startsWith("http") }
                "category_id" -> categoryId = reader.nextStringOrNull()
                "epg_channel_id" -> epgId = reader.nextStringOrNull()?.takeIf { it.isNotBlank() }
                "container_extension" -> ext = reader.nextStringOrNull()?.takeIf { it.isNotBlank() }
                "direct_source" -> directSource = reader.nextStringOrNull()?.takeIf { it.startsWith("http") }
                "tv_archive" -> archive = reader.nextStringOrNull() == "1"
                "num" -> num = reader.nextStringOrNull()?.toIntOrNull()
                else -> reader.skipValue()
            }
        }
        reader.endObject()
        val providerId = id?.takeIf { it.isNotBlank() } ?: return null
        val cat = categoryId?.takeIf { it in knownCategories } ?: UNCATEGORIZED
        val user = enc(acc.username); val pass = enc(acc.password)
        val url = directSource ?: when (type) {
            StreamType.LIVE -> "${acc.baseUrl}/live/$user/$pass/$providerId.${info.liveExtension}"
            StreamType.MOVIE -> "${acc.baseUrl}/movie/$user/$pass/$providerId.${ext ?: "mp4"}"
            // Series rows are containers; episodes are resolved via get_series_info.
            StreamType.SERIES -> "xtream-series:$providerId"
        }
        return StreamItemEntity(
            id = "$playlistId:${type.name}:$providerId",
            name = name,
            streamUrl = url,
            logoUrl = icon,
            streamType = type,
            categoryId = categoryId(playlistId, type, cat),
            playlistId = playlistId,
            epgChannelId = epgId,
            providerId = providerId,
            catchupType = if (archive && type == StreamType.LIVE) CatchupUrlFormatter.TYPE_XTREAM else null,
            // Xtream timeshift: /timeshift/{user}/{pass}/{minutes}/{YYYY-MM-DD:HH-MM}/{id}.ts in server time.
            catchupSource = if (archive && type == StreamType.LIVE) {
                "${acc.baseUrl}/timeshift/$user/$pass/{duration_min}/{xtream_start|${info.timezone ?: "UTC"}}/$providerId.ts"
            } else null,
            userAgent = acc.userAgent,
            sortOrder = num ?: index
        )
    }

    private fun get(acc: Account, url: HttpUrl): String =
        httpClient.newCall(request(acc, url)).execute().use { response ->
            if (response.code == 401 || response.code == 403) throw IOException("Login failed: access denied by server (${response.code}).")
            if (!response.isSuccessful) throw IOException("Server error ${response.code}")
            response.body?.string() ?: throw IOException("Empty response")
        }

    private fun request(acc: Account, url: HttpUrl) = Request.Builder().url(url).apply {
        acc.userAgent?.takeIf { it.isNotBlank() }?.let { header("User-Agent", it) }
    }.build()

    private fun JsonReader.nextStringOrNull(): String? = when (peek()) {
        JsonToken.NULL -> { nextNull(); null }
        JsonToken.STRING, JsonToken.NUMBER -> nextString()
        JsonToken.BOOLEAN -> nextBoolean().toString()
        else -> { skipValue(); null }
    }

    companion object {
        private const val UNCATEGORIZED = "uncategorized"
        fun categoryId(playlistId: String, type: StreamType, id: String) = "$playlistId:${type.name}:cat:$id"
        private fun enc(value: String) = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

        /** Accepts "host:port", "http://host:port/", ".../player_api.php?..." and ".../get.php?..." forms. */
        fun normalizeBaseUrl(input: String): String {
            var url = input.trim()
            if (!url.startsWith("http://", true) && !url.startsWith("https://", true)) url = "http://$url"
            url = url.substringBefore("/player_api.php").substringBefore("/get.php").substringBefore("/xmltv.php")
            return url.trimEnd('/')
        }
    }
}
