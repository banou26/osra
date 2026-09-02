import type { Transport } from '../../src'

import { expect } from 'chai'

import { expose, identity } from '../../src/index'

export const sameReferenceAcrossArgs = async (transport: Transport) => {
  const value = async (a: () => number, b: () => number) => a === b
  expose(value, { transport })

  const test = await expose<typeof value>({}, { transport })

  const fn = () => 42
  const result = await test(identity(fn), identity(fn))
  expect(result).to.equal(true)
}

export const sameReferenceAcrossCalls = async (transport: Transport) => {
  let captured: unknown
  const value = {
    capture: async (fn: () => number) => {
      captured = fn
      return fn
    },
    compare: async (fn: () => number) => fn === captured,
  }
  expose(value, { transport })

  const remote = await expose<typeof value>({}, { transport })

  const fn = () => 42
  await remote.capture(identity(fn))
  const result = await remote.compare(identity(fn))
  expect(result).to.equal(true)
}

export const addRemoveEventListenerPattern = async (transport: Transport) => {
  const listeners = new Set<() => Promise<void>>()
  const value = {
    add: async (listener: () => Promise<void>) => {
      listeners.add(listener)
    },
    remove: async (listener: () => Promise<void>) => {
      listeners.delete(listener)
    },
    fireAll: async () => {
      for (const listener of listeners) await listener()
    },
  }
  expose(value, { transport })

  const remote = await expose<typeof value>({}, { transport })

  let callCount = 0
  const handler = async () => { callCount++ }

  await remote.add(identity(handler))
  await remote.fireAll()
  expect(callCount).to.equal(1)

  await remote.remove(identity(handler))
  await remote.fireAll()
  expect(callCount).to.equal(1)
}

export const unwrappedValuesClone = async (transport: Transport) => {
  const value = async (a: () => number, b: () => number) => a === b
  expose(value, { transport })

  const test = await expose<typeof value>({}, { transport })

  const fn = () => 42
  const result = await test(fn, fn)
  expect(result).to.equal(false)
}

export const identityIdempotentMemoized = async (_transport: Transport) => {
  const fn = () => 42
  expect(identity(fn)).to.equal(identity(fn))
  expect(identity(identity(fn))).to.equal(identity(fn))

  const obj = { a: 1 }
  expect(identity(obj)).to.equal(identity(obj))
  expect(identity(identity(obj))).to.equal(identity(obj))
}

export const primitivesPassThrough = async (_transport: Transport) => {
  expect(identity(42)).to.equal(42)
  expect(identity('hi')).to.equal('hi')
  expect(identity(null)).to.equal(null)
  expect(identity(undefined)).to.equal(undefined)
  expect(identity(true)).to.equal(true)
  expect(identity(0)).to.equal(0)
  expect(identity('')).to.equal('')
}

export const identityWithFunctionStillCallable = async (transport: Transport) => {
  const value = async (fn: () => number) => fn()
  expose(value, { transport })

  const test = await expose<typeof value>({}, { transport })

  const fn = () => 42
  const result = await test(identity(fn))
  expect(result).to.equal(42)
}

export const identityTwiceAcrossCallsCallable = async (transport: Transport) => {
  let captured: (() => number) | undefined
  const value = {
    capture: async (fn: () => number) => {
      captured = fn
    },
    compareAndCall: async (fn: () => number) => ({
      same: fn === captured,
      result: await fn(),
    }),
  }
  expose(value, { transport })

  const remote = await expose<typeof value>({}, { transport })

  const fn = () => 99
  await remote.capture(identity(fn))
  const { same, result } = await remote.compareAndCall(identity(fn))
  expect(same).to.equal(true)
  expect(result).to.equal(99)
}

export const roundTripReturnsOriginalFunction = async (transport: Transport) => {
  const value = async (fn: () => number) => identity(fn)
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const fn = () => 42
  const echoed = await remote(identity(fn))
  expect(echoed).to.equal(fn)
  expect(echoed()).to.equal(42)
}

export const roundTripReturnsOriginalObject = async (transport: Transport) => {
  const value = async (o: { a: number }) => identity(o)
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const obj = { a: 1 }
  const echoed = await remote(identity(obj))
  expect(echoed).to.equal(obj)
}

export const roundTripStableAcrossCalls = async (transport: Transport) => {
  const value = async (fn: () => number) => identity(fn)
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const fn = () => 7
  const [a, b, c] = await Promise.all([
    remote(identity(fn)),
    remote(identity(fn)),
    remote(identity(fn)),
  ])
  expect(a).to.equal(fn)
  expect(b).to.equal(fn)
  expect(c).to.equal(fn)
}

export const roundTripDistinctObjectsStayDistinct = async (transport: Transport) => {
  const value = async (o: { a: number }) => identity(o)
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const obj1 = { a: 1 }
  const obj2 = { a: 1 }
  const echoed1 = await remote(identity(obj1))
  const echoed2 = await remote(identity(obj2))
  expect(echoed1).to.equal(obj1)
  expect(echoed2).to.equal(obj2)
  expect(echoed1).to.not.equal(echoed2)
}

export const revivedValueIsNotTheOriginal = async (transport: Transport) => {
  const obj = { a: 1 }
  const value = { get: async () => identity(obj) }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const received = await remote.get()
  expect(received).to.not.equal(obj)
  expect(received.a).to.equal(1)
}

export const returnedValueSentBackUnwrappedResolvesToOriginal = async (transport: Transport) => {
  const obj = { a: 1 }
  const value = {
    get: async () => identity(obj),
    isOriginal: async (received: { a: number }) => received === obj,
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const received = await remote.get()
  expect(await remote.isOriginal(received)).to.equal(true)
}

export const argumentSentBackUnwrappedResolvesToOriginal = async (transport: Transport) => {
  let held: (() => number) | undefined
  const value = {
    hold: async (fn: () => number) => { held = fn },
    handBack: async (): Promise<() => number> => held!,
  }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  const fn = () => 42
  await remote.hold(identity(fn))
  expect(await remote.handBack()).to.equal(fn)
}

export const resendDoesNotReboxTheValue = async (transport: Transport) => {
  let reads = 0
  const obj = {
    get a() { reads++; return 1 },
  }
  const value = { take: async (received: { a: number }) => received.a }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  await remote.take(identity(obj))
  const afterFirst = reads
  await remote.take(identity(obj))
  expect(reads).to.equal(afterFirst)
}

export const markedValueIsOneReferenceEvenWhenSentUnmarked = async (transport: Transport) => {
  const plain = { foo: 'bar' }
  const shared = { foo: 'bar' }
  const value = { plain1: plain, plain2: plain, ref1: identity(shared), ref2: shared }
  expose(value, { transport })
  const remote = await expose<typeof value>({}, { transport })

  expect(remote.plain1).to.not.equal(remote.plain2)
  expect(remote.ref1).to.equal(remote.ref2)
}
