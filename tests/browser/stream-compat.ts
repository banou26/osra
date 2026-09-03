import type { Capable } from '../../src/types'
import type { RevivableContext } from '../../src/revivables/utils'

import { expect } from 'chai'

import { defaultRevivableModules } from '../../src/revivables/index'
import { box, revive, BoxedReadableStream } from '../../src/revivables/readable-stream'
import { createRevivableChannel, revive as reviveMessagePort } from '../../src/revivables/message-port'
import { BoxBase } from '../../src/revivables/utils'

// legacyBox/legacyRevive below are VERBATIM osra 0.5.5 implementations - do not modernize them.

// any structured transport object serves here: the revivables only ask isJsonOnlyTransport of it,
// and a browser global would keep the group off the node runner
const fakeContext = (): RevivableContext => ({
  transport: { emit: () => {}, receive: () => {} },
  remoteUuid: crypto.randomUUID(),
  sendMessage: () => {},
  revivableModules: defaultRevivableModules,
  eventTarget: new EventTarget(),
}) as unknown as RevivableContext

const legacyBox = (value: ReadableStream, context: RevivableContext): BoxedReadableStream => {
  const { localPort, boxedRemote } = createRevivableChannel<Capable>(context)
  const reader = value.getReader()

  localPort.addEventListener('message', ({ data }) => {
    if (data && typeof data === 'object' && 'type' in data && data.type === 'pull') {
      localPort.postMessage(reader.read() as never)
    } else {
      const reason = data && typeof data === 'object' && 'reason' in data ? data.reason : undefined
      reader.cancel(reason).catch(() => {})
      localPort.close()
    }
  })
  localPort.addEventListener('close', () => {
    reader.cancel(new Error('osra: connection closed')).catch(() => {})
  }, { once: true })
  localPort.start()

  return { ...BoxBase, type: 'readableStream', port: boxedRemote } as unknown as BoxedReadableStream
}

const legacyRevive = (value: BoxedReadableStream, context: RevivableContext): ReadableStream => {
  const port = reviveMessagePort(value.port as never, context)
  port.start()

  let done = false
  return new ReadableStream({
    start: (controller) => {
      port.addEventListener('close', () => {
        if (done) return
        done = true
        try { controller.error(new Error('osra: connection closed')) } catch { /* already settled */ }
      }, { once: true })
    },
    pull: (controller) => new Promise<void>((resolve, reject) => {
      port.addEventListener('message', ({ data }) => {
        if (!(data instanceof Promise)) return
        data
          .then((result: ReadableStreamReadResult<unknown>) => {
            if (result.done) {
              done = true
              controller.close()
              port.postMessage({ type: 'cancel' } as never)
              queueMicrotask(() => port.close())
            }
            else controller.enqueue(result.value)
            resolve()
          })
          .catch((error: unknown) => {
            done = true
            reject(error)
          })
      }, { once: true })
      port.postMessage({ type: 'pull' } as never)
    }),
    cancel: (reason) => {
      done = true
      port.postMessage({ type: 'cancel', reason } as never)
      queueMicrotask(() => port.close())
    },
  })
}

const sourceOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

const readAll = async (stream: ReadableStream): Promise<number[]> => {
  const reader = stream.getReader()
  const received: number[] = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    received.push(...value as Uint8Array)
  }
  return received
}

export const newBoxAdvertisesCredit = async () => {
  const context = fakeContext()
  const boxed = box(sourceOf([]), context)
  expect(boxed.credit).to.equal(true)
  await readAll(revive(boxed, context))
}

export const newBoxServesLegacyPullRevive = async () => {
  const context = fakeContext()
  const boxed = box(sourceOf([new Uint8Array([1, 2]), new Uint8Array([3, 4])]), context)
  const received = await readAll(legacyRevive(boxed, context))
  expect(received).to.deep.equal([1, 2, 3, 4])
}

export const newReviveSpeaksPullToLegacyBox = async () => {
  const context = fakeContext()
  const boxed = legacyBox(sourceOf([new Uint8Array([1, 2]), new Uint8Array([3, 4])]), context)
  expect('credit' in boxed).to.be.false
  const received = await readAll(revive(boxed, context))
  expect(received).to.deep.equal([1, 2, 3, 4])
}

export const newReviveCancelReachesLegacyBox = async () => {
  const context = fakeContext()
  let cancelled = false
  let pulled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++
      controller.enqueue(new Uint8Array([pulled]))
    },
    cancel() {
      cancelled = true
    },
  })
  const revived = revive(legacyBox(stream, context), context)
  const reader = revived.getReader()
  const first = await reader.read()
  expect(first.value?.[0]).to.equal(1)
  await reader.cancel()
  for (let i = 0; i < 20 && !cancelled; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(cancelled).to.be.true
}

export const legacyReviveCancelReachesNewBox = async () => {
  const context = fakeContext()
  let cancelled = false
  let pulled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++
      controller.enqueue(new Uint8Array([pulled]))
    },
    cancel() {
      cancelled = true
    },
  })
  const revived = legacyRevive(box(stream, context), context)
  const reader = revived.getReader()
  const first = await reader.read()
  expect(first.value?.[0]).to.equal(1)
  await reader.cancel()
  for (let i = 0; i < 20 && !cancelled; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(cancelled).to.be.true
}

export const chunkBoxingFailureErrorsConsumer = async () => {
  const context = fakeContext()
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(circular)
    },
  })
  const reader = revive(box(stream, context), context).getReader()
  let rejected = false
  await reader.read().then(() => {}, () => { rejected = true })
  expect(rejected).to.be.true
}

const floodingBox = (context: RevivableContext): BoxedReadableStream => {
  const { localPort, boxedRemote } = createRevivableChannel<Capable>(context)
  localPort.addEventListener('message', ({ data }) => {
    if (data && typeof data === 'object' && 'type' in data && data.type === 'credit') {
      for (let i = 0; i < 1000; i++) localPort.postMessage({ type: 'chunk', value: i } as never)
    }
  })
  localPort.start()
  return { ...BoxBase, type: 'readableStream', credit: true, port: boxedRemote } as unknown as BoxedReadableStream
}

export const creditFloodFailsClosed = async () => {
  const context = fakeContext()
  const reader = revive(floodingBox(context), context).getReader()
  await reader.read()
  await new Promise(resolve => setTimeout(resolve, 100))
  let error: unknown
  try {
    for (let i = 0; i < 200; i++) await reader.read()
  } catch (e) {
    error = e
  }
  expect(String(error)).to.contain('credit window')
}

const chunkSource = (count: number, size: number): ReadableStream<Uint8Array> => {
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i++ < count) controller.enqueue(new Uint8Array(size))
      else controller.close()
    },
  })
}

const drain = async (stream: ReadableStream): Promise<number> => {
  const reader = stream.getReader()
  let bytes = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    bytes += (value as Uint8Array).byteLength
  }
  return bytes
}

export const streamCreditBench = async () => {
  const count = 2000
  const size = 16 * 1024
  const run = async (wire: (s: ReadableStream, ctx: RevivableContext) => ReadableStream) => {
    const context = fakeContext()
    const start = performance.now()
    const bytes = await drain(wire(chunkSource(count, size), context))
    const ms = performance.now() - start
    expect(bytes).to.equal(count * size)
    return ms
  }
  const pullMs = await run((s, ctx) => legacyRevive(legacyBox(s, ctx), ctx))
  const creditMs = await run((s, ctx) => revive(box(s, ctx), ctx))
  expect(creditMs, `pull=${pullMs.toFixed(0)}ms credit=${creditMs.toFixed(0)}ms`).to.be.lessThan(pullMs)
}
