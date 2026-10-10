import { configure, deliver, emit } from './bridge'
import { krmzyConnector } from './vendor/main/sources/krmzy'
import { isqConnector } from './vendor/main/sources/isq'
import { iskConnector } from './vendor/main/sources/isk'
import { qrmziConnector } from './vendor/main/sources/qrmzi'
import { prstejConnector } from './vendor/main/sources/prstej'
import { mycimaConnector } from './vendor/main/sources/mycima'
import { qisatConnector } from './vendor/main/sources/qisat'
import { boredflixConnector } from './vendor/main/sources/boredflix'
import { movishConnector } from './vendor/main/sources/movish'
import { vixsrcConnector } from './vendor/main/sources/vixsrc'
import { mirrorsConnector } from './vendor/main/sources/mirrors'
import { relaysConnector } from './vendor/main/sources/relays'
import { hydrahdConnector } from './vendor/main/sources/hydrahd'
import { anikotoConnector } from './vendor/main/sources/anikoto'
import { reanimeConnector } from './vendor/main/sources/reanime'
import { openSubtitlesConnector } from './vendor/main/sources/opensubtitles'
import { torrentioConnector } from './vendor/main/sources/torrentio'
import { createStremioConnector } from './vendor/main/sources/stremio'
import { streamHeadersFor } from './vendor/main/sources/headers'
import type { SourceConnector } from './vendor/main/sources/types'

// Only the three base64 conversions used by the imported parsers need a Buffer shim.
;(globalThis as any).Buffer = {
  from: (input: string, encoding: string) => ({
    toString: (output: string) => {
      const binary = encoding === 'base64' ? atob(input) : input
      return output === 'binary' ? binary : new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)))
    }
  })
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const builtins: SourceConnector[] = [krmzyConnector, isqConnector, iskConnector, qrmziConnector,
  prstejConnector, mycimaConnector, qisatConnector, boredflixConnector, movishConnector, vixsrcConnector,
  mirrorsConnector, relaysConnector, hydrahdConnector, anikotoConnector, reanimeConnector,
  openSubtitlesConnector, torrentioConnector]

function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Source timed out')), milliseconds)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

async function run(options: any) {
  configure(options.settings || {}, options.query)
  const custom = (options.addons || []).map((addon: any) => createStremioConnector(addon))
  const enabled = new Set(options.enabled)
  const connectors: SourceConnector[] = [...builtins, ...custom].filter(connector => enabled.has(connector.id))
  await Promise.allSettled(connectors.map(async connector => {
    emit({ type: 'progress', id: connector.id, state: 'searching' })
    try {
      const streams = await timeout(connector.getStreams(options.query), 25_000)
      // Do not let a subtitle-only miss delay the first playable stream.
      emit({ type: 'streams', id: connector.id, streams: streams.map(stream => ({ ...stream,
        headers: { 'User-Agent': BROWSER_UA, ...stream.headers, ...streamHeadersFor(stream.url || '') },
        subtitles: stream.subtitles?.map(subtitle => ({ ...subtitle, headers: streamHeadersFor(subtitle.url) }))
      })) })
      const subtitles = [ ...streams.flatMap(stream => stream.subtitles || []),
        ...(connector.getSubtitles ? await timeout(connector.getSubtitles(options.query), 15_000).catch(() => []) : []) ]
      emit({ type: 'subtitles', id: connector.id, subtitles: subtitles.map(subtitle => ({ ...subtitle, headers: streamHeadersFor(subtitle.url) })) })
      emit({ type: 'progress', id: connector.id, state: streams.length || subtitles.length ? 'found' : 'empty' })
    } catch {
      emit({ type: 'progress', id: connector.id, state: 'failed' })
    }
  }))
  emit({ type: 'complete' })
}

;(globalThis as any).MarqueeRuntime = { deliver, run }
emit({ type: 'ready' })
