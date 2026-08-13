// each entry must be self-contained: content scripts and MV3 service workers can't share chunks
// do not fold this back into a vite config: as vite.extension-test.config.ts it ran three nested viteBuild() calls from a buildStart hook, and with `formats: []` on the outer config vite 8 returns before plugin hooks fire, leaving the extension build silently empty

import { build as viteBuild } from 'vite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { Script } from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(__dirname, 'build/extension-test')

const buildEntry = (name, entry) =>
  viteBuild({
    configFile: false,
    build: {
      target: 'esnext',
      outDir,
      emptyOutDir: false,
      sourcemap: true,
      minify: false,
      lib: {
        entry,
        name,
        fileName: () => `${name}.js`,
        formats: ['es'],
      },
    },
    logLevel: 'warn',
  })

await rm(outDir, { recursive: true }).catch(() => {})
await mkdir(outDir, { recursive: true })

console.log('[ext-build] background.js')
await buildEntry('background', resolve(__dirname, 'tests/extension/background.ts'))

console.log('[ext-build] content.js')
await buildEntry('content', resolve(__dirname, 'tests/extension/content.ts'))

console.log('[ext-build] popup.js')
await buildEntry('popup', resolve(__dirname, 'tests/extension/popup.ts'))

// A manifest content script and an MV3 service worker are both loaded as CLASSIC scripts, so module-only
// syntax (top-level await, import, export) is a PARSE error there. Nothing reports it: the file just never
// runs, `globalThis.tests` never appears, and the suite hangs in beforeAll looking like a timeout. That is
// exactly how all 47 extension tests sat dead. vm.Script parses with the same rules the browser uses.
for (const name of ['background', 'content', 'popup']) {
  const file = resolve(outDir, `${name}.js`)
  try {
    new Script(await readFile(file, 'utf8'), { filename: file })
  } catch (error) {
    throw new Error(`[ext-build] ${name}.js is not loadable as a classic script: ${error.message}`)
  }
}

await copyFile(
  resolve(__dirname, 'tests/extension/manifest.json'),
  resolve(outDir, 'manifest.json'),
)
await copyFile(
  resolve(__dirname, 'tests/extension/popup.html'),
  resolve(outDir, 'popup.html'),
)

console.log('[ext-build] done')
