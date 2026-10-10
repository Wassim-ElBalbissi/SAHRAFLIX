import { createStremioConnector } from './stremio'
import { getSettings } from '../settings'
import type { SourceConnector } from './types'
import type { Stream, StreamQuery, Subtitle } from '@shared/types'

/**
 * Torrentio, built in and configured — the app's torrent source.
 *
 * It is the Stremio addon that aggregates a dozen torrent indexers behind one
 * endpoint, so a single connector is effectively "scrape yts + eztv + 1337x +
 * thepiratebay + rarbg + torrentgalaxy + magnetdl + kickass at once". That is
 * why there is no second torrent addon: the alternatives were probed and are
 * dead, gated, or debrid-only, while Torrentio with every provider on is the
 * multi-source scraping the user asked for.
 *
 * The config is baked here rather than pasted into Settings so there is nothing
 * to set up and nothing to lose. Living in code also means it ships with app
 * updates, so the provider list can be tuned centrally.
 *
 * **The quality filter is load-bearing, with or without debrid.** The file
 * plays through Chromium, which cannot decode 4K/HEVC, Dolby Vision/HDR, or
 * BluRay REMUX (DTS-HD/TrueHD audio) — and a debrid service changes only how
 * the bytes arrive, not what Chromium can decode. Left unfiltered, those
 * dominate the top of the list and every play would fail over two or three
 * times before landing on something watchable. The filter drops them and
 * `sort=qualityseeders` floats x264 1080p/720p up — YTS releases especially
 * are x264 + AAC in an MP4 and play with no conversion at all.
 *
 * **What the filter cannot reach is audio, and that used to be silent.** This
 * comment claimed for a while that a 1080p release carrying AC3 "fails over to
 * the next result" — it does not, because Chromium does not *error* on Dolby or
 * DTS. It decodes the video, drops the audio track, and plays on mute. The bite
 * is worst for streaming-native TV, which has no BluRay or YTS rip to fall back
 * on: of eight Silo S01E01 candidates probed on 2026-08-31, six were AC3/E-AC3
 * and one was AAC. Torrentio's `qualityfilter` has no audio option, so this is
 * handled downstream instead — `byRankThenQuality` sinks releases whose name
 * advertises Dolby/DTS (`@shared/audio-support`), and `Player.tsx`'s
 * silent-source watchdog catches the ones that never said.
 *
 * **Debrid.** When Settings carries a `debridService` + `debridApiKey`, the
 * key is embedded in Torrentio's config URL and Torrentio answers with direct
 * HTTPS resolve links for releases the debrid service has cached, instead of
 * infoHashes — instant start, full seeking, no peers, no IP exposure.
 * `debridoptions=nodownloadlinks` keeps uncached "download to your account"
 * entries out, so every debrid result is playable-now by construction; a cache
 * miss falls back to the plain peer-to-peer query below. The app never talks
 * to the debrid API itself — Torrentio does the resolving.
 *
 * Anime-specific providers (nyaasi, tokyotosho, anidex) are deliberately left
 * out: they key on kitsu ids, and the app queries by tmdb/imdb id, so they
 * would rarely match and only slow the response. Anime-over-torrent is a future
 * item that needs kitsu-id mapping first.
 *
 * To show every quality (accepting the failover churn), drop the
 * `qualityfilter=…|` segment from the options below.
 */
const TORRENTIO_OPTIONS =
  'providers=yts,eztv,1337x,thepiratebay,torrentgalaxy,magnetdl,rarbg,kickasstorrents|qualityfilter=4k,dolbyvision,dolbyvisionwithhdr,hdrall,brremux,cam,scr,unknown|sort=qualityseeders'

/** Torrentio's config keys, which double as the `debridService` setting values. */
const DEBRID_SERVICES: Record<string, string> = {
  realdebrid: 'RealDebrid',
  premiumize: 'Premiumize',
  alldebrid: 'AllDebrid',
  torbox: 'TorBox',
  debridlink: 'Debrid-Link'
}

