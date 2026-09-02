import type { Capable } from '../types.js'
import type { RevivableContext, BoxBase as BoxBaseType } from './utils.js'

import { BoxBase } from './utils.js'
import { recursiveBox, recursiveRevive } from './index.js'

export const type = 'error' as const

/** Never claims a primitive, so the walker can skip this module for primitive leaves. */
export const objectsOnly = true

export type BoxedError =
  & BoxBaseType<typeof type>
  & {
    name: string
    message: string
    stack: string
    cause?: Capable
    /** AggregateError only */
    errors?: Capable
    isDOMException?: boolean
  }

const ERROR_CONSTRUCTORS: Record<string, ErrorConstructor> = {
  Error,
  TypeError: TypeError as ErrorConstructor,
  RangeError: RangeError as ErrorConstructor,
  SyntaxError: SyntaxError as ErrorConstructor,
  ReferenceError: ReferenceError as ErrorConstructor,
  EvalError: EvalError as ErrorConstructor,
  URIError: URIError as ErrorConstructor,
}

export const isType = (value: unknown): value is Error =>
  value instanceof Error

export const box = <T extends Error, T2 extends RevivableContext>(
  value: T,
  context: T2,
): BoxedError => {
  const hasCause = 'cause' in value && value.cause !== undefined
  const isAggregate = typeof AggregateError !== 'undefined' && value instanceof AggregateError
  const isDomException = typeof DOMException !== 'undefined' && value instanceof DOMException
  return {
    ...BoxBase,
    type,
    name: value.name,
    message: value.message,
    stack: value.stack || value.toString(),
    ...(hasCause ? { cause: recursiveBox(value.cause as Capable, context) as Capable } : {}),
    ...(isAggregate ? { errors: recursiveBox(value.errors as Capable, context) as Capable } : {}),
    ...(isDomException ? { isDOMException: true } : {}),
  }
}

export const revive = <T extends BoxedError, T2 extends RevivableContext>(
  value: T,
  context: T2,
): Error => {
  const cause = value.cause !== undefined
    ? recursiveRevive(value.cause, context)
    : undefined
  const options = cause !== undefined ? { cause } : undefined

  if (value.isDOMException && typeof DOMException !== 'undefined') {
    const err = new DOMException(value.message, value.name)
    if (value.stack) {
      try { Object.defineProperty(err, 'stack', { value: value.stack, configurable: true }) } catch { /* immutable on some engines */ }
    }
    return err
  }

  let err: Error
  if (value.errors !== undefined && typeof AggregateError !== 'undefined') {
    err = new AggregateError(recursiveRevive(value.errors, context) as unknown as unknown[], value.message, options)
  } else {
    const Constructor = ERROR_CONSTRUCTORS[value.name] ?? Error
    err = options !== undefined
      ? new Constructor(value.message, options)
      : new Constructor(value.message)
  }
  if (value.name && err.name !== value.name) err.name = value.name
  if (value.stack) err.stack = value.stack
  return err
}

const typeCheck = () => {
  const boxed = box(new Error('test'), {} as RevivableContext)
  const revived = revive(boxed, {} as RevivableContext)
  const expected: Error = revived
  // @ts-expect-error - not an Error
  const notError: string = revived
  // @ts-expect-error - cannot box non-Error
  box('not an error', {} as RevivableContext)
}
