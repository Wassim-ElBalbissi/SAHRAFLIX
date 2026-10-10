import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
await build({
  absWorkingDir: root,
  entryPoints: ['runtime.ts'],
  outfile: '../../app/src/main/assets/marquee-runtime.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  minify: true,
  legalComments: 'inline',
  alias: { '@shared': path.join(root, 'vendor/shared') }
})
