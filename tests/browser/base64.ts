import { expect } from 'chai'

import { expose } from '../../src/index'
import { base64ToBytes, bytesToBase64 } from '../../src/utils/base64'
import { makeJsonTransport } from './utils'

/** The base64 fallbacks behind a JSON transport's buffers. The native `Uint8Array` methods exist in
 *  every current browser and in node 26, not in node 22 or 24, so each test hides what the
 *  platform has and proves the next path down gives the same bytes. */

type Hidden = { restore: () => void }

const hide = <T extends object>(target: T, key: string): Hidden => {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (!descriptor) return { restore: () => {} }
  delete (target as Record<string, unknown>)[key]
  return { restore: () => { Object.defineProperty(target, key, descriptor) } }
}

const withoutNativeBase64 = async (fn: () => Promise<void>) => {
  const hidden = [hide(Uint8Array.prototype, 'toBase64'), hide(Uint8Array, 'fromBase64')]
  try {
    expect(typeof (Uint8Array.prototype as { toBase64?: unknown }).toBase64, 'control: the native encoder is hidden').to.equal('undefined')
    await fn()
  } finally {
    for (const h of hidden) h.restore()
  }
}

const withoutNodeBuffer = async (fn: () => Promise<void>) => {
  const hidden = hide(globalThis, 'Buffer')
  try {
    expect(typeof (globalThis as { Buffer?: unknown }).Buffer, 'control: Buffer is hidden').to.equal('undefined')
    await fn()
  } finally {
    hidden.restore()
  }
}

// getRandomValues caps one call at 65,536 bytes, so the large vector is filled in slices
const random = (length: number) => {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 65_536) crypto.getRandomValues(bytes.subarray(i, i + 65_536))
  return bytes
}

const vectors = () => [
  new Uint8Array(0),
  new Uint8Array([1]),
  new Uint8Array([1, 2]),
  new Uint8Array([1, 2, 3]),
  new Uint8Array([255, 254, 253, 0, 1, 2]),
  random(100_000),
]

const roundTrips = () => {
  for (const bytes of vectors()) {
    const encoded = bytesToBase64(bytes)
    expect(encoded).to.match(/^[A-Za-z0-9+/]*={0,2}$/)
    const decoded = base64ToBytes(encoded)
    expect(decoded.byteLength).to.equal(bytes.byteLength)
    expect(decoded.buffer.byteLength, 'the decoded view owns an exact buffer').to.equal(bytes.byteLength)
    expect(Array.from(decoded)).to.deep.equal(Array.from(bytes))
  }
}

export const nativePathRoundTrips = async () => {
  roundTrips()
}

export const fallbackWithoutNativeMethodsRoundTrips = () =>
  withoutNativeBase64(async () => { roundTrips() })

export const fallbackWithoutNativeMethodsOrBufferRoundTrips = () =>
  withoutNativeBase64(() => withoutNodeBuffer(async () => { roundTrips() }))

/** The encoders agree: whatever the fallback produces, the native decoder reads back, and the other
 *  way round, so a node 24 peer and a browser peer interoperate over the same JSON transport. */
export const fallbackAndNativeAgree = async () => {
  const native = Uint8Array.prototype as { toBase64?: () => string }
  if (typeof native.toBase64 !== 'function') return
  for (const bytes of vectors()) {
    let viaFallback = ''
    await withoutNativeBase64(() => withoutNodeBuffer(async () => { viaFallback = bytesToBase64(bytes) }))
    expect(viaFallback).to.equal(native.toBase64.call(bytes))
    expect(Array.from(base64ToBytes(viaFallback))).to.deep.equal(Array.from(bytes))
  }
}

/** A typed array crossing a JSON transport with the native methods hidden, end to end. */
export const jsonTransportCarriesBuffersWithoutNativeBase64 = () =>
  withoutNativeBase64(() => withoutNodeBuffer(async () => {
    const { port1, port2 } = new MessageChannel()
    const value = { echo: async (bytes: Uint8Array, buffer: ArrayBuffer) => ({ bytes, buffer }) }
    expose(value, { transport: makeJsonTransport(port1) })
    const remote = await expose<typeof value>({}, { transport: makeJsonTransport(port2) })
    const sent = crypto.getRandomValues(new Uint8Array(1_000))
    const { bytes, buffer } = await remote.echo(sent, sent.buffer.slice(0, 10))
    expect(bytes).to.be.instanceOf(Uint8Array)
    expect(Array.from(bytes)).to.deep.equal(Array.from(sent))
    expect(Array.from(new Uint8Array(buffer))).to.deep.equal(Array.from(sent.subarray(0, 10)))
    port1.close()
    port2.close()
  }))
