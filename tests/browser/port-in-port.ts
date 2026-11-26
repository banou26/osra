import type { BoxBase, RevivableContext, RevivableModule, Transport } from '../../src/index'
import type { Message } from '../../src/types'
import type { MessageContext } from '../../src/utils/transport'

import { expect } from 'chai'

import { expose, identity, transfer } from '../../src/index'
import { defaultRevivableModules, onBoxWalkSettled, recursiveBox, recursiveRevive } from '../../src/revivables/index'
import { boxMessage } from '../../src/revivables/walk'
import { OSRA_BOX } from '../../src/types'
import { EventChannel, type EventPort } from '../../src/utils/event-channel'

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

  try {
    await verifyInnerRemote(remoteInner)
  } finally {
    remotePort.close()
    inner.port1.close()
  }
}

export const osraRpcOverArgumentRelayedPort = async (transport: Transport) => {
  const inner = new MessageChannel()
  expose(makeInnerApi(), { transport: inner.port1 })
  inner.port1.start()

  let acceptedPort: MessagePort | undefined
  const serverDone = new Promise<InnerApi>((resolve, reject) => {
    try {
      expose(
        {
          acceptPort: async (port: MessagePort) => {
            acceptedPort = port
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

  try {
    await verifyInnerRemote(remoteInner)
  } finally {
    acceptedPort?.close()
    inner.port1.close()
  }
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

  try {
    await verifyInnerRemote(remoteInner)
    expect(emitCount()).to.be.greaterThan(0)
  } finally {
    remotePort.close()
    inner.port1.close()
  }
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

  let relayedAtB: MessagePort | undefined
  expose({
    getRelayedPort: async () => {
      relayedAtB = await middleFromA.getPort()
      return relayedAtB
    },
  }, { transport: linkBC.left })

  const clientFromB = await makeTimeout(
    expose<{ getRelayedPort: () => Promise<MessagePort> }>({}, { transport: linkBC.right }),
    'hop2 expose',
  )

  const portAtC = await makeTimeout(clientFromB.getRelayedPort(), 'hop2 getRelayedPort')
  const remoteInnerPromise = expose<InnerApi>({}, { transport: portAtC })
  portAtC.start()
  const remoteInner = await makeTimeout(remoteInnerPromise, 'hop2 inner expose')

  try {
    await verifyInnerRemote(remoteInner)
    expect(linkAB.emitCount()).to.be.greaterThan(0)
    expect(linkBC.emitCount()).to.be.greaterThan(0)
  } finally {
    portAtC.close()
    relayedAtB?.close()
    inner.port1.close()
  }
}

export const rawMessagesOverRelayedPortKeepBuffersAndSpecials = async () => {
  const { left, right } = makeStrictJsonPair()
  const channel = new MessageChannel()

  expose({ getPort: async () => channel.port2 }, { transport: left })
  const outer = await makeTimeout(
    expose<{ getPort: () => Promise<MessagePort> }>({}, { transport: right }),
    'raw port outer expose',
  )

  const remotePort = await makeTimeout(outer.getPort(), 'raw getPort')
  remotePort.start()
  channel.port1.start()

  let receivedNestedAtServer: MessagePort | undefined
  let receivedNestedAtClient: MessagePort | undefined
  const localNested = new MessageChannel()
  const remoteNested = new MessageChannel()

  try {
    const serverReceived = new Promise<Record<string, unknown>>(resolve => {
      channel.port1.addEventListener('message', event => resolve(event.data as Record<string, unknown>), { once: true })
    })
    const clientBytes = new Uint8Array([11, 22, 33]).buffer
    const clientNestedAck = new Promise<string>(resolve => {
      localNested.port1.addEventListener('message', event => resolve(String(event.data)), { once: true })
    })
    localNested.port1.start()
    remotePort.postMessage(
      {
        count: 1,
        when: new Date(1_700_000_000_000),
        view: new Uint8Array([4, 5]),
        map: new Map([['a', 10]]),
        set: new Set(['x']),
        err: new TypeError('client-raw-err'),
        ab: clientBytes,
        port: localNested.port2,
        undef: undefined,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        big: 9n,
      },
      [clientBytes, localNested.port2],
    )
    expect(clientBytes.byteLength).to.equal(0)

    const msgToServer = await makeTimeout(serverReceived, 'raw message to server')
    expect(msgToServer.count).to.equal(1)
    expect(msgToServer.when).to.be.instanceOf(Date)
    expect((msgToServer.when as Date).getTime()).to.equal(1_700_000_000_000)
    expect(Array.from(msgToServer.view as Uint8Array)).to.deep.equal([4, 5])
    expect((msgToServer.map as Map<string, number>).get('a')).to.equal(10)
    expect((msgToServer.set as Set<string>).has('x')).to.be.true
    expect((msgToServer.err as TypeError).message).to.equal('client-raw-err')
    expect(Array.from(new Uint8Array(msgToServer.ab as ArrayBuffer))).to.deep.equal([11, 22, 33])
    expect('undef' in msgToServer && msgToServer.undef === undefined).to.be.true
    expect(Number.isNaN(msgToServer.nan)).to.be.true
    expect(msgToServer.inf).to.equal(Number.POSITIVE_INFINITY)
    expect(msgToServer.big).to.equal(9n)
    receivedNestedAtServer = msgToServer.port as MessagePort
    receivedNestedAtServer.postMessage('ping-server-nested')
    expect(await makeTimeout(clientNestedAck, 'nested ack client<-server')).to.equal('ping-server-nested')

    const clientReceived = new Promise<Record<string, unknown>>(resolve => {
      remotePort.addEventListener('message', event => resolve(event.data as Record<string, unknown>), { once: true })
    })
    const serverBytes = new Uint8Array([77, 88]).buffer
    const serverNestedAck = new Promise<string>(resolve => {
      remoteNested.port1.addEventListener('message', event => resolve(String(event.data)), { once: true })
    })
    remoteNested.port1.start()
    channel.port1.postMessage(
      {
        dir: 'reverse',
        when: new Date(1_700_000_123_000),
        view: new Uint8Array([9, 8]),
        map: new Map([['b', 20]]),
        set: new Set(['y']),
        err: new RangeError('server-raw-err'),
        ab: serverBytes,
        port: remoteNested.port2,
        undef: undefined,
        ninf: Number.NEGATIVE_INFINITY,
        big: 11n,
      },
      [serverBytes, remoteNested.port2],
    )

    const msgToClient = await makeTimeout(clientReceived, 'raw message to client')
    expect(msgToClient.dir).to.equal('reverse')
    expect((msgToClient.when as Date).getTime()).to.equal(1_700_000_123_000)
    expect(Array.from(msgToClient.view as Uint8Array)).to.deep.equal([9, 8])
    expect((msgToClient.map as Map<string, number>).get('b')).to.equal(20)
    expect((msgToClient.set as Set<string>).has('y')).to.be.true
    expect((msgToClient.err as RangeError).message).to.equal('server-raw-err')
    expect(Array.from(new Uint8Array(msgToClient.ab as ArrayBuffer))).to.deep.equal([77, 88])
    expect('undef' in msgToClient && msgToClient.undef === undefined).to.be.true
    expect(msgToClient.ninf).to.equal(Number.NEGATIVE_INFINITY)
    expect(msgToClient.big).to.equal(11n)
    receivedNestedAtClient = msgToClient.port as MessagePort
    receivedNestedAtClient.postMessage('ping-client-nested')
    expect(await makeTimeout(serverNestedAck, 'nested ack server<-client')).to.equal('ping-client-nested')
  } finally {
    receivedNestedAtServer?.close()
    receivedNestedAtClient?.close()
    localNested.port1.close()
    remoteNested.port1.close()
    channel.port1.close()
    remotePort.close()
  }
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

  expect(() => boxMessage(evilBox as never, context, { quoteAll: true })).to.throw('boom-marker')
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

const makeEventPortTransport = (port: EventPort<unknown>): Transport => {
  port.start()
  return {
    emit: (message: Message) => {
      port.postMessage(message)
    },
    receive: (listener: (message: Message, context: MessageContext) => void) => {
      const handler = (event: MessageEvent<unknown>) => {
        listener(event.data as Message, {})
      }
      port.addEventListener('message', handler as EventListener)
      return () => port.removeEventListener('message', handler as EventListener)
    },
  }
}

export const threeHopPortInPortRelayOverJson = async () => {
  const linkAB = makeStrictJsonPair()
  const linkBC = makeStrictJsonPair()
  const linkCD = makeStrictJsonPair()

  const inner = new MessageChannel()
  expose(makeInnerApi(), { transport: inner.port1 })
  inner.port1.start()

  expose({ getPort: async () => inner.port2 }, { transport: linkAB.left })
  const middleB = await makeTimeout(
    expose<{ getPort: () => Promise<MessagePort> }>({}, { transport: linkAB.right }),
    '3hop AB expose',
  )

  let portAtB: MessagePort | undefined
  expose({
    getRelayedPort: async () => {
      portAtB = await middleB.getPort()
      return portAtB
    },
  }, { transport: linkBC.left })
  const middleC = await makeTimeout(
    expose<{ getRelayedPort: () => Promise<MessagePort> }>({}, { transport: linkBC.right }),
    '3hop BC expose',
  )

  let portAtC: MessagePort | undefined
  expose({
    getRelayedPort: async () => {
      portAtC = await middleC.getRelayedPort()
      return portAtC
    },
  }, { transport: linkCD.left })
  const clientD = await makeTimeout(
    expose<{ getRelayedPort: () => Promise<MessagePort> }>({}, { transport: linkCD.right }),
    '3hop CD expose',
  )

  const portAtD = await makeTimeout(clientD.getRelayedPort(), '3hop getRelayedPort')
  const remoteInnerPromise = expose<InnerApi>({}, { transport: portAtD })
  portAtD.start()
  const remoteInner = await makeTimeout(remoteInnerPromise, '3hop inner expose')

  try {
    await verifyInnerRemote(remoteInner)
    expect(linkAB.emitCount()).to.be.greaterThan(0)
    expect(linkBC.emitCount()).to.be.greaterThan(0)
    expect(linkCD.emitCount()).to.be.greaterThan(0)
  } finally {
    portAtD.close()
    portAtC?.close()
    portAtB?.close()
    inner.port1.close()
  }
}

export const threeLayerNestedQuotedBoxesRoundTrip = async () => {
  const context: RevivableContext<readonly RevivableModule[]> = {
    transport: { isJson: true, emit: () => {}, receive: () => {} },
    remoteUuid: '00000000-0000-0000-0000-000000000000',
    sendMessage: () => {},
    revivableModules: defaultRevivableModules,
    eventTarget: new EventTarget() as RevivableContext['eventTarget'],
  }

  const input = {
    when: new Date(1_700_000_000_000),
    bytes: new Uint8Array([4, 5, 6]),
    userQuoted: { [OSRA_BOX]: 'quoted' as const, box: 'revivable' as const, value: { k: 7 } },
  }

  const layer0 = recursiveBox(input, context) as unknown as Record<string, unknown>
  const layer1 = boxMessage(layer0 as never, context, { quoteAll: true }) as unknown as Record<string, unknown>
  const layer2 = boxMessage(layer1 as never, context, { quoteAll: true }) as unknown as Record<string, unknown>
  const layer3 = boxMessage(layer2 as never, context, { quoteAll: true }) as unknown as Record<string, unknown>

  const whenL3 = layer3.when as Record<string, unknown>
  expect(whenL3[OSRA_BOX]).to.equal('quoted')
  expect(whenL3.box).to.equal('quoted')
  const whenL2 = whenL3.value as Record<string, unknown>
  expect(OSRA_BOX in whenL2).to.equal(false)
  expect(whenL2.box).to.equal('quoted')
  const whenL1 = whenL2.value as Record<string, unknown>
  expect(OSRA_BOX in whenL1).to.equal(false)
  expect(whenL1.box).to.equal('revivable')

  const uqL3 = layer3.userQuoted as Record<string, unknown>
  expect(uqL3[OSRA_BOX]).to.equal('quoted')
  expect(uqL3.box).to.equal('quoted')
  const uqL2 = uqL3.value as Record<string, unknown>
  expect(uqL2.box).to.equal('quoted')
  const uqL1 = uqL2.value as Record<string, unknown>
  expect(uqL1.box).to.equal('quoted')
  const uqL0 = uqL1.value as Record<string, unknown>
  expect(uqL0.box).to.equal('quoted')
  expect((uqL0.value as Record<string, unknown>).box).to.equal('revivable')

  const unquoted2 = recursiveRevive(layer3 as never, context) as unknown
  const unquoted1 = recursiveRevive(unquoted2 as never, context) as unknown
  const unquoted0 = recursiveRevive(unquoted1 as never, context) as unknown
  const finalValue = recursiveRevive(unquoted0 as never, context) as unknown as typeof input

  expect(finalValue.when).to.be.instanceOf(Date)
  expect(finalValue.when.getTime()).to.equal(1_700_000_000_000)
  expect(Array.from(finalValue.bytes)).to.deep.equal([4, 5, 6])
  expect(finalValue.userQuoted).to.deep.equal({
    [OSRA_BOX]: 'quoted',
    box: 'revivable',
    value: { k: 7 },
  })
}

export const circularBoxUnderQuotingThrowsAndRollsBack = async () => {
  let committed = 0
  let rolledBack = 0
  const trackModule = {
    type: 'track-circular-rollback' as const,
    isType: (value: unknown): value is { __track: true } =>
      typeof value === 'object' && value !== null && '__track' in value,
    box: () => {
      onBoxWalkSettled(
        () => { committed++ },
        () => { rolledBack++ },
      )
      return { [OSRA_BOX]: 'revivable' as const, type: 'track-circular-rollback' as const }
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

  const circularRevivable: Record<string, unknown> = {
    [OSRA_BOX]: 'revivable',
    type: 'custom-cycle',
    tracked: { __track: true },
  }
  circularRevivable.self = circularRevivable

  expect(() => boxMessage(circularRevivable as never, context, { quoteAll: true })).to.throw(
    TypeError,
    /circular structure/,
  )
  expect(committed).to.equal(0)
  expect(rolledBack).to.equal(1)

  const circularQuoted: Record<string, unknown> = {
    [OSRA_BOX]: 'quoted',
    box: 'revivable',
    value: {
      tracked: { __track: true },
    },
  }
  ;(circularQuoted.value as Record<string, unknown>).self = circularQuoted

  expect(() => boxMessage(circularQuoted as never, context, { quoteAll: true })).to.throw(
    TypeError,
    /circular structure/,
  )
  expect(committed).to.equal(0)
  expect(rolledBack).to.equal(2)
}

export const userBoxShapedObjectsPreserved = async (transport: Transport) => {
  const api = { echo: async (value: unknown) => value }
  expose(api, { transport })
  const remote = await expose<typeof api>({}, { transport })

  const plainQuoted = { [OSRA_BOX]: 'quoted', box: 'revivable', value: { a: 1 } }
  expect(await makeTimeout(remote.echo(plainQuoted), 'plainQuoted')).to.deep.equal(plainQuoted)

  const quotedWithExtra = { [OSRA_BOX]: 'quoted', box: 'revivable', value: { a: 1 }, extra: 'keep' }
  expect(await makeTimeout(remote.echo(quotedWithExtra), 'quotedWithExtra')).to.deep.equal(quotedWithExtra)

  const nestedQuoted = { [OSRA_BOX]: 'quoted', box: 'quoted', value: { box: 'revivable', value: { a: 2 } } }
  expect(await makeTimeout(remote.echo(nestedQuoted), 'nestedQuoted')).to.deep.equal(nestedQuoted)

  const customProto = Object.assign(Object.create({ inherited: 'proto' }), {
    [OSRA_BOX]: 'quoted',
    box: 'revivable',
    value: { a: 3 },
  })
  const echoedProto = await makeTimeout(remote.echo(customProto), 'customProto') as Record<string, unknown>
  expect(echoedProto[OSRA_BOX]).to.equal('quoted')
  expect(echoedProto.box).to.equal('revivable')
  expect(echoedProto.value).to.deep.equal({ a: 3 })
}

export const relayedPortPreservesUserBoxShapedObjects = async () => {
  const { left, right } = makeStrictJsonPair()
  const inner = new MessageChannel()
  const innerApi = { echo: async (value: unknown) => value }
  expose(innerApi, { transport: inner.port1 })
  inner.port1.start()

  expose({ getPort: async () => inner.port2 }, { transport: left })
  const outer = await makeTimeout(
    expose<{ getPort: () => Promise<MessagePort> }>({}, { transport: right }),
    'user-box outer expose',
  )
  const remotePort = await makeTimeout(outer.getPort(), 'user-box getPort')
  const remoteInnerPromise = expose<typeof innerApi>({}, { transport: remotePort })
  remotePort.start()
  const remote = await makeTimeout(remoteInnerPromise, 'user-box inner expose')

  const rawLink = makeStrictJsonPair()
  const rawChannel = new MessageChannel()
  expose({ getPort: async () => rawChannel.port2 }, { transport: rawLink.left })
  const rawOuter = await makeTimeout(
    expose<{ getPort: () => Promise<MessagePort> }>({}, { transport: rawLink.right }),
    'user-box raw outer expose',
  )
  const rawRemotePort = await makeTimeout(rawOuter.getPort(), 'user-box raw getPort')
  rawChannel.port1.start()
  rawRemotePort.start()

  try {
    const plainQuoted = { [OSRA_BOX]: 'quoted', box: 'revivable', value: { a: 1 } }
    expect(await makeTimeout(remote.echo(plainQuoted), 'relayed plainQuoted')).to.deep.equal(plainQuoted)

    const quotedWithExtra = { [OSRA_BOX]: 'quoted', box: 'revivable', value: { a: 1 }, extra: 'keep' }
    expect(await makeTimeout(remote.echo(quotedWithExtra), 'relayed quotedWithExtra')).to.deep.equal(quotedWithExtra)

    const fakeRevivable = { [OSRA_BOX]: 'revivable', type: 'date', value: 0 }
    const serverGot = new Promise<unknown>(resolve => {
      rawChannel.port1.addEventListener('message', event => resolve((event as MessageEvent).data), { once: true })
    })
    rawRemotePort.postMessage({ fakeRevivable, plainQuoted, quotedWithExtra })
    expect(await makeTimeout(serverGot, 'raw relayed user boxes client->server')).to.deep.equal({
      fakeRevivable,
      plainQuoted,
      quotedWithExtra,
    })

    const clientGot = new Promise<unknown>(resolve => {
      rawRemotePort.addEventListener('message', event => resolve((event as MessageEvent).data), { once: true })
    })
    rawChannel.port1.postMessage({ fakeRevivable, plainQuoted, quotedWithExtra })
    expect(await makeTimeout(clientGot, 'raw relayed user boxes server->client')).to.deep.equal({
      fakeRevivable,
      plainQuoted,
      quotedWithExtra,
    })
  } finally {
    rawRemotePort.close()
    rawChannel.port1.close()
    remotePort.close()
    inner.port1.close()
  }
}

export const quotedTransferOverEventPortThroughCloneChannel = async () => {
  // 1-hop: EventChannel inside structured-clone MessageChannel
  const outer1 = new MessageChannel()
  const inner1 = new EventChannel<unknown, unknown>()
  const api = {
    takeArrayBuffer: async (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)),
    takeDataView: async (view: DataView) => [view.byteLength, view.getUint8(0)],
  }
  expose(api, { transport: makeEventPortTransport(inner1.port1) })
  expose({ getPort: async () => inner1.port2 as unknown as MessagePort }, { transport: outer1.port1 })
  const client1 = await makeTimeout(
    expose<{ getPort: () => Promise<MessagePort> }>({}, { transport: outer1.port2 }),
    'eventPort 1-hop outer',
  )
  const port1 = (await makeTimeout(client1.getPort(), 'eventPort 1-hop getPort')) as unknown as EventPort<unknown>
  const remote1 = await makeTimeout(
    expose<typeof api>({}, { transport: makeEventPortTransport(port1) }),
    'eventPort 1-hop inner',
  )

  // 2-hop: EventChannel relayed across two structured-clone MessageChannels
  const hopAB = new MessageChannel()
  const hopBC = new MessageChannel()
  const inner2 = new EventChannel<unknown, unknown>()
  expose(api, { transport: makeEventPortTransport(inner2.port1) })
  expose({ getPort: async () => inner2.port2 as unknown as MessagePort }, { transport: hopAB.port1 })
  const mid = await makeTimeout(
    expose<{ getPort: () => Promise<MessagePort> }>({}, { transport: hopAB.port2 }),
    'eventPort 2-hop AB',
  )
  let portAtB: EventPort<unknown> | undefined
  expose({
    getRelayedPort: async () => {
      portAtB = (await mid.getPort()) as unknown as EventPort<unknown>
      return portAtB as unknown as MessagePort
    },
  }, { transport: hopBC.port1 })
  const client2 = await makeTimeout(
    expose<{ getRelayedPort: () => Promise<MessagePort> }>({}, { transport: hopBC.port2 }),
    'eventPort 2-hop BC',
  )
  const port2 = (await makeTimeout(client2.getRelayedPort(), 'eventPort 2-hop getRelayedPort')) as unknown as EventPort<unknown>
  const remote2 = await makeTimeout(
    expose<typeof api>({}, { transport: makeEventPortTransport(port2) }),
    'eventPort 2-hop inner',
  )

  try {
    const ab1 = new Uint8Array([1, 2, 3, 4]).buffer
    expect(await makeTimeout(remote1.takeArrayBuffer(transfer(ab1)), '1-hop transfer ArrayBuffer')).to.deep.equal([1, 2, 3, 4])
    expect(ab1.byteLength).to.equal(0)

    const dvBuf1 = new Uint8Array(32).fill(17).buffer
    expect(await makeTimeout(remote1.takeDataView(transfer(new DataView(dvBuf1))), '1-hop transfer DataView')).to.deep.equal([32, 17])
    expect(dvBuf1.byteLength).to.equal(0)

    const ab2 = new Uint8Array([5, 6, 7, 8]).buffer
    expect(await makeTimeout(remote2.takeArrayBuffer(transfer(ab2)), '2-hop transfer ArrayBuffer')).to.deep.equal([5, 6, 7, 8])
    expect(ab2.byteLength).to.equal(0)
  } finally {
    port1.close()
    inner1.port1.close()
    outer1.port1.close()
    outer1.port2.close()
    port2.close()
    portAtB?.close()
    inner2.port1.close()
    hopAB.port1.close()
    hopAB.port2.close()
    hopBC.port1.close()
    hopBC.port2.close()
  }
}

export const abortSignalDeferredBoxShapedReasonNoDoubleRevive = async (transport: Transport) => {
  let resolveReason!: (reason: unknown) => void
  const api = {
    watch: async (signal: AbortSignal) => {
      signal.addEventListener('abort', () => resolveReason(signal.reason), { once: true })
    },
  }

  expose(api, { transport })
  const remote = await expose<typeof api>({}, { transport })

  const quotedCtrl = new AbortController()
  const quotedDone = new Promise<unknown>(resolve => { resolveReason = resolve })
  await makeTimeout(remote.watch(quotedCtrl.signal), 'watch quoted signal')
  const quotedReason = { [OSRA_BOX]: 'quoted', box: 'revivable', value: { a: 1 } }
  quotedCtrl.abort(quotedReason)
  expect(await makeTimeout(quotedDone, 'quoted abort reason')).to.deep.equal(quotedReason)

  if ('isJson' in transport && transport.isJson === true) {
    const revivableCtrl = new AbortController()
    const revivableDone = new Promise<unknown>(resolve => { resolveReason = resolve })
    await makeTimeout(remote.watch(revivableCtrl.signal), 'watch revivable signal')
    const fakeRevivableReason = { [OSRA_BOX]: 'revivable', type: 'date', value: 0 }
    revivableCtrl.abort(fakeRevivableReason)
    const received = await makeTimeout(revivableDone, 'revivable abort reason')
    expect(received).to.not.be.instanceOf(Date)
    expect(received).to.deep.equal(fakeRevivableReason)
  }
}

export const clonableAndTransferableRejectOnJsonAndRawPort = async () => {
  const { left, right } = makeStrictJsonPair()
  const channel = new MessageChannel()
  const innerApi = { echo: async (value: unknown) => value }

  expose({ echo: innerApi.echo, getPort: async () => channel.port2 }, { transport: left })
  const remote = await makeTimeout(
    expose<{ echo: (value: unknown) => Promise<unknown>, getPort: () => Promise<MessagePort> }>({}, { transport: right }),
    'json fallback outer',
  )

  await expect(remote.echo(new File(['a'], 'a.txt'))).to.eventually.be.rejectedWith(
    TypeError,
    /only supported on structured-clone transports/,
  )
  await expect(remote.echo(/abc/i)).to.eventually.be.rejectedWith(
    TypeError,
    /only supported on structured-clone transports/,
  )
  await expect(remote.echo(new DataView(new ArrayBuffer(4)))).to.eventually.be.rejectedWith(
    TypeError,
    /only supported on structured-clone transports/,
  )
  await expect(remote.echo(new Blob(['a']))).to.eventually.be.rejectedWith(
    TypeError,
    /only supported on structured-clone transports/,
  )

  const remotePort = await makeTimeout(remote.getPort(), 'json fallback getPort')
  remotePort.start()
  channel.port1.start()

  try {
    const messageErrorPromise = new Promise<Event>(resolve => {
      remotePort.addEventListener('messageerror', event => resolve(event), { once: true })
    })
    const serverAfterError = new Promise<unknown>(resolve => {
      channel.port1.addEventListener('message', event => resolve((event as MessageEvent).data), { once: true })
    })
    remotePort.postMessage(new Blob(['bad-client-to-server']))
    await makeTimeout(messageErrorPromise, 'client remotePort messageerror on Blob')
    remotePort.postMessage('after-error')
    expect(await makeTimeout(serverAfterError, 'subsequent message after Blob error')).to.equal('after-error')

    const clientAfterError = new Promise<unknown>(resolve => {
      remotePort.addEventListener('message', event => resolve((event as MessageEvent).data), { once: true })
    })
    channel.port1.postMessage(new Blob(['bad-server-to-client']))
    channel.port1.postMessage('still-alive')
    expect(await makeTimeout(clientAfterError, 'subsequent server->client message after Blob error')).to.equal('still-alive')
  } finally {
    remotePort.close()
    channel.port1.close()
  }
}

export const nestedConnectionsMoveTransfersThroughThreeQuoteLayers = async () => {
  // Four nested connections: each inner one runs over an EventPort the next outer one relays, so the
  // innermost transfer box reaches the outer MessageChannel post under three quote layers.
  const api = { take: async (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)) }
  const outer = new MessageChannel()
  const inner = Array.from({ length: 3 }, () => new EventChannel<unknown, unknown>())
  expose(api, { transport: makeEventPortTransport(inner[2]!.port1) })
  for (let i = 2; i > 0; i--) {
    const next = inner[i]!.port2
    expose({ getPort: async () => next as unknown as MessagePort }, { transport: makeEventPortTransport(inner[i - 1]!.port1) })
  }
  expose({ getPort: async () => inner[0]!.port2 as unknown as MessagePort }, { transport: outer.port1 })

  const clientPorts: EventPort<unknown>[] = []
  try {
    let transport: Transport = outer.port2
    for (let level = 0; level < 3; level++) {
      const client = await makeTimeout(
        expose<{ getPort: () => Promise<MessagePort> }>({}, { transport }),
        `nested level ${level}`,
      )
      const port = (await makeTimeout(client.getPort(), `nested level ${level} getPort`)) as unknown as EventPort<unknown>
      clientPorts.push(port)
      transport = makeEventPortTransport(port)
    }
    const remote = await makeTimeout(expose<typeof api>({}, { transport }), 'nested innermost')

    const buf = new Uint8Array([1, 2, 3, 4]).buffer
    expect(await makeTimeout(remote.take(transfer(buf)), 'nested transfer')).to.deep.equal([1, 2, 3, 4])
    expect(buf.byteLength).to.equal(0)

    const copied = new Uint8Array([5, 6]).buffer
    expect(await makeTimeout(remote.take(copied), 'nested copy')).to.deep.equal([5, 6])
    expect(copied.byteLength).to.equal(2)
  } finally {
    for (const port of clientPorts) port.close()
    for (const channel of inner) channel.port1.close()
    outer.port1.close()
    outer.port2.close()
  }
}

const fakeDate = () => ({ [OSRA_BOX]: 'revivable', type: 'date', ISOString: '1970-01-01T00:00:00.000Z' })
const fakeQuoted = () => ({ [OSRA_BOX]: 'quoted', box: 'revivable', value: { type: 'date', ISOString: '1970-01-01T00:00:00.000Z' } })

export const userRevivableShapedObjectsPreservedAtEveryEntryPoint = async (transport: Transport) => {
  const payload = () => ({ date: fakeDate(), quoted: fakeQuoted(), list: [fakeDate()] })
  let receivedArg: unknown
  const api = {
    initValue: payload(),
    echo: async (value: unknown) => {
      receivedArg = value
      return value
    },
    later: async () => ({ result: Promise.resolve(payload()) }),
    watch: async (signal: AbortSignal) =>
      new Promise<unknown>(resolve => signal.addEventListener('abort', () => resolve(signal.reason), { once: true })),
  }
  expose(api, { transport })
  const remote = await makeTimeout(expose<typeof api>({}, { transport }), 'entry points expose')

  expect(remote.initValue, 'init').to.deep.equal(payload())

  const echoed = await makeTimeout(remote.echo(payload()), 'echo')
  expect(receivedArg, 'function argument').to.deep.equal(payload())
  expect(echoed, 'function result').to.deep.equal(payload())

  const { result } = await makeTimeout(remote.later(), 'later')
  expect(await makeTimeout(result, 'later result'), 'protocol port').to.deep.equal(payload())

  const controller = new AbortController()
  const reason = remote.watch(controller.signal)
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort(payload())
  expect(await makeTimeout(reason, 'abort reason'), 'abort reason').to.deep.equal(payload())
}

export const boxingAnOsraBoxTwiceLeavesItUntouched = async () => {
  const context: RevivableContext<readonly RevivableModule[]> = {
    transport: { isJson: true, emit: () => {}, receive: () => {} },
    remoteUuid: '00000000-0000-0000-0000-000000000000',
    sendMessage: () => {},
    revivableModules: defaultRevivableModules,
    eventTarget: new EventTarget() as RevivableContext['eventTarget'],
  }
  const once = recursiveBox({ when: new Date(0) }, context) as unknown as { when: object }
  const twice = recursiveBox(once as never, context) as unknown as { when: object }
  expect(twice.when).to.equal(once.when)
  const revived = recursiveRevive(twice as never, context) as unknown as { when: Date }
  expect(revived.when).to.be.instanceOf(Date)

  const foreign = recursiveBox({ when: fakeDate() } as never, context) as unknown as { when: Record<string, unknown> }
  expect(foreign.when[OSRA_BOX]).to.equal('quoted')
  expect(recursiveRevive(foreign as never, context)).to.deep.equal({ when: fakeDate() })
}
