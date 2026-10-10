package com.sahraflix.data.sources

import android.content.Context
import android.net.Uri
import com.sahraflix.domain.model.ExternalSubtitle
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit
import javax.inject.Inject

class SourceSubtitleLoader @Inject constructor(
    @ApplicationContext private val context: Context, client: OkHttpClient,
    private val preferences: SourcePreferences
) {
    private val http = client.newBuilder().callTimeout(15, TimeUnit.SECONDS).build()

    /** Download only the chosen track; OpenSubtitles charges quota at this point. */
    suspend fun load(subtitle: SourceSubtitle): ExternalSubtitle {
        var url = subtitle.url
        if (url.startsWith("opensubtitles://")) {
            val id = url.removePrefix("opensubtitles://").toLong()
            val response = http.newCall(Request.Builder().url("https://api.opensubtitles.com/api/v1/download")
                .header("Api-Key", preferences.subtitleKey).header("User-Agent", "SahraFlix v2.1.0")
                .post(JSONObject().put("file_id", id).toString().toRequestBody("application/json".toMediaType())).build()).sourceText()
            check(response.getInt("status") in 200..299)
            url = JSONObject(response.getString("body")).getString("link")
        }
        val request = Request.Builder().url(url).apply { subtitle.headers.forEach { (key, value) -> header(key, value) } }.build()
        val response = http.newCall(request).sourceText()
        check(response.getInt("status") in 200..299)
        val text = response.getString("body").removePrefix("\uFEFF")
        require(!text.trimStart().startsWith("<")) { "Subtitle is not a text track" }
        val extension = subtitle.format.takeIf { it in listOf("vtt", "ass", "ssa", "srt") } ?: "srt"
        val file = withContext(Dispatchers.IO) {
            File.createTempFile("source-sub-", ".$extension", context.cacheDir).apply { writeText(text, Charsets.UTF_8) }
        }
        val mime = when (extension) {
            "vtt" -> "text/vtt"
            "ass", "ssa" -> "text/x-ssa"
            else -> "application/x-subrip"
        }
        return ExternalSubtitle(Uri.fromFile(file).toString(), mime, subtitle.language, subtitle.label)
    }
}
