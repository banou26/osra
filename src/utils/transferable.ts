import { transfer } from '../revivables/transfer.js'
import { isRevivableBox } from '../revivables/utils.js'
import { instanceOfAny, isSharedArrayBuffer, isTransferable } from './type-guards.js'

export { transfer }

// Structured clone can't copy these, so they must go on the transfer list - opt-in or not.
const isMustTransfer = (value: unknown): value is Transferable =>
  instanceOfAny(value, [
    globalThis.MessagePort,
    globalThis.ReadableStream,
    globalThis.WritableStream,
    globalThis.TransformStream,
    globalThis.OffscreenCanvas,
    (globalThis as { MediaSourceHandle?: abstract new (...args: any[]) => unknown }).MediaSourceHandle,
    (globalThis as { MediaStreamTrack?: abstract new (...args: any[]) => unknown }).MediaStreamTrack,
    (globalThis as { MIDIAccess?: abstract new (...args: any[]) => unknown }).MIDIAccess,
    (globalThis as { RTCDataChannel?: abstract new (...args: any[]) => unknown }).RTCDataChannel,
    (globalThis as { WebTransportReceiveStream?: abstract new (...args: any[]) => unknown }).WebTransportReceiveStream,
    (globalThis as { WebTransportSendStream?: abstract new (...args: any[]) => unknown }).WebTransportSendStream,
  ])

// `degraded` (set by transfer.box) means the wrapper is a no-op here.
const isTransferBox = (value: unknown): value is { inner: unknown, degraded: boolean } =>
  isRevivableBox(value) && value.type === 'transfer'

/** Walk a boxed message and collect Transferables to move (rather than copy)
 *  on postMessage:
 *    1. Must-transfer types are always included.
 *    2. Clonable types (SharedArrayBuffer) are skipped.
 *    3. Other Transferables are included only inside a non-degraded transfer
 *       box (user opted in AND the platform supports transferring). */
export const getTransferableObjects = (value: unknown): Transferable[] => {
  const transferables: Transferable[] = []
  const seen = new WeakSet<object>()

  const recurse = (value: unknown, inTransferBox: boolean): void => {
    if (!value || typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)

    if (isSharedArrayBuffer(value)) return

    if (isTransferBox(value)) {
      recurse(value.inner, inTransferBox || !value.degraded)
      return
    }

    if (isMustTransfer(value)) {
      transferables.push(value)
      return
    }

    if (isTransferable(value)) {
      if (inTransferBox) {
        transferables.push(value)
      }
      return
    }

    // TypedArray / DataView expose every numeric index, so never descend into them. Typed
    // arrays are boxed (their raw buffer rides the box and is collected above); a raw
    // DataView rides the clonable fallback, so inside a transfer box its buffer is the
    // thing to move - the serialized view then arrives over the moved buffer.
    if (ArrayBuffer.isView(value)) {
      if (inTransferBox && value instanceof DataView && !isSharedArrayBuffer(value.buffer) && !seen.has(value.buffer)) {
        seen.add(value.buffer)
        transferables.push(value.buffer as ArrayBuffer)
      }
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) recurse(item, inTransferBox)
      return
    }

    for (const item of Object.values(value)) recurse(item, inTransferBox)
  }

  recurse(value, false)
  return transferables
}
