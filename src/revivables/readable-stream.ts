import type { Capable } from '../types.js'
import type { RevivableContext, BoxBase as BoxBaseType } from './utils.js'
import type { UnderlyingType } from './index.js'

import { BoxBase } from './utils.js'
import { isInTransfer, forceTransfer } from './transfer.js'
import {
  createRevivableChannel,
  revive as reviveMessagePort,
  BoxedMessagePort,
  AnyPort
} from './message-port.js'

export const type = 'readableStream' as const

export type PullContext =
  | { type: 'pull' }
  | { type: 'cancel', reason?: Capable }
  | { type: 'credit', n: number }

type ChunkMessage<T = unknown> = Promise<ReadableStreamReadResult<T>>

type PushMessage =
  | { type: 'chunk', value: Capable }
  | { type: 'end' }
  | { type: 'error', error: Capable }

type Msg = PullContext | PushMessage | ChunkMessage

export type BoxedReadableStream<T extends ReadableStream = ReadableStream> =
  & BoxBaseType<typeof type>
  & { port: BoxedMessagePort<Msg>, credit?: true }
  & { [UnderlyingType]: T }

export const isType = (value: unknown): value is ReadableStream =>
  value instanceof ReadableStream

export const MAX_CREDIT_WINDOW = 64
const MIN_CREDIT_WINDOW = 2
const INITIAL_CREDIT_WINDOW = 8
const CREDIT_BYTE_BUDGET = 4 * 1024 * 1024

export const box = <T extends ReadableStream, T2 extends RevivableContext>(
  value: T,
  context: T2
): BoxedReadableStream<T> => {
  const { localPort, boxedRemote } = createRevivableChannel<Msg>(context)
  const reader = value.getReader()
  // Captured at box time: transfer(stream) marks each chunk so transferables inside it
  // move instead of copy. Chunks that themselves carry streams re-enter the extent when
  // they are boxed, which is what makes the marker propagate through nested streams.
  const transferChunks = isInTransfer()

  let credit = 0
  let pumping = false
  let finished = false

  const finish = (message: PushMessage) => {
    finished = true
    // The terminal itself can fail to box - still close so the peer's close arm errors the consumer instead of hanging it
    try { localPort.postMessage(message) } catch {}
    localPort.close()
  }

  const pump = async () => {
    if (pumping || finished) return
    pumping = true
    while (credit > 0) {
      let result: ReadableStreamReadResult<unknown>
      try { result = await reader.read() }
      catch (error) {
        if (!finished) finish({ type: 'error', error: error as Capable })
        return
      }
      if (finished) return
      if (result.done) {
        finish({ type: 'end' })
        return
      }
      credit--
      const chunk = transferChunks ? forceTransfer(result.value as Capable) : result.value as Capable
      try { localPort.postMessage({ type: 'chunk', value: chunk }) }
      catch (error) {
        finish({ type: 'error', error: error as Capable })
        reader.cancel(error).catch(() => {})
        return
      }
    }
    pumping = false
  }

  localPort.addEventListener('message', ({ data }) => {
    if (data instanceof Promise || !('type' in data)) return
    if (data.type === 'pull') {
      // Legacy peer (osra <= 0.5.5): one boxed-Promise round trip per chunk.
      localPort.postMessage(reader.read())
    } else if (data.type === 'credit') {
      credit += data.n
      pump()
    } else if (data.type === 'cancel') {
      finished = true
      reader.cancel(data.reason).catch(() => {})
      localPort.close()
    }
  })
  localPort.addEventListener('close', () => {
    if (finished) return
    finished = true
    reader.cancel(new Error('osra: connection closed')).catch(() => {})
  }, { once: true })
  localPort.start()

  return { ...BoxBase, type, credit: true, port: boxedRemote } as BoxedReadableStream<T>
}

const byteLength = (value: unknown): number | undefined =>
  ArrayBuffer.isView(value) ? value.byteLength
  : value instanceof ArrayBuffer ? value.byteLength
  : typeof value === 'string' ? value.length * 2
  : typeof Blob !== 'undefined' && value instanceof Blob ? value.size
  : undefined

