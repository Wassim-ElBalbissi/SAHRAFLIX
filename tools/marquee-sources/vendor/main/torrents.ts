export const torrents = new Map<string, { trackers: string[]; fileIdx?: number; filename?: string }>()
export function registerTorrentStream(hash: string, options: { trackers: string[]; fileIdx?: number; filename?: string }) {
  if (!/^[a-f0-9]{40}$/i.test(hash)) throw new Error('Invalid torrent hash')
  torrents.set(hash, options)
}
