import type { RevivableContext } from './utils.js'

import { BoxBase } from './utils.js'

export const type = 'date' as const

/** Never claims a primitive, so the walker can skip this module for primitive leaves. */
export const objectsOnly = true

export const isType = (value: unknown): value is Date =>
  value instanceof Date

export const box = <T extends Date, T2 extends RevivableContext>(
  value: T,
  _context: T2
) => ({
  ...BoxBase,
  type,
  ISOString: value.toISOString()
})

export const revive = <T extends ReturnType<typeof box>, T2 extends RevivableContext>(
  value: T,
  _context: T2
) => new Date(value.ISOString)

const typeCheck = () => {
  const boxed = box(new Date(), {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: Date = revived
  // @ts-expect-error - not a Date
  const notDate: string = revived
  // @ts-expect-error - cannot box non-Date
  box('not a date', {} as RevivableContext)
}
