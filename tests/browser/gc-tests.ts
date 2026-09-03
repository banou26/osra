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

/** The chain unwinds from the origin outward: the middle context holds its value only while the
 *  origin holds its own, and the far end holds its own only while the middle does. Each assertion is
 *  paired with the control that the value is still there before the drop it is waiting on. */
const identityChainUnwindsFromTheOrigin = async (_transport: Transport) => {
  const a = new MessageChannel()
  const b = new MessageChannel()

  let origin: { tag: string } | undefined = { tag: 'origin' }
  const originApi = { get: async () => identity(origin!) }
  expose(originApi, { transport: a.port1 })

  const upstream = await expose<typeof originApi>({}, { transport: a.port2 })
  const middleHeld: { value?: unknown } = {}
  const middleApi = { get: async () => (middleHeld.value = await upstream.get()) as { tag: string } }
  expose(middleApi, { transport: b.port1 })

  const farEnd = await expose<typeof middleApi>({}, { transport: b.port2 })
  const farHeld: { value?: unknown } = { value: await farEnd.get() }

  const middleRef = new WeakRef(middleHeld.value as object)
  const farRef = new WeakRef(farHeld.value as object)
  expect(middleRef.deref(), 'the middle context revived a value').to.not.equal(undefined)
  expect(farRef.deref(), 'the far end revived a value').to.not.equal(undefined)

  // nothing in user code holds either of them any more, but both pins do
  middleHeld.value = undefined
  farHeld.value = undefined
  await __osraForceGc()
  expect(middleRef.deref(), 'the middle value is pinned while the origin holds its own').to.not.equal(undefined)
  expect(farRef.deref(), 'the far value is pinned while the middle holds its own').to.not.equal(undefined)

  origin = undefined
  await __osraForceGc()
  expect(middleRef.deref(), 'the middle pin is released when the origin drops its value').to.equal(undefined)
  expect(farRef.deref(), 'the far pin is released when the middle value goes with it').to.equal(undefined)
}


/** An identity shared down a chain outlives the context that minted it.
 *
 *  Context 1 marks a value and hands it to context 2, which forwards it to context 3, which keeps
 *  it. Context 1 then lets go and its value is collected, so a dispose travels outward hop by hop.
 *  What context 3 still holds must keep its identity: a value coming back to it has to land on that
 *  same object, not on a fresh copy. A dispose says the peer forgot the id, which says nothing about
 *  whether this side still holds the value, and conflating those two was what broke this.
 *
 *  The dispose arriving at context 3 is asserted BEFORE the round trip, because without it the round
 *  trip would pass on any build and prove nothing. */
export const identityOutlivesTheContextThatMintedIt = async (_transport: Transport) => {
  const seen = { disposesAtC3: 0 }
  const countingPair = () => {
    const { port1, port2 } = new MessageChannel()
    const side = (port: MessagePort, count: boolean): Transport => ({
      emit: (message, transferables) => { port.postMessage(message, transferables ?? []) },
      receive: (listener) => {
        port.addEventListener('message', event => {
          const message = (event as MessageEvent).data as { type?: string }
          if (count && message?.type === 'identity-dispose') seen.disposesAtC3++
          listener(message as never, {})
        })
        port.start()
      },
    })
    return [side(port1, false), side(port2, true)] as const
  }

  type Shared = { tag: string }
  // context 3, the far end, keeps whatever it is handed for the whole test
  const kept = new Set<Shared>()
  const c3Api = {
    keep: async (value: Shared) => { kept.add(value); return kept.size },
    isTheOneIKept: async (value: Shared) => kept.has(value),
    sendBack: async () => [...kept][0] as Shared,
  }
  const [toC3, atC3] = countingPair()
  expose(c3Api, { transport: atC3 })
  const c3 = await expose<typeof c3Api>({}, { transport: toC3 })

  // context 2 forwards both ways and keeps nothing, so it lets go once context 1 does
  const c2Api = {
    keep: async (value: Shared) => c3.keep(value),
    isTheOneIKept: async (value: Shared) => c3.isTheOneIKept(value),
    sendBack: async () => c3.sendBack(),
  }
  const { port1, port2 } = new MessageChannel()
  expose(c2Api, { transport: port2 })
  const c2 = await expose<typeof c2Api>({}, { transport: port1 })

  // its own scope, so no sibling closure of this test keeps the value reachable
  const ownedRef = await (async () => {
    const owned: Shared = { tag: 'shared' }
    const ref = new WeakRef(owned)
    await c2.keep(identity(owned))
    return ref
  })()

  for (let i = 0; i < 12 && ownedRef.deref() !== undefined; i++) await __osraForceGc()
  expect(ownedRef.deref(), 'context 1 let its own value go').to.equal(undefined)

  // the unwind is one collection per hop, so it needs more than one bracket
  for (let i = 0; i < 12 && seen.disposesAtC3 === 0; i++) await __osraForceGc()
  expect(seen.disposesAtC3, 'the dispose reached context 3, without which the next assertion proves nothing')
    .to.be.greaterThan(0)

  const back = await c2.sendBack()
  expect(await c2.isTheOneIKept(back), 'context 3 resolves the round trip to the value it still holds')
    .to.equal(true)
}

