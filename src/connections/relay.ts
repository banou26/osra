import type { Transport } from '../utils/transport.js'

import { OSRA_DEFAULT_KEY } from '../types.js'
import { isEmitTransport, isJsonOnlyTransport, isReceiveTransport } from '../utils/type-guards.js'
import { markPortsShipped } from '../revivables/message-port.js'
import { getTransferableObjects } from '../utils/transferable.js'
import {
  registerOsraMessageListener,
  sendOsraMessage,
} from '../utils/transport.js'
import { normalizeTransport } from './utils.js'

export type RelayOptions = {
  key?: string
  origin?: string
  originA?: string
  originB?: string
  nameA?: string
  nameB?: string
  unregisterSignal?: AbortSignal
}

export const relay = (
  transportA: Transport,
  transportB: Transport,
  {
    key = OSRA_DEFAULT_KEY,
    origin = '*',
    originA = origin,
    originB = origin,
    nameA,
    nameB,
    unregisterSignal,
  }: RelayOptions = {},
): void => {
  const a = normalizeTransport(transportA)
  const b = normalizeTransport(transportB)

  const forward = (
    from: Transport,
    to: Transport,
    fromOrigin: string,
    toOrigin: string,
    remoteName: string | undefined,
  ): void => {
    if (!isReceiveTransport(from) || !isEmitTransport(to)) return
    registerOsraMessageListener({
      transport: from,
      key,
      remoteName,
      origin: fromOrigin,
      unregisterSignal,
      listener: (message) => {
        const transferables = getTransferableObjects(message)
        sendOsraMessage(to, message, toOrigin, transferables)
        markPortsShipped(transferables, !isJsonOnlyTransport(to))
      },
    })
  }

  forward(a, b, originA, originB, nameA)
  forward(b, a, originB, originA, nameB)
}
