const headersByHost = new Map<string, Record<string, string>>()
const headersByUrl = new Map<string, Record<string, string>>()
export function registerStreamHeaders(url: string, headers: Record<string, string>) {
  headersByUrl.set(url, headers)
}
export function registerHostHeaders(url: string, headers: Record<string, string>) {
  headersByHost.set(new URL(url).host, headers)
}
export function streamHeadersFor(url: string) {
  try { return { ...headersByHost.get(new URL(url).host), ...headersByUrl.get(url) } } catch { return undefined }
}
