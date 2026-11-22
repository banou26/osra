import type { BoxBase, RevivableContext, RevivableModule, Transport } from '../../src/index'
import type { Message } from '../../src/types'
import type { MessageContext } from '../../src/utils/transport'

import { expect } from 'chai'

import { expose, identity, transfer } from '../../src/index'
import { defaultRevivableModules, onBoxWalkSettled, recursiveBox } from '../../src/revivables/index'
import { withQuotedBoxes } from '../../src/revivables/quote'
import { OSRA_BOX } from '../../src/types'

const makeTimeout = <T>(promise: Promise<T>, label: string, ms = 2_000): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`port-in-port timeout (${ms}ms): ${label}`)), ms),
    ),
  ])

const isJsonWireValue = (value: unknown, seen: WeakSet<object>, path: string): void => {
  if (value === null) return
  if (typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DOMException(`DataCloneError: non-finite number at ${path}`, 'DataCloneError')
    }
    return
  }
  if (typeof value !== 'object') {
    if (typeof value === 'undefined' && path === 'root.name') return
    throw new DOMException(`DataCloneError: non-JSON primitive (${typeof value}) at ${path}`, 'DataCloneError')
  }
  if (seen.has(value)) {
    throw new DOMException(`DataCloneError: cyclic object at ${path}`, 'DataCloneError')
  }
  seen.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      isJsonWireValue(value[i], seen, `${path}[${i}]`)
    }
    return
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    const ctorName = (value as { constructor?: { name?: string } }).constructor?.name ?? 'object'
    throw new DOMException(`DataCloneError: non-plain ${ctorName} at ${path}`, 'DataCloneError')
  }
  for (const [k, v] of Object.entries(value)) {
    isJsonWireValue(v, seen, `${path}.${k}`)
  }
}

const makeStrictJsonPair = (): { left: Transport, right: Transport, emitCount: () => number } => {
  const { port1, port2 } = new MessageChannel()
  ;(port1 as unknown as { unref?: () => void }).unref?.()
  ;(port2 as unknown as { unref?: () => void }).unref?.()
  port1.start()
  port2.start()

  let sent = 0
  const side = (port: MessagePort): Transport => ({
    isJson: true,
    emit: (message: Message, transferables?: Transferable[]) => {
      if (transferables && transferables.length > 0) {
        throw new DOMException('DataCloneError: strict JSON transport cannot transfer objects', 'DataCloneError')
      }
      isJsonWireValue(message, new WeakSet(), 'root')
      sent++
      port.postMessage(JSON.stringify(message))
    },
    receive: (listener: (message: Message, context: MessageContext) => void) => {
      port.addEventListener('message', event => {
        listener(JSON.parse((event as MessageEvent).data as string) as Message, {})
      })
    },
  })

  return {
    left: side(port1),
    right: side(port2),
    emitCount: () => sent,
  }
}

const makeInnerApi = () => ({
  ping: async (msg: string) => `pong:${msg}`,
  echoBuffer: async (buf: ArrayBuffer) => new Uint8Array(buf),
  transferBuffer: async (buf: ArrayBuffer) => {
    const view = new Uint8Array(buf)
    view[0] = 99
    return transfer(buf)
  },
  callbackArg: async (cb: (x: number) => Promise<number>) => cb(21),
  returnFn: async (base: number) => async (delta: number) => base + delta,
  echoSpecials: async (payload: {
    u: undefined
    n: number
    inf: number
    ninf: number
    big: bigint
    map: Map<string, number>
    set: Set<number>
    err: Error
  }) => payload,
  nestedPort: async (port: MessagePort) => {
    port.start()
    return new Promise<string>(resolve => {
      port.addEventListener('message', event => resolve(`ack:${String(event.data)}`), { once: true })
    })
  },
  streamSum: async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    let sum = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (const byte of value) sum += byte
    }
    return sum
  },
})

type InnerApi = ReturnType<typeof makeInnerApi>

