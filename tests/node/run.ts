/// <reference path="../global-types.d.ts" />

import { describe, test } from 'node:test'

import { use } from 'chai'
import chaiAsPromised from 'chai-as-promised'

import { transportTests, memoryTests, standaloneTests, gcTests } from '../browser/registry'
import { nodeTransports } from './transports'
import { browserOnly } from './browser-only'
import * as workerThreads from './worker-threads'
import { useWebSocketRelay } from './ws-relay'

/** The browser registry, run under node. Same test functions, node-native transports, node:test
 *  as the harness. Skips are explicit and carry a reason (browser-only.ts), so a test that stops
 *  running here does so by decision and not by accident. Run with --expose-gc: the GC and memory
 *  tests are built on a real collection, and without one they would report success unconditionally. */

use(chaiAsPromised)

const gc = (globalThis as { gc?: () => void }).gc
if (!gc) throw new Error('run with --expose-gc: the GC and memory tests need globalThis.gc')

const forceGc = async () => {
  for (let i = 0; i < 10; i++) {
    gc()
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
;(globalThis as { __osraForceGc?: () => Promise<void> }).__osraForceGc = forceGc

const skip = (group: string, name: string) => browserOnly[`${group}/${name}`] ?? browserOnly[group] ?? false

// per test, never per suite: node 22 applies --test-timeout to a describe() as a whole, and the
// transport suites run for longer than any sane single-test timeout
const TEST_TIMEOUT_MS = 15_000
const MEMORY_TEST_TIMEOUT_MS = 120_000
const GC_TEST_TIMEOUT_MS = 30_000

for (const t of nodeTransports) {
  describe(t.name, () => {
    for (const [group, suite] of Object.entries(transportTests)) {
      describe(group, () => {
        for (const [name, fn] of Object.entries(suite)) {
          test(name, { skip: skip(group, name), timeout: TEST_TIMEOUT_MS }, async () => {
            await fn(t.factory())
          })
        }
      })
    }

    describe('MemoryLeaks', () => {
      for (const [name, fn] of Object.entries(memoryTests)) {
        test(name, { skip: skip('MemoryLeaks', name), timeout: MEMORY_TEST_TIMEOUT_MS }, async () => {
          await forceGc()
          const initial = process.memoryUsage().heapUsed
          await fn(t.factory(), t.memoryIterations)
          await forceGc()
          const growth = process.memoryUsage().heapUsed - initial
          if (growth > t.memoryThreshold) throw new Error(`Memory leak detected: ${growth} bytes growth`)
        })
      }
    })

    describe('GcTests', () => {
      for (const [name, fn] of Object.entries(gcTests)) {
        test(name, { skip: skip('GcTests', name), timeout: GC_TEST_TIMEOUT_MS }, async () => {
          await fn(t.factory())
        })
      }
    })
  })
}

for (const [group, suite] of Object.entries(standaloneTests)) {
  describe(group, () => {
    // webSocketRpc and webSocketCallback dial ws://localhost:3001, the relay playwright runs as a webServer
    if (group === 'PlatformTransports') useWebSocketRelay()
    for (const [name, fn] of Object.entries(suite)) {
      test(name, { skip: skip(group, name), timeout: TEST_TIMEOUT_MS }, async () => {
        await fn()
      })
    }
  })
}

describe('WorkerThreads', () => {
  for (const [name, fn] of Object.entries(workerThreads)) {
    if (typeof fn !== 'function') continue
    test(name, { timeout: TEST_TIMEOUT_MS }, async () => {
      await (fn as () => Promise<void>)()
    })
  }
})
