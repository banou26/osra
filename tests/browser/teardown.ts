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

/** Where the host reports an escape: a browser page raises global `error` and `unhandledrejection`
 *  events, node emits the same two on `process`. Picked at call time so one test body runs under
 *  both runners; the browser branch is the original hook unchanged. */
const escapeListeners = (escaped: unknown[]): { attach: () => void, detach: () => void } => {
  if (typeof globalThis.addEventListener === 'function') {
    const onError = (event: ErrorEvent) => escaped.push(event.error ?? event.message)
    const onRejection = (event: PromiseRejectionEvent) => escaped.push(event.reason)
    return {
      attach: () => {
        globalThis.addEventListener('error', onError)
        globalThis.addEventListener('unhandledrejection', onRejection)
      },
      detach: () => {
        globalThis.removeEventListener('error', onError)
        globalThis.removeEventListener('unhandledrejection', onRejection)
      },
    }
  }
  const onError = (error: Error) => escaped.push(error)
  const onRejection = (reason: unknown) => escaped.push(reason)
  return {
    attach: () => {
      process.on('uncaughtException', onError)
      process.on('unhandledRejection', onRejection)
    },
    detach: () => {
      process.off('uncaughtException', onError)
      process.off('unhandledRejection', onRejection)
    },
  }
}

/** Collects anything that escapes to the host while `run` is in flight.
 *
 *  Load-bearing: the callee's handler is a DETACHED async IIFE (function.ts box()), so a throw inside it
 *  reaches no caller and no assertion. Without this hook a test can claim "and it must not throw on the way
 *  out" while being physically unable to observe a throw, which is exactly how the plain-result test below
 *  was vacuous on its first pass. */
const withoutEscapingErrors = async (run: () => Promise<void>): Promise<unknown[]> => {
  const escaped: unknown[] = []
  const listeners = escapeListeners(escaped)
  listeners.attach()
  try {
    await run()
  } finally {
    listeners.detach()
  }
  return escaped
}

const expectNothingEscaped = (escaped: unknown[]) =>
  expect(
    escaped,
    `nothing may escape the detached handler, got: ${escaped.map(error => String((error as Error)?.message ?? error)).join(' | ')}`,
  ).to.have.length(0)

// Teardown used to be one-sided: the caller rejected while the callee's detached handler ran on, boxed its
// result into the dead context, and left a returned stream LOCKED by box()'s own getReader() and never
// cancelled. Measured before the fix as locked=true / cancelled=false.
export const teardownReleasesAnUndeliverableStream = async () => {
  const { port1, port2 } = new MessageChannel()
  const exposerController = new AbortController()

  let produced: ReadableStream<Uint8Array> | undefined
  let cancelled = false
  const value = {
    slowStream: async () => {
      await new Promise(resolve => setTimeout(resolve, 60))
      produced = new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(new Uint8Array([1, 2, 3])),
        cancel: () => { cancelled = true },
      })
      return produced
    },
  }
  expose(value, { transport: port1, unregisterSignal: exposerController.signal })

  const remote = await expose<typeof value>({}, { transport: port2 })
  const call = remote.slowStream()
  call.catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 20))
  exposerController.abort()
  await expect(call).to.eventually.be.rejectedWith(/connection closed/)
  await new Promise(resolve => setTimeout(resolve, 100))

  expect(produced, 'the handler still ran to completion').to.not.equal(undefined)
  expect(produced!.locked, 'an undeliverable stream must not be left locked').to.equal(false)
  expect(cancelled, 'and must be cancelled so whatever feeds it is released').to.equal(true)
}

// Drives the same teardown-mid-handler shape and returns whatever escaped to the page
const undeliverable = async <T>(resolve_: () => Promise<T>): Promise<unknown[]> => {
  const { port1, port2 } = new MessageChannel()
  const exposerController = new AbortController()
  const value = { slow: async () => resolve_() }
  expose(value, { transport: port1, unregisterSignal: exposerController.signal })
  const remote = await expose<typeof value>({}, { transport: port2 })

  return withoutEscapingErrors(async () => {
    const call = remote.slow()
    await new Promise(resolve => setTimeout(resolve, 20))
    exposerController.abort()
    await expect(call).to.eventually.be.rejectedWith(/connection closed/)
    await new Promise(resolve => setTimeout(resolve, 150))
  })
}

const afterDelay = async <T>(make: () => T): Promise<T> => {
  await new Promise(resolve => setTimeout(resolve, 60))
  return make()
}

// A plain result needs no disposal. The escape hook is what gives this test teeth: without it the assertion
// was unobservable, and it passed even with the whole box() guard deleted.
export const teardownDropsAnUndeliverablePlainResult = async () => {
  expectNothingEscaped(await undeliverable(() => afterDelay(() => ({ some: 'value' }))))
}

// The `message.type === 'throw'` arm of the guard: a callee that rejects after teardown still resolves to a
// connection-closed rejection for the caller, and must not surface its own error to the page.
export const teardownDropsAnUndeliverableCalleeThrow = async () => {
  expectNothingEscaped(await undeliverable(() => afterDelay(() => { throw new Error('callee blew up') })))
}

export const teardownReleasesAnUndeliverableWritableStream = async () => {
  let produced: WritableStream | undefined
  let aborted = false
  const escaped = await undeliverable(() => afterDelay(() => {
    produced = new WritableStream({ abort: () => { aborted = true } })
    return produced
  }))
  expectNothingEscaped(escaped)
  expect(produced, 'the handler still ran to completion').to.not.equal(undefined)
  expect(produced!.locked, 'an undeliverable writable must not be left locked').to.equal(false)
  expect(aborted, 'and must be aborted so its sink is released').to.equal(true)
}

// osra must only release what it would otherwise have taken. A stream the callee already holds a reader on
// is the callee's to finish with, so the guard's `!value.locked` arm has to leave it completely alone.
export const teardownLeavesAnAlreadyLockedResultAlone = async () => {
  let produced: ReadableStream<Uint8Array> | undefined
  let cancelled = false
  const escaped = await undeliverable(() => afterDelay(() => {
    produced = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true } })
    produced.getReader()
    return produced
  }))
  expectNothingEscaped(escaped)
  expect(produced!.locked, "the callee's own reader still holds it").to.equal(true)
  expect(cancelled, 'osra must not cancel a stream it never took').to.equal(false)
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
