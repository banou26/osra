import type { Transport } from '../../src'

import { expect } from 'chai'

import { toHex } from './utils'

import { expose, transfer } from '../../src/index'
import { EventChannel, type EventPort } from '../../src/utils/event-channel'

const hashToHex = async (arrayBuffer: BufferSource) =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', arrayBuffer)))

export const unwrappedBufferIsCopied = async (transport: Transport) => {
  const value = async (data: ArrayBuffer) => data.byteLength
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const buffer = new ArrayBuffer(1024)
  new Uint8Array(buffer).fill(7)
  const result = await remote(buffer)
  expect(result).to.equal(1024)
  expect(buffer.byteLength).to.equal(1024)
  expect(new Uint8Array(buffer)[0]).to.equal(7)
}

export const transferredBufferIsDetached = async (transport: Transport) => {
  const value = async (data: ArrayBuffer) => data.byteLength
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const buffer = new ArrayBuffer(1024)
  new Uint8Array(buffer).fill(5)
  const result = await remote(transfer(buffer))
  expect(result).to.equal(1024)
  // JSON-only transports serialize to base64 and always "copy", so detachment isn't observable there
  if (!('isJson' in transport && transport.isJson === true)) {
    expect(buffer.byteLength).to.equal(0)
  }
}

export const broadcastUnwrappedWorks = async (transport: Transport) => {
  const value = async (data: ArrayBuffer) => data.byteLength
  expose(value, { transport })
  const remote1 = await expose<typeof value>({}, { transport })
  const remote2 = await expose<typeof value>({}, { transport })

  const buffer = new ArrayBuffer(512)
  new Uint8Array(buffer).fill(9)

  const r1 = await remote1(buffer)
  const r2 = await remote2(buffer)
  expect(r1).to.equal(512)
  expect(r2).to.equal(512)
  expect(buffer.byteLength).to.equal(512)
  expect(new Uint8Array(buffer)[0]).to.equal(9)
}

export const transferIsIdempotent = async (_transport: Transport) => {
  const buffer = new ArrayBuffer(64)
  const once = transfer(buffer)
  const twice = transfer(once)
  expect(twice).to.equal(once)
}

export const transferIsIdempotentTypedArray = async (_transport: Transport) => {
  const u8 = new Uint8Array(32)
  const once = transfer(u8)
  const twice = transfer(once)
  expect(twice).to.equal(once)
}

export const transferTwiceInlineStillTransfers = async (transport: Transport) => {
  const value = async (data: ArrayBuffer) => data.byteLength
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const buffer = new ArrayBuffer(128)
  const result = await remote(transfer(transfer(buffer)))
  expect(result).to.equal(128)
  if (!('isJson' in transport && transport.isJson === true)) {
    expect(buffer.byteLength).to.equal(0)
  }
}

export const transferTypedArrayMovesUnderlyingBuffer = async (transport: Transport) => {
  const value = async (data: Uint8Array) => data.length
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const u8 = new Uint8Array(256)
  u8.fill(3)
  const originalHash = await hashToHex(u8.buffer as ArrayBuffer)
  const result = await remote(transfer(u8))
  expect(result).to.equal(256)
  if (!('isJson' in transport && transport.isJson === true)) {
    expect(u8.byteLength).to.equal(0)
  }
  expect(originalHash.length).to.equal(64)
}

export const transferReadableStream = async (transport: Transport) => {
  const chunks = ['a', 'b', 'c']
  const value = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const received: string[] = []
    while (true) {
      const { value: v, done } = await reader.read()
      if (done) break
      received.push(new TextDecoder().decode(v))
    }
    return received.join('')
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
      controller.close()
    },
  })

  const result = await remote(transfer(stream))
  expect(result).to.equal('abc')
}

