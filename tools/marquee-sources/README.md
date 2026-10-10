# Marquee sources for SahraFlix

Imported from the local checkout of [Wassim-ElBalbissi/Marquee](https://github.com/Wassim-ElBalbissi/Marquee), commit `fc9eb5f65aaa1c74ca17cb508192cb429c2f5729`, on 2026-10-10. The original checkout was not modified. Imported files retain original comments, including desktop behaviour; the Android differences below describe this port.

## Imported code

`vendor/main/sources/` contains Krmzy, 3isq, 3isk, Qrmzi, Prstej, MyCima, Qisat, Movish, VixSrc, Boredflix, Embed Mirrors, Embed Relays, HydraHD, Anikoto, Reanime, OpenSubtitles and Torrentio, plus the generic Stremio connector. Matching, aliases, parsing and embed helpers are retained. Unicode utilities, TVmaze lookup and shared type declarations also come from Marquee.

## Android adapters

- `runtime.ts` emits progressive stream/subtitle/status events. A failing connector does not discard other results. Stream resolution is bounded to 25 seconds per connector, followed by up to 15 seconds for subtitles; Android also enforces a whole-search timeout.
- `bridge.ts` and `vendor/main/net.ts` replace Electron networking with cancellable native OkHttp requests. Text responses are capped at 4 MiB, preserving HTTP status, final URL, headers and encoding.
- `vendor/main/sources/browser-resolve.ts` delegates dynamic embeds to Android WebView. At most three provider WebViews run at once, without a native bridge or local file access. Media requests are intercepted before downloading video; playback headers are carried into Media3.
- The worker WebView runs only the bundled script. CSP, navigation interception, disabled networking and disabled file/content access separate it from provider pages.
- Settings, TMDB alternative-title requests and season/air-date reads use Android adapters. TMDB's key stays native; OpenSubtitles/debrid configuration is supplied to the bundled worker. Request URLs and headers are not logged.
- `vendor/shared/media-url.ts` and `vendor/main/torrents.ts` produce magnet URIs with hash, trackers and file index. There is **no in-process Android torrent engine**. Torrentio's debrid HTTP results play normally; the imported conservative quality filter is retained.
- Selected subtitles download to private cache files with their own headers. OpenSubtitles download quota is used only when a selected track is loaded for playback.

Desktop filesystem sources, plugin execution, persistent catalogue caches, source tier scheduling and Electron torrent playback are not included. Every enabled connector is searched. Individual site availability and Android-specific challenges require live verification.

## Development

```sh
npm ci
npm test
```

`build.mjs` uses locked esbuild to generate `app/src/main/assets/marquee-runtime.js`. Commit the asset with source changes. Fixtures cover API/playlist resolution, failure isolation, disabled sources, headers, subtitles, Stremio episode IDs and magnet file selection. Android tests execute the actual bundle in WebView and check native browser/subtitle adapters.

When updating from Marquee, replace only imported files; retain and review the Android adapters above. Do not copy desktop API keys, tokens, local settings or user databases.