const verifyInnerRemote = async (remoteInner: InnerApi) => {
  await expect(makeTimeout(remoteInner.ping('hi'), 'ping')).to.eventually.equal('pong:hi')

  const srcBytes = new Uint8Array([1, 2, 3, 4])
  const echoed = await makeTimeout(remoteInner.echoBuffer(srcBytes.buffer), 'echoBuffer')
  expect(Array.from(echoed)).to.deep.equal([1, 2, 3, 4])

  const xferBuf = new Uint8Array([7, 8, 9]).buffer
  const xferResult = await makeTimeout(remoteInner.transferBuffer(transfer(xferBuf)), 'transferBuffer')
  expect(xferBuf.byteLength).to.equal(0)
  expect(Array.from(new Uint8Array(xferResult))).to.deep.equal([99, 8, 9])

  const cbResult = await makeTimeout(remoteInner.callbackArg(async x => x * 2), 'callbackArg')
  expect(cbResult).to.equal(42)

  const adder = await makeTimeout(remoteInner.returnFn(10), 'returnFn')
  expect(await makeTimeout(adder(5), 'returnedFn call')).to.equal(15)

  const specials = await makeTimeout(
    remoteInner.echoSpecials({
      u: undefined,
      n: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      ninf: Number.NEGATIVE_INFINITY,
      big: 42n,
      map: new Map([['k', 7]]),
      set: new Set([3, 5]),
      err: new TypeError('inner-boom'),
    }),
    'echoSpecials',
  )
  expect('u' in specials && specials.u === undefined).to.be.true
  expect(Number.isNaN(specials.n)).to.be.true
  expect(specials.inf).to.equal(Number.POSITIVE_INFINITY)
  expect(specials.ninf).to.equal(Number.NEGATIVE_INFINITY)
  expect(specials.big).to.equal(42n)
  expect(specials.map.get('k')).to.equal(7)
  expect(specials.set.has(3) && specials.set.has(5)).to.be.true
  expect(specials.err).to.be.instanceOf(TypeError)
  expect(specials.err.message).to.equal('inner-boom')

  const nested = new MessageChannel()
  nested.port1.start()
  const nestedAckPromise = makeTimeout(remoteInner.nestedPort(nested.port2), 'nestedPort')
  nested.port1.postMessage('secret')
  await expect(nestedAckPromise).to.eventually.equal('ack:secret')
  nested.port1.close()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([10, 20]))
      controller.enqueue(new Uint8Array([30]))
      controller.close()
    },
  })
  await expect(makeTimeout(remoteInner.streamSum(stream), 'streamSum')).to.eventually.equal(60)
}

export const osraRpcOverReturnedRelayedPort = async (transport: Transport) => {
  const inner = new MessageChannel()
  expose(makeInnerApi(), { transport: inner.port1 })
  inner.port1.start()

  expose({ getPort: async () => inner.port2 }, { transport })
  const outer = await makeTimeout(
    expose<{ getPort: () => Promise<MessagePort> }>({}, { transport }),
    'outer expose',
  )

  const remotePort = await makeTimeout(outer.getPort(), 'getPort')
  const remoteInnerPromise = expose<InnerApi>({}, { transport: remotePort })
  remotePort.start()
  const remoteInner = await makeTimeout(remoteInnerPromise, 'inner expose')

  await verifyInnerRemote(remoteInner)
  remotePort.close()
  inner.port1.close()
}

export const osraRpcOverArgumentRelayedPort = async (transport: Transport) => {
  const inner = new MessageChannel()
  expose(makeInnerApi(), { transport: inner.port1 })
  inner.port1.start()

  const serverDone = new Promise<InnerApi>((resolve, reject) => {
    try {
      expose(
        {
          acceptPort: async (port: MessagePort) => {
            try {
              const innerPromise = expose<InnerApi>({}, { transport: port })
              port.start()
              resolve(await innerPromise)
            } catch (error) {
              reject(error)
              throw error
            }
          },
        },
        { transport },
      )
    } catch (error) {
      reject(error)
    }
  })

  const outer = await makeTimeout(
    expose<{ acceptPort: (port: MessagePort) => Promise<void> }>({}, { transport }),
    'outer expose arg',
  )
  await makeTimeout(outer.acceptPort(inner.port2), 'acceptPort')
  const remoteInner = await makeTimeout(serverDone, 'server inner expose')

  await verifyInnerRemote(remoteInner)
  inner.port1.close()
}

export const strictJsonPortInPortCarriesAllPayloads = async () => {
  const { left, right, emitCount } = makeStrictJsonPair()

  const inner = new MessageChannel()
  expose(makeInnerApi(), { transport: inner.port1 })
  inner.port1.start()

  expose({ getPort: async () => inner.port2 }, { transport: left })
  const outer = await makeTimeout(
    expose<{ getPort: () => Promise<MessagePort> }>({}, { transport: right }),
    'strict outer expose',
  )

  const remotePort = await makeTimeout(outer.getPort(), 'strict getPort')
  const remoteInnerPromise = expose<InnerApi>({}, { transport: remotePort })
  remotePort.start()
  const remoteInner = await makeTimeout(remoteInnerPromise, 'strict inner expose')

  await verifyInnerRemote(remoteInner)
  expect(emitCount()).to.be.greaterThan(0)
  remotePort.close()
  inner.port1.close()
}

