import type { Transport } from '../../src'

import { expect } from 'chai'

import { toHex } from './utils'

import { expose } from '../../src/index'

export const argsAndResponse = async (transport: Transport) => {
  const value = async (data: { foo: number }, bar: string) => {
    if (data.foo !== 1) {
      throw new Error('foo is not 1')
    }
    if (bar !== 'bar') {
      throw new Error('bar is not bar')
    }
    return 1
  }
  expose(value, { transport })

  const test = await expose<typeof value>({}, { transport })

  await expect(test({ foo: 1 }, 'bar')).to.eventually.equal(1)
  await expect(test({ foo: 0 }, 'baz')).to.be.rejectedWith(/foo is not 1/)
}

export const callback = async (transport: Transport) => {
  const value = async () => async () => 1
  expose(value, { transport })

  const test = await expose<typeof value>({}, { transport })

  const result = await test()
  await expect(result()).to.eventually.equal(1)
}

export const callbackAsArg = async (transport: Transport) => {
  const value = async (callback: () => number) => callback()
  expose(value, { transport })

  const test = await expose<typeof value>({}, { transport })

  const result = await test(() => 1)
  expect(result).to.equal(1)
}

export const objectBaseArgsAndResponse = async (transport: Transport) => {
  const value = {
    test: async (data: { foo: number }, bar: string) => {
      if (data.foo !== 1) {
        throw new Error('foo is not 1')
      }
      if (bar !== 'bar') {
        throw new Error('bar is not bar')
      }
      return 1
    }
  }
  expose(value, { transport })

  const { test } = await expose<typeof value>({}, { transport })

  await expect(test({ foo: 1 }, 'bar')).to.eventually.equal(1)
  await expect(test({ foo: 0 }, 'baz')).to.be.rejectedWith(/foo is not 1/)
}

export const objectCallback = async (transport: Transport) => {
  const value = {
    test: async () => async () => 1
  }
  expose(value, { transport })

  const { test } = await expose<typeof value>({}, { transport })

  const result = await test()
  await expect(result()).to.eventually.equal(1)
}

export const objectCallbackAsArg = async (transport: Transport) => {
  const value = {
    test: async (callback: () => number) => callback()
  }
  expose(value, { transport })

  const { test } = await expose<typeof value>({}, { transport })

  const result = await test(() => 1)
  expect(result).to.equal(1)
}

export const userMessagePort = async (transport: Transport) => {
  const { port1: _port1, port2 } = new MessageChannel()
  const value = {
    port1: _port1
  }
  expose(value, { transport })

  const { port1 } = await expose<typeof value>({}, { transport })

  expect(port1).to.be.instanceOf(MessagePort)

  let port1Resolve: ((value: number) => void)
  const port1Promise = new Promise<number>(resolve => port1Resolve = resolve)
  port1.addEventListener('message', event => {
    port1Resolve(event.data)
  })
  port1.start()
  port1.postMessage(1)

  let port2Resolve: ((value: number) => void)
  const port2Promise = new Promise<number>(resolve => port2Resolve = resolve)
  port2.addEventListener('message', event => {
    port2Resolve(event.data)
  })
  port2.start()
  port2.postMessage(2)

  await expect(port1Promise).to.eventually.equal(2)
  await expect(port2Promise).to.eventually.equal(1)
}

export const userPromise = async (transport: Transport) => {
  const value = {
    promise: Promise.resolve(1)
  }
  expose(value, { transport })

  const { promise } = await expose<typeof value>({}, { transport })

  await expect(promise).to.eventually.equal(1)
}

const hashToHex = async (arrayBuffer: BufferSource) =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', arrayBuffer)))

export const userArrayBuffer = async (transport: Transport) => {
  const _arrayBuffer = new ArrayBuffer(100)
  const uint8Array = new Uint8Array(_arrayBuffer)
  crypto.getRandomValues(uint8Array)
  const originalHash = await hashToHex(_arrayBuffer)
  const value = {
    arrayBuffer: _arrayBuffer
  }
  expose(value, { transport })

  const { arrayBuffer } = await expose<typeof value>({}, { transport })
  const newHash = await hashToHex(arrayBuffer)
  expect(newHash).to.equal(originalHash)
}

export const userTypedArray = async (transport: Transport) => {
  const _arrayBuffer = new ArrayBuffer(100)
  const _uint8Array = new Uint8Array(_arrayBuffer)
  crypto.getRandomValues(_uint8Array)
  const originalHash = await hashToHex(_arrayBuffer)
  const value = {
    uint8Array: _uint8Array
  }
  expose(value, { transport })

  const { uint8Array } = await expose<typeof value>({}, { transport })
  expect(uint8Array).to.be.instanceOf(Uint8Array)
  const newHash = await hashToHex(uint8Array)
  expect(newHash).to.equal(originalHash)
}

export const userReadableStream = async (transport: Transport) => {
  const _arrayBuffer = new ArrayBuffer(100)
  const uint8Array = new Uint8Array(_arrayBuffer)
  crypto.getRandomValues(uint8Array)
  const originalHash = await hashToHex(_arrayBuffer)
  const readableStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(uint8Array)
      controller.close()
    }
  })
  const value = {
    readableStream
  }
  expose(value, { transport })

  const { readableStream: resultReadableStream } = await expose<typeof value>({}, { transport })
  expect(resultReadableStream).to.be.instanceOf(ReadableStream)
  const reader = resultReadableStream.getReader()
  const result = await reader.read()
  if (!result.value) throw new Error('value is undefined')
  const newHash = await hashToHex(result.value.buffer as ArrayBuffer)
  expect(newHash).to.equal(originalHash)
  expect(result.done).to.be.false
  const doneResult = await reader.read()
  expect(doneResult.done).to.be.true
}

