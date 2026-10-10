import { httpFetch } from '../net'

/**
 * Shared helpers for scraper connectors that resolve third-party video embed
 * pages (JWPlayer-style hosts) down to a direct `.m3u8`/`.mp4` URL.
 */

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const FETCH_TIMEOUT_MS = 15_000

export interface FetchedPage {
  /** The URL the response actually came from, after any redirects. */
  url: string
  text: string
}

/**
 * Like `fetchText`, but keeps the post-redirect URL.
 *
 * The rotating-domain sites redirect their stable brand domain to whatever
 * throwaway host is serving today, so the final URL is the only way to learn
 * where the content actually lives.
 */
export async function fetchPage(
  url: string,
  referer?: string,
  /**
   * Extra request headers, merged last.
   *
   * Anikoto's whole `/ajax/` surface answers `{"status":500,"result":"Bad
   * request"}` without `X-Requested-With: XMLHttpRequest`, so for that connector
   * this is not a nicety — nothing resolves without it.
   */
  extraHeaders?: Record<string, string>
): Promise<FetchedPage> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'user-agent': BROWSER_UA, accept: 'text/html,*/*' }
    if (referer) headers.referer = referer
    Object.assign(headers, extraHeaders)
    const response = await httpFetch(url, { headers, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { url: response.url || url, text: await response.text() }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchText(
  url: string,
  referer?: string,
  extraHeaders?: Record<string, string>
): Promise<string> {
  return (await fetchPage(url, referer, extraHeaders)).text
}

/**
 * Sample/placeholder clips some embed pages ship as decoys (or as a player
 * default) — never the real stream, so they must be skipped.
 */
const DECOY_URL =
  /test-videos\.co\.uk|sample-videos\.com|commondatastorage\.googleapis\.com|bigbuckbunny|w3(?:schools)?\.org|demo-video\.mp4/i

/** Shared with the browser resolver, which sees the same decoys go past. */
export function isDecoyUrl(url: string): boolean {
  return DECOY_URL.test(url)
}

/** Extracts a direct media URL from a JWPlayer-style embed page. */
export function extractPlayable(html: string): string | null {
  const source = html.includes('eval(function(p,a,c,k,e,d)') ? unpack(html) ?? html : html

  return (
    firstRealMatch(source, /https?:\\?\/\\?\/[^"'\s\\]+\.m3u8[^"'\s\\]*/g) ??
    firstRealMatch(source, /https?:\\?\/\\?\/[^"'\s\\]+\.mp4[^"'\s\\]*/g)
  )
}

function firstRealMatch(text: string, re: RegExp): string | null {
  for (const match of text.matchAll(re)) {
    const url = cleanUrl(match[0])
    if (!DECOY_URL.test(url)) return url
  }
  return null
}

/**
 * Reverses Dean Edwards' packer — `eval(function(p,a,c,k,e,d){...})` — which is
 * how most of these embed hosts hide their playlist URL.
 */
export function unpack(code: string): string | null {
  const start = code.indexOf('eval(function(p,a,c,k,e,d)')
  if (start === -1) return null
  const segment = code.slice(start, code.indexOf('</script>', start) + 1 || undefined)

  const m = segment.match(/\}\('(.*?)',\s*(\d+),\s*(\d+),\s*'(.*?)'\.split\('\|'\)/s)
  if (!m) return null

  let payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  const radix = parseInt(m[2], 10)
  let count = parseInt(m[3], 10)
  const words = m[4].split('|')

  while (count--) {
    if (words[count]) {
      payload = payload.replace(new RegExp('\\b' + count.toString(radix) + '\\b', 'g'), words[count])
    }
  }
  return payload
}

function cleanUrl(url: string): string {
  return url.replace(/\\\//g, '/').replace(/\\/g, '')
}

export interface ResolvedEmbed {
  /** The direct `.m3u8`/`.mp4` URL. */
  file: string
  /** Origin of the page the file was found on — used for Referer/Origin. */
  pageOrigin: string
}

/**
 * Fetches an embed page and extracts its stream, following the client-side
 * `window.location` / meta-refresh redirects that hosts like VOE use to bounce
 * to a rotating mirror before the real player loads.
 *
 * VOE prefers the obfuscated JSON blob over the plain scan, because its player
 * page also embeds a sample clip as a decoy.
 */
export async function resolveEmbedStream(
  embedUrl: string,
  maxHops = 3
): Promise<ResolvedEmbed | null> {
  let url = embedUrl
  for (let hop = 0; hop <= maxHops; hop++) {
    const origin = new URL(url).origin
    const html = await fetchText(url, `${origin}/`).catch(() => '')
    if (!html) return null

    const file = extractVoe(html) ?? extractPlayable(html)
    if (file) return { file, pageOrigin: origin }

    // Some players are only a shell that iframes the real embed (AlbaPlayer
    // wraps a packed cdnplus embed this way), so an iframe is followed with the
    // same budget as a redirect.
    const next = jsRedirectTarget(html) ?? iframeTarget(html, url)
    if (!next) return null
    const abs = new URL(next, url).href
    if (abs === url) return null
    url = abs
  }
  return null
}

/**
 * The first iframe that plausibly holds a player.
 *
 * Skips self-references (these shells iframe themselves with a `?serv=` switch)
 * and the usual ads/social embeds, which would otherwise burn the hop budget.
 */
function iframeTarget(html: string, pageUrl: string): string | null {
  const NOISE = /doubleclick|googlesyndication|google\.com|facebook|twitter|disqus|recaptcha/i

  for (const match of html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) {
    const raw = decodeEntities(match[1]).trim()
    if (!raw || NOISE.test(raw)) continue

    let abs: URL
    try {
      abs = new URL(raw, pageUrl)
    } catch {
      continue
    }
    if (!/^https?:$/.test(abs.protocol)) continue
    // Same path as the page we're on = the self-iframe shell, not the player.
    if (abs.origin === new URL(pageUrl).origin && abs.pathname === new URL(pageUrl).pathname) continue

    return abs.href
  }
  return null
}

function jsRedirectTarget(html: string): string | null {
  const js = html.match(/(?:window\.)?location(?:\.href)?\s*=\s*['"](https?:\/\/[^'"]+)['"]/)
  if (js) return js[1]
  const meta = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>\s]+)/i)
  if (meta) return meta[1]
  return null
}

/**
 * VOE (voe.sx and its rotating mirrors) hides the playlist URL in a
 * multi-step-obfuscated JSON blob inside a `<script type="application/json">`.
 * This reverses the known scheme (ROT13 → strip junk → base64 → shift → reverse
 * → base64), then scans the decoded JSON for the stream. Falls back to the
 * older `{"hls":"<base64>"}` shape.
 */
export function extractVoe(html: string): string | null {
  const script = html.match(
    /<script[^>]+type="application\/json"[^>]*>\s*(\[[\s\S]*?\])\s*<\/script>/i
  )
  if (script) {
    try {
      const arr = JSON.parse(script[1]) as unknown[]
      const encoded = typeof arr[0] === 'string' ? arr[0] : ''
      const decoded = voeDecode(encoded)
      if (decoded) {
        // The decoded payload is JSON: `source` is the HLS, `direct_access_url`
        // the MP4 fallback. Read the fields directly so the page's decoy clip
        // can't win; fall back to a scan of the decoded string if the shape
        // changed.
        try {
          const obj = JSON.parse(decoded) as Record<string, unknown>
          for (const key of ['source', 'direct_access_url', 'file']) {
            const val = obj[key]
            if (typeof val === 'string' && /^https?:/.test(val)) return cleanUrl(val)
          }
        } catch {
          /* not JSON — scan it */
        }
        const url = extractPlayable(decoded)
        if (url) return url
      }
    } catch {
      /* fall through to the older shapes */
    }
  }

  const hls = html.match(/["']hls["']\s*:\s*["']([A-Za-z0-9+/=]{16,})["']/)
  if (hls) {
    const dec = Buffer.from(hls[1], 'base64').toString('utf8')
    if (/\.m3u8/.test(dec)) return cleanUrl(dec)
  }
  return null
}

function voeDecode(input: string): string | null {
  if (!input) return null
  try {
    let s = input.replace(/[a-zA-Z]/g, (c) => {
      const base = c <= 'Z' ? 65 : 97
      return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base)
    })
    for (const junk of ['@$', '^^', '~@', '%?', '*~', '!!', '#&']) s = s.split(junk).join('')
    s = Buffer.from(s, 'base64').toString('binary')
    s = Array.from(s, (c) => String.fromCharCode(c.charCodeAt(0) - 3)).join('')
    s = s.split('').reverse().join('')
    return Buffer.from(s, 'base64').toString('utf8')
  } catch {
    return null
  }
}

export function decodeEntities(input: string): string {
  return input
    .replace(/&#0*38;|&amp;/g, '&')
    .replace(/&#0*34;|&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#0*60;|&lt;/g, '<')
    .replace(/&#0*62;|&gt;/g, '>')
}
