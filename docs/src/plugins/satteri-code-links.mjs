// Turns an inline code span in hand-written prose into a link to that symbol's API reference entry.
//
// Written against Satteri's hast visitor API, NOT rehype. Astro 7 makes Satteri the default
// markdown processor, and `markdown.rehypePlugins` only runs when the processor is the legacy
// unified one: set against the default, those plugins are skipped with a warning. Going through
// `satteri({ hastPlugins: [...] })` keeps the whole site on the engine it already renders with,
// where switching to `unified({...})` would change the markdown engine for every hand-written page
// to install one linker.

import { resolveCodeLink } from '../lib/code-links.mjs'

// the generated pages already carry typedoc's own links; auto-linking them would be noise
const GENERATED = '/content/docs/api/'
const CONTENT_ROOT = '/src/content/docs/'

// never link a span that is part of a code block, already a link, or inside a heading
const BLOCKING = new Set(['pre', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

// /home/.../docs/src/content/docs/guides/lifecycle.md -> /guides/lifecycle/
const routeFromPath = (path) => {
  const at = path.lastIndexOf(CONTENT_ROOT)
  if (at === -1) return null
  const slug = path
    .slice(at + CONTENT_ROOT.length)
    .replace(/\.mdx?$/, '')
    .replace(/(^|\/)index$/, '$1')
    .replace(/\/$/, '')
  return `/${slug}${slug ? '/' : ''}`
}

export const satteriCodeLinks = () => ({
  name: 'osra-code-links',
  element: {
    filter: ['code'],
    visit(node, ctx) {
      const path = ctx.fileURL?.pathname
      if (!path) return
      if (path.includes(GENERATED)) return

      // ctx.parent gives one hop, so walk up: a span can sit under `a > strong > code`
      for (let parent = ctx.parent(node); parent; parent = ctx.parent(parent)) {
        if (parent.type !== 'element') break
        if (BLOCKING.has(parent.tagName)) return
      }

      const href = resolveCodeLink(ctx.textContent(node), routeFromPath(path))
      if (!href) return
      ctx.wrapNode(node, {
        type: 'element',
        tagName: 'a',
        properties: { href, className: ['code-ref'] },
        children: [],
      })
    },
  },
})