export const userPromiseTypedArray = async (transport: Transport) => {
  const _arrayBuffer = new ArrayBuffer(100)
  const _uint8Array = new Uint8Array(_arrayBuffer)
  crypto.getRandomValues(_uint8Array)
  const originalHash = await hashToHex(_arrayBuffer)
  const value = {
    uint8Array: Promise.resolve(_uint8Array)
  }
  expose(value, { transport })

  const { uint8Array } = await expose<typeof value>({}, { transport })
  expect(uint8Array).to.be.instanceOf(Promise)
  const newHash = await hashToHex(await uint8Array)
  expect(newHash).to.equal(originalHash)
}

export const userDate = async (transport: Transport) => {
  const _date = new Date()
  const value = {
    date: _date
  }
  expose(value, { transport })

  const { date } = await expose<typeof value>({}, { transport })

  expect(date).to.be.instanceOf(Date)
  expect(date.toISOString()).to.equal(_date.toISOString())
}

export const userError = async (transport: Transport) => {
  const _error = new Error('Test error message')
  const value = {
    error: _error,
    throwError: () => {
      throw new Error('Thrown error')
    }
  }
  expose(value, { transport })

  const { error, throwError } = await expose<typeof value>({}, { transport })

  expect(error).to.be.instanceOf(Error)
  expect(error.message).to.equal('Test error message')
  await expect(throwError()).to.be.rejectedWith('Thrown error')
}


export const asyncInit = async (transport: Transport) => {
  const value = {
    foo: 1
  }
  expose(value, { transport })
  
  await new Promise(resolve => setTimeout(resolve, 100))

  const { foo } = await expose<typeof value>({}, { transport })

  expect(foo).to.equal(1)
}

export const userAbortSignal = async (transport: Transport) => {
  const controller = new AbortController()
  const value = {
    signal: controller.signal
  }
  expose(value, { transport })

  const { signal } = await expose<typeof value>({}, { transport })

  expect(signal).to.be.instanceOf(AbortSignal)
  expect(signal.aborted).to.be.false

  const aborted = new Promise<unknown>(resolve => {
    signal.addEventListener('abort', () => resolve(signal.reason), { once: true })
  })

  controller.abort('test reason')

  const reason = await aborted
  expect(signal.aborted).to.be.true
  expect(reason).to.equal('test reason')
}

export const userAbortSignalAlreadyAborted = async (transport: Transport) => {
  const controller = new AbortController()
  controller.abort('pre-aborted')
  const value = {
    signal: controller.signal
  }
  expose(value, { transport })

  const { signal } = await expose<typeof value>({}, { transport })

  expect(signal).to.be.instanceOf(AbortSignal)
  expect(signal.aborted).to.be.true
}

export const userAbortSignalAlreadyAbortedWithLiveReason = async (transport: Transport) => {
  const inner = new AbortController()
  const controller = new AbortController()
  controller.abort({ fn: () => 42, nested: inner.signal })
  const value = { signal: controller.signal }
  expose(value, { transport })

  const { signal } = await expose<typeof value>({}, { transport })

  expect(signal.aborted).to.be.true
  const reason = signal.reason as { fn: () => Promise<number>, nested: AbortSignal }
  expect(reason.nested).to.be.instanceOf(AbortSignal)
  expect(await reason.fn()).to.equal(42)
}

export const userResponse = async (transport: Transport) => {
  const _response = new Response('test body', {
    status: 201,
    statusText: 'Created',
    headers: { 'X-Custom': 'header-value' }
  })
  const value = {
    response: _response
  }
  expose(value, { transport })

  const { response } = await expose<typeof value>({}, { transport })

  expect(response).to.be.instanceOf(Response)
  expect(response.status).to.equal(201)
  expect(response.statusText).to.equal('Created')
  expect(response.headers.get('X-Custom')).to.equal('header-value')

  const body = await response.text()
  expect(body).to.equal('test body')
}

export const userResponseWithStreamBody = async (transport: Transport) => {
  const chunks = ['chunk1', 'chunk2', 'chunk3']
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk))
      }
      controller.close()
    }
  })
  const _response = new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  })
  const value = {
    response: _response
  }
  expose(value, { transport })

  const { response } = await expose<typeof value>({}, { transport })

  expect(response).to.be.instanceOf(Response)
  expect(response.status).to.equal(200)

  const body = await response.text()
  expect(body).to.equal('chunk1chunk2chunk3')
}

export const userResponseNoBody = async (transport: Transport) => {
  const _response = new Response(null, {
    status: 204,
    statusText: 'No Content'
  })
  const value = {
    response: _response
  }
  expose(value, { transport })

  const { response } = await expose<typeof value>({}, { transport })

  expect(response).to.be.instanceOf(Response)
  expect(response.status).to.equal(204)
  expect(response.statusText).to.equal('No Content')
  expect(response.body).to.be.null
}

// a fetched Response can carry body bytes on a null-body status (204/205/304), which `new Response(body, { status: 204 })` refuses to construct
export const userResponseNullBodyStatusWithBody = async (transport: Transport) => {
  const withStatus = (status: number) => {
    const response = new Response('unexpected body', { status: 200 })
    Object.defineProperty(response, 'status', { value: status, configurable: true })
    return response
  }
  const value = { r204: withStatus(204), r205: withStatus(205), r304: withStatus(304) }
  expose(value, { transport })

  const revived = await expose<typeof value>({}, { transport })

  for (const [status, key] of [[204, 'r204'], [205, 'r205'], [304, 'r304']] as const) {
    const response = revived[key]
    expect(response, `status ${status}`).to.be.instanceOf(Response)
    expect(response.status, `status ${status}`).to.equal(status)
    expect(response.body, `status ${status} body`).to.be.null
  }
}

