import type { Message } from '../../src/types'
import type { MessageContext } from '../../src/utils/transport'

export const makeJsonEmitter =
  (port: MessagePort) =>
    (osraMessage: Message, _?: Transferable[]) =>
      port.postMessage(JSON.stringify(osraMessage))

export const makeJsonReceiver =
  (port: MessagePort) =>
    (callback: (message: Message, ctx: MessageContext) => void) => {
      port.start()
      port.addEventListener(
        'message',
        event => callback(JSON.parse(event.data as string) as Message, {}),
      )
    }

export const makeJsonTransport = (port: MessagePort) => ({
  isJson: true as const,
  emit: makeJsonEmitter(port),
  receive: makeJsonReceiver(port),
})

/** Hex of a byte view. `Uint8Array.prototype.toHex` is not in node 22 or 24, which the node runner
 *  also targets, so the tests spell it out. */
export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
