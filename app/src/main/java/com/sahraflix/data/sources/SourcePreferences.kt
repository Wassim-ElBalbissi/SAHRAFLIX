package com.sahraflix.data.sources

import android.content.Context
import com.sahraflix.BuildConfig
import com.sahraflix.data.local.SecurePreferences
import dagger.hilt.android.qualifiers.ApplicationContext
import org.json.JSONArray
import org.json.JSONObject
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.map

data class SourceDefinition(val id: String, val name: String, val description: String)

@Singleton
class SourcePreferences @Inject constructor(@ApplicationContext context: Context) {
    private val preferences = SecurePreferences(context, "source_preferences")
    val tmdbConfigured = preferences.observeString("tmdb_key", "").map { it.isNotBlank() || BuildConfig.TMDB_API_KEY.isNotBlank() }
    var tmdbKey: String
        get() = preferences.getString("tmdb_key").orEmpty().ifBlank { BuildConfig.TMDB_API_KEY }.trim()
        set(value) = preferences.putString("tmdb_key", value.trim())
    var subtitleKey: String
        get() = preferences.getString("subtitle_key").orEmpty()
        set(value) = preferences.putString("subtitle_key", value.trim())
    var debridService: String
        get() = preferences.getString("debrid_service").orEmpty()
        set(value) = preferences.putString("debrid_service", value.trim())
    var debridKey: String
        get() = preferences.getString("debrid_key").orEmpty()
        set(value) = preferences.putString("debrid_key", value.trim())

    fun enabled(id: String) = preferences.getBoolean("enabled:$id", true)
    fun setEnabled(id: String, value: Boolean) = preferences.putBoolean("enabled:$id", value)
    fun addons(): List<JSONObject> {
        val array = runCatching { JSONArray(preferences.getString("addons") ?: "[]") }.getOrDefault(JSONArray())
        return (0 until array.length()).mapNotNull { array.optJSONObject(it) }
    }
    fun saveAddon(id: String, name: String, target: String) {
        val entries = addons().filterNot { it.optString("id") == id } + JSONObject()
            .put("id", id).put("name", name).put("target", target)
        preferences.putString("addons", JSONArray(entries).toString())
    }
    fun removeAddon(id: String) {
        preferences.putString("addons", JSONArray(addons().filterNot { it.optString("id") == id }).toString())
    }
    fun definitions() = BUILT_INS + addons().map { SourceDefinition(it.getString("id"), it.getString("name"), "Stremio addon") }
    fun runtimeOptions(query: JSONObject) = JSONObject()
        .put("query", query)
        .put("enabled", JSONArray(definitions().filter { enabled(it.id) }.map { it.id }))
        .put("addons", JSONArray(addons()))
        .put("settings", JSONObject().put("openSubtitlesApiKey", subtitleKey)
            .put("debridService", debridService).put("debridApiKey", debridKey))

    companion object {
        val BUILT_INS = listOf(
            SourceDefinition("krmzy", "قرمزي · Krmzy", "Turkish series"),
            SourceDefinition("3isq", "قصة عشق · 3isq", "Turkish series"),
            SourceDefinition("3isk", "قصة عشق · 3isk", "Turkish series"),
            SourceDefinition("qrmzi", "قرمزي · Qrmzi", "Turkish series"),
            SourceDefinition("prstej", "برستيج · Prstej", "Arabic and Turkish series"),
            SourceDefinition("mycima", "ماي سيما · MyCima", "Movies and series"),
            SourceDefinition("qisat", "قصة عشق · Qisat", "Turkish series"),
            SourceDefinition("movish", "Movish", "Movies, series and subtitles"),
            SourceDefinition("vixsrc", "VixSrc", "Movies and series · multiple audio tracks"),
            SourceDefinition("boredflix", "Boredflix", "Movies and series"),
            SourceDefinition("mirrors", "Embed Mirrors", "Movies, series and subtitles"),
            SourceDefinition("relays", "Embed Relays", "Movies and series"),
            SourceDefinition("hydrahd", "HydraHD", "Movies and series"),
            SourceDefinition("anikoto", "Anikoto", "Anime and subtitles"),
            SourceDefinition("reanime", "Reanime", "Anime subtitles"),
            SourceDefinition("opensubtitles", "OpenSubtitles", "Subtitles · your API key required"),
            SourceDefinition("torrentio", "Torrentio", "Debrid streams or an external torrent app")
        )
    }
}