export const userRequest = async (transport: Transport) => {
  const _request = new Request('https://example.com/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Custom': 'test' }
  })
  const value = {
    request: _request
  }
  expose(value, { transport })

  const { request } = await expose<typeof value>({}, { transport })

  expect(request).to.be.instanceOf(Request)
  expect(request.method).to.equal('POST')
  expect(request.url).to.equal('https://example.com/api')
  expect(request.headers.get('Content-Type')).to.equal('application/json')
  expect(request.headers.get('X-Custom')).to.equal('test')
}

// Firefox does not support ReadableStream as a Request body (Bugzilla 1387483) and silently coerces it to its toString
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

export const userRequestWithBody = async (transport: Transport) => {
  if (!supportsStreamingRequestBody()) return
  const bodyContent = 'test request body'
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(bodyContent))
      controller.close()
    }
  })
  const _request = new Request('https://example.com/api', {
    method: 'POST',
    body: stream,
    headers: { 'Content-Type': 'text/plain' },
    // @ts-expect-error - duplex is required for streaming bodies
    duplex: 'half'
  })
  const value = {
    request: _request
  }
  expose(value, { transport })

  const { request } = await expose<typeof value>({}, { transport })

  expect(request).to.be.instanceOf(Request)
  expect(request.method).to.equal('POST')
  expect(request.headers.get('Content-Type')).to.equal('text/plain')

  const body = await request.text()
  expect(body).to.equal(bodyContent)
}

export const userRequestNoBody = async (transport: Transport) => {
  const _request = new Request('https://example.com/resource', {
    method: 'GET'
  })
  const value = {
    request: _request
  }
  expose(value, { transport })

  const { request } = await expose<typeof value>({}, { transport })

  expect(request).to.be.instanceOf(Request)
  expect(request.method).to.equal('GET')
  expect(request.url).to.equal('https://example.com/resource')
  // Firefox 146 returns `undefined` for a bodyless Request's `.body` instead of the spec-mandated `null`
  // eslint-disable-next-line eqeqeq
  expect(request.body == null).to.be.true
}

export const userMap = async (transport: Transport) => {
  const _map = new Map<string, number>([['a', 1], ['b', 2], ['c', 3]])
  const value = { map: _map }
  expose(value, { transport })

  const { map } = await expose<typeof value>({}, { transport })

  expect(map).to.be.instanceOf(Map)
  expect(map.size).to.equal(3)
  expect(map.get('a')).to.equal(1)
  expect(map.get('b')).to.equal(2)
  expect(map.get('c')).to.equal(3)
}

export const userMapEmpty = async (transport: Transport) => {
  const value = { map: new Map<string, number>() }
  expose(value, { transport })

  const { map } = await expose<typeof value>({}, { transport })

  expect(map).to.be.instanceOf(Map)
  expect(map.size).to.equal(0)
}

export const userMapWithLiveValues = async (transport: Transport) => {
  const value = {
    map: new Map<string, Promise<number>>([
      ['first', Promise.resolve(10)],
      ['second', Promise.resolve(20)],
    ]),
  }
  expose(value, { transport })

  const { map } = await expose<typeof value>({}, { transport })

  expect(map).to.be.instanceOf(Map)
  expect(map.size).to.equal(2)
  await expect(map.get('first')!).to.eventually.equal(10)
  await expect(map.get('second')!).to.eventually.equal(20)
}

export const userMapWithFunctions = async (transport: Transport) => {
  const value = {
    map: new Map<string, () => Promise<number>>([
      ['double', async () => 4],
      ['triple', async () => 9],
    ]),
  }
  expose(value, { transport })

  const { map } = await expose<typeof value>({}, { transport })

  expect(map).to.be.instanceOf(Map)
  await expect(map.get('double')!()).to.eventually.equal(4)
  await expect(map.get('triple')!()).to.eventually.equal(9)
}

export const userMapWithComplexKeys = async (transport: Transport) => {
  const d1 = new Date('2026-01-01T00:00:00.000Z')
  const d2 = new Date('2026-06-01T00:00:00.000Z')
  const value = {
    map: new Map<Date, string>([[d1, 'jan'], [d2, 'jun']]),
  }
  expose(value, { transport })

  const { map } = await expose<typeof value>({}, { transport })

  expect(map).to.be.instanceOf(Map)
  expect(map.size).to.equal(2)
  const entries = [...map.entries()]
  const jan = entries.find(([k]) => k.toISOString() === d1.toISOString())
  const jun = entries.find(([k]) => k.toISOString() === d2.toISOString())
  expect(jan?.[1]).to.equal('jan')
  expect(jun?.[1]).to.equal('jun')
}

export const userSet = async (transport: Transport) => {
  const value = { set: new Set<number>([1, 2, 3]) }
  expose(value, { transport })

  const { set } = await expose<typeof value>({}, { transport })

  expect(set).to.be.instanceOf(Set)
  expect(set.size).to.equal(3)
  expect(set.has(1)).to.be.true
  expect(set.has(2)).to.be.true
  expect(set.has(3)).to.be.true
}

