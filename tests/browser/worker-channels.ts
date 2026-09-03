import { expect } from 'chai'

import { expose } from '../../src/index'

/** Channels that settle before their box has shipped, across a real worker boundary.
 *
 *  Gecko discards the messages queued on a MessagePort whose sender closed before the port was
 *  transferred to a worker; Chromium and WebKit deliver them, as the spec says. Osra produces that
 *  shape whenever a channel settles in the same tick as the call that carries it, because the
 *  envelope leaves in a microtask: a signal aborted right after the call, or a promise that is
 *  already resolved when it crosses (its `.then` reaction runs before that microtask). Measured
 *  2026-09-03; every test here hung on Firefox before message-port.ts deferred the local close. */

const osraUrl = () => new URL('/build/index.js', location.href).href

const withWorker = async <T>(source: string, run: (worker: Worker) => Promise<T>): Promise<T> => {
  const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
  const worker = new Worker(url, { type: 'module' })
  try {
    return await run(worker)
  } finally {
    worker.terminate()
    URL.revokeObjectURL(url)
  }
}

const DEADLINE_MS = 2_000
const settled = <T>(p: Promise<T>) =>
  Promise.race([
    p.then(v => `resolved:${String(v)}`, (e: unknown) => `rejected:${(e as Error)?.message ?? String(e)}`),
    new Promise<string>(r => setTimeout(() => r('timeout'), DEADLINE_MS)),
  ])

type WorkerApi = {
  wait: (ms: number, signal: AbortSignal) => Promise<string>
  awaitArg: (p: Promise<number>) => Promise<number>
  returnResolved: () => Promise<{ p: Promise<number> }>
}

const workerSource = () => `
  import('${osraUrl()}').then(({ expose }) => {
    expose({
      wait: (ms, signal) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve('finished'), ms)
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) })
      }),
      awaitArg: async (p) => await p,
      returnResolved: async () => ({ p: Promise.resolve(42) }),
    }, { transport: globalThis })
  })
`

export const abortInTheSameTickReachesTheWorker = () =>
  withWorker(workerSource(), async worker => {
    const { wait } = await expose<WorkerApi>({}, { transport: worker })
    const controller = new AbortController()
    const pending = wait(DEADLINE_MS * 5, controller.signal)
    controller.abort(new Error('changed my mind'))
    expect(await settled(pending)).to.equal('rejected:changed my mind')
  })

export const resolvedPromiseArgumentSettlesInTheWorker = () =>
  withWorker(workerSource(), async worker => {
    const { awaitArg } = await expose<WorkerApi>({}, { transport: worker })
    expect(await settled(awaitArg(Promise.resolve(7)))).to.equal('resolved:7')
  })

export const resolvedPromiseInAReturnValueSettles = () =>
  withWorker(workerSource(), async worker => {
    const { returnResolved } = await expose<WorkerApi>({}, { transport: worker })
    const { p } = await returnResolved()
    expect(await settled(p)).to.equal('resolved:42')
  })

/** The platform measurement the workaround rests on, asserted per engine so a Gecko fix shows up as
 *  a failure here and tells us the deferred close can go. No osra involved. */
export const platformKeepsQueuedMessagesWhenTheSenderClosesBeforeTransfer = () =>
  withWorker(`
    addEventListener('message', event => {
      const port = event.data.port
      port.addEventListener('message', e => { postMessage('got:' + e.data) })
      port.start()
    })
    postMessage('ready')
  `, async worker => {
    const { port1, port2 } = new MessageChannel()
    const { promise: ready, resolve: onReady } = Promise.withResolvers<void>()
    const { promise, resolve } = Promise.withResolvers<string>()
    worker.addEventListener('message', event => {
      if (event.data === 'ready') onReady()
      else resolve(String(event.data))
    })
    await ready
    port1.postMessage('hello')
    port1.close()
    worker.postMessage({ port: port2 }, [port2])
    const result = await Promise.race([promise, new Promise<string>(r => setTimeout(() => r('timeout'), DEADLINE_MS))])
    const gecko = /\bGecko\/\d/.test(navigator.userAgent) && !/like Gecko/.test(navigator.userAgent)
    expect(result, gecko ? 'Gecko now keeps the queue: retire the deferred close in message-port.ts' : 'the spec behaviour')
      .to.equal(gecko ? 'timeout' : 'got:hello')
  })
