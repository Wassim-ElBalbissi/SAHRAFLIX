import { torrents } from '../main/torrents'
// Android hands peer-to-peer results to an installed torrent client. Debrid URLs play in Media3.
export function torrentStreamUrl(hash: string, fileIdx: number): string {
  const query = new URLSearchParams({ xt: `urn:btih:${hash}` })
  const options = torrents.get(hash)
  if (options?.filename) query.set('dn', options.filename)
  if (fileIdx >= 0) query.set('so', String(fileIdx))
  options?.trackers.forEach(tracker => query.append('tr', tracker))
  return `magnet:?${query}`
}