const reviveCredit = (port: AnyPort<Msg>): ReadableStream => {
  let done = false
  let outstanding = 0
  let averageChunkBytes: number | undefined
  // Pipelined chunks wait here, not in the controller queue - controller.error discards queued chunks, and an early error must not eat delivered data
  const buffered: unknown[] = []
  let ended = false
  let errored = false
  let pendingError: unknown
  let waiter: {
    controller: ReadableStreamDefaultController<unknown>
    resolve: () => void
    reject: (error: unknown) => void
  } | undefined

  // Unmeasurable chunk types (plain objects, Maps, ...) stay at the initial window - jumping to MAX with zero byte accounting is how memory blows up
  const targetWindow = () =>
    averageChunkBytes !== undefined
      ? Math.max(MIN_CREDIT_WINDOW, Math.min(MAX_CREDIT_WINDOW, Math.floor(CREDIT_BYTE_BUDGET / averageChunkBytes)))
      : INITIAL_CREDIT_WINDOW

  // Half-window hysteresis: ~one credit message per target/2 chunks.
  const topUp = () => {
    const target = targetWindow()
    const ahead = outstanding + buffered.length
    if (ahead > target / 2) return
    const n = target - ahead
    outstanding += n
    port.postMessage({ type: 'credit', n })
  }

  const finishClose = () => {
    done = true
    queueMicrotask(() => port.close())
  }

  const fail = (error: unknown) => {
    errored = true
    pendingError = error
    if (!waiter || buffered.length) return
    const w = waiter
    waiter = undefined
    finishClose()
    w.reject(error)
  }

  return new ReadableStream({
    start: () => {
      port.addEventListener('message', ({ data }) => {
        if (data instanceof Promise || !('type' in data)) return
        if (data.type === 'chunk') {
          if (done) return
          if (outstanding <= 0) {
            buffered.length = 0
            fail(new Error('osra: stream exceeded its credit window'))
            queueMicrotask(() => port.close())
            return
          }
          outstanding--
          const size = byteLength(data.value)
          if (size !== undefined) {
            averageChunkBytes = averageChunkBytes === undefined ? size : averageChunkBytes * 0.875 + size * 0.125
          }
          if (waiter) {
            const w = waiter
            waiter = undefined
            w.controller.enqueue(data.value)
            w.resolve()
          } else buffered.push(data.value)
        } else if (data.type === 'end') {
          if (done) return
          ended = true
          if (!waiter || buffered.length) return
          const w = waiter
          waiter = undefined
          finishClose()
          w.controller.close()
          w.resolve()
        } else if (data.type === 'error') {
          if (done) return
          fail(data.error)
        }
      })
      port.addEventListener('messageerror', () => {
        if (done) return
        fail(new Error('osra: a chunk failed to deserialize on this platform'))
      })
      port.addEventListener('close', () => {
        if (done || ended || errored) return
        fail(new Error('osra: connection closed'))
      }, { once: true })
    },
    pull: (controller) => {
      if (done) return
      if (buffered.length) {
        controller.enqueue(buffered.shift())
        if (!ended && !errored) topUp()
        return
      }
      // errored before ended: a messageerror-dropped chunk followed by a clean 'end' must
      // surface as an error, never as a silently truncated stream
      if (errored) {
        finishClose()
        return Promise.reject(pendingError)
      }
      if (ended) {
        finishClose()
        controller.close()
        return
      }
      topUp()
      return new Promise<void>((resolve, reject) => { waiter = { controller, resolve, reject } })
    },
    cancel: (reason) => {
      done = true
      buffered.length = 0
      const w = waiter
      waiter = undefined
      w?.resolve()
      port.postMessage({ type: 'cancel', reason: reason as Capable })
      // Defer close so the cancel message dispatches before tear-down.
      queueMicrotask(() => port.close())
    },
  })
}

const revivePull = (port: AnyPort<Msg>): ReadableStream => {
  let done = false
  return new ReadableStream({
    start: (controller) => {
      port.addEventListener('messageerror', () => {
        if (done) return
        done = true
        try { controller.error(new Error('osra: a chunk failed to deserialize on this platform')) } catch {}
        queueMicrotask(() => port.close())
      })
      port.addEventListener('close', () => {
        if (done) return
        done = true
        try { controller.error(new Error('osra: connection closed')) } catch {}
      }, { once: true })
    },
    pull: (controller) => new Promise<void>((resolve, reject) => {
      port.addEventListener('message', ({ data }) => {
        if (!(data instanceof Promise)) return
        data
          .then(result => {
            if (result.done) {
              done = true
              controller.close()
              port.postMessage({ type: 'cancel' })
              queueMicrotask(() => port.close())
            }
            else controller.enqueue(result.value)
            resolve()
          })
          .catch(error => {
            done = true
            reject(error)
          })
      }, { once: true })
      port.postMessage({ type: 'pull' })
    }),
    cancel: (reason) => {
      done = true
      port.postMessage({ type: 'cancel', reason: reason as Capable })
      queueMicrotask(() => port.close())
    },
  })
}

export const revive = <T extends BoxedReadableStream, T2 extends RevivableContext>(
  value: T,
  context: T2
): T[UnderlyingType] => {
  const port = reviveMessagePort(value.port, context)
  port.start()
  // A box that doesn't advertise credit (osra <= 0.5.5) cancels on any unknown message, so it must only ever be spoken to in pull
  return (value.credit ? reviveCredit(port) : revivePull(port)) as T[UnderlyingType]
}

const typeCheck = () => {
  const stream = new ReadableStream<number>()
  const boxed = box(stream, {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: ReadableStream<number> = revived
  // @ts-expect-error - wrong stream type
  const wrongType: ReadableStream<string> = revived
  // @ts-expect-error - not a ReadableStream
  box('not a stream', {} as RevivableContext)
}
