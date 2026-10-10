package com.sahraflix.data.sources

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class MarqueeSourceRuntime @Inject constructor(
    @ApplicationContext private val context: Context,
    client: OkHttpClient,
    private val preferences: SourcePreferences,
    private val browser: BrowserSourceResolver
) {
    private val http = client.newBuilder().callTimeout(15, TimeUnit.SECONDS).build()

    /** Each search owns its worker, pending HTTP requests and browser resolvers; cancellation closes all three. */
    @SuppressLint("SetJavaScriptEnabled")
    fun resolve(query: JSONObject): Flow<JSONObject> = callbackFlow {
        val searchScope = this
        val tasks = ConcurrentHashMap<Int, Job>()
        var worker: WebView? = null
        val options = preferences.runtimeOptions(query).toString()
        val startup = launch {
            delay(8_000)
            trySend(JSONObject().put("type", "error").put("message", "Source engine did not start. Update Android System WebView and try again."))
            close()
        }
        val setup = launch(Dispatchers.Main) {
            try {
                val script = withContext(Dispatchers.IO) { context.assets.open("marquee-runtime.js").bufferedReader().use { it.readText() } }
                val web = WebView(context)
                worker = web
                web.settings.apply {
                    javaScriptEnabled = true
                    allowFileAccess = false
                    allowContentAccess = false
                    blockNetworkLoads = true
                }
                web.addJavascriptInterface(object {
                    @JavascriptInterface fun event(payload: String) {
                        val event = runCatching { JSONObject(payload) }.getOrNull() ?: return
                        when (event.optString("type")) {
                            "ready" -> {
                                startup.cancel()
                                trySend(event)
                                searchScope.launch(Dispatchers.Main) {
                                    web.evaluateJavascript("MarqueeRuntime.run($options)", null)
                                }
                            }
                            "complete" -> { trySend(event); close() }
                            else -> trySend(event)
                        }
                    }
                    @JavascriptInterface fun request(id: Int, payload: String) {
                        tasks[id] = searchScope.launch {
                            val result = try {
                                val input = JSONObject(payload)
                                when (input.getString("type")) {
                                    "fetch" -> fetch(input)
                                    "tmdb" -> tmdb(input.getString("path"))
                                    "browser" -> browser.resolve(input.getString("url"), input.optLong("timeout", 9_000),
                                        input.optString("referer").takeIf { it.isNotBlank() })
                                    else -> error("Unsupported source operation")
                                }
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (_: Exception) {
                                JSONObject().put("error", "Source request failed")
                            }
                            withContext(Dispatchers.Main) {
                                web.evaluateJavascript("MarqueeRuntime.deliver($id,$result)", null)
                            }
                            tasks.remove(id)
                        }
                    }
                    @JavascriptInterface fun cancel(id: Int) { tasks.remove(id)?.cancel() }
                }, "SahraBridge")
                web.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                        WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
                    override fun onPageFinished(view: WebView, url: String) { view.evaluateJavascript(script, null) }
                }
                // Only bundled script runs here. CSP blocks frames, requests and injected remote content.
                web.loadDataWithBaseURL("https://sahraflix.invalid/", "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-eval'\"><title>Source runtime</title>", "text/html", "UTF-8", null)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                trySend(JSONObject().put("type", "error").put("message", "Source search needs an enabled Android System WebView."))
                close()
            }
        }
        awaitClose {
            startup.cancel()
            setup.cancel()
            tasks.values.forEach { it.cancel() }
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                worker?.removeJavascriptInterface("SahraBridge")
                worker?.stopLoading()
                worker?.destroy()
                worker = null
            }
        }
    }

    private suspend fun fetch(input: JSONObject): JSONObject {
        val builder = Request.Builder().url(input.getString("url"))
        val headers = input.optJSONObject("headers") ?: JSONObject()
        headers.keys().forEach { key -> builder.header(key, headers.getString(key)) }
        when (input.optString("method", "GET").uppercase()) {
            "GET" -> builder.get()
            "POST" -> builder.post(input.optString("body", "").toRequestBody(headers.optString("content-type", "application/json").toMediaTypeOrNull()))
            else -> error("Unsupported HTTP method")
        }
        return http.newCall(builder.build()).sourceText()
    }

    private suspend fun tmdb(path: String): JSONObject {
        require(Regex("(movie|tv)/\\d+/alternative_titles").matches(path))
        val key = preferences.tmdbKey
        require(key.isNotBlank())
        val builder = Request.Builder().url("https://api.themoviedb.org/3/$path")
        val request = if (key.startsWith("eyJ")) builder.header("Authorization", "Bearer $key").build()
        else builder.build().let { it.newBuilder().url(it.url.newBuilder().addQueryParameter("api_key", key).build()).build() }
        return http.newCall(request).sourceText()
    }
}
