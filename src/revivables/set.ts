import type { Capable } from '../types.js'
import type { RevivableContext, UnderlyingType, BoxBase as BoxBaseType } from './utils.js'

import { BoxBase } from './utils.js'
import { recursiveBox, recursiveRevive } from './index.js'

export const type = 'set' as const

/** Never claims a primitive, so the walker can skip this module for primitive leaves. */
export const objectsOnly = true

export type BoxedSet<T extends Set<Capable> = Set<Capable>> =
  & BoxBaseType<typeof type>
  & { values: Array<Capable> }
  & { [UnderlyingType]: T }

export const isType = (value: unknown): value is Set<unknown> =>
  value instanceof Set

export const box = <T extends Set<Capable>, T2 extends RevivableContext>(
  value: T,
  context: T2,
): BoxedSet<T> => ({
  ...BoxBase,
  type,
  values: Array.from(value, v => recursiveBox(v, context) as Capable),
}) as BoxedSet<T>

export const revive = <T extends BoxedSet, T2 extends RevivableContext>(
  value: T,
  context: T2,
): T[UnderlyingType] =>
  new Set(value.values.map(v => recursiveRevive(v, context))) as T[UnderlyingType]

const typeCheck = () => {
  const s = new Set<number>([1, 2, 3])
  const boxed = box(s, {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: Set<number> = revived
  // @ts-expect-error - wrong value type
  const wrongValue: Set<string> = revived
  // @ts-expect-error - cannot box non-Set
  box('not a set', {} as RevivableContext)
}