export const userSetEmpty = async (transport: Transport) => {
  const value = { set: new Set<number>() }
  expose(value, { transport })

  const { set } = await expose<typeof value>({}, { transport })

  expect(set).to.be.instanceOf(Set)
  expect(set.size).to.equal(0)
}

export const userSetWithLiveValues = async (transport: Transport) => {
  const value = {
    set: new Set<Promise<number>>([Promise.resolve(1), Promise.resolve(2)]),
  }
  expose(value, { transport })

  const { set } = await expose<typeof value>({}, { transport })

  expect(set).to.be.instanceOf(Set)
  expect(set.size).to.equal(2)
  const values = await Promise.all([...set])
  expect(values.sort()).to.deep.equal([1, 2])
}

export const userBigInt = async (transport: Transport) => {
  const value = { big: 9_007_199_254_740_993n }
  expose(value, { transport })

  const { big } = await expose<typeof value>({}, { transport })

  expect(typeof big).to.equal('bigint')
  expect(big).to.equal(9_007_199_254_740_993n)
}

export const userBigIntInMap = async (transport: Transport) => {
  const value = { map: new Map<string, bigint>([['big', 1_000_000_000_000_000_000n]]) }
  expose(value, { transport })

  const { map } = await expose<typeof value>({}, { transport })

  expect(map.get('big')).to.equal(1_000_000_000_000_000_000n)
}

export const userBigInt64Array = async (transport: Transport) => {
  const arr = new BigInt64Array([1n, 2n, 3n, -9_223_372_036_854_775_808n])
  const value = { arr }
  expose(value, { transport })

  const { arr: revived } = await expose<typeof value>({}, { transport })

  expect(revived).to.be.instanceOf(BigInt64Array)
  expect(revived.length).to.equal(4)
  expect(revived[0]).to.equal(1n)
  expect(revived[3]).to.equal(-9_223_372_036_854_775_808n)
}

export const userBigUint64Array = async (transport: Transport) => {
  const arr = new BigUint64Array([0n, 1n, 18_446_744_073_709_551_615n])
  const value = { arr }
  expose(value, { transport })

  const { arr: revived } = await expose<typeof value>({}, { transport })

  expect(revived).to.be.instanceOf(BigUint64Array)
  expect(revived.length).to.equal(3)
  expect(revived[2]).to.equal(18_446_744_073_709_551_615n)
}

export const userPromiseRejected = async (transport: Transport) => {
  const value = { failing: Promise.reject(new Error('boom')) }
  ;(value.failing as Promise<unknown>).catch(() => {})
  expose(value, { transport })

  const { failing } = await expose<typeof value>({}, { transport })

  // asserting instanceof as well as the message guards against regressing to the old stringified-stack serialization, where on Firefox the stack lacked the message prefix and a bare /boom/ match would silently pass
  let caught: unknown
  try { await failing } catch (e) { caught = e }
  expect(caught).to.be.instanceOf(Error)
  expect((caught as Error).message).to.equal('boom')
}

export const userPromiseRejectedWithString = async (transport: Transport) => {
  const value = { failing: Promise.reject('plain string reason') }
  ;(value.failing as Promise<unknown>).catch(() => {})
  expose(value, { transport })

  const { failing } = await expose<typeof value>({}, { transport })

  let caught: unknown
  try { await failing } catch (e) { caught = e }
  expect(caught).to.equal('plain string reason')
}

export const userAbortSignalErrorReason = async (transport: Transport) => {
  const controller = new AbortController()
  const value = { signal: controller.signal }
  expose(value, { transport })

  const { signal } = await expose<typeof value>({}, { transport })

  let abortedReason: unknown
  signal.addEventListener('abort', () => { abortedReason = signal.reason })

  controller.abort(new Error('abort cause'))
  await new Promise(resolve => setTimeout(resolve, 50))

  expect(signal.aborted).to.be.true
  expect(abortedReason).to.be.instanceOf(Error)
  expect((abortedReason as Error).message).to.equal('abort cause')
}

export const userHeadersDirect = async (transport: Transport) => {
  const _headers = new Headers({ 'X-A': '1', 'X-B': '2' })
  const value = { headers: _headers }
  expose(value, { transport })

  const { headers } = await expose<typeof value>({}, { transport })

  expect(headers).to.be.instanceOf(Headers)
  expect(headers.get('X-A')).to.equal('1')
  expect(headers.get('X-B')).to.equal('2')
}

export const userArrayBufferEmpty = async (transport: Transport) => {
  const value = { ab: new ArrayBuffer(0) }
  expose(value, { transport })

  const { ab } = await expose<typeof value>({}, { transport })

  expect(ab).to.be.instanceOf(ArrayBuffer)
  expect(ab.byteLength).to.equal(0)
}

export const userTypedArrayEmpty = async (transport: Transport) => {
  const value = { arr: new Uint8Array(0) }
  expose(value, { transport })

  const { arr } = await expose<typeof value>({}, { transport })

  expect(arr).to.be.instanceOf(Uint8Array)
  expect(arr.length).to.equal(0)
}

export const userReadableStreamMultiChunk = async (transport: Transport) => {
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5, 6])]
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const value = { stream }
  expose(value, { transport })

  const { stream: revived } = await expose<typeof value>({}, { transport })
  const reader = revived.getReader()
  const received: number[] = []
  while (true) {
    const { value: v, done } = await reader.read()
    if (done) break
    received.push(...v)
  }
  expect(received).to.deep.equal([1, 2, 3, 4, 5, 6])
}

