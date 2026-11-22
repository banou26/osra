import { OSRA_BOX } from '../types.js'

export type QuotedBox = {
  [OSRA_BOX]: 'quoted'
  box: 'revivable' | 'quoted'
  value: Record<string, unknown>
}

export const isQuotedBox = (value: unknown): value is QuotedBox =>
  !!value
  && typeof value === 'object'
  && OSRA_BOX in value
  && value[OSRA_BOX] === 'quoted'
  && 'box' in value
  && (value.box === 'revivable' || value.box === 'quoted')
  && 'value' in value
  && !!value.value
  && typeof value.value === 'object'
  && Object.getPrototypeOf(value.value) === Object.prototype

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
