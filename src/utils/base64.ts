/** Base64 for the bytes a JSON transport carries. Internal: module authors get the same behaviour
 *  through `boxBuffer`/`reviveBuffer`, so this stays out of the package root.
 *
 *  `Uint8Array.prototype.toBase64` and `Uint8Array.fromBase64` are in every current browser, but
 *  node 22 and 24, both LTS as of 2026-09, ship neither (node 26 does), and a JSON transport boxes
 *  every buffer and typed array through here. So: the native method when present, node's `Buffer`
 *  when present, a chunked `btoa`/`atob` otherwise. Measured 2026-09-03 on node 22.23.2, 24.19.0
 *  and 26.8.1. */

type NodeBuffer = {
  from(source: Uint8Array | string, encoding?: string): Uint8Array & { toString(encoding: string): string }
}

const nodeBuffer = (): NodeBuffer | undefined =>
  (globalThis as { Buffer?: NodeBuffer }).Buffer

/** Large inputs go through `String.fromCharCode` in slices, since spreading a whole buffer into one
 *  call overflows the argument limit somewhere past 64k elements. */
const CHUNK = 0x8000

export const bytesToBase64 = (bytes: Uint8Array): string => {
  const native = (bytes as { toBase64?: () => string }).toBase64
  if (typeof native === 'function') return native.call(bytes)
  const buffer = nodeBuffer()
  if (buffer) return buffer.from(bytes).toString('base64')
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export const base64ToBytes = (base64: string): Uint8Array<ArrayBuffer> => {
  const native = (Uint8Array as { fromBase64?: (base64: string) => Uint8Array<ArrayBuffer> }).fromBase64
  if (typeof native === 'function') return native(base64)
  const buffer = nodeBuffer()
  // copied out: a Buffer may sit in a shared pool, so its own .buffer is larger than the bytes
  if (buffer) return new Uint8Array(buffer.from(base64, 'base64'))
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