export const plainStreamChunkBuffersAreCopied = async (transport: Transport) => {
  const value = async (stream: ReadableStream<ArrayBuffer | Uint8Array>) => {
    const reader = stream.getReader()
    let total = 0
    while (true) {
      const { value: v, done } = await reader.read()
      if (done) break
      total += v.byteLength
    }
    return total
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const buffer = new ArrayBuffer(1024)
  const u8 = new Uint8Array(2048)
  const stream = new ReadableStream<ArrayBuffer | Uint8Array>({
    start(controller) {
      controller.enqueue(buffer)
      controller.enqueue(u8)
      controller.close()
    },
  })

  const result = await remote(stream)
  expect(result).to.equal(1024 + 2048)
  expect(buffer.byteLength).to.equal(1024)
  expect(u8.byteLength).to.equal(2048)
}

export const transferStreamMovesChunkBuffers = async (transport: Transport) => {
  const value = async (stream: ReadableStream<ArrayBuffer | Uint8Array>) => {
    const reader = stream.getReader()
    let total = 0
    let first = -1
    while (true) {
      const { value: v, done } = await reader.read()
      if (done) break
      total += v.byteLength
      if (first === -1) first = new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer as ArrayBuffer)[0] ?? -1
    }
    return { total, first }
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const buffer = new ArrayBuffer(1024)
  new Uint8Array(buffer).fill(8)
  const u8 = new Uint8Array(2048)
  const stream = new ReadableStream<ArrayBuffer | Uint8Array>({
    start(controller) {
      controller.enqueue(buffer)
      controller.enqueue(u8)
      controller.close()
    },
  })

  const result = await remote(transfer(stream))
  expect(result.total).to.equal(1024 + 2048)
  expect(result.first).to.equal(8)
  if ('isJson' in transport && transport.isJson === true) {
    expect(buffer.byteLength).to.equal(1024)
    expect(u8.byteLength).to.equal(2048)
  } else {
    expect(buffer.byteLength).to.equal(0)
    expect(u8.byteLength).to.equal(0)
  }
}

export const transferStreamMovesNestedChunkBuffers = async (transport: Transport) => {
  const value = async (stream: ReadableStream<{ id: number, data: Uint8Array }>) => {
    const reader = stream.getReader()
    const out: number[] = []
    while (true) {
      const { value: v, done } = await reader.read()
      if (done) break
      out.push(v.id, v.data.byteLength, v.data[0] ?? -1)
    }
    return out
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const data = new Uint8Array(512).fill(4)
  const stream = new ReadableStream<{ id: number, data: Uint8Array }>({
    start(controller) {
      controller.enqueue({ id: 1, data })
      controller.close()
    },
  })

  const result = await remote(transfer(stream))
  expect(result).to.deep.equal([1, 512, 4])
  if ('isJson' in transport && transport.isJson === true) {
    expect(data.byteLength).to.equal(512)
  } else {
    expect(data.byteLength).to.equal(0)
  }
}

export const transferStreamPropagatesToNestedStream = async (transport: Transport) => {
  const value = async (stream: ReadableStream<{ inner: ReadableStream<Uint8Array> }>) => {
    const reader = stream.getReader()
    let innerTotal = 0
    while (true) {
      const { value: v, done } = await reader.read()
      if (done) break
      const innerReader = v.inner.getReader()
      while (true) {
        const { value: c, done: innerDone } = await innerReader.read()
        if (innerDone) break
        innerTotal += c.byteLength
      }
    }
    return innerTotal
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const innerU8 = new Uint8Array(256).fill(2)
  const innerStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(innerU8)
      controller.close()
    },
  })
  const stream = new ReadableStream<{ inner: ReadableStream<Uint8Array> }>({
    start(controller) {
      controller.enqueue({ inner: innerStream })
      controller.close()
    },
  })

  const result = await remote(transfer(stream))
  expect(result).to.equal(256)
  if ('isJson' in transport && transport.isJson === true) {
    expect(innerU8.byteLength).to.equal(256)
  } else {
    expect(innerU8.byteLength).to.equal(0)
  }
}

export const transferResponseMovesBodyChunks = async (transport: Transport) => {
  const value = async (res: Response) => await res.text()
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const u8 = new TextEncoder().encode('hello response body')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(u8)
      controller.close()
    },
  })

  const result = await remote(transfer(new Response(stream)))
  expect(result).to.equal('hello response body')
  if ('isJson' in transport && transport.isJson === true) {
    expect(u8.byteLength).to.be.greaterThan(0)
  } else {
    expect(u8.byteLength).to.equal(0)
  }
}

// Firefox does not support ReadableStream as a Request body (Bugzilla 1387483)
const supportsStreamingRequestBody = (): boolean => {
  try {
    const probe = new Request('https://example.com', {
      method: 'POST',
      body: new ReadableStream(),
      // @ts-expect-error - duplex required for streaming bodies
      duplex: 'half',
    })
    return probe.body instanceof ReadableStream
  } catch {
    return false
  }
}

