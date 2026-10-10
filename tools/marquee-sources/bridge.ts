declare const SahraBridge: { request(id: number, payload: string): void; cancel(id: number): void; event(payload: string): void }
let next = 0
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
export let configuration: any = {}
export let currentQuery: any = {}
export function configure(config: any, query: any) { configuration = config; currentQuery = query }
export function emit(value: unknown) { SahraBridge.event(JSON.stringify(value)) }
export function deliver(id: number, value: any) {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  if (value.error) entry.reject(new Error(value.error))
  else entry.resolve(value)
}
export function native(payload: any, signal?: AbortSignal): Promise<any> {
  const id = ++next
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'))
    const abort = () => { pending.delete(id); SahraBridge.cancel(id); reject(new Error('Cancelled')) }
    signal?.addEventListener('abort', abort, { once: true })
    pending.set(id, {
      resolve: value => { signal?.removeEventListener('abort', abort); resolve(value) },
      reject: error => { signal?.removeEventListener('abort', abort); reject(error) }
    })
    SahraBridge.request(id, JSON.stringify(payload))
  })
}