export const userReadableStreamCancel = async (transport: Transport) => {
  let pulled = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++
      controller.enqueue(new Uint8Array([pulled]))
    },
    cancel() {
      cancelled = true
    },
  })
  const value = { stream }
  expose(value, { transport })

  const { stream: revived } = await expose<typeof value>({}, { transport })
  const reader = revived.getReader()
  const first = await reader.read()
  expect(first.value?.[0]).to.equal(1)
  await reader.cancel()
  for (let i = 0; i < 20 && !cancelled; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  expect(cancelled).to.be.true
}

export const userErrorWithCause = async (transport: Transport) => {
  const inner = new Error('inner reason')
  const value = { error: new Error('outer message', { cause: inner }) }
  expose(value, { transport })

  const { error } = await expose<typeof value>({}, { transport })

  expect(error).to.be.instanceOf(Error)
  expect(error.message).to.equal('outer message')
  expect(error.cause).to.be.instanceOf(Error)
  expect((error.cause as Error).message).to.equal('inner reason')
}

export const userPromiseOfMap = async (transport: Transport) => {
  const value = {
    deferredMap: Promise.resolve(new Map<string, number>([['a', 1], ['b', 2]])),
  }
  expose(value, { transport })

  const { deferredMap } = await expose<typeof value>({}, { transport })

  const m = await deferredMap
  expect(m).to.be.instanceOf(Map)
  expect(m.get('a')).to.equal(1)
  expect(m.get('b')).to.equal(2)
}

export const userCallbackReturningSet = async (transport: Transport) => {
  const expected = [
    '2026-01-01T00:00:00.000Z',
    '2026-12-31T00:00:00.000Z',
  ] as const
  const value = async () => new Set<Date>(expected.map(s => new Date(s)))
  expose(value, { transport })

  const remote = await expose<typeof value>({}, { transport })

  const s = await remote()
  expect(s).to.be.instanceOf(Set)
  expect(s.size).to.equal(2)
  const isoStrings = [...s].map(d => {
    expect(d).to.be.instanceOf(Date)
    return d.toISOString()
  }).sort()
  expect(isoStrings).to.deep.equal([...expected].sort())
}

export const userMapInsideArray = async (transport: Transport) => {
  const value = {
    list: [
      new Map<string, number>([['x', 1]]),
      new Map<string, number>([['y', 2]]),
    ],
  }
  expose(value, { transport })

  const { list } = await expose<typeof value>({}, { transport })

  expect(list).to.have.length(2)
  expect(list[0]).to.be.instanceOf(Map)
  expect(list[0]!.get('x')).to.equal(1)
  expect(list[1]!.get('y')).to.equal(2)
}

export const userArrayBufferInMap = async (transport: Transport) => {
  const buf = new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer
  const value = {
    map: new Map<string, ArrayBuffer>([['data', buf]]),
  }
  expose(value, { transport })

  const { map } = await expose<typeof value>({}, { transport })

  const revived = map.get('data')!
  expect(revived).to.be.instanceOf(ArrayBuffer)
  expect(new Uint8Array(revived)).to.deep.equal(new Uint8Array([1, 2, 3, 4]))
}

export const userEventTarget = async (transport: Transport) => {
  const _et = new EventTarget()
  const value = {
    et: _et,
    fire: async (eventType: string) => { _et.dispatchEvent(new Event(eventType)) },
  }
  expose(value, { transport })

  const { et, fire } = await expose<typeof value>({}, { transport })

  expect(et).to.be.instanceOf(EventTarget)

  let resolveSeen: (e: Event) => void
  const seen = new Promise<Event>(r => { resolveSeen = r })
  et.addEventListener('ping', resolveSeen!)

  await new Promise(r => setTimeout(r, 50))
  await fire('ping')

  const event = await seen
  expect(event.type).to.equal('ping')
}

export const userEventTargetMultipleListeners = async (transport: Transport) => {
  const _et = new EventTarget()
  const value = {
    et: _et,
    fire: async () => { _et.dispatchEvent(new Event('go')) },
  }
  expose(value, { transport })

  const { et, fire } = await expose<typeof value>({}, { transport })

  let count = 0
  const inc = () => { count++ }
  et.addEventListener('go', inc)
  et.addEventListener('go', () => { count += 10 })

  await new Promise(r => setTimeout(r, 50))
  await fire()

  await new Promise(r => setTimeout(r, 50))
  expect(count).to.equal(11)
}

export const userEventTargetCustomEvent = async (transport: Transport) => {
  const _et = new EventTarget()
  const value = {
    et: _et,
    fire: async (detail: { hello: string, n: number }) => {
      _et.dispatchEvent(new CustomEvent('payload', { detail }))
    },
  }
  expose(value, { transport })

  const { et, fire } = await expose<typeof value>({}, { transport })

  let resolveSeen: (e: CustomEvent) => void
  const seen = new Promise<CustomEvent>(r => { resolveSeen = r })
  et.addEventListener('payload', e => { resolveSeen(e as CustomEvent) })

  await new Promise(r => setTimeout(r, 50))
  await fire({ hello: 'world', n: 42 })

  const event = await seen
  expect(event).to.be.instanceOf(CustomEvent)
  expect(event.detail).to.deep.equal({ hello: 'world', n: 42 })
}