export const twoHopPortInPortRelayOverJson = async () => {
  const linkAB = makeStrictJsonPair()
  const linkBC = makeStrictJsonPair()

  const inner = new MessageChannel()
  expose(makeInnerApi(), { transport: inner.port1 })
  inner.port1.start()

  expose({ getPort: async () => inner.port2 }, { transport: linkAB.left })
  const middleFromA = await makeTimeout(
    expose<{ getPort: () => Promise<MessagePort> }>({}, { transport: linkAB.right }),
    'hop1 expose',
  )

  expose({
    getRelayedPort: async () => middleFromA.getPort(),
  }, { transport: linkBC.left })

  const clientFromB = await makeTimeout(
    expose<{ getRelayedPort: () => Promise<MessagePort> }>({}, { transport: linkBC.right }),
    'hop2 expose',
  )

  const portAtC = await makeTimeout(clientFromB.getRelayedPort(), 'hop2 getRelayedPort')
  const remoteInnerPromise = expose<InnerApi>({}, { transport: portAtC })
  portAtC.start()
  const remoteInner = await makeTimeout(remoteInnerPromise, 'hop2 inner expose')

  await verifyInnerRemote(remoteInner)
  expect(linkAB.emitCount()).to.be.greaterThan(0)
  expect(linkBC.emitCount()).to.be.greaterThan(0)
  portAtC.close()
  inner.port1.close()
}

export const rawMessagesOverRelayedPortKeepBuffersAndSpecials = async () => {
  const { left, right } = makeStrictJsonPair()
  const channel = new MessageChannel()

  expose({ getPort: async () => channel.port2 }, { transport: left })
  const outer = await makeTimeout(
    expose<{ getPort: () => Promise<MessagePort> }>({}, { transport: right }),
    'raw port outer expose',
  )

  const received = new Promise<Record<string, unknown>>(resolve => {
    channel.port1.addEventListener('message', event => resolve(event.data as Record<string, unknown>), { once: true })
  })
  channel.port1.start()

  const remotePort = await makeTimeout(outer.getPort(), 'raw getPort')
  const bytes = new Uint8Array([11, 22, 33]).buffer
  remotePort.postMessage(
    { count: 1, ab: bytes, undef: undefined, nan: Number.NaN, big: 9n },
    [bytes],
  )
  expect(bytes.byteLength).to.equal(0)

  const msg = await makeTimeout(received, 'raw message received')
  expect(msg.count).to.equal(1)
  expect(msg.ab).to.be.instanceOf(ArrayBuffer)
  expect(Array.from(new Uint8Array(msg.ab as ArrayBuffer))).to.deep.equal([11, 22, 33])
  expect('undef' in msg && msg.undef === undefined).to.be.true
  expect(Number.isNaN(msg.nan)).to.be.true
  expect(msg.big).to.equal(9n)

  channel.port1.close()
  remotePort.close()
}

class ProtoPayload {
  constructor(
    public readonly field: unknown,
    public readonly hasOwnProto = true,
  ) {}
}

const protoModule = {
  type: 'proto-payload' as const,
  isType: (value: unknown): value is ProtoPayload => value instanceof ProtoPayload,
  box: (value: ProtoPayload, _context: RevivableContext) =>
    Object.fromEntries([
      [OSRA_BOX, 'revivable' as const],
      ['type', 'proto-payload' as const],
      ['__proto__', value.field],
    ]) as unknown as BoxBase<'proto-payload'> & Record<string, unknown>,
  revive: (value: Record<string, unknown>, _context: RevivableContext) =>
    new ProtoPayload(
      Object.hasOwn(value, '__proto__') ? value['__proto__'] : undefined,
      Object.hasOwn(value, '__proto__'),
    ),
} as const satisfies RevivableModule

const withProtoPayload = <TDefaults extends readonly RevivableModule[]>(defaults: TDefaults) =>
  [protoModule, ...defaults] as const

