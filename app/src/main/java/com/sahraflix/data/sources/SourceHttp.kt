package com.sahraflix.data.sources

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Bounded text responses only; source code never downloads the video through this bridge. */
internal suspend fun Call.sourceText(): JSONObject = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            if (continuation.isActive) continuation.resumeWithException(e)
        }
        override fun onResponse(call: Call, response: Response) {
            val result = runCatching {
                response.use {
                    val body = it.body ?: throw IOException("Empty response")
                    val source = body.source()
                    val limit = 4L * 1024 * 1024
                    if (source.request(limit + 1)) throw IOException("Source response too large")
                    val bytes = source.readByteArray()
                    val declared = body.contentType()?.charset()
                    val text = if (declared != null) String(bytes, declared) else try {
                        Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
                    } catch (_: java.nio.charset.CharacterCodingException) {
                        String(bytes, java.nio.charset.Charset.forName("windows-1256"))
                    }
                    JSONObject().put("status", it.code).put("url", it.request.url.toString())
                        .put("body", text).put("headers", JSONObject(it.headers.toMap()))
                }
            }
            if (continuation.isActive) result.fold(continuation::resume, continuation::resumeWithException)
        }
    })
}
