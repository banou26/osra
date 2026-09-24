import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

// vite-plus bundles its own vitest and ships vite as vite-plus-core, and its docs require a project to
// pin both to the same release ("Updating the Vitest Pin" at viteplus.dev). A pin left behind on a
// vite-plus bump keeps installing the previous runner. osra had no vitest pin at all and carried the
// vulnerable vitest 4.1.10 (GHSA-82fw-gwwq-j7x9) under vite-plus 0.2.4 until 2026-09-24. The root
// overrides apply to the docs workspace too, so the Astro build runs on the same vite-plus-core.
// Reads package.json and the lockfile only, so it runs from a bare checkout.
const ROOT = join(import.meta.dirname, '..', '..')

type LockEntry = { name?: string; version: string; dependencies?: Record<string, string> }
type Manifest = { devDependencies: Record<string, string>; overrides?: Record<string, string> }

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, LockEntry>
}

const installed = (pattern: RegExp) =>
  Object.entries(lock.packages).filter(([path]) => pattern.test(path))

describe('the vite-plus toolchain is pinned as one release', () => {
  const vitePlus = lock.packages['node_modules/vite-plus']
  assert.ok(vitePlus, 'the lockfile installs no vite-plus')
  const core = `npm:@voidzero-dev/vite-plus-core@${vitePlus.version}`

  test('the vite alias names the core of the installed vite-plus, everywhere npm reads it', () => {
    assert.equal(manifest.devDependencies['vite-plus'], vitePlus.version)
    assert.equal(manifest.devDependencies.vite, core)
    assert.equal(manifest.overrides?.vite, core)
    const vites = installed(/(^|\/)node_modules\/vite$/).map(
      ([, entry]) => `${entry.name}@${entry.version}`,
    )
    assert.deepEqual(vites, [`@voidzero-dev/vite-plus-core@${vitePlus.version}`])
  })

  test('the vitest pin is the vitest vite-plus itself depends on', () => {
    assert.ok(vitePlus.dependencies?.vitest, 'vite-plus declares no vitest dependency')
    assert.equal(manifest.overrides?.vitest, vitePlus.dependencies.vitest)
  })

  test('one vitest is installed, and every @vitest package is at the pinned version', () => {
    const copies = installed(/(^|\/)node_modules\/(vitest|@vitest\/[^/]+)$/)
    assert.ok(copies.length > 1, 'the scan found no vitest at all, so it proves nothing')
    const off = copies
      .filter(([, entry]) => entry.version !== manifest.overrides?.vitest)
      .map(([path, entry]) => `${path}@${entry.version}`)
    assert.deepEqual(off, [])
    assert.equal(copies.filter(([path]) => path.endsWith('node_modules/vitest')).length, 1)
  })
})
