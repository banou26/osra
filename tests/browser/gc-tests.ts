import type { Transport } from '../../src'

import { expect } from 'chai'

import { expose, identity } from '../../src/index'
import { EventChannel, EventPort } from '../../src/utils/event-channel'

// wired up by the spec runner via page.exposeFunction, and waits for FinalizationRegistry callbacks
declare const __osraForceGc: () => Promise<void>

export const gcBracketCollectsUnreferencedObject = async (_transport: Transport) => {
  const probe = new WeakRef({ marker: 'unreferenced' })
  await __osraForceGc()
  expect(probe.deref(), 'plain object with no retaining refs should be collected').to.equal(undefined)
}

export const revivedEventTargetDroppedWithoutListenerIsCollected = async (transport: Transport) => {
  const _et = new EventTarget()
  const value = { et: _et }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const etRef = new WeakRef(remote.et)
  ;(remote as { et?: unknown }).et = undefined
  await __osraForceGc()
  expect(etRef.deref(), 'revived EventTarget should be collected when user never added a listener').to.equal(undefined)
}

// osra internals retain the resolved init-object, so only scrubbing the field releases the revived value
export const revivedFunctionDroppedIsCollected = async (transport: Transport) => {
  const value = { foo: async () => 1 }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })
  const fooRef = new WeakRef(remote.foo)
  ;(remote as { foo?: unknown }).foo = undefined
  await __osraForceGc()
  expect(fooRef.deref(), 'revived function should be collected after dropping the holding reference').to.equal(undefined)
}

export const revivedEventTargetDropTearsDownSource = async (transport: Transport) => {
  const _et = new EventTarget()
  let probeCount = 0
  _et.addEventListener('tick', () => { probeCount++ })

  // the forwarder fires before the probe listener (install order), so probe can't detect its presence
  let forwarderLive = 0
  const originalAdd = _et.addEventListener.bind(_et)
  const originalRemove = _et.removeEventListener.bind(_et)
  const wrapped = new WeakSet<EventListener>()
  _et.addEventListener = ((type: string, listener: EventListener, opts?: unknown) => {
    if (type === 'tick' && listener !== undefined && !wrapped.has(listener)) {
      forwarderLive++
      wrapped.add(listener)
    }
    return originalAdd(type, listener, opts as AddEventListenerOptions | boolean | undefined)
  }) as EventTarget['addEventListener']
  _et.removeEventListener = ((type: string, listener: EventListener, opts?: unknown) => {
    if (type === 'tick' && listener !== undefined && wrapped.has(listener)) {
      forwarderLive--
      wrapped.delete(listener)
    }
    return originalRemove(type, listener, opts as EventListenerOptions | boolean | undefined)
  }) as EventTarget['removeEventListener']

  const value = {
    et: _et,
    fire: async () => { _et.dispatchEvent(new Event('tick')) },
    probe: async () => probeCount,
    forwarderLive: async () => forwarderLive,
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  remote.et.addEventListener('tick', () => {})
  await new Promise(r => setTimeout(r, 50))
  await remote.fire()
  await new Promise(r => setTimeout(r, 50))
  expect(await remote.forwarderLive()).to.equal(1)

  const etRef = new WeakRef(remote.et)
  ;(remote as { et?: unknown }).et = undefined
  await __osraForceGc()
  expect(etRef.deref(), 'revived EventTarget should be collected after drop').to.equal(undefined)

  const probeBefore = await remote.probe()
  await remote.fire()
  await new Promise(r => setTimeout(r, 50))
  expect(await remote.probe()).to.equal(probeBefore + 1)
  expect(await remote.forwarderLive()).to.equal(0)
}

// auto-rejecting would fire spuriously whenever V8's liveness analysis collects the proxy local mid-await
export const funcDropDoesNotRejectPending = async (transport: Transport) => {
  const value = { slow: (): Promise<number> => new Promise(() => {}) }
  expose(value, { transport })

  const remote = await expose<typeof value>({}, { transport })

  const callPromise = remote.slow().then(
    () => 'settled' as const,
    () => 'settled' as const,
  )

  await new Promise(r => setTimeout(r, 50))

  ;(remote as { slow?: unknown }).slow = undefined
  await __osraForceGc()

  const settled = await Promise.race([
    callPromise,
    new Promise<'hung'>(r => setTimeout(() => r('hung'), 200)),
  ])
  expect(settled).to.equal('hung')
}

export const revivedPortDropSendsCloseToBoxSide = async (transport: Transport) => {
  const channel = new EventChannel<string, string>()
  let closes = 0
  const sourceReceived: string[] = []
  channel.port2.addEventListener('close', () => { closes++ })
  channel.port1.addEventListener('message', event => { sourceReceived.push((event as MessageEvent<string>).data) })
  channel.port1.start()

  const value = {
    getPort: async () => channel.port2,
    ping: async () => 'pong',
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const holder: { port?: unknown } = { port: await remote.getPort() }
  ;(holder.port as EventPort<string>).postMessage('hello')
  await new Promise(r => setTimeout(r, 50))
  expect(sourceReceived).to.deep.equal(['hello'])

  const portRef = new WeakRef(holder.port as object)
  holder.port = undefined
  await __osraForceGc()
  expect(portRef.deref(), 'revived port should be collected after drop').to.equal(undefined)

  await new Promise(r => setTimeout(r, 50))
  expect(closes).to.equal(1)
  await expect(remote.ping()).to.eventually.equal('pong')
}

/** The peer holds a revived identity until the origin drops its own reference: the first assertion
 *  is the control, it proves the WeakRef can still see the value while the pin is in place. */
export const identityDropReleasesThePeersPin = async (transport: Transport) => {
  let held: { a: number } | undefined = { a: 1 }
  const value = { get: async () => identity(held!) }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const holder: { received?: unknown } = { received: await remote.get() }
  const receivedRef = new WeakRef(holder.received as object)
  holder.received = undefined
  await __osraForceGc()
  expect(receivedRef.deref(), 'revived identity should be held while the origin still has its value').to.not.equal(undefined)

  held = undefined
  await __osraForceGc()
  expect(receivedRef.deref(), 'revived identity should be released once the origin drops its value').to.equal(undefined)
}

export const gc = {
  identityDropReleasesThePeersPin,
  gcBracketCollectsUnreferencedObject,
  revivedEventTargetDroppedWithoutListenerIsCollected,
  revivedFunctionDroppedIsCollected,
  revivedEventTargetDropTearsDownSource,
  funcDropDoesNotRejectPending,
  revivedPortDropSendsCloseToBoxSide,
}
