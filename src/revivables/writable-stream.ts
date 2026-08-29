import type { RevivableContext, BoxBase as BoxBaseType } from './utils.js'
import type { UnderlyingType } from './index.js'
import type { Capable } from '../types.js'

import { BoxBase } from './utils.js'
import { isInTransfer, forceTransfer } from './transfer.js'
import {
  createRevivableChannel,
  revive as reviveMessagePort,
  BoxedMessagePort,
} from './message-port.js'

export const type = 'writableStream' as const

// outgoing wire shape revive -> box, one per call
export type WriteContext =
  | { type: 'write', chunk: Capable }
  | { type: 'close' }
  | { type: 'abort', reason: Capable }

// reply box -> revive after a write completes, which is what lets writer.write() await
export type WriteAck =
  | { type: 'ack' }
  | { type: 'err', error: string }

export type Msg = WriteContext | WriteAck

export type BoxedWritableStream<T extends WritableStream = WritableStream> =
  & BoxBaseType<typeof type>
  // transferChunks rides the wire because chunks originate on the revive side; old peers ignore it
  & { port: BoxedMessagePort<Msg>, transferChunks?: true }
  & { [UnderlyingType]: T }

export const isType = (value: unknown): value is WritableStream =>
  value instanceof WritableStream

export const box = <T extends WritableStream, T2 extends RevivableContext>(
  value: T,
  context: T2
): BoxedWritableStream<T> => {
  const { localPort, boxedRemote } = createRevivableChannel<Msg>(context)
  const writer = value.getWriter()

  let terminated = false
  const settle = (op: Promise<void>, terminal: boolean) =>
    op
      .then(() => localPort.postMessage({ type: 'ack' }))
      .catch((err) => localPort.postMessage({ type: 'err', error: (err as Error)?.message ?? String(err) }))
      .then(() => {
        if (!terminal) return
        terminated = true
        queueMicrotask(() => localPort.close())
      })

  localPort.addEventListener('message', ({ data }) => {
    if (!data || typeof data !== 'object' || !('type' in data)) return
    if (data.type === 'write') settle(writer.write((data as { chunk: Capable }).chunk as any), false)
    else if (data.type === 'close') settle(writer.close(), true)
    else if (data.type === 'abort') settle(writer.abort((data as { reason: Capable }).reason as any), true)
  })
  // A write the platform failed to deserialize would otherwise never be acked, hanging the writer.
  localPort.addEventListener('messageerror', () => {
    localPort.postMessage({ type: 'err', error: 'osra: a chunk failed to deserialize on this platform' })
  })
  // Abnormal channel death: abort the sink and release the writer lock instead of holding both forever.
  localPort.addEventListener('close', () => {
    if (terminated) return
    terminated = true
    writer.abort(new Error('osra: connection closed')).catch(() => {})
  }, { once: true })
  localPort.start()

  return {
    ...BoxBase,
    type,
    port: boxedRemote,
    ...(isInTransfer() ? { transferChunks: true as const } : {}),
  } as BoxedWritableStream<T>
}

export const revive = <T extends BoxedWritableStream, T2 extends RevivableContext>(
  value: T,
  context: T2
): T[UnderlyingType] => {
  const port = reviveMessagePort(value.port, context)
  port.start()

  const pending = new Set<(error: Error) => void>()
  let dead = false
  port.addEventListener('close', () => {
    dead = true
    const error = new Error('osra: connection closed')
    for (const reject of [...pending]) reject(error)
    pending.clear()
  }, { once: true })

  // The port is shared, so we serialize via a chain - concurrent writes would mis-pair their ack messages.
  let chain: Promise<void> = Promise.resolve()
  const request = (msg: WriteContext): Promise<void> => {
    const next = chain.then(() => new Promise<void>((resolve, reject) => {
      if (dead) {
        reject(new Error('osra: connection closed'))
        return
      }
      const settle = (fn: () => void) => {
        pending.delete(reject)
        fn()
      }
      pending.add(reject)
      port.addEventListener('message', ({ data }) => {
        if (!data || typeof data !== 'object' || !('type' in data)) return
        if ((data as { type: string }).type === 'ack') settle(resolve)
        else if ((data as { type: string }).type === 'err') settle(() => reject(new Error((data as { error: string }).error)))
      }, { once: true })
      port.postMessage(msg as Msg)
    }))
    chain = next.catch(() => {})
    return next
  }

  const transferChunks = value.transferChunks === true
  return new WritableStream({
    write: (chunk) => request({ type: 'write', chunk: (transferChunks ? forceTransfer(chunk) : chunk) as Capable }),
    close: () => request({ type: 'close' }),
    abort: (reason) => request({ type: 'abort', reason: reason as Capable }),
  }) as T[UnderlyingType]
}

const typeCheck = () => {
  const stream = new WritableStream<number>()
  const boxed = box(stream, {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: WritableStream<number> = revived
  // @ts-expect-error - wrong stream type
  const wrongType: WritableStream<string> = revived
  // @ts-expect-error - not a WritableStream
  box('not a stream', {} as RevivableContext)
}
