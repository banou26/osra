import type { RevivableContext } from './utils.js'

import { BoxBase } from './utils.js'

export const type = 'headers' as const

/** Never claims a primitive, so the walker can skip this module for primitive leaves. */
export const objectsOnly = true

export const isType = (value: unknown): value is Headers =>
  value instanceof Headers

export const box = <T extends Headers, T2 extends RevivableContext>(
  value: T,
  _context: T2
) => ({
  ...BoxBase,
  type,
  entries: [...value.entries()]
})

export const revive = <T extends ReturnType<typeof box>, T2 extends RevivableContext>(
  value: T,
  _context: T2
): Headers => {
  return new Headers(value.entries)
}

const typeCheck = () => {
  const boxed = box(new Headers(), {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: Headers = revived
  // @ts-expect-error - not a Headers
  const notHeaders: string = revived
  // @ts-expect-error - cannot box non-Headers
  box('not a header', {} as RevivableContext)
}
