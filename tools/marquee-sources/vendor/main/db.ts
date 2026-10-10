import { currentQuery } from '../../bridge'
// The connectors only read season counts and the selected episode's air date.
// Android supplies these from TMDB; there is no desktop database in this runtime.
export function get<T>(sql: string, params: unknown[]): T | undefined {
  const season = Number(params[1])
  if (sql.includes('COUNT(*)')) {
    const counts = currentQuery.seasonEpisodeCounts || {}
    const total = sql.includes('season_number <')
      ? Object.entries(counts).reduce((n, [key, count]) => n + (Number(key) > 0 && Number(key) < season ? Number(count) : 0), 0)
      : Number(counts[season] || 0)
    return { total } as T
  }
  if (sql.includes('air_date')) return { air_date: currentQuery.episodeAirDate ?? null } as T
  throw new Error('Unsupported catalogue lookup')
}
