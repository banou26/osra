// Fails when a shipped declaration imports a bare specifier.
//
// osra declares no dependencies, so anything `build/**/*.d.ts` imports by package name is a module
// the consumer may simply not have. 0.6.6 and 0.6.7 both shipped `import type { Browser } from
// 'webextension-polyfill'`: with `skipLibCheck: false` that is TS2307 on install, and with it on the
// import silently becomes `any`, which collapsed the whole `Transport` union and every check built on
// it. `tests/consumer` could not catch it, because a bare specifier resolves up into this repo's own
// node_modules.
//
// Run it against a fresh `npm run build`. It prints what it scanned, so a run that found nothing to
// check fails instead of reporting success.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = join(ROOT, 'build')

const declarations = (dir) =>
  readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return declarations(path)
    return path.endsWith('.d.ts') ? [path] : []
  })

// `from '…'`, `import('…')` and the bare `import '…'` side-effect form
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g

const isLocal = (specifier) =>
  specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('node:')

let files
try {
  files = declarations(BUILD)
} catch {
  console.error(`[check-declaration-imports] no build/ directory at ${BUILD} - run \`npm run build\` first`)
  process.exit(1)
}

if (files.length === 0) {
  console.error('[check-declaration-imports] build/ holds no .d.ts files - nothing was checked')
  process.exit(1)
}

let scanned = 0
const offenders = []

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  for (const [, specifier] of source.matchAll(SPECIFIER)) {
    scanned++
    if (isLocal(specifier)) continue
    const line = source.slice(0, source.indexOf(specifier)).split('\n').length
    offenders.push(`${relative(ROOT, file)}:${line}  imports '${specifier}'`)
  }
}

console.log(`[check-declaration-imports] ${files.length} declaration files, ${scanned} module specifiers`)

if (offenders.length > 0) {
  console.error(`[check-declaration-imports] BARE IMPORTS: ${offenders.length}`)
  for (const offender of offenders) console.error(`  ${offender}`)
  console.error('  osra declares no dependencies, so a consumer has nothing to resolve these to.')
  console.error('  Vendor the shapes into src/ (see src/utils/webext-types.ts) instead of importing them.')
  process.exit(1)
}

console.log('[check-declaration-imports] OK  every import is relative or node:')