/**
 * A rejected/expired key doesn't fail the request — Torrentio answers with a
 * pseudo-stream whose `url` is a hosted failure clip (e.g.
 * `videos/failed_access_v3.mp4`). It carries a `url`, so it would sail through
 * the connector's playability filter and "play" an error video; anything under
 * this prefix is stripped and treated as a key rejection instead.
 */
const FAILURE_VIDEO_PREFIX = 'https://torrentio.strem.fun/videos/'

function target(options: string): string {
  return `https://torrentio.strem.fun/${options}/manifest.json`
}

/** The peer-to-peer connector — the only path when no debrid key is saved. */
const plain = createStremioConnector({
  id: 'torrentio',
  name: 'Torrentio',
  target: target(TORRENTIO_OPTIONS)
})

function debridConfig(): { service: string; key: string } | null {
  const settings = getSettings()
  const service = settings.debridService.trim().toLowerCase()
  const key = settings.debridApiKey.trim()
  // Unknown service values (a typo, a removed provider) degrade to P2P rather
  // than building a config URL Torrentio would reject.
  if (!key || !(service in DEBRID_SERVICES)) return null
  return { service, key }
}

// Built per call rather than cached: the key can change in Settings at any
// time, and connector construction is just string assembly — nothing fetches
// until getStreams runs.
function debridConnector(cfg: { service: string; key: string }): SourceConnector {
  return createStremioConnector({
    id: 'torrentio',
    name: 'Torrentio',
    target: target(`${TORRENTIO_OPTIONS}|${cfg.service}=${cfg.key}|debridoptions=nodownloadlinks`)
  })
}

export const torrentioConnector: SourceConnector = {
  id: 'torrentio',
  name: 'Torrentio',
  kind: 'stremio',

  async getStreams(query: StreamQuery): Promise<Stream[]> {
    const cfg = debridConfig()
    if (!cfg) return plain.getStreams(query)

    const raw = await debridConnector(cfg).getStreams(query)
    const streams = raw.filter((s) => !s.url?.startsWith(FAILURE_VIDEO_PREFIX))
    if (streams.length > 0) return streams

    // Cache miss or rejected key — either way P2P still works, so playback is
    // never held hostage to the debrid account.
    const rejected = raw.length > streams.length
    if (rejected) {
      console.warn(`[torrentio] ${DEBRID_SERVICES[cfg.service]} rejected the API key; using peer-to-peer`)
    }
    const fallback = await plain.getStreams(query)
    if (fallback.length === 0 && rejected) {
      // Only surface the bad key when there is nothing to play anyway; the
      // registry narrates thrown errors through streams:progress.
      throw new Error(
        `${DEBRID_SERVICES[cfg.service]} rejected the API key — check Settings → API keys.`
      )
    }
    return fallback
  },

  getSubtitles(query: StreamQuery): Promise<Subtitle[]> {
    return plain.getSubtitles!(query)
  },

  async test(): Promise<{ ok: boolean; message?: string }> {
    const base = await plain.test!()
    const cfg = debridConfig()
    if (!base.ok || !cfg) return base

    // Validate the key against a title every provider has cached (The
    // Shawshank Redemption) so a pasted-wrong key surfaces here rather than as
    // a silent P2P downgrade on first play.
    try {
      const raw = await debridConnector(cfg).getStreams({
        tmdbId: 278,
        imdbId: 'tt0111161',
        type: 'movie',
        title: 'The Shawshank Redemption'
      })
      const rejected = raw.some((s) => s.url?.startsWith(FAILURE_VIDEO_PREFIX))
      if (rejected) {
        return { ok: false, message: `${DEBRID_SERVICES[cfg.service]} rejected the API key.` }
      }
      return { ok: true, message: `${base.message} · ${DEBRID_SERVICES[cfg.service]} key OK` }
    } catch (err) {
      return { ok: false, message: `Debrid check failed: ${(err as Error).message}` }
    }
  }
}