export const transferRequestMovesBodyChunks = async (transport: Transport) => {
  if (!supportsStreamingRequestBody()) return
  const value = async (req: Request) => await req.text()
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const u8 = new TextEncoder().encode('hello request body')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(u8)
      controller.close()
    },
  })
  const request = new Request('https://example.com/api', {
    method: 'POST',
    body: stream,
    // @ts-expect-error - duplex is required for streaming bodies
    duplex: 'half',
  })

  const result = await remote(transfer(request))
  expect(result).to.equal('hello request body')
  if ('isJson' in transport && transport.isJson === true) {
    expect(u8.byteLength).to.be.greaterThan(0)
  } else {
    expect(u8.byteLength).to.equal(0)
  }
}

export const transferWritableMovesWrittenChunks = async (transport: Transport) => {
  let received: Uint8Array | undefined
  const sink = new WritableStream<Uint8Array>({
    write: (chunk) => { received = chunk },
  })
  const value = { getSink: async () => transfer(sink) }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const remoteSink = await remote.getSink()
  const writer = remoteSink.getWriter()
  const u8 = new Uint8Array(1024).fill(6)
  await writer.write(u8)
  await writer.close()
  expect(received?.byteLength).to.equal(1024)
  expect(received?.[0]).to.equal(6)
  if ('isJson' in transport && transport.isJson === true) {
    expect(u8.byteLength).to.equal(1024)
  } else {
    expect(u8.byteLength).to.equal(0)
  }
}

export const transferStreamMovesManyChunksBeyondFirstWindow = async (transport: Transport) => {
  const CHUNKS = 40
  const SIZE = 32 * 1024
  const value = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    let total = 0
    let count = 0
    while (true) {
      const { value: v, done } = await reader.read()
      if (done) break
      total += v.byteLength
      count++
    }
    return { total, count }
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const sent: Uint8Array[] = []
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= CHUNKS) {
        controller.close()
        return
      }
      const u8 = new Uint8Array(SIZE).fill(i % 256)
      sent.push(u8)
      i++
      controller.enqueue(u8)
    },
  })

  const result = await remote(transfer(stream))
  expect(result.count).to.equal(CHUNKS)
  expect(result.total).to.equal(CHUNKS * SIZE)
  const detached = sent.filter(u8 => u8.byteLength === 0).length
  if ('isJson' in transport && transport.isJson === true) expect(detached).to.equal(0)
  else expect(detached).to.equal(CHUNKS)
}

export const transferStreamAsReturnValueMovesChunks = async (transport: Transport) => {
  const u8 = new Uint8Array(128).fill(7)
  const value = {
    download: async () =>
      transfer(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(u8)
          controller.close()
        },
      })),
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const stream = await remote.download()
  const reader = stream.getReader()
  const { value: chunk } = await reader.read()
  await reader.read()
  expect(chunk?.byteLength).to.equal(128)
  expect(chunk?.[0]).to.equal(7)
  if ('isJson' in transport && transport.isJson === true) expect(u8.byteLength).to.equal(128)
  else expect(u8.byteLength).to.equal(0)
}

export const transferWritableMovesNestedChunkBuffers = async (transport: Transport) => {
  let received: { id: number, data: Uint8Array } | undefined
  const sink = new WritableStream<{ id: number, data: Uint8Array }>({
    write: (chunk) => { received = chunk },
  })
  const value = { getSink: async () => transfer(sink) }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const remoteSink = await remote.getSink()
  const writer = remoteSink.getWriter()
  const data = new Uint8Array(512).fill(5)
  await writer.write({ id: 2, data })
  await writer.close()
  expect(received?.id).to.equal(2)
  expect(received?.data.byteLength).to.equal(512)
  expect(received?.data[0]).to.equal(5)
  if ('isJson' in transport && transport.isJson === true) expect(data.byteLength).to.equal(512)
  else expect(data.byteLength).to.equal(0)
}

