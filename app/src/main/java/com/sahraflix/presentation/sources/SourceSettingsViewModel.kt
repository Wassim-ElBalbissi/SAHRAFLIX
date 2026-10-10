package com.sahraflix.presentation.sources

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sahraflix.data.sources.SourcePreferences
import com.sahraflix.data.sources.sourceText
import com.sahraflix.data.worker.TmdbSyncWorker
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import javax.inject.Inject

@HiltViewModel
class SourceSettingsViewModel @Inject constructor(
    val preferences: SourcePreferences, client: OkHttpClient, @ApplicationContext private val context: Context
) : ViewModel() {
    private val http = client.newBuilder().callTimeout(15, TimeUnit.SECONDS).build()
    private val _sources = MutableStateFlow(preferences.definitions().map { it to preferences.enabled(it.id) })
    val sources = _sources.asStateFlow()
    val message = MutableStateFlow<String?>(null)
    val busy = MutableStateFlow(false)
    fun toggle(id: String, enabled: Boolean) { preferences.setEnabled(id, enabled); refresh() }
    fun remove(id: String) { preferences.removeAddon(id); refresh() }
    private fun refresh() { _sources.value = preferences.definitions().map { it to preferences.enabled(it.id) } }

    fun saveKeys(tmdb: String, subtitle: String, service: String, debrid: String) {
        preferences.tmdbKey = tmdb
        preferences.subtitleKey = subtitle
        preferences.debridService = service
        preferences.debridKey = debrid
        TmdbSyncWorker.schedule(context)
        message.value = "Settings saved. Discovery is refreshing."
    }
    fun addAddon(input: String) {
        viewModelScope.launch {
            busy.value = true
            message.value = null
            try {
                val target = input.trim().toHttpUrlOrNull() ?: error("Enter a valid HTTP or HTTPS manifest URL")
                require(target.encodedPath.endsWith("/manifest.json") && target.query == null && target.fragment == null) { "Use the addon's full manifest.json address" }
                val response = http.newCall(Request.Builder().url(target).build()).sourceText()
                check(response.getInt("status") in 200..299) { "The addon could not be reached" }
                val manifest = JSONObject(response.getString("body"))
                val resources = manifest.optJSONArray("resources") ?: error("The addon declares no resources")
                require((0 until resources.length()).any { index ->
                    val name = resources.optJSONObject(index)?.optString("name") ?: resources.optString(index)
                    name == "stream" || name == "subtitles"
                }) { "This addon has no streams or subtitles" }
                val digest = MessageDigest.getInstance("SHA-256").digest(target.toString().toByteArray()).take(12).joinToString("") { "%02x".format(it) }
                preferences.saveAddon("addon-$digest", manifest.getString("name"), target.toString())
                refresh()
                message.value = "Addon added"
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { message.value = error.message?.takeUnless { it.contains("http") } ?: "Couldn't add this addon. Check its address." }
            finally { busy.value = false }
        }
    }
}
