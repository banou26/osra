import { definePlugin } from '@expressive-code/core'

// expressive-code-twoslash renders a diagnostic as ONE text node holding the output of
// ts.flattenDiagnosticMessageText(messageText, '\n'), then styles it `white-space: normal !important`,
// so the structure TypeScript encoded as newlines plus two spaces per level collapses into a single
// paragraph. This plugin puts that structure back: one element per step of the chain, every quoted
// type as its own <code>, and object types too long to sit inline broken over their members.
//
// It only reformats. Every character TypeScript emitted is still there, in the same order.

const CLOSERS = { '{': '}', '<': '>', '(': ')', '[': ']' }

/** Parse a type printed on one line into a tree of bracket groups. String literal types stay
 *  atomic, so a `,` or a brace inside one never reads as syntax. */
const parseType = (source) => {
  let i = 0
  const walk = (closer) => {
    const parts = []
    let text = ''
    const flush = () => {
      if (text) parts.push(text)
      text = ''
    }
    while (i < source.length) {
      const char = source[i]
      if (char === closer) {
        i++
        break
      }
      if (CLOSERS[char]) {
        flush()
        i++
        parts.push({ open: char, close: CLOSERS[char], parts: walk(CLOSERS[char]) })
        continue
      }
      if (char === '"' || char === "'") {
        flush()
        const end = source.indexOf(char, i + 1)
        const stop = end === -1 ? source.length : end + 1
        parts.push({ literal: source.slice(i, stop) })
        i = stop
        continue
      }
      text += char
      i++
    }
    flush()
    return parts
  }
  return walk(null)
}

const flatten = (parts) =>
  parts
    .map((part) =>
      typeof part === 'string'
        ? part
        : (part.literal ?? part.open + flatten(part.parts) + part.close),
    )
    .join('')

/** Split a brace group's children on the `;` and `,` separating its members. */
const members = (parts) => {
  const out = []
  let current = []
  for (const part of parts) {
    if (typeof part !== 'string') {
      current.push(part)
      continue
    }
    const pieces = part.split(/(?<=[;,])/)
    pieces.forEach((piece, index) => {
      current.push(piece)
      if (index < pieces.length - 1) {
        out.push(current)
        current = []
      }
    })
  }
  if (current.length) out.push(current)
  return out.filter((member) => flatten(member).trim() !== '')
}

const trimLeading = (parts) => {
  const copy = parts.slice()
  while (copy.length && typeof copy[0] === 'string') {
    const trimmed = copy[0].replace(/^\s+/, '')
    if (trimmed) {
      copy[0] = trimmed
      break
    }
    copy.shift()
  }
  return copy
}

const emit = (parts, depth, width, lines) => {
  let line = lines.pop() ?? ''
  for (const part of parts) {
    if (typeof part === 'string') {
      line += part
      continue
    }
    if (part.literal) {
      line += part.literal
      continue
    }
    const inline = part.open + flatten(part.parts) + part.close
    if (line.length + inline.length <= width) {
      line += inline
      continue
    }
    // only an object type has members to break on; anything else keeps its brackets on the line
    // it started and lets whatever it contains break instead
    if (part.open !== '{') {
      lines.push(line + part.open)
      emit(part.parts, depth, width, lines)
      line = lines.pop() + part.close
      continue
    }
    lines.push(line + part.open)
    for (const member of members(part.parts)) {
      lines.push('  '.repeat(depth + 1))
      emit(trimLeading(member), depth + 1, width, lines)
    }
    lines.push('  '.repeat(depth) + part.close)
    line = lines.pop()
  }
  lines.push(line)
  return lines
}

/** A one-line type as the text it should be printed as, broken over members once it passes
 *  `width` columns. A type that fits comes back unchanged. */
export const formatType = (type, width) =>
  emit(parseType(type), 0, width, [])
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .join('\n')

