import { expect } from 'chai'

import { expose, transfer } from '../../src/index'

/** The three examples of docs/src/content/docs/general/getting-started.md, run as written: the
 *  worker side is the example's worker.ts as plain JS in a real module Worker importing the built
 *  package, the page side is the example's main.ts against the source bundle. A docs example that
 *  only ran in node over a MessageChannel had never crossed a real worker boundary in a browser. */

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

// ---- Simple cross context communication

type SimpleWorker = { add: (a: number, b: number) => number }

const simpleWorkerSource = () => `
  import('${osraUrl()}').then(async ({ expose }) => {
    const { mult, report } = await expose(
      { add: (a, b) => a + b },
      { transport: globalThis }
    )
    report(await mult(3, 7))
  })
`

export const simpleCrossContextCommunication = () =>
  withWorker(simpleWorkerSource(), async worker => {
    const { promise: reported, resolve: report } = Promise.withResolvers<number>()
    const { add } = await expose<SimpleWorker>(
      { mult: (a: number, b: number) => a * b, report },
      { transport: worker }
    )
    expect(await add(40, 2)).to.equal(42)
    expect(await reported, 'the worker called the page\'s mult').to.equal(21)
  })

// ---- Callbacks, generators and cancellation

type MediumWorker = {
  countTo: (n: number, onTick: (i: number) => void) => Promise<string>
  fibonacci: () => AsyncGenerator<number>
  fibonacciCleanedUp: () => boolean
  wait: (ms: number, signal: AbortSignal) => Promise<string>
}

const mediumWorkerSource = () => `
  import('${osraUrl()}').then(({ expose }) => {
    let cleanedUp = false
    const payload = {
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
    }
    expose(payload, { transport: globalThis })
  })
`

export const callbacksGeneratorsAndCancellation = () =>
  withWorker(mediumWorkerSource(), async worker => {
    const { countTo, fibonacci, fibonacciCleanedUp, wait } =
      await expose<MediumWorker>({}, { transport: worker })

    const ticks: number[] = []
    expect(await countTo(3, i => { ticks.push(i) })).to.equal('done')
    expect(ticks, 'every tick reached the page before the call resolved').to.deep.equal([1, 2, 3])

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

const highWorkerSource = () => `
  import('${osraUrl()}').then(async ({ expose, transfer }) => {
    const payload = {
      sha256: async (stream) => {
        const bytes = await new Response(stream).arrayBuffer()
        const digest = await crypto.subtle.digest('SHA-256', bytes)
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      },
      gzip: (stream) =>
        transfer(stream.pipeThrough(new CompressionStream('gzip')))
    }
    const page = await expose(payload, { transport: globalThis })
    await page.log('ready')
  })
`

// sha256 of the bytes of 'hello osra'
const HELLO_OSRA_SHA256 = 'e3c59cf79b983eec844eb817bc4288125d53518df46268e0b586b4c584e10fe9'

export const streamsTransferAndBothDirections = () =>
  withWorker(highWorkerSource(), async worker => {
    const controller = new AbortController()
    const { promise: logged, resolve: onLog } = Promise.withResolvers<string>()

    const { sha256, gzip } = await expose<HighWorker>(
      { log: (line: string) => { onLog(line) } },
      { transport: worker, unregisterSignal: controller.signal }
    )
    expect(await logged, 'the worker called back into the page').to.equal('ready')

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