export const transferStreamMovesDataViewChunks = async (transport: Transport) => {
  if ('isJson' in transport && transport.isJson === true) return
  const value = async (stream: ReadableStream<DataView>) => {
    const reader = stream.getReader()
    const { value: view } = await reader.read()
    await reader.read()
    return { byteLength: view?.byteLength ?? -1, first: view?.getUint8(0) ?? -1 }
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const buffer = new ArrayBuffer(96)
  new Uint8Array(buffer).fill(11)
  const view = new DataView(buffer)
  const stream = new ReadableStream<DataView>({
    start(controller) {
      controller.enqueue(view)
      controller.close()
    },
  })

  const result = await remote(transfer(stream))
  expect(result.byteLength).to.equal(96)
  expect(result.first).to.equal(11)
  expect(buffer.byteLength).to.equal(0)
}

export const transferDataViewMovesUnderlyingBuffer = async (transport: Transport) => {
  if ('isJson' in transport && transport.isJson === true) return
  const value = async (view: DataView) => ({ byteLength: view.byteLength, first: view.getUint8(0) })
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const buffer = new ArrayBuffer(96)
  new Uint8Array(buffer).fill(13)
  const result = await remote(transfer(new DataView(buffer)))
  expect(result.byteLength).to.equal(96)
  expect(result.first).to.equal(13)
  expect(buffer.byteLength).to.equal(0)
}

export const transferTypedArrayPartialViewKeepsOriginal = async (transport: Transport) => {
  const value = async (data: Uint8Array) => ({ len: data.byteLength, first: data[0] ?? -1 })
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const backing = new Uint8Array(64).fill(1)
  backing.set([9, 9, 9, 9], 8)
  const result = await remote(transfer(backing.subarray(8, 12)))
  expect(result.len).to.equal(4)
  expect(result.first).to.equal(9)
  // a partial view has its window sliced out at box time, so the original stays usable
  expect(backing.byteLength).to.equal(64)
  expect(backing[8]).to.equal(9)
}

export const transferStreamMovesVideoFrameChunks = async (transport: Transport) => {
  if ('isJson' in transport && transport.isJson === true) return
  if (typeof VideoFrame === 'undefined') return
  const value = async (stream: ReadableStream<{ frame: VideoFrame }>) => {
    const reader = stream.getReader()
    const { value: chunk } = await reader.read()
    await reader.read()
    const info = { isFrame: chunk?.frame instanceof VideoFrame, width: chunk?.frame?.codedWidth ?? -1 }
    if (chunk?.frame instanceof VideoFrame) chunk.frame.close()
    return info
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const frame = new VideoFrame(new Uint8Array(2 * 2 * 4).fill(127), {
    format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 0,
  })
  const stream = new ReadableStream<{ frame: VideoFrame }>({
    start(controller) {
      controller.enqueue({ frame })
      controller.close()
    },
  })

  // Gecko can fail to deserialize a VideoFrame transferred through a MessagePort (it fires
  // messageerror and drops the message). The contract is: delivered as a real frame, or the
  // stream errors loudly - a silently missing chunk is the one unacceptable outcome.
  if (navigator.userAgent.includes('Firefox')) {
    try {
      const result = await remote(transfer(stream))
      expect(result.isFrame).to.equal(true)
      expect(result.width).to.equal(2)
    } catch (error) {
      expect(String((error as Error)?.message ?? error)).to.include('deserialize')
    }
    return
  }
  const result = await remote(transfer(stream))
  expect(result.isFrame).to.equal(true)
  expect(result.width).to.equal(2)
  expect(frame.format).to.equal(null)
}

// regression: message-port.box's liveRef.start() flushes an EventPort's queue synchronously
// while a transfer() extent is on the stack; queued values must not inherit the extent
export const queuedEventPortMessagesDoNotInheritTransfer = async (transport: Transport) => {
  type PortMessage = { stream: ReadableStream<Uint8Array> }
  const { port1, port2 } = new EventChannel<PortMessage, PortMessage>()
  const innerU8 = new Uint8Array(64).fill(3)
  const innerStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(innerU8)
      controller.close()
    },
  })
  port2.postMessage({ stream: innerStream })
  // let the microtask land the message in port1's not-yet-started queue
  await new Promise(resolve => setTimeout(resolve, 0))

  const value = async (stream: ReadableStream<{ port: EventPort<PortMessage> }>) => {
    const reader = stream.getReader()
    const { value: chunk } = await reader.read()
    await reader.read()
    const port = chunk?.port
    if (!port) return -1
    return new Promise<number>(resolve => {
      port.addEventListener('message', async event => {
        const { stream: inner } = (event as MessageEvent<PortMessage>).data
        const innerReader = inner.getReader()
        let sum = 0
        while (true) {
          const { value: c, done } = await innerReader.read()
          if (done) break
          sum += c.byteLength
        }
        resolve(sum)
      })
      port.start()
    })
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const outer = new ReadableStream<{ port: EventPort<PortMessage> }>({
    start(controller) {
      controller.enqueue({ port: port1 })
      controller.close()
    },
  })
  const total = await remote(transfer(outer))
  expect(total).to.equal(64)
  // the queued message was flushed during boxing but is not part of the wrapper's graph
  expect(innerU8.byteLength).to.equal(64)
}

