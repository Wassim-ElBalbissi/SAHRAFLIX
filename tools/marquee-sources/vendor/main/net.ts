import { native } from '../../bridge'
export async function httpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = Object.fromEntries(new Headers(init.headers).entries())
  const result = await native({ type: 'fetch', url: String(url), method: init.method || 'GET', headers, body: init.body }, init.signal ?? undefined)
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    url: result.url,
    headers: new Headers(result.headers),
    text: async () => result.body,
    json: async () => JSON.parse(result.body)
  } as Response
}
