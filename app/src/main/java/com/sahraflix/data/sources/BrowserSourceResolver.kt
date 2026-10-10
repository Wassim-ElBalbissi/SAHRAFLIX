package com.sahraflix.data.sources

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject
import java.io.ByteArrayInputStream
import javax.inject.Inject
import javax.inject.Singleton

/** Provider pages have no JavaScript/native bridge and no access to app files or credentials. */
@Singleton
class BrowserSourceResolver @Inject constructor(@ApplicationContext private val context: Context) {
    private val slots = Semaphore(3)

    @SuppressLint("SetJavaScriptEnabled")
    suspend fun resolve(url: String, timeoutMs: Long, referer: String?): JSONObject = slots.withPermit {
        require(url.toHttpUrlOrNull() != null) { "Invalid provider address" }
        withContext(Dispatchers.Main) {
            val found = CompletableDeferred<JSONObject>()
            val web = WebView(context)
            try {
                web.settings.apply {
                    javaScriptEnabled = true
                    userAgentString = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
                    domStorageEnabled = true
                    allowFileAccess = false
                    allowContentAccess = false
                    javaScriptCanOpenWindowsAutomatically = false
                    setSupportMultipleWindows(false)
                    mediaPlaybackRequiresUserGesture = false
                    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                }
                web.webChromeClient = WebChromeClient()
                web.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                        request.url.scheme !in listOf("http", "https") || (request.isForMainFrame && request.hasGesture())

                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val target = request.url.toString()
                        if (MEDIA.containsMatchIn(target) && !DECOY.containsMatchIn(target)) {
                            val origin = (request.requestHeaders["Referer"] ?: referer ?: url).toHttpUrlOrNull()
                            val headers = JSONObject(request.requestHeaders.filterKeys { key ->
                                key.lowercase(java.util.Locale.ROOT) in listOf("referer", "origin", "user-agent", "cookie")
                            })
                            android.webkit.CookieManager.getInstance().getCookie(target)?.let { headers.put("Cookie", it) }
                            found.complete(JSONObject().put("file", target)
                                .put("headers", headers)
                                .put("pageOrigin", origin?.let { "${it.scheme}://${it.host}${if (it.port !in listOf(80, 443)) ":${it.port}" else ""}" }.orEmpty()))
                            // Stop before fetching media; Media3 owns playback after the user selects a result.
                            return WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
                        }
                        return null
                    }
                }
                web.loadUrl(url, referer?.let { mapOf("Referer" to it) }.orEmpty())
                withTimeoutOrNull(timeoutMs.coerceIn(1_000, 15_000)) { found.await() } ?: JSONObject()
            } finally {
                web.stopLoading()
                web.destroy()
            }
        }
    }

    private companion object {
        val MEDIA = Regex("\\.(m3u8|mp4|mpd)(?:[?#]|$)", RegexOption.IGNORE_CASE)
        val DECOY = Regex("(?:/ads?/|/trailers?/|/samples?/|failed_access)", RegexOption.IGNORE_CASE)
    }
}