export const userEventTargetUnsubscribe = async (transport: Transport) => {
  const _et = new EventTarget()
  const value = {
    et: _et,
    fire: async () => { _et.dispatchEvent(new Event('tick')) },
    listenerCount: async () => {
      return probeCount
    },
  }
  let probeCount = 0
  _et.addEventListener('tick', () => { probeCount++ })
  expose(value, { transport })

  const { et, fire, listenerCount } = await expose<typeof value>({}, { transport })

  let receiverCount = 0
  const handler = () => { receiverCount++ }
  et.addEventListener('tick', handler)

  await new Promise(r => setTimeout(r, 50))
  await fire()
  await new Promise(r => setTimeout(r, 50))
  expect(receiverCount).to.equal(1)
  const probeAfterFirst = await listenerCount()

  et.removeEventListener('tick', handler)
  await new Promise(r => setTimeout(r, 50))
  await fire()
  await new Promise(r => setTimeout(r, 50))
  expect(receiverCount).to.equal(1)
  expect(await listenerCount()).to.equal(probeAfterFirst + 1)
}

export const userEventTargetMultipleEventTypes = async (transport: Transport) => {
  const _et = new EventTarget()
  const value = {
    et: _et,
    fireA: async () => { _et.dispatchEvent(new Event('a')) },
    fireB: async () => { _et.dispatchEvent(new Event('b')) },
  }
  expose(value, { transport })

  const { et, fireA, fireB } = await expose<typeof value>({}, { transport })

  let aCount = 0
  let bCount = 0
  et.addEventListener('a', () => { aCount++ })
  et.addEventListener('b', () => { bCount++ })

  await new Promise(r => setTimeout(r, 50))
  await fireA()
  await fireA()
  await fireB()
  await new Promise(r => setTimeout(r, 50))

  expect(aCount).to.equal(2)
  expect(bCount).to.equal(1)
}

export const functionNonClonableResultRejects = async (transport: Transport) => {
  const value = async (): Promise<any> => new WeakMap()
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const call = (remote() as Promise<unknown>).then(
    () => 'resolved' as const,
    () => 'rejected' as const,
  )
  const settled = await Promise.race([
    call,
    new Promise<'hung'>(r => setTimeout(() => r('hung'), 2_000)),
  ])
  expect(settled).to.not.equal('hung')
}

export const userEventTargetCaptureBothFlags = async (transport: Transport) => {
  const _et = new EventTarget()
  const value = {
    et: _et,
    fire: async () => { _et.dispatchEvent(new Event('ping')) },
  }
  expose(value, { transport })

  const { et, fire } = await expose<typeof value>({}, { transport })

  let count = 0
  const handler = () => { count++ }
  et.addEventListener('ping', handler, { capture: false })
  et.addEventListener('ping', handler, { capture: true })

  await new Promise(r => setTimeout(r, 50))
  await fire()
  await new Promise(r => setTimeout(r, 50))
  expect(count).to.equal(2)

  et.removeEventListener('ping', handler, { capture: false })
  await new Promise(r => setTimeout(r, 50))
  await fire()
  await new Promise(r => setTimeout(r, 50))
  expect(count).to.equal(3)
}

export const userEventTargetOnceUnsubscribes = async (transport: Transport) => {
  const _et = new EventTarget()
  let probeCount = 0
  _et.addEventListener('tick', () => { probeCount++ })
  const value = {
    et: _et,
    fire: async () => { _et.dispatchEvent(new Event('tick')) },
    probe: async () => probeCount,
  }
  expose(value, { transport })

  const { et, fire, probe } = await expose<typeof value>({}, { transport })

  let receiverCount = 0
  et.addEventListener('tick', () => { receiverCount++ }, { once: true })

  await new Promise(r => setTimeout(r, 50))
  await fire()
  await new Promise(r => setTimeout(r, 50))
  expect(receiverCount).to.equal(1)
  const probeAfterFirst = await probe()

  await fire()
  await new Promise(r => setTimeout(r, 50))
  expect(receiverCount).to.equal(1)
  expect(await probe()).to.equal(probeAfterFirst + 1)
}

export const userSymbol = async (transport: Transport) => {
  const _sym = Symbol('hello symbol')
  const value = { sym: _sym }
  expose(value, { transport })

  const { sym } = await expose<typeof value>({}, { transport })

  expect(typeof sym).to.equal('symbol')
  expect(sym.description).to.equal('hello symbol')
  // description-based serialization cannot preserve identity, so a fresh Symbol() is intentionally !== the original
  expect(sym).to.not.equal(_sym)
}

export const userSymbolNoDescription = async (transport: Transport) => {
  const value = { sym: Symbol() }
  expose(value, { transport })

  const { sym } = await expose<typeof value>({}, { transport })

  expect(typeof sym).to.equal('symbol')
  expect(sym.description).to.be.undefined
}


const until = async (condition: () => Promise<boolean>) => {
  for (let i = 0; i < 80; i++) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition not reached within deadline')
}

export const userWritableStream = async (transport: Transport) => {
  const chunks: Uint8Array[] = []
  let closed = false
  const value = {
    writableStream: new WritableStream<Uint8Array>({
      write: (chunk) => { chunks.push(chunk) },
      close: () => { closed = true },
    }),
    getState: async () => ({ chunks, closed }),
  }
  expose(value, { transport })

  const remote = await expose<typeof value>({}, { transport })
  const writer = remote.writableStream.getWriter()
  await writer.write(new Uint8Array([1, 2, 3]))
  await writer.write(new Uint8Array([4, 5]))
  await writer.close()

  const state = await remote.getState()
  expect(state.closed).to.be.true
  expect(state.chunks.length).to.equal(2)
  expect([...state.chunks[0]!]).to.deep.equal([1, 2, 3])
  expect([...state.chunks[1]!]).to.deep.equal([4, 5])
}

