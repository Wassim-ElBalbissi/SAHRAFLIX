const ids = new Map<number, number>()
export function getTvmazeId(id: number) { return ids.get(id) }
export function setTvmazeId(id: number, tvmazeId: number) { ids.set(id, tvmazeId) }
