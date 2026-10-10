# SahraFlix

Android TV and phone player built with Compose, Media3, Room, Paging, Hilt and WorkManager. Supports IPTV subscriptions and movie/episode discovery with sources adapted from [Marquee](https://github.com/Wassim-ElBalbissi/Marquee).

## Features

- M3U/M3U8, Xtream Codes and Stalker live TV; per-stream headers, catch-up and XMLTV guide.
- Xtream movie metadata and episode navigation, including when TMDB is unavailable.
- TMDB discovery, cast, trailers, similar titles, library matching and watch-provider information.
- **17 Marquee connectors:** Krmzy, 3isq, 3isk, Qrmzi, Prstej, MyCima, Qisat, Movish, VixSrc, Boredflix, Embed Mirrors, Embed Relays, HydraHD, Anikoto, Reanime, OpenSubtitles and Torrentio.
- User-added Stremio stream/subtitle addons and individual source switches.
- Progressive results, season/episode selection and optional Arabic, Turkish or English subtitles.
- Direct HTTP/HLS/debrid streams play through Media3 with source headers. Torrent results open an installed torrent app.
- Continue Watching resolves fresh links for source titles before resuming. IPTV history and favourites remain available.
- Phone pairing, encrypted settings, profile PINs, background sync, audio/subtitle selection, PiP and external players.

## Setup

1. Choose TV or mobile layout and create/select a profile.
2. For IPTV, use **Settings → Add playlist** or pair from a phone.
3. Open **Settings → Marquee sources** and enter your own TMDB key or read token to enable discovery. OpenSubtitles and debrid keys are optional.
4. Open a discovery/search title, then **Find streams** or **Choose episode & sources**.

Keys are stored in encrypted preferences. No Marquee account credentials or API keys are bundled. A build-time TMDB key in `local.properties` (`TMDB_API_KEY=...`) remains supported. Get your key from [TMDB](https://www.themoviedb.org/settings/api).

## Build and verify

Requires JDK 17 and Android SDK 36. Open in Android Studio or run:

```sh
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
./gradlew :app:connectedDebugAndroidTest  # running emulator/device required
```

On Windows use `gradlew.bat`. The APK is `app/build/outputs/apk/debug/app-debug.apk`.

The generated source bundle is committed, so ordinary Android builds do not require Node. After editing its TypeScript:

```sh
cd tools/marquee-sources
npm ci
npm test
```

CI checks bundle reproducibility, connector fixtures, Android compilation, unit tests and lint. Instrumentation tests cover Room migration 7→8, Xtream metadata/authentication, navigation, the real WebView source bridge, browser isolation and subtitles. Local fixtures verify integration; they do not certify current availability of third-party hosts.

## Test server

```sh
python tools/test-server/server.py
```

Use **Settings → Add demo server** on the emulator, or Xtream `http://<LAN-IP>:8000` with `demo` / `demo` on a device. See [test server instructions](tools/test-server/README.md).

## Architecture

```text
app/src/main/java/com/sahraflix/
  presentation/    Compose screens and ViewModels
  domain/          models and repository contracts
  data/local/      Room v8 and encrypted preferences
  data/repository/ IPTV providers and unified catalogue
  data/sources/    Marquee runtime, HTTP/browser and subtitle adapters
  data/remote/     TMDB API
  player/          Media3, media session and PiP
```

See [source provenance and port details](tools/marquee-sources/README.md) and [change history](CHANGES.md).

## Limitations

- Source domains, anti-bot challenges and availability can change. No results does not mean a title is unavailable everywhere.
- Source search needs an enabled, current Android System WebView. Provider pages have no native bridge. IPTV playback does not need WebView.
- Desktop Marquee's local-folder scanner, arbitrary plugins and embedded torrent engine are not included. Magnet playback requires another app; debrid HTTP links play here.
- Stalker portals currently support live TV only. Catch-up depends on the provider.
- Real subscription/debrid credentials and physical TV/phone compatibility require testing on the target device.

SahraFlix distributes no media files. Use sources you are entitled to access. TMDB supplies metadata, with watch-provider information from JustWatch. This product uses the TMDB API but is not endorsed or certified by TMDB.