export const userWritableStreamAbort = async (transport: Transport) => {
  let abortReason: string | undefined
  const value = {
    writableStream: new WritableStream({
      abort: (reason) => { abortReason = String(reason) },
    }),
    getAbortReason: async () => abortReason,
  }
  expose(value, { transport })

  const remote = await expose<typeof value>({}, { transport })
  const writer = remote.writableStream.getWriter()
  await writer.abort('stop now')
  await until(async () => await remote.getAbortReason() !== undefined)
  expect(await remote.getAbortReason()).to.equal('stop now')
}

export const userWritableStreamSinkErrorPropagates = async (transport: Transport) => {
  const value = {
    writableStream: new WritableStream({
      write: () => { throw new Error('sink failed') },
    }),
  }
  expose(value, { transport })

  const remote = await expose<typeof value>({}, { transport })
  const writer = remote.writableStream.getWriter()
  await expect(writer.write('x')).to.eventually.be.rejectedWith(/sink failed/)
}

export const userAsyncGenerator = async (transport: Transport) => {
  const value = {
    streamData: async function* () {
      for (let i = 0; i < 3; i++) yield i
    },
  }
  expose(value, { transport })

  const remote = await expose<typeof value>({}, { transport })
  const collected: number[] = []
  for await (const item of await remote.streamData()) collected.push(item as number)
  expect(collected).to.deep.equal([0, 1, 2])
}

export const userAsyncGeneratorEarlyBreak = async (transport: Transport) => {
  let finallyRan = false
  const value = {
    infinite: async function* () {
      try {
        let i = 0
        while (true) yield i++
      } finally {
        finallyRan = true
      }
    },
    didFinally: async () => finallyRan,
  }
  expose(value, { transport })

  const remote = await expose<typeof value>({}, { transport })
  for await (const item of await remote.infinite()) {
    if ((item as number) >= 2) break
  }
  await until(() => remote.didFinally())
}

export const userTypedArraySubarray = async (transport: Transport) => {
  const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
  const oddSized = new Int32Array(new ArrayBuffer(10), 0, 2)
  oddSized.set([7, 8])
  const value = {
    getViews: async () => ({
      sub: backing.subarray(2, 5),
      odd: oddSized,
    }),
  }
  expose(value, { transport })

  const remote = await expose<typeof value>({}, { transport })
  const { sub, odd } = await remote.getViews()
  expect([...sub]).to.deep.equal([2, 3, 4])
  expect(sub.byteLength).to.equal(3)
  expect([...odd]).to.deep.equal([7, 8])
}

export const userCircularThrows = async (transport: Transport) => {
  const value = { echo: async (input: unknown) => input }
  expose(value, { transport })

  const remote = await expose<typeof value>({}, { transport })
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  await expect(remote.echo(cyclic as never)).to.eventually.be.rejectedWith(TypeError, /circular/)
}

export const userErrorSubclasses = async (transport: Transport) => {
  const value = {
    getTypeError: async () => new TypeError('bad type'),
    getAggregate: async () => new AggregateError([new RangeError('inner range')], 'multiple'),
  }
  expose(value, { transport })

  const remote = await expose<typeof value>({}, { transport })
  const typeError = await remote.getTypeError()
  expect(typeError).to.be.instanceOf(TypeError)
  expect(typeError.message).to.equal('bad type')

  const aggregate = await remote.getAggregate() as AggregateError
  expect(aggregate).to.be.instanceOf(AggregateError)
  expect(aggregate.message).to.equal('multiple')
  expect(aggregate.errors[0]).to.be.instanceOf(RangeError)
  expect((aggregate.errors[0] as RangeError).message).to.equal('inner range')
}

export const userRegisteredSymbol = async (transport: Transport) => {
  const value = { sym: Symbol.for('osra.test.registered') }
  expose(value, { transport })

  const { sym } = await expose<typeof value>({}, { transport })
  expect(sym).to.equal(Symbol.for('osra.test.registered'))
}

export const userReadableStreamSourceErrorPropagates = async (transport: Transport) => {
  let calls = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      calls++
      if (calls <= 2) controller.enqueue(new Uint8Array([calls]))
      else controller.error(new Error('source exploded'))
    },
  })
  const value = { stream }
  expose(value, { transport })

  const { stream: revived } = await expose<typeof value>({}, { transport })
  const reader = revived.getReader()
  // chunks produced before the error must still be delivered: the credit pump runs ahead of the consumer
  expect((await reader.read()).value?.[0]).to.equal(1)
  expect((await reader.read()).value?.[0]).to.equal(2)
  await expect(reader.read()).to.be.rejectedWith(/source exploded/)
}

export const userReadableStreamBackpressure = async (transport: Transport) => {
  let produced = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced++
      controller.enqueue(new Uint8Array([produced % 256]))
    },
  })
  const value = { stream }
  expose(value, { transport })

  const { stream: revived } = await expose<typeof value>({}, { transport })
  const reader = revived.getReader()
  for (let i = 0; i < 5; i++) await reader.read()
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(produced).to.be.greaterThan(5)
  expect(produced).to.be.at.most(80)
  await reader.cancel()
}

export const userReadableStreamObjectBackpressure = async (transport: Transport) => {
  let produced = 0
  const stream = new ReadableStream({
    pull(controller) {
      produced++
      controller.enqueue({ n: produced })
    },
  })
  const value = { stream }
  expose(value, { transport })

  const { stream: revived } = await expose<typeof value>({}, { transport })
  const reader = revived.getReader()
  for (let i = 0; i < 3; i++) await reader.read()
  await new Promise(resolve => setTimeout(resolve, 200))
  // unmeasurable chunks stay on the conservative initial credit window, not the maximum
  expect(produced).to.be.greaterThan(3)
  expect(produced).to.be.at.most(16)
  await reader.cancel()
}

