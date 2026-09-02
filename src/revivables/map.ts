import type { Capable } from '../types.js'
import type { RevivableContext, UnderlyingType, BoxBase as BoxBaseType } from './utils.js'

import { BoxBase } from './utils.js'
import { recursiveBox, recursiveRevive } from './index.js'

export const type = 'map' as const

/** Never claims a primitive, so the walker can skip this module for primitive leaves. */
export const objectsOnly = true

export type BoxedMap<T extends Map<Capable, Capable> = Map<Capable, Capable>> =
  & BoxBaseType<typeof type>
  & { entries: Array<[Capable, Capable]> }
  & { [UnderlyingType]: T }

// `Map<unknown, unknown>` (rather than `Map<Capable, Capable>`) breaks the Capable ↔ defaultRevivableModules ↔ this module type cycle
export const isType = (value: unknown): value is Map<unknown, unknown> =>
  value instanceof Map

export const box = <T extends Map<Capable, Capable>, T2 extends RevivableContext>(
  value: T,
  context: T2,
): BoxedMap<T> => ({
  ...BoxBase,
  type,
  entries: Array.from(value, ([k, v]): [Capable, Capable] =>
    [recursiveBox(k, context) as Capable, recursiveBox(v, context) as Capable]),
}) as BoxedMap<T>

export const revive = <T extends BoxedMap, T2 extends RevivableContext>(
  value: T,
  context: T2,
): T[UnderlyingType] =>
  new Map(value.entries.map(([k, v]) => [
    recursiveRevive(k, context),
    recursiveRevive(v, context),
  ])) as T[UnderlyingType]

const typeCheck = () => {
  const m = new Map<string, number>([['a', 1]])
  const boxed = box(m, {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: Map<string, number> = revived
  // @ts-expect-error - wrong value type
  const wrongValue: Map<string, string> = revived
  // @ts-expect-error - cannot box non-Map
  box('not a map', {} as RevivableContext)
}
