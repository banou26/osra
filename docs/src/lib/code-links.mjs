// Resolves an inline code span in hand-written prose to its API reference url, or to null when the
// span is not an osra symbol. Consumed by src/plugins/rehype-code-links.mjs.

import { API_ALIASES } from './api-map.generated.mjs'
import { GUIDE_LINKS } from './guide-links.mjs'

// Names the general rules below would let through, that still mean something else in osra's prose.
//   type -> the RevivableModule discriminant field, and a TypeScript keyword
//   init -> the RevivableModule hook and the handshake message, not the barrel-exported function
//   Path -> a real exported brand symbol, but "path" is ordinary English
const AMBIGUOUS = new Set(['type', 'init', 'Path'])

export const resolveCodeLink = (raw, currentRoute) => {
  const text = String(raw).trim()
  const cut = Math.min(
    ...['(', '<'].map((c) => (text.indexOf(c) + 1 || text.length + 1) - 1),
  )
  const name = text.slice(0, cut)

  // must be a bare identifier, which rejects dotted (`context.abort`), bracketed
  // (`[Symbol.asyncIterator]`), hyphenated, quoted, and anything containing a space
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null
  if (AMBIGUOUS.has(name)) return null

  // A single-word lowercase name in bare form is English, not a symbol; the call form is a symbol.
  // Exact for osra: of its 62 lowercase-initial exports the 8 single-word ones (connections,
  // context, expose, identity, init, relay, transfer, type) are precisely the 8 that read as
  // ordinary words, and the other 54 are camelCase and unambiguous.
  const called = cut < text.length && text[cut] === '('
  if (/^[a-z]/.test(name) && !/[A-Z]/.test(name) && !called) return null

  // never send a reader off the very page that explains this symbol
  if (currentRoute && GUIDE_LINKS[name]?.route === currentRoute) return null

  return API_ALIASES[name] ?? null
}