export const userNonFinitePrimitives = async (transport: Transport) => {
  const value = {
    numbers: async () => ({
      nan: NaN,
      positive: Infinity,
      negative: -Infinity,
      sparse: [1, undefined, 2] as (number | undefined)[],
      maybe: undefined as number | undefined,
    }),
  }
  expose(value, { transport })

  const remote = await expose<typeof value>({}, { transport })
  const result = await remote.numbers()
  expect(Number.isNaN(result.nan)).to.be.true
  expect(result.positive).to.equal(Infinity)
  expect(result.negative).to.equal(-Infinity)
  expect(result.sparse).to.deep.equal([1, undefined, 2])
  expect('maybe' in result).to.be.true
}

// Blob is clone-only, so JSON transports must throw instead of the silent `{}` JSON.stringify produces
export const userBlobArg = async (transport: Transport) => {
  const value = { echo: async (input: unknown) => input }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const blob = new Blob(['osra-blob'], { type: 'text/plain' })
  if ('isJson' in transport && transport.isJson === true) {
    await expect(remote.echo(blob)).to.eventually.be.rejectedWith(TypeError, /only supported on structured-clone transports/)
  } else {
    const echoed = await remote.echo(blob) as Blob
    expect(echoed).to.be.instanceOf(Blob)
    expect(await echoed.text()).to.equal('osra-blob')
    expect(echoed.type).to.equal('text/plain')
  }
}

export const userBlobNestedArg = async (transport: Transport) => {
  const value = { echo: async (input: unknown) => input }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const wrapped = { data: [new Blob(['nested'], { type: 'text/plain' })] }
  if ('isJson' in transport && transport.isJson === true) {
    await expect(remote.echo(wrapped)).to.eventually.be.rejectedWith(TypeError, /only supported on structured-clone transports/)
  } else {
    const echoed = await remote.echo(wrapped) as typeof wrapped
    expect(echoed.data[0]).to.be.instanceOf(Blob)
    expect(await echoed.data[0]!.text()).to.equal('nested')
  }
}

export const userBlobReturnRejects = async (transport: Transport) => {
  const value = { getBlob: async () => new Blob(['osra-blob'], { type: 'text/plain' }) }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  if ('isJson' in transport && transport.isJson === true) {
    await expect(remote.getBlob()).to.eventually.be.rejectedWith(TypeError, /only supported on structured-clone transports/)
  } else {
    const blob = await remote.getBlob()
    expect(blob).to.be.instanceOf(Blob)
    expect(await blob.text()).to.equal('osra-blob')
  }
}

// 300 calls churns past TOMBSTONE_LIMIT (128) in message-port.ts, so old tombstones must evict cleanly
export const manyCallsChurnTombstonedPorts = async (transport: Transport) => {
  const value = { echo: async (n: number) => n }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  for (let i = 0; i < 300; i++) {
    expect(await remote.echo(i)).to.equal(i)
  }
}

export const base = {
  argsAndResponse,
  callback,
  callbackAsArg,
  objectBaseArgsAndResponse,
  objectCallback,
  objectCallbackAsArg,
  userMessagePort,
  userPromise,
  userArrayBuffer,
  userTypedArray,
  userReadableStream,
  userPromiseTypedArray,
  userDate,
  userError,
  asyncInit,
  userAbortSignal,
  userAbortSignalAlreadyAborted,
  userResponse,
  userResponseWithStreamBody,
  userResponseNoBody,
  userResponseNullBodyStatusWithBody,
  userRequest,
  userRequestWithBody,
  userRequestNoBody,
  userMap,
  userMapEmpty,
  userMapWithLiveValues,
  userMapWithFunctions,
  userMapWithComplexKeys,
  userSet,
  userSetEmpty,
  userSetWithLiveValues,
  userBigInt,
  userBigIntInMap,
  userBigInt64Array,
  userBigUint64Array,
  userPromiseRejected,
  userPromiseRejectedWithString,
  userAbortSignalErrorReason,
  userHeadersDirect,
  userArrayBufferEmpty,
  userTypedArrayEmpty,
  userReadableStreamMultiChunk,
  userReadableStreamCancel,
  userErrorWithCause,
  userPromiseOfMap,
  userCallbackReturningSet,
  userMapInsideArray,
  userArrayBufferInMap,
  userEventTarget,
  userEventTargetMultipleListeners,
  userEventTargetCustomEvent,
  userEventTargetUnsubscribe,
  userEventTargetMultipleEventTypes,
  userEventTargetCaptureBothFlags,
  userEventTargetOnceUnsubscribes,
  userAbortSignalAlreadyAbortedWithLiveReason,
  functionNonClonableResultRejects,
  userSymbol,
  userSymbolNoDescription,
  userWritableStream,
  userWritableStreamAbort,
  userWritableStreamSinkErrorPropagates,
  userAsyncGenerator,
  userAsyncGeneratorEarlyBreak,
  userTypedArraySubarray,
  userCircularThrows,
  userErrorSubclasses,
  userRegisteredSymbol,
  userNonFinitePrimitives,
  userReadableStreamSourceErrorPropagates,
  userReadableStreamBackpressure,
  userReadableStreamObjectBackpressure,
  userBlobArg,
  userBlobNestedArg,
  userBlobReturnRejects,
  manyCallsChurnTombstonedPorts,
}
