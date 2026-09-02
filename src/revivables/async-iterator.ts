import type { Capable } from '../types.js'
import type { RevivableContext, BoxBase as BoxBaseType } from './utils.js'

import { BoxBase } from './utils.js'
import { box as boxFunction, revive as reviveFunction, BoxedFunction } from './function.js'

export const type = 'asyncIterator' as const

/** Never claims a primitive, so the walker can skip this module for primitive leaves. */
export const objectsOnly = true

type AnyAsyncIterable = { [Symbol.asyncIterator]: () => AsyncIterator<unknown> }

export type BoxedAsyncIterator =
  & BoxBaseType<typeof type>
  & {
    next: BoxedFunction
    return: BoxedFunction
    throw: BoxedFunction
  }

export const isType = (value: unknown): value is AnyAsyncIterable => {
  if (!value || typeof value !== 'object') return false
  // ReadableStream is async-iterable on some platforms but has its own revivable
  if (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) return false
  return typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function'
}

export const box = <T extends AnyAsyncIterable, T2 extends RevivableContext>(
  value: T,
  context: T2,
): BoxedAsyncIterator => {
  const iterator = value[Symbol.asyncIterator]()
  return {
    ...BoxBase,
    type,
    next: boxFunction(((arg?: Capable) => iterator.next(arg)) as never, context) as unknown as BoxedFunction,
    return: boxFunction(((arg?: Capable) =>
      iterator.return?.(arg) ?? Promise.resolve({ done: true as const, value: arg })) as never, context) as unknown as BoxedFunction,
    throw: boxFunction(((error?: Capable) =>
      iterator.throw?.(error) ?? Promise.reject(error)) as never, context) as unknown as BoxedFunction,
  }
}

export const revive = <T extends BoxedAsyncIterator, T2 extends RevivableContext>(
  value: T,
  context: T2,
): AsyncIterableIterator<Capable> => {
  const next = reviveFunction(value.next, context)
  const returnRpc = reviveFunction(value.return, context)
  const throwRpc = reviveFunction(value.throw, context)
  const iterator: AsyncIterableIterator<Capable> = {
    next: (...args: [] | [unknown]) =>
      next(...args as Capable[]) as Promise<IteratorResult<Capable>>,
    return: (arg?: unknown) =>
      returnRpc(arg as Capable) as Promise<IteratorResult<Capable>>,
    throw: (error?: unknown) =>
      throwRpc(error as Capable) as Promise<IteratorResult<Capable>>,
    [Symbol.asyncIterator]: () => iterator,
  }
  return iterator
}

const typeCheck = () => {
  const gen = (async function* () { yield 1 })()
  const boxed = box(gen, {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: AsyncIterableIterator<Capable> = revived
  // @ts-expect-error - not a string
  const notString: string = revived
  // @ts-expect-error - cannot box a non-async-iterable
  box({ next: () => {} }, {} as RevivableContext)
}
