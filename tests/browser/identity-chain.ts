import type { Transport } from '../../src'
import type { Message } from '../../src/types'

import { expect } from 'chai'

import { expose, identity } from '../../src/index'

type Marked = { tag: string }

type ChainApi = {
  get: () => Promise<Marked>
  /** One boolean per hop, nearest first: did that context resolve the value
   *  to the exact reference it handed out, all the way down to the origin. */
  check: (value: Marked) => Promise<boolean[]>
  echo: (value: Marked) => Promise<Marked>
}

type Pair = readonly [Transport, Transport]

const structuredPair = (): Pair => {
  const { port1, port2 } = new MessageChannel()
  return [port1, port2]
}

const jsonPair = (): Pair => {
  const { port1, port2 } = new MessageChannel()
  const side = (port: MessagePort): Transport => ({
    isJson: true,
    receive: (listener: (message: Message, context: Record<string, never>) => void) => {
      port.addEventListener('message', event => {
        listener(JSON.parse((event as MessageEvent).data as string) as Message, {})
      })
      port.start()
    },
    emit: (message: Message) => port.postMessage(JSON.stringify(message)),
  })
  return [side(port1), side(port2)]
}

/** A line of `length` contexts, each connected only to its neighbours. The
 *  returned api lives in the far end, so every call walks the whole line. */
const buildChain = async (length: number, pair: () => Pair) => {
  const marker: Marked = { tag: 'origin' }
  let api: ChainApi = {
    get: async () => identity(marker),
    check: async (value: Marked) => [value === marker],
    echo: async (value: Marked) => value,
  }

  for (let hop = 1; hop < length; hop++) {
    const [left, right] = pair()
    expose(api, { transport: left })
    const upstream = await expose<ChainApi>({}, { transport: right })
    let handedOut: Marked | undefined
    api = {
      get: async () => (handedOut = await upstream.get()),
      check: async (value: Marked) => [value === handedOut, ...await upstream.check(value)],
      echo: async (value: Marked) => upstream.echo(value),
    }
  }

  return { marker, farEnd: api }
}

const chainKeepsIdentity = async (pair: () => Pair) => {
  const { farEnd } = await buildChain(5, pair)

  const value = await farEnd.get()
  const hops = await farEnd.check(value)
  expect(hops).to.have.lengthOf(5)
  expect(hops).to.deep.equal([true, true, true, true, true])
}

const chainIsStableAcrossCalls = async (pair: () => Pair) => {
  const { farEnd } = await buildChain(4, pair)

  const first = await farEnd.get()
  const second = await farEnd.get()
  expect(first).to.equal(second)
}

const chainReturnsTheFarEndsOwnValue = async (pair: () => Pair) => {
  const { farEnd } = await buildChain(4, pair)

  const mine: Marked = { tag: 'far' }
  const echoed = await farEnd.echo(identity(mine))
  expect(echoed).to.equal(mine)
}

/** One value, two peers on separate connections: each gets its own local value, and each side
 *  resolves an id through its own connection rather than through anything realm-wide. */
export const identityToTwoPeersKeepsEachSideSeparate = async () => {
  const [a1, a2] = structuredPair()
  const [b1, b2] = structuredPair()

  const marker: Marked = { tag: 'origin' }
  const origin = {
    get: async () => identity(marker),
    isOriginal: async (value: Marked) => value === marker,
  }
  expose(origin, { transport: a1 })
  expose(origin, { transport: b1 })

  const peerA = await expose<typeof origin>({}, { transport: a2 })
  const peerB = await expose<typeof origin>({}, { transport: b2 })

  const fromA = await peerA.get()
  const fromB = await peerB.get()
  expect(fromA).to.not.equal(fromB)
  expect(fromA).to.not.equal(marker)

  expect(await peerA.isOriginal(fromA)).to.equal(true)
  expect(await peerB.isOriginal(fromB)).to.equal(true)
}

export const identityAcrossFiveContexts = () => chainKeepsIdentity(structuredPair)
export const identityAcrossFiveContextsJson = () => chainKeepsIdentity(jsonPair)
export const identityStableAcrossCalls = () => chainIsStableAcrossCalls(structuredPair)
export const identityStableAcrossCallsJson = () => chainIsStableAcrossCalls(jsonPair)
export const identityRoundTripsBackToTheFarEnd = () => chainReturnsTheFarEndsOwnValue(structuredPair)
export const identityRoundTripsBackToTheFarEndJson = () => chainReturnsTheFarEndsOwnValue(jsonPair)

/** A real second realm, and a second copy of osra: the page runs the source bundle while the worker
 *  imports the published build, so this is the wire protocol being exercised, not one module
 *  instance recognising its own objects. */
type WorkerApi = {
  echo: (value: Marked) => Promise<Marked>
  hold: (value: Marked) => Promise<void>
  isHeld: (value: Marked) => Promise<boolean>
}

const workerSource = () => `
  import('${new URL('/build/index.js', location.href).href}').then(({ expose }) => {
    let held
    expose(
      {
        echo: async (value) => value,
        hold: async (value) => { held = value },
        isHeld: async (value) => value === held,
      },
      { transport: globalThis },
    )
  })
`

export const identityRoundTripsThroughAWorker = async () => {
  const url = URL.createObjectURL(new Blob([workerSource()], { type: 'application/javascript' }))
  const worker = new Worker(url, { type: 'module' })
  try {
    const remote = await expose<WorkerApi>({}, { transport: worker })

    const mine: Marked = identity({ tag: 'page' })
    expect(await remote.echo(mine)).to.equal(mine)

    await remote.hold(mine)
    expect(await remote.isHeld(mine)).to.equal(true)
  } finally {
    worker.terminate()
    URL.revokeObjectURL(url)
  }
}
