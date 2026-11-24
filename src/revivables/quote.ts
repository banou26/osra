import { OSRA_BOX } from '../types.js'

export type QuotedBox = {
  [OSRA_BOX]: 'quoted'
  box: 'revivable' | 'quoted'
  value: Record<string, unknown>
}

export const hasQuotedBoxFields = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!Object.hasOwn(value, OSRA_BOX) || !Object.hasOwn(value, 'box') || !Object.hasOwn(value, 'value')) return false
  if (Object.keys(value).length !== 3) return false
  const record = value as Record<string, unknown>
  if (record[OSRA_BOX] !== 'quoted') return false
  if (record.box !== 'revivable' && record.box !== 'quoted') return false
  const inner = record.value
  return !!inner && typeof inner === 'object' && !Array.isArray(inner)
}

export const isQuotedBox = (value: unknown): value is QuotedBox => {
  if (!hasQuotedBoxFields(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  const innerProto = Object.getPrototypeOf(value.value)
  return innerProto === Object.prototype || innerProto === null
}

// Depth rather than a flag so nested withQuotedBoxes() restores cleanly, and outsideQuoting()
// can suspend it at independent walk entry points (Protocol ports, revived function calls) that
// already expect osra's box pass to leave existing boxes untouched.
let quoteBoxesDepth = 0

export const isQuotingBoxes = (): boolean => quoteBoxesDepth > 0

export const withQuotedBoxes = <T>(fn: () => T): T => {
  quoteBoxesDepth++
  try {
    return fn()
  } finally {
    quoteBoxesDepth--
  }
}

export const outsideQuoting = <T>(fn: () => T): T => {
  const saved = quoteBoxesDepth
  quoteBoxesDepth = 0
  try {
    return fn()
  } finally {
    quoteBoxesDepth = saved
  }
}
