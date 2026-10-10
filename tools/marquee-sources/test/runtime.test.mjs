import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const bundle = fs.readFileSync(new URL('../../../app/src/main/assets/marquee-runtime.js', import.meta.url), 'utf8')
async function resolve(enabled, fetch, query = { type: 'movie', tmdbId: 1, title: 'Fixture' }, addons = []) {
  const events = []
  const calls = []
  let context
  const sandbox = { URL, URLSearchParams, Headers, AbortController, TextDecoder, Uint8Array, atob, console,
    setTimeout, clearTimeout,
    SahraBridge: {
      event: json => events.push(JSON.parse(json)),
      cancel() {},
      request(id, json) {
        const input = JSON.parse(json)
        calls.push(input)
        Promise.resolve().then(() => fetch(input)).then(result => context.MarqueeRuntime.deliver(id, result),
          () => context.MarqueeRuntime.deliver(id, { error: 'Failed' }))
      }
    }
  }
  context = vm.createContext(sandbox)
  vm.runInContext(bundle, context)
  await context.MarqueeRuntime.run({ query, enabled, settings: {}, addons })
  return { events, calls, streams: events.filter(e => e.type === 'streams').flatMap(e => e.streams) }
}
const response = (url, body) => ({ status: 200, url, body: JSON.stringify(body), headers: {} })

test('Movish carries HLS flags, headers and subtitles; disabled sources never fetch', async () => {
  const result = await resolve(['movish'], input => response(input.url, {
    streams: [{ url: 'https://cdn.example.test/video.m3u8', quality: '1080p', type: 'hls' }],
    subtitles: [{ url: 'https://cdn.example.test/ar.vtt', label: 'Arabic', lang: 'ar' }]
  }))
  assert.ok(result.streams.length > 0)
  assert.equal(result.streams[0].isHls, true)
  assert.equal(result.streams[0].headers.Referer, 'https://movish.to/')
  assert.ok(result.calls.every(call => call.url.startsWith('https://movish.to/')))
  assert.ok(result.events.some(e => e.type === 'subtitles' && e.subtitles.some(s => s.lang === 'ar')))
  assert.equal(result.events.at(-1).type, 'complete')
})

test('VixSrc preserves the API to embed to playlist exchange', async () => {
  const result = await resolve(['vixsrc'], input => input.url.includes('/api/')
    ? response(input.url, { src: '/embed/fixture?token=one' })
    : { status: 200, url: input.url, headers: {}, body: "window.masterPlaylist = { params: { 'token': 'two', 'expires': '123' }, url: 'https://cdn.example.test/master.m3u8' }" })
  assert.equal(result.streams[0].url, 'https://cdn.example.test/master.m3u8?token=two&expires=123&h=1')
})

test('failed source cannot hide a working source', async () => {
  const result = await resolve(['movish', 'vixsrc'], input => {
    if (input.url.includes('vixsrc')) throw new Error('Offline')
    return response(input.url, { streams: [{ url: 'https://cdn.example.test/video.mp4' }] })
  })
  assert.ok(result.streams.length > 0)
  assert.ok(result.streams.every(stream => stream.connectorId === 'movish'))
  assert.equal(result.events.at(-1).type, 'complete')
})

test('empty enabled set performs no network work', async () => {
  const result = await resolve([], () => { throw new Error('Unexpected network request') })
  assert.equal(result.calls.length, 0)
  assert.equal(result.streams.length, 0)
})

test('Stremio uses IMDb episode ids and keeps embedded subtitles plus torrent file selection', async () => {
  const result = await resolve(['fixture'], input => response(input.url, input.url.includes('/stream/') ? { streams: [
    { url: 'https://cdn.example.test/video.mp4', behaviorHints: { proxyHeaders: { request: { 'X-Fixture': 'one' } } },
      subtitles: [{ url: 'https://cdn.example.test/ar.vtt', lang: 'ar' }] },
    { infoHash: '0123456789abcdef0123456789abcdef01234567', fileIdx: 3, sources: ['tracker:udp://tracker.test/announce'] }
  ] } : { subtitles: [] }), { type: 'series', tmdbId: 1, imdbId: 'tt123', season: 2, episode: 4 },
  [{ id: 'fixture', name: 'Fixture', target: 'https://addon.test/manifest.json' }])
  assert.ok(result.calls[0].url.endsWith('/stream/series/tt123%3A2%3A4.json'))
  assert.equal(result.streams[0].headers['X-Fixture'], 'one')
  const magnet = new URL(result.streams[1].url)
  assert.equal(magnet.searchParams.get('so'), '3')
  assert.equal(magnet.searchParams.get('tr'), 'udp://tracker.test/announce')
  assert.ok(result.events.some(e => e.type === 'subtitles' && e.subtitles.some(s => s.lang === 'ar')))
})