/** Split a diagnostic line into prose and the types TypeScript wrapped in single quotes. */
export const splitQuotedTypes = (line) => {
  const runs = []
  let i = 0
  while (i < line.length) {
    const open = line.indexOf("'", i)
    const close = open === -1 ? -1 : line.indexOf("'", open + 1)
    if (close === -1) {
      runs.push({ text: line.slice(i) })
      break
    }
    if (open > i) runs.push({ text: line.slice(i, open) })
    runs.push({ type: line.slice(open + 1, close) })
    i = close + 1
  }
  return runs.filter((run) => (run.text ?? run.type) !== '')
}

// wide enough that the two osra examples keep their short types inline, narrow enough that the
// branded intersection breaks; the error box is the width of the code block, not of the page
const TYPE_WIDTH = 72
const MAX_DEPTH = 4

/** One flattened diagnostic as hast children: a step per level of the chain, prose and <code>
 *  types inside each. */
export const buildMessageAst = (message) =>
  message.split('\n').map((raw) => {
    const depth = Math.min(MAX_DEPTH, Math.floor(raw.match(/^ */)[0].length / 2))
    const children = splitQuotedTypes(raw.trim()).map((run) =>
      run.text !== undefined
        ? { type: 'text', value: run.text }
        : {
            type: 'element',
            tagName: 'code',
            properties: { className: ['osra-tserr-type'] },
            children: [{ type: 'text', value: formatType(run.type, TYPE_WIDTH) }],
          },
    )
    return {
      type: 'element',
      tagName: 'span',
      properties: { className: ['osra-tserr-step'], 'data-depth': String(depth) },
      children,
    }
  })

// `.twoerror` on the ancestor beats the plugin's own `white-space: normal !important` on the
// message, so this does not depend on which stylesheet the bundler emits last
const baseStyles = `
  .twoerror .twoslash-error-box-content-message {
    white-space: pre-wrap !important;
    overflow-wrap: anywhere;
  }
  /* the negative text-indent hangs every continuation line, soft-wrapped or one the formatter
     broke, under the start of its step instead of back at the margin */
  .osra-tserr-step {
    display: block;
    padding-inline-start: calc(var(--osra-tserr-depth, 0) * 1.15em + 1.6em);
    text-indent: -1.6em;
  }
  .osra-tserr-step + .osra-tserr-step {
    margin-block-start: .3em;
  }
  .osra-tserr-step[data-depth='1'] { --osra-tserr-depth: 1; }
  .osra-tserr-step[data-depth='2'] { --osra-tserr-depth: 2; }
  .osra-tserr-step[data-depth='3'] { --osra-tserr-depth: 3; }
  .osra-tserr-step[data-depth='4'] { --osra-tserr-depth: 4; }
  /* upright against the box's italic prose: the two are the same size and color family, so the
     slant is what separates a type from the sentence around it */
  .osra-tserr-type {
    font-family: var(--ec-codeFontFml, ui-monospace, monospace);
    font-size: .93em;
    font-style: normal;
    color: var(--o-brand-ink, inherit);
  }
`

// upstream ends the title with a U+2015 horizontal bar, because it renders the title inline with
// the message. The message is its own block now, so that separator is left dangling.
const TRAILING_SEPARATOR = /\s+[\u2010-\u2015]\s*$/

const soleText = (node) =>
  node.type === 'element' && node.children?.length === 1 && node.children[0].type === 'text'
    ? node.children[0]
    : null

/** Reformats the twoslash error box so a nested TypeScript diagnostic reads as the chain it is. */
export const twoslashPrettyErrors = () =>
  definePlugin({
    name: 'osra-twoslash-pretty-errors',
    baseStyles,
    hooks: {
      postprocessRenderedBlock({ renderData }) {
        const walk = (node) => {
          const raw = node.properties?.className ?? []
          const classes = Array.isArray(raw) ? raw : String(raw).split(/\s+/)
          const text = soleText(node)
          if (text && classes.includes('twoslash-error-box-content-message')) {
            node.children = buildMessageAst(text.value)
            return
          }
          if (text && classes.includes('twoslash-error-box-content-title')) {
            text.value = text.value.replace(TRAILING_SEPARATOR, '').replace(/\s{2,}/g, ' ')
            return
          }
          for (const child of node.children ?? []) walk(child)
        }
        walk(renderData.blockAst)
      },
    },
  })
