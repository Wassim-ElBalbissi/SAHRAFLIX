package com.sahraflix.di

import com.sahraflix.core.AppConfig
import com.sahraflix.data.remote.TmdbApi
import com.sahraflix.data.remote.TmdbClient
import com.sahraflix.data.sources.SourcePreferences
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import okhttp3.JavaNetCookieJar
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.net.CookieManager
import java.net.CookiePolicy
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    /**
     * Moshi must have KotlinJsonAdapterFactory: without it Moshi 1.15 refuses to (de)serialise Kotlin
     * classes, which made every TMDB call throw in the previous build.
     */
    @Provides
    @Singleton
    fun provideMoshi(): Moshi = Moshi.Builder().add(KotlinJsonAdapterFactory()).build()

    @Provides
    @Singleton
    fun provideOkHttpClient(): OkHttpClient {
        val cookies = JavaNetCookieJar(CookieManager(null, CookiePolicy.ACCEPT_ALL))
        return OkHttpClient.Builder()
            // System DNS on purpose: forced DoH broke LAN/self-hosted IPTV servers and local hostnames.
            .cookieJar(cookies)
            .connectTimeout(AppConfig.CONNECT_TIMEOUT_S, TimeUnit.SECONDS)
            .readTimeout(AppConfig.READ_TIMEOUT_S, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true) // http→https redirects are common on IPTV panels
            .retryOnConnectionFailure(true)
            .addInterceptor { chain ->
                val request = chain.request()
                if (request.header("User-Agent") != null) chain.proceed(request)
                else chain.proceed(request.newBuilder().header("User-Agent", AppConfig.DEFAULT_USER_AGENT).build())
            }
            // IPTV and addon URLs can contain credentials. Do not log request URLs or headers.
            .build()
    }

    @Provides
    @Singleton
    fun provideTmdbApi(client: OkHttpClient, moshi: Moshi, preferences: SourcePreferences): TmdbApi {
        // Accept either a v3 API key or a v4 "API Read Access Token" (JWT, sent as Bearer).
        val tmdbClient = client.newBuilder().addInterceptor { chain ->
            val key = preferences.tmdbKey
            val req = chain.request()
            val authed = when {
                key.isEmpty() -> req
                key.startsWith("eyJ") -> req.newBuilder().header("Authorization", "Bearer $key").build()
                else -> req.newBuilder().url(req.url.newBuilder().addQueryParameter("api_key", key).build()).build()
            }
            chain.proceed(authed)
        }.build()
        return Retrofit.Builder()
            .baseUrl("https://api.themoviedb.org/3/")
            .client(tmdbClient)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()
            .create(TmdbApi::class.java)
    }

    @Provides
    @Singleton
    fun provideTmdbClient(api: TmdbApi, preferences: SourcePreferences): TmdbClient = TmdbClient(api) { preferences.tmdbKey.isNotBlank() }
}
