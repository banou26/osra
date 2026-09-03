import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

import { expect } from 'chai'

import type { Transport } from '../../src'
import type { Message } from '../../src/types'
import type { MessageContext } from '../../src/utils/transport'

import { expose, transfer } from '../../src/index'

/** The getting started examples over node's worker_threads, the way node needs them: a node
 *  worker has no global postMessage, so the worker side exposes on `parentPort` (a real
 *  MessagePort), and the main side wraps the Worker, an EventEmitter rather than an EventTarget,
 *  in a custom { emit, receive } pair. The worker imports the built package while the main side
 *  runs the source, so two copies of osra meet on the wire. */

// from the working directory, the repo root under `npm run test-node`: the bundle's own location
// is build-test/, one directory off from where the test source sits
const osraUrl = () => pathToFileURL(path.resolve('build/index.js')).href

/** The main side of a node Worker as an osra transport. */
const workerTransport = (worker: Worker): Transport => ({
  emit: (message: Message, transferables?: Transferable[]) => {
    worker.postMessage(message, transferables as never)
  },
  receive: (listener: (message: Message, context: MessageContext) => void) => {
    worker.on('message', (data: Message) => listener(data, {}))
  },
})

const withWorker = async <T>(source: string, run: (transport: Transport) => Promise<T>): Promise<T> => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads')
    import('${osraUrl()}').then(({ expose, transfer }) => { ${source} })
  `, { eval: true })
  try {
    return await run(workerTransport(worker))
  } finally {
    await worker.terminate()
  }
}

// ---- Simple cross context communication

type SimpleWorker = { add: (a: number, b: number) => number }

export const simpleCrossContextCommunication = () =>
  withWorker(`
    expose({ add: (a, b) => a + b }, { transport: parentPort }).then(async ({ mult, report }) => {
      report(await mult(3, 7))
    })
  `, async transport => {
    const { promise: reported, resolve: report } = Promise.withResolvers<number>()
    const { add } = await expose<SimpleWorker>(
      { mult: (a: number, b: number) => a * b, report },
      { transport }
    )
    expect(await add(40, 2)).to.equal(42)
    expect(await reported, 'the worker called the main thread\'s mult').to.equal(21)
  })

// ---- Callbacks, generators and cancellation

type MediumWorker = {
  countTo: (n: number, onTick: (i: number) => void) => Promise<string>
  fibonacci: () => AsyncGenerator<number>
  fibonacciCleanedUp: () => boolean
  wait: (ms: number, signal: AbortSignal) => Promise<string>
}

export const callbacksGeneratorsAndCancellation = () =>
  withWorker(`
    let cleanedUp = false
    expose({
      countTo: async (n, onTick) => {
        for (let i = 1; i <= n; i++) onTick(i)
        return 'done'
      },
      fibonacci: async function* () {
        let [a, b] = [0, 1]
        try {
          while (true) {
            yield a
            ;[a, b] = [b, a + b]
          }
        } finally {
          cleanedUp = true
        }
      },
      fibonacciCleanedUp: () => cleanedUp,
      wait: (ms, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve('finished'), ms)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(signal.reason)
          })
        })
    }, { transport: parentPort })
  `, async transport => {
    const { countTo, fibonacci, fibonacciCleanedUp, wait } =
      await expose<MediumWorker>({}, { transport })

    const ticks: number[] = []
    expect(await countTo(3, i => { ticks.push(i) })).to.equal('done')
    expect(ticks).to.deep.equal([1, 2, 3])

    const fibs: number[] = []
    for await (const n of await fibonacci()) {
      if (n > 20) break
      fibs.push(n)
    }
    expect(fibs).to.deep.equal([0, 1, 1, 2, 3, 5, 8, 13])
    expect(await fibonacciCleanedUp(), 'break ran the generator\'s finally block in the worker').to.equal(true)

    const controller = new AbortController()
    const pending = wait(10_000, controller.signal)
    controller.abort(new Error('changed my mind'))
    const reason = await pending.then(() => undefined, (error: unknown) => error)
    expect(reason).to.be.instanceOf(Error)
    expect((reason as Error).message).to.equal('changed my mind')
  })

// ---- Streams, transfer and both directions

type HighWorker = {
  sha256: (stream: ReadableStream<Uint8Array<ArrayBuffer>>) => Promise<string>
  gzip: (stream: ReadableStream<Uint8Array<ArrayBuffer>>) => ReadableStream<Uint8Array<ArrayBuffer>>
}

const HELLO_OSRA_SHA256 = 'e3c59cf79b983eec844eb817bc4288125d53518df46268e0b586b4c584e10fe9'

export const streamsTransferAndBothDirections = () =>
  withWorker(`
    const payload = {
      sha256: async (stream) => {
        const bytes = await new Response(stream).arrayBuffer()
        const digest = await crypto.subtle.digest('SHA-256', bytes)
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      },
      gzip: (stream) =>
        transfer(stream.pipeThrough(new CompressionStream('gzip')))
    }
    expose(payload, { transport: parentPort }).then(page => page.log('ready'))
  `, async transport => {
    const controller = new AbortController()
    const { promise: logged, resolve: onLog } = Promise.withResolvers<string>()

    const { sha256, gzip } = await expose<HighWorker>(
      { log: (line: string) => { onLog(line) } },
      { transport, unregisterSignal: controller.signal }
    )
    expect(await logged, 'the worker called back into the main thread').to.equal('ready')

    const file = new File(['hello osra'], 'hello.txt')

    expect(await sha256(transfer(file.stream()))).to.equal(HELLO_OSRA_SHA256)

    const compressed = await new Response(await gzip(transfer(file.stream()))).blob()
    expect(compressed.size).to.be.greaterThan(0)
    const inflated = await new Response(
      compressed.stream().pipeThrough(new DecompressionStream('gzip')),
    ).text()
    expect(inflated).to.equal('hello osra')

    controller.abort()
    await expect(sha256(transfer(file.stream()))).to.be.rejectedWith('osra: connection closed')
  })

// ---- The channel timing the Firefox fix pins, over a thread boundary

type ChannelWorker = {
  wait: (ms: number, signal: AbortSignal) => Promise<string>
  awaitArg: (p: Promise<number>) => Promise<number>
  returnResolved: () => Promise<{ p: Promise<number> }>
}

const channelSource = `
  expose({
    wait: (ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve('finished'), ms)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) })
    }),
    awaitArg: async (p) => await p,
    returnResolved: async () => ({ p: Promise.resolve(42) }),
  }, { transport: parentPort })
`

const settled = <T>(p: Promise<T>) =>
  Promise.race([
    p.then(v => `resolved:${String(v)}`, (e: unknown) => `rejected:${(e as Error)?.message ?? String(e)}`),
    new Promise<string>(r => setTimeout(() => r('timeout'), 2_000)),
  ])

export const abortInTheSameTickReachesTheWorker = () =>
  withWorker(channelSource, async transport => {
    const { wait } = await expose<ChannelWorker>({}, { transport })
    const controller = new AbortController()
    const pending = wait(10_000, controller.signal)
    controller.abort(new Error('changed my mind'))
    expect(await settled(pending)).to.equal('rejected:changed my mind')
  })

export const resolvedPromiseArgumentSettlesInTheWorker = () =>
  withWorker(channelSource, async transport => {
    const { awaitArg } = await expose<ChannelWorker>({}, { transport })
    expect(await settled(awaitArg(Promise.resolve(7)))).to.equal('resolved:7')
  })

export const resolvedPromiseInAReturnValueSettles = () =>
  withWorker(channelSource, async transport => {
    const { returnResolved } = await expose<ChannelWorker>({}, { transport })
    const { p } = await returnResolved()
    expect(await settled(p)).to.equal('resolved:42')
  })
