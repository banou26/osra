import type { Transport } from '../../src'
import type { RevivableContext, RevivableModule } from '../../src/index'

import { expect } from 'chai'

import { expose, BoxBase } from '../../src/index'

class Point {
  constructor(public x: number, public y: number) {}
  distance() {
    return Math.sqrt(this.x ** 2 + this.y ** 2)
  }
}

const pointModule = {
  type: 'point' as const,
  isType: (value: unknown): value is Point => value instanceof Point,
  box: (value: Point, _context: RevivableContext) => ({
    ...BoxBase,
    type: 'point' as const,
    x: value.x,
    y: value.y,
  }),
  revive: (value: { x: number; y: number }, _context: RevivableContext) =>
    new Point(value.x, value.y),
} as const satisfies RevivableModule

const withPoint = <TDefaults extends readonly RevivableModule[]>(defaults: TDefaults) =>
  [pointModule, ...defaults] as const

export const userPoint = async (transport: Transport) => {
  const value = async (p: Point) => {
    if (!(p instanceof Point)) {
      throw new Error('received value is not a Point instance')
    }
    return new Point(p.x * 2, p.y * 2)
  }
  expose(value, { transport, revivableModules: withPoint })

  const test = await expose<typeof value, ReturnType<typeof withPoint>>(
    {},
    { transport, revivableModules: withPoint },
  )

  const result = await test(new Point(3, 4))
  expect(result).to.be.instanceOf(Point)
  expect(result.x).to.equal(6)
  expect(result.y).to.equal(8)
  expect(result.distance()).to.equal(10)
}

export const userPointReturn = async (transport: Transport) => {
  const value = async () => new Point(1, 2)
  expose(value, { transport, revivableModules: withPoint })

  const test = await expose<typeof value, ReturnType<typeof withPoint>>(
    {},
    { transport, revivableModules: withPoint },
  )

  const result = await test()
  expect(result).to.be.instanceOf(Point)
  expect(result.x).to.equal(1)
  expect(result.y).to.equal(2)
}

export const userPointDefaultsStillWork = async (transport: Transport) => {
  const value = async () => new Date('2026-04-08T00:00:00.000Z')
  expose(value, { transport, revivableModules: withPoint })

  const test = await expose<typeof value, ReturnType<typeof withPoint>>(
    {},
    { transport, revivableModules: withPoint },
  )

  const result = await test()
  expect(result).to.be.instanceOf(Date)
  expect(result.toISOString()).to.equal('2026-04-08T00:00:00.000Z')
}

/** The function module boxes a call payload eagerly, and the port it posts on must not walk the very
 *  same payload again. A rebuilt copy is indistinguishable from the original once it arrives, so the
 *  only way to see the second walk is from inside the walk itself: a module whose `isType` counts how
 *  many times it is offered a value carrying the probe marker. */
let probeVisits = 0
/** Claims nothing, ever: it is here to be OFFERED values, not to box them. */
type NeverClaimed = { probeNeverClaimed: true }
const walkProbe = {
  type: 'walk-probe' as const,
  isType: (value: unknown): value is NeverClaimed => {
    if (value !== null && typeof value === 'object' && (value as { probe?: string }).probe === 'walk') {
      probeVisits++
    }
    return false
  },
  box: (_value: NeverClaimed, _context: RevivableContext) => ({ ...BoxBase, type: 'walk-probe' as const }),
  revive: (_value: { type: 'walk-probe' }, _context: RevivableContext): NeverClaimed => ({ probeNeverClaimed: true }),
} as const satisfies RevivableModule

const withWalkProbe = <TDefaults extends readonly RevivableModule[]>(defaults: TDefaults) =>
  [walkProbe, ...defaults] as const

export const callArgsAreWalkedOnce = async (transport: Transport) => {
  probeVisits = 0
  const value = { take: async (received: { probe: string }) => received.probe }
  expose(value, { transport, revivableModules: withWalkProbe })

  const remote = await expose<typeof value, ReturnType<typeof withWalkProbe>>(
    {},
    { transport, revivableModules: withWalkProbe },
  )

  expect(await remote.take({ probe: 'walk' })).to.equal('walk')
  expect(probeVisits).to.equal(1)
}