/** What the middle context sees once the chain has unwound past it.
 *
 *  Context 2 losing its copy and context 3 losing its record are the SAME event: the registry
 *  callback that deletes the record is the one that sends the dispose. So there is no state where
 *  context 2 still resolves an id that context 3 has forgotten. What matters is what happens next,
 *  when context 3 hands the value back down: context 2 cannot resolve to the copy it let go, so it
 *  revives a fresh one, but the id travels with the value, so the pair stabilises on that object and
 *  a send back still lands on the object context 3 never stopped holding. Same identity, new local
 *  object for the context that forgot. */
export const identityRebindsOnTheContextThatForgot = async (_transport: Transport) => {
  const seen = { disposesAtC3: 0 }
  const countingPair = () => {
    const { port1, port2 } = new MessageChannel()
    const side = (port: MessagePort, count: boolean): Transport => ({
      emit: (message, transferables) => { port.postMessage(message, transferables ?? []) },
      receive: (listener) => {
        port.addEventListener('message', event => {
          const message = (event as MessageEvent).data as { type?: string }
          if (count && message?.type === 'identity-dispose') seen.disposesAtC3++
          listener(message as never, {})
        })
        port.start()
      },
    })
    return [side(port1, false), side(port2, true)] as const
  }

  type Shared = { tag: string }
  const kept = new Set<Shared>()
  const c3Api = {
    keep: async (value: Shared) => { kept.add(value); return kept.size },
    isTheOneIKept: async (value: Shared) => kept.has(value),
    sendBack: async () => [...kept][0] as Shared,
  }
  const [toC3, atC3] = countingPair()
  expose(c3Api, { transport: atC3 })
  const c3 = await expose<typeof c3Api>({}, { transport: toC3 })

  // context 2 keeps nothing at first, so it lets go when context 1 does, then holds what it pulls back
  let c2Held: Shared | undefined
  const c2Api = {
    keep: async (value: Shared) => c3.keep(value),
    pull: async () => { c2Held = await c3.sendBack(); return c2Held.tag },
    pullAgainIsTheSameObject: async () => (await c3.sendBack()) === c2Held,
    pushBackLandsOnTheOneC3Kept: async () => c3.isTheOneIKept(c2Held as Shared),
  }
  const { port1, port2 } = new MessageChannel()
  expose(c2Api, { transport: port2 })
  const c2 = await expose<typeof c2Api>({}, { transport: port1 })

  const ownedRef = await (async () => {
    const owned: Shared = { tag: 'shared' }
    const ref = new WeakRef(owned)
    await c2.keep(identity(owned))
    return ref
  })()

  for (let i = 0; i < 12 && ownedRef.deref() !== undefined; i++) await __osraForceGc()
  expect(ownedRef.deref(), 'context 1 let its own value go').to.equal(undefined)
  for (let i = 0; i < 12 && seen.disposesAtC3 === 0; i++) await __osraForceGc()
  // the dispose is what deletes context 2's record too, so this is the control for BOTH halves
  expect(seen.disposesAtC3, 'context 2 let go, which is what forgets the id on both sides')
    .to.be.greaterThan(0)

  await c2.pull()
  expect(await c2.pullAgainIsTheSameObject(), 'context 2 settles on one object for the id it re-learned')
    .to.equal(true)
  expect(await c2.pushBackLandsOnTheOneC3Kept(), 'and it still resolves to the object context 3 never let go of')
    .to.equal(true)
}

export const gc = {
  identityChainUnwindsFromTheOrigin,
  identityRebindsOnTheContextThatForgot,
  identityDropReleasesThePeersPin,
  identityOutlivesTheContextThatMintedIt,
  gcBracketCollectsUnreferencedObject,
  revivedEventTargetDroppedWithoutListenerIsCollected,
  revivedFunctionDroppedIsCollected,
  revivedEventTargetDropTearsDownSource,
  funcDropDoesNotRejectPending,
  revivedPortDropSendsCloseToBoxSide,
}