// regression: user code (a getter evaluated while boxing a transferred chunk) calling a
// revived function must not have the call's arguments inherit the transfer extent
export const rpcDuringTransferBoxingDoesNotInheritTransfer = async (transport: Transport) => {
  let captured: ReadableStream<Uint8Array> | undefined
  const value = {
    capture: async (stream: ReadableStream<Uint8Array>) => { captured = stream },
    take: async (stream: ReadableStream<{ x: number }>) => {
      const reader = stream.getReader()
      while (!(await reader.read()).done) { /* drain */ }
    },
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const innerU8 = new Uint8Array(64).fill(9)
  const innerStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(innerU8)
      controller.close()
    },
  })

  let capturePromise: Promise<void> | undefined
  const chunk = {
    get x() {
      capturePromise ??= remote.capture(innerStream)
      return 1
    },
  }
  const outer = new ReadableStream<{ x: number }>({
    start(controller) {
      controller.enqueue(chunk)
      controller.close()
    },
  })
  await remote.take(transfer(outer))
  expect(capturePromise).to.not.equal(undefined)
  await capturePromise
  const reader = captured?.getReader()
  let total = 0
  while (reader) {
    const { value: c, done } = await reader.read()
    if (done) break
    total += c.byteLength
  }
  expect(total).to.equal(64)
  expect(innerU8.byteLength).to.equal(64)
}

export const plainWritableWrittenChunksAreCopied = async (transport: Transport) => {
  let received: Uint8Array | undefined
  const sink = new WritableStream<Uint8Array>({
    write: (chunk) => { received = chunk },
  })
  const value = { getSink: async () => sink }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const remoteSink = await remote.getSink()
  const writer = remoteSink.getWriter()
  const u8 = new Uint8Array(1024).fill(6)
  await writer.write(u8)
  await writer.close()
  expect(received?.byteLength).to.equal(1024)
  expect(u8.byteLength).to.equal(1024)
}

export const nonTransferablesAreNoOp = async (_transport: Transport) => {
  expect(transfer(42)).to.equal(42)
  expect(transfer('hi')).to.equal('hi')
  expect(transfer(true)).to.equal(true)
  expect(transfer(null)).to.equal(null)
  expect(transfer(undefined)).to.equal(undefined)
  const obj = { foo: 1 }
  expect(transfer(obj)).to.equal(obj)
  const arr = [1, 2, 3]
  expect(transfer(arr)).to.equal(arr)
}

export const transferDoesNotCrashNonTransferable = async (transport: Transport) => {
  const value = async (data: { foo: number }) => data.foo
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const result = await remote(transfer({ foo: 7 }) as { foo: number })
  expect(result).to.equal(7)
}

export const messagePortStillTransfersWithoutWrapper = async (transport: Transport) => {
  const { port1: _port1, port2 } = new MessageChannel()
  const value = {
    port1: _port1,
  }
  expose(value, { transport })
  const { port1 } = await expose<typeof value>({}, { transport })

  let port1Resolve: (value: number) => void
  const port1Promise = new Promise<number>(resolve => { port1Resolve = resolve })
  port1.addEventListener('message', event => { port1Resolve(event.data) })
  port1.start()
  port1.postMessage(1)

  let port2Resolve: (value: number) => void
  const port2Promise = new Promise<number>(resolve => { port2Resolve = resolve })
  port2.addEventListener('message', event => { port2Resolve(event.data) })
  port2.start()
  port2.postMessage(2)

  await expect(port1Promise).to.eventually.equal(2)
  await expect(port2Promise).to.eventually.equal(1)
}

