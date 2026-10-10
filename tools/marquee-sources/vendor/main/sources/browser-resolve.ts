import { native } from '../../../bridge'
import { registerStreamHeaders } from './headers'
export async function resolveViaBrowser(url: string, timeout: number, options: { referer?: string } = {}) {
  const result = await native({ type: 'browser', url, timeout, referer: options.referer })
  if (result.file && result.headers) registerStreamHeaders(result.file, result.headers)
  return result.file ? result : null
}