export const customRevivableOwnProtoOnRelayedPort = async () => {
  const { left, right } = makeStrictJsonPair()
  const inner = new MessageChannel()
  const innerApi = { echoProto: async (payload: ProtoPayload) => payload }
  expose(innerApi, { transport: inner.port1, revivableModules: withProtoPayload })
  inner.port1.start()

  expose({ getPort: async () => inner.port2 }, { transport: left })
  const outer = await makeTimeout(
    expose<{ getPort: () => Promise<MessagePort> }>({}, { transport: right }),
    'proto outer expose',
  )

  const remotePort = await makeTimeout(outer.getPort(), 'proto getPort')
  const remoteInnerPromise = expose<typeof innerApi, ReturnType<typeof withProtoPayload>>(
    {},
    { transport: remotePort, revivableModules: withProtoPayload },
  )
  remotePort.start()
  const remoteInner = await makeTimeout(remoteInnerPromise, 'proto inner expose')

  try {
    const echoed = await makeTimeout(
      remoteInner.echoProto(new ProtoPayload({ marker: 42 })),
      'echoProto',
    )
    expect(echoed).to.be.instanceOf(ProtoPayload)
    expect(echoed.hasOwnProto).to.equal(true)
    expect(echoed.field).to.deep.equal({ marker: 42 })
    expect('marker' in Object.prototype).to.equal(false)
  } finally {
    remotePort.close()
    inner.port1.close()
  }
}

export const throwingBoxMarkerRollsBackWalk = async () => {
  let committed = 0
  let rolledBack = 0
  const trackModule = {
    type: 'track-rollback' as const,
    isType: (value: unknown): value is { __track: true } =>
      typeof value === 'object' && value !== null && '__track' in value,
    box: () => {
      onBoxWalkSettled(
        () => { committed++ },
        () => { rolledBack++ },
      )
      return { [OSRA_BOX]: 'revivable' as const, type: 'track-rollback' as const }
    },
    revive: (value: unknown) => value as { __track: true },
  } as const satisfies RevivableModule

  const context: RevivableContext<readonly RevivableModule[]> = {
    transport: { isJson: true, emit: () => {}, receive: () => {} },
    remoteUuid: '00000000-0000-0000-0000-000000000000',
    sendMessage: () => {},
    revivableModules: [trackModule, ...defaultRevivableModules],
    eventTarget: new EventTarget() as RevivableContext['eventTarget'],
  }

  let reads = 0
  const evilBox = Object.defineProperty(
    { inner: { __track: true } },
    OSRA_BOX,
    {
      enumerable: true,
      get() {
        reads++
        if (reads <= 2) return 'revivable'
        throw new Error('boom-marker')
      },
    },
  )

  expect(() => withQuotedBoxes(() => recursiveBox(evilBox as never, context))).to.throw('boom-marker')
  expect(reads).to.equal(3)
  expect(committed).to.equal(0)
  expect(rolledBack).to.equal(1)
}

export const strictJsonRelayedPortPreservesIdentity = async () => {
  const { left, right } = makeStrictJsonPair()
  const inner = new MessageChannel()
  let captured: { tag: string } | undefined
  const serverOwned = { tag: 'server-owned' }
  const innerApi = {
    sameCall: async (a: { tag: string }, b: { tag: string }) => a === b,
    capture: async (value: { tag: string }) => {
      captured = value
      return true
    },
    matches: async (value: { tag: string }) => value === captured,
    roundTrip: async (value: { tag: string }) => value,
    getServerOwned: async () => identity(serverOwned),
    matchesServerOwned: async (value: { tag: string }) => value === serverOwned,
  }
  expose(innerApi, { transport: inner.port1 })
  inner.port1.start()

  expose({ getPort: async () => inner.port2 }, { transport: left })
  const outer = await makeTimeout(
    expose<{ getPort: () => Promise<MessagePort> }>({}, { transport: right }),
    'identity outer expose',
  )

  const remotePort = await makeTimeout(outer.getPort(), 'identity getPort')
  const remoteInnerPromise = expose<typeof innerApi>({}, { transport: remotePort })
  remotePort.start()
  const remote = await makeTimeout(remoteInnerPromise, 'identity inner expose')

  try {
    const clientObj = identity({ tag: 'client-owned' })
    expect(await makeTimeout(remote.sameCall(clientObj, clientObj), 'identity sameCall')).to.equal(true)
    expect(await makeTimeout(remote.capture(clientObj), 'identity capture')).to.equal(true)
    expect(await makeTimeout(remote.matches(clientObj), 'identity crossCall')).to.equal(true)
    expect(await makeTimeout(remote.roundTrip(clientObj), 'identity roundTrip')).to.equal(clientObj)

    const fromServer = await makeTimeout(remote.getServerOwned(), 'getServerOwned')
    expect(await makeTimeout(remote.getServerOwned(), 'getServerOwned second')).to.equal(fromServer)
    expect(await makeTimeout(remote.matchesServerOwned(fromServer), 'matchesServerOwned')).to.equal(true)
  } finally {
    remotePort.close()
    inner.port1.close()
  }
}
