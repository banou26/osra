import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// A CommonJS consumer requires osra through the published exports map, resolved here by the package's
// self-reference, so this reads package.json exactly as an installed copy would. With an `import` condition
// alone, require() met ERR_PACKAGE_PATH_NOT_EXPORTED (osra 0.6.13; 22 of @fkn/lib's 31 require entries
// failed on it). Node loads an ES module through require() from 22.12. Needs `npm run build` first.
const require = createRequire(import.meta.url)

test('require resolves osra to the file import resolves', () => {
  assert.equal(require.resolve('osra'), fileURLToPath(import.meta.resolve('osra')))
  assert.equal(require.resolve('osra/build/index'), fileURLToPath(import.meta.resolve('osra/build/index')))
})

test('require loads osra, and it is the same module import loads', async () => {
  const required = require('osra') as typeof import('osra')
  assert.equal(typeof required.expose, 'function')
  assert.equal(required.expose, (await import('osra')).expose)
  assert.equal((require('osra/build/index') as typeof import('osra')).expose, required.expose)
})
