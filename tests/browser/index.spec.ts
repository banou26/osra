import type { Page } from '@playwright/test'

import { test } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { mkdir, writeFile } from 'fs/promises'

import { transportTests, memoryTests, standaloneTests, gcTests } from './registry'
import { transports } from './transports'

// Heaviest memory test (concurrentCallsNoLeak) lands around 50s on a quiet machine.
const MEMORY_TEST_TIMEOUT_MS = 120_000
const GC_TEST_TIMEOUT_MS = 30_000

// Absolute so addScriptTag works from any cwd - WebKit's Playwright worker resolves relative paths elsewhere.
const TEST_BUNDLE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'build-test',
  'test.js',
)

test.beforeEach(async ({ page }) => {
  // OSRA_TEST_URL only for the case where something else already holds :3000 locally; the config's
  // own webServer, and therefore CI, is unaffected. The page's content barely matters (the bundle is
  // injected from disk), but the worker tests fetch build/index.js from this origin.
  await page.goto(process.env.OSRA_TEST_URL ?? 'http://localhost:3000')
  await page.addScriptTag({ path: TEST_BUNDLE_PATH, type: 'module' })
  await page.waitForFunction(() => '__osraRun' in globalThis)
})

test.afterEach(async ({ page }) => {
  // Only when the bundle was built instrumented (VITE_COVERAGE), otherwise every test in every run
  // serializes a coverage object over CDP and writes a file nothing ever reads.
  if (!process.env.VITE_COVERAGE) return
  const coverage = await page.evaluate(() => (window as unknown as { __coverage__?: unknown }).__coverage__)
  if (!coverage) return
  const dir = path.join(process.cwd(), '.nyc_output')
  await mkdir(dir, { recursive: true }).catch(() => {})
  await writeFile(
    path.join(dir, `coverage-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
    JSON.stringify(coverage),
  )
})

const measureHeapGrowth = async (page: Page, threshold: number) => {
  const client = await page.context().newCDPSession(page)
  await client.send('Performance.enable')
  await client.send('HeapProfiler.collectGarbage')
  const initial = (await client.send('Performance.getMetrics')).metrics
    .find(m => m.name === 'JSHeapUsedSize')?.value
  if (initial === undefined) throw new Error('Initial heap size unavailable')

  return async () => {
    for (let i = 0; i < 10; i++) {
      await client.send('HeapProfiler.collectGarbage')
      await page.evaluate(() => new Promise(r => setTimeout(r, 100)))
      await client.send('HeapProfiler.collectGarbage')
    }
    const finalHeap = (await client.send('Performance.getMetrics')).metrics
      .find(m => m.name === 'JSHeapUsedSize')?.value ?? 0
    const growth = finalHeap - initial
    if (growth > threshold) throw new Error(`Memory leak detected: ${growth} bytes growth`)
  }
}

for (const t of transports) {
  test.describe(t.name, () => {
    for (const [group, suite] of Object.entries(transportTests)) {
      test.describe(group, () => {
        for (const name of Object.keys(suite)) {
          test(name, async ({ page }) => {
            await page.evaluate(
              async ([g, n, tn]) => globalThis.__osraRun.transport(g, n, tn as never),
              [group, name, t.name] as const,
            )
          })
        }
      })
    }

    test.describe('MemoryLeaks', () => {
      test.skip(({ browserName }) => browserName !== 'chromium', 'CDP required')
      for (const name of Object.keys(memoryTests)) {
        test(name, async ({ page }) => {
          test.setTimeout(MEMORY_TEST_TIMEOUT_MS)
          const finalize = await measureHeapGrowth(page, t.memoryThreshold)
          await page.evaluate(
            async ([n, tn]) => globalThis.__osraRun.memory(n, tn as never),
            [name, t.name] as const,
          )
          await finalize()
        })
      }
    })

    // Drain macrotasks between collections so FinalizationRegistry callbacks actually fire.
    test.describe('GcTests', () => {
      for (const name of Object.keys(gcTests)) {
        test(name, async ({ page }) => {
          test.setTimeout(GC_TEST_TIMEOUT_MS)
          await page.exposeFunction('__osraForceGc', async () => {
            for (let i = 0; i < 10; i++) {
              await page.requestGC()
              await page.evaluate(() => new Promise(r => setTimeout(r, 50)))
            }
          })
          await page.evaluate(
            async ([n, tn]) => globalThis.__osraRun.gc(n, tn as never),
            [name, t.name] as const,
          )
        })
      }
    })
  })
}

for (const [group, suite] of Object.entries(standaloneTests)) {
  test.describe(group, () => {
    for (const name of Object.keys(suite)) {
      test(name, async ({ page }) => {
        await page.evaluate(
          async ([g, n]) => globalThis.__osraRun.standalone(g, n),
          [group, name] as const,
        )
      })
    }
  })
}
