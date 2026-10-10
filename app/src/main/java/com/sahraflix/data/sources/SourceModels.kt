package com.sahraflix.data.sources

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject

data class SourceStream(
    val id: String, val source: String, val label: String, val quality: String,
    val url: String, val headers: Map<String, String>, val isHls: Boolean
) {
    val isTorrent get() = url.startsWith("magnet:")
    companion object {
        fun parse(json: JSONObject): SourceStream? {
            val url = json.optString("url")
            if (url.toHttpUrlOrNull() == null && !url.startsWith("magnet:?xt=urn%3Abtih%3A")) return null
            return SourceStream(json.optString("id", url), json.optString("connectorName"),
                json.optString("label", "Stream"), json.optString("quality", "auto"), url,
                json.optJSONObject("headers").stringMap(), json.optBoolean("isHls"))
        }
    }
}

data class SourceSubtitle(val url: String, val label: String, val language: String, val format: String, val headers: Map<String, String>) {
    companion object {
        fun parse(json: JSONObject): SourceSubtitle? {
            val url = json.optString("url")
            if (url.toHttpUrlOrNull() == null && !Regex("opensubtitles://\\d+").matches(url)) return null
            return SourceSubtitle(url, json.optString("label", "Subtitle"), json.optString("lang", "und"),
                json.optString("format", "srt"), json.optJSONObject("headers").stringMap())
        }
    }
}

internal fun JSONObject?.stringMap(): Map<String, String> = this?.let { json ->
    json.keys().asSequence().associateWith { json.getString(it) }
}.orEmpty()
internal fun JSONArray?.objects(): List<JSONObject> = this?.let { array ->
    (0 until array.length()).mapNotNull { array.optJSONObject(it) }
}.orEmpty()
