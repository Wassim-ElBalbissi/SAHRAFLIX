# SahraFlix change history

## October 2026 continuation

- Added 17 Marquee connectors and Stremio stream/subtitle addons with an isolated bundled JavaScript runtime and Android adapters.
- Added source settings, encrypted API keys, episode/source selection, external subtitles and fresh-link resolution when resuming.
- Direct streams play through Media3; torrents open an external app. Desktop plugin/local-folder features are not included.
- Restored the TV guide. IPTV movies and series open details; similar/library cards navigate correctly. Top-level navigation returns to the destination root.
- Added Xtream movie plot/cast/director details, optional TMDB enrichment and safer authentication/expiry handling.
- Corrected Arabic/Turkish matching, numeric titles and false sequel matches. Fixed encoded detail IDs, mobile categories and touch cards.
- Added migration, provider, navigation, source bridge and subtitle tests, connector fixtures, and CI build/test/lint checks.
- Removed HTTP request logging because provider/addon URLs can contain credentials.

## Original 2.0 rebuild

## Build blockers (the previous version could not compile)
- `NetworkMonitor` was imported by HomeViewModel but did not exist → added `core/NetworkMonitor`.
- `@xml/network_security_config`, `@mipmap/ic_launcher(_round)` and `proguard-rules.pro` were referenced but missing → added.
- Kotlin 2.0.21 compiler with 2026 AndroidX/Compose/Media3 artifacts (newer Kotlin metadata) → Kotlin 2.2.21, KSP 2.3.12, Hilt 2.60.1, Media3 1.11.1, Room 2.7.2.

## Crashes / broken features
- Moshi was built without `KotlinJsonAdapterFactory`, so every TMDB request threw.
- `PlaylistSyncWorker` was never enqueued, so playlists were saved but never downloaded.
- Screens got their own `PlayerViewModel` (hiltViewModel inside NavHost), so clicking a channel didn't show the player.
- PiP: missing `supportsPictureInPicture` (crash) and API-26 calls on minSdk 23 (crash on Android 6/7).
- `CastPlayer` created without a Cast OptionsProvider (crash at startup); Cast removed.
- `startForegroundService` on MediaSessionService could crash when nothing was playing yet.
- `SahraFocusCard` added a second `.focusable()` → double focus stops, broken D-pad navigation.
- Only the TV theme was applied; Material3 widgets rendered in the light theme.

## Data correctness
- Xtream: every stream was saved as MOVIE (live channels missing); categories never fetched (all "Uncategorized");
  series used a non-playable URL; VOD ignored `container_extension`; timeshift template lacked stream id/format;
  short-EPG titles are base64 and in seconds (stored as ms); one EPG request per channel → replaced by xmltv.php.
- Stalker: no handshake/token/`create_link`; MAC address was discarded at pairing.
- Home "Live / Movies / Series" rows all showed the same unfiltered list.
- `REPLACE` inserts + FK cascades wiped the EPG on every re-sync; channels removed upstream were never deleted.
- `streaming_items` unique index on `tmdbId` made movie/TV ids with the same number overwrite each other.
- M3U: titles/groups containing commas were truncated; no gzip; stream ids included credentials.
- Continue Watching was never written (`saveProgress` unused); "On now" and EPG search items had empty URLs.
- Settings toggles (refresh, interval, hardware accel, default player) were stored but never read.

## Playback quality
- ExoPlayer default HTTP refused http→https redirects and sent no per-stream User-Agent/Referer → OkHttp data source.
- `DynamicLoadControl` swapped allocators mid-life → one tuned `DefaultLoadControl`.
- Auto-launched VLC after 10 s of buffering → auto-retry with backoff, live-window recovery, HLS fallback, clear errors.
- Position polled 4×/s forever → only while playing.

## Security
- Pairing PIN (6 digits on an open LAN port) had no brute-force protection → 5-try lockout, single-use PIN.
- Forced DNS-over-HTTPS broke LAN/self-hosted servers → system DNS.

## Removed
- VidSrc embed scraping, `LocalHlsProxy` (Referer/UA spoofing for third-party hosts), the WebView embed + ad
  stripper. Replaced with TMDB metadata, legal "where to watch", official trailers and matching against the
  user's own IPTV library.