export const transferredBufferDataRoundTrips = async (transport: Transport) => {
  const value = async (data: ArrayBuffer) => toHex(new Uint8Array(data))
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const buffer = new ArrayBuffer(64)
  const u8 = new Uint8Array(buffer)
  crypto.getRandomValues(u8)
  const expectedHex = toHex(u8)

  const receivedHex = await remote(transfer(buffer))
  expect(receivedHex).to.equal(expectedHex)
}

// OffscreenCanvas also extends EventTarget: it must not get boxed into an eventTarget husk
export const offscreenCanvasTransfersAsCanvas = async (transport: Transport) => {
  if ('isJson' in transport && transport.isJson === true) return

  // a canvas with a context can't be transferred, so this transfers a fresh canvas and draws in the worker
  const value = async (canvas: OffscreenCanvas) => {
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'rgb(10, 20, 30)'
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    return { isCanvas: canvas instanceof OffscreenCanvas, width: canvas.width, height: canvas.height, r, g, b, a }
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const canvas = new OffscreenCanvas(48, 24)
  const result = await remote(transfer(canvas))
  expect(result.isCanvas).to.equal(true)
  expect(result.width).to.equal(48)
  expect(result.height).to.equal(24)
  expect([result.r, result.g, result.b, result.a]).to.deep.equal([10, 20, 30, 255])
}

// regression: isWrappableTransferable omitted VideoFrame/AudioData, so transfer() silently
// degraded to a copy
export const videoFrameTransferDetachesSource = async (transport: Transport) => {
  if ('isJson' in transport && transport.isJson === true) return
  if (typeof VideoFrame === 'undefined') return

  const value = async (frame: VideoFrame) => {
    const info = { isFrame: frame instanceof VideoFrame, width: frame.codedWidth, height: frame.codedHeight }
    frame.close()
    return info
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const frame = new VideoFrame(new Uint8Array(2 * 2 * 4).fill(127), {
    format: 'RGBA', codedWidth: 2, codedHeight: 2, timestamp: 0,
  })
  const result = await remote(transfer(frame))
  expect(result.isFrame).to.equal(true)
  expect(result.width).to.equal(2)
  expect(result.height).to.equal(2)
  expect(frame.format).to.equal(null)
}

export const audioDataTransferDetachesSource = async (transport: Transport) => {
  if ('isJson' in transport && transport.isJson === true) return
  if (typeof AudioData === 'undefined') return

  const value = async (data: AudioData) => {
    const info = { isAudioData: data instanceof AudioData, frames: data.numberOfFrames }
    data.close()
    return info
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const audio = new AudioData({
    format: 'f32', sampleRate: 8000, numberOfFrames: 8, numberOfChannels: 1,
    timestamp: 0, data: new Float32Array(8),
  })
  const result = await remote(transfer(audio))
  expect(result.isAudioData).to.equal(true)
  expect(result.frames).to.equal(8)
  expect(audio.format).to.equal(null)
}

export const tests = {
  unwrappedBufferIsCopied,
  transferredBufferIsDetached,
  broadcastUnwrappedWorks,
  transferIsIdempotent,
  transferIsIdempotentTypedArray,
  transferTwiceInlineStillTransfers,
  transferTypedArrayMovesUnderlyingBuffer,
  transferReadableStream,
  plainStreamChunkBuffersAreCopied,
  transferStreamMovesChunkBuffers,
  transferStreamMovesNestedChunkBuffers,
  transferStreamPropagatesToNestedStream,
  transferResponseMovesBodyChunks,
  transferRequestMovesBodyChunks,
  transferWritableMovesWrittenChunks,
  plainWritableWrittenChunksAreCopied,
  transferStreamMovesManyChunksBeyondFirstWindow,
  transferStreamAsReturnValueMovesChunks,
  transferWritableMovesNestedChunkBuffers,
  transferStreamMovesDataViewChunks,
  transferDataViewMovesUnderlyingBuffer,
  transferTypedArrayPartialViewKeepsOriginal,
  transferStreamMovesVideoFrameChunks,
  queuedEventPortMessagesDoNotInheritTransfer,
  rpcDuringTransferBoxingDoesNotInheritTransfer,
  nonTransferablesAreNoOp,
  transferDoesNotCrashNonTransferable,
  messagePortStillTransfersWithoutWrapper,
  transferredBufferDataRoundTrips,
  offscreenCanvasTransfersAsCanvas,
  videoFrameTransferDetachesSource,
  audioDataTransferDetachesSource,
}
