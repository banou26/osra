import { expect } from 'chai'

import type { Uuid } from '../../src/types'

import { expose } from '../../src/index'
import { OSRA_KEY, OSRA_DEFAULT_KEY } from '../../src/types'

export const emitOnlyTransportRejects = async () => {
  await expect(
    expose({}, { transport: { emit: () => {} } }),
  ).to.eventually.be.rejectedWith(/emit and receive/)
}

export const receiveOnlyTransportRejects = async () => {
  await expect(
    expose({}, { transport: { receive: () => {} } }),
  ).to.eventually.be.rejectedWith(/emit and receive/)
}

export const abortRejectsPendingExpose = async () => {
  const { port1 } = new MessageChannel()
  const controller = new AbortController()
  const pending = expose({}, { transport: port1, unregisterSignal: controller.signal })
  controller.abort(new Error('torn down'))
  await expect(pending).to.eventually.be.rejectedWith(/torn down/)
}

export const alreadyAbortedSignalRejectsImmediately = async () => {
  const { port1 } = new MessageChannel()
  const controller = new AbortController()
  controller.abort(new Error('pre-aborted'))
  await expect(
    expose({}, { transport: port1, unregisterSignal: controller.signal }),
  ).to.eventually.be.rejectedWith(/pre-aborted/)
}

export const abortRejectsPendingCalls = async () => {
  const { port1, port2 } = new MessageChannel()
  const value = { hang: () => new Promise<void>(() => {}) }
  expose(value, { transport: port1 })

  const controller = new AbortController()
  const remote = await expose<typeof value>(
    {},
    { transport: port2, unregisterSignal: controller.signal },
  )
  const call = remote.hang()
  await new Promise(resolve => setTimeout(resolve, 50))
  controller.abort()
  await expect(call).to.eventually.be.rejectedWith(/connection closed/)
}

export const peerCloseRejectsPendingCalls = async () => {
  const { port1, port2 } = new MessageChannel()
  const exposerController = new AbortController()
  const value = { hang: () => new Promise<void>(() => {}) }
  expose(value, { transport: port1, unregisterSignal: exposerController.signal })

  const remote = await expose<typeof value>({}, { transport: port2 })
  const call = remote.hang()
  await new Promise(resolve => setTimeout(resolve, 50))
  exposerController.abort()
  await expect(call).to.eventually.be.rejectedWith(/connection closed/)
}

// A call issued AFTER teardown must reject without boxing its arguments into the dead context. Boxing a
// stream argument would lock it forever, since box() takes a reader and nothing is left to cancel it.
//
// THIS TEST EXISTS TO GUARD A TRAP, so do not "simplify" it away. It passed on the ORIGINAL code only by
// accident: `settle()` reached `removeTeardown` from inside that const's own initializer, and the resulting
// TDZ ReferenceError aborted the promise executor before the boxing below could run. Repairing that binding
// on its own (hoist to `let`, call `removeTeardown?.()`) removes the accident and makes this test FAIL,
// which is verified. The refusal has to be explicit, which is what the guard in revive() now makes it.
export const callAfterTeardownRejectsWithoutLockingItsArguments = async () => {
  const { port1, port2 } = new MessageChannel()
  const value = { take: async (_stream: ReadableStream) => 'ok' }
  expose(value, { transport: port1 })

  const controller = new AbortController()
  const remote = await expose<typeof value>({}, { transport: port2, unregisterSignal: controller.signal })
  controller.abort()
  await new Promise(resolve => setTimeout(resolve, 50))

  const argument = new ReadableStream()
  await expect(remote.take(argument)).to.eventually.be.rejectedWith(/connection closed/)
  expect(argument.locked, 'a refused call must not consume its arguments').to.equal(false)
}

export const malformedInitRejects = async () => {
  const { port1, port2 } = new MessageChannel()
  port2.start()
  const evilUuid = '11111111-1111-1111-1111-111111111111' as Uuid

  port2.onmessage = ({ data }) => {
    if (data?.[OSRA_KEY] !== OSRA_DEFAULT_KEY) return
    if (data.type === 'announce' && !data.remoteUuid) {
      const envelope = { [OSRA_KEY]: OSRA_DEFAULT_KEY, uuid: evilUuid }
      port2.postMessage({ ...envelope, type: 'announce', remoteUuid: data.uuid })
      port2.postMessage({
        ...envelope,
        type: 'init',
        remoteUuid: data.uuid,
        data: {
          __OSRA_BOX__: 'revivable',
          type: 'typedArray',
          typedArrayType: 'NotARealTypedArray',
          base64Buffer: '',
        },
      })
    }
  }

  await expect(
    expose({}, { transport: port1 }),
  ).to.eventually.be.rejectedWith(/Unknown typed array/)
}
