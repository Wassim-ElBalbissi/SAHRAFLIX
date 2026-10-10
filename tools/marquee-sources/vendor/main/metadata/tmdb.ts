import { native } from '../../../bridge'
export async function getAlternativeTitles(id: number, type: string): Promise<string[]> {
  const result = await native({ type: 'tmdb', path: `${type === 'movie' ? 'movie' : 'tv'}/${id}/alternative_titles` })
  const body = JSON.parse(result.body)
  return (body.titles || body.results || []).map((item: any) => item.title).filter(Boolean)
}
