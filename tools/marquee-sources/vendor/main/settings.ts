import { configuration } from '../../bridge'
export function getSettings() {
  return { openSubtitlesApiKey: '', debridService: '', debridApiKey: '', ...configuration }
}
export function wantedSubtitleLanguages() { return ['ar', 'en', 'tr'] }
