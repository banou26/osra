#!/usr/bin/env node
// Reports every internal link in a generated markdown tree whose target anchor does not exist.
//
//   node scripts/check-links.mjs <dir> [--route-base /api] [--quiet-ok]
//
// Anchors are computed the way the site computes them: astro's rehypeHeadingIds runs
// github-slugger over the heading text remark produced, one slugger per page, in document
// order. See scripts/clean-text.mjs for the normalization that turns a raw markdown heading
// back into that text.
//
// Handles both trees:
//   * raw typedoc output   -> links look like `other.md#anchor` and `#anchor`
//   * post-rewrite output  -> links look like `/api/other/#anchor` and `#anchor`
//
// Every file read is printed with its byte count, so a walk that found nothing cannot be
// mistaken for a tree with no broken links.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, relative, dirname, join } from 'node:path'
import GithubSlugger from 'github-slugger'
import { cleanText } from './clean-text.mjs'

const args = process.argv.slice(2)
const DIR = resolve(args.find((a) => !a.startsWith('--')) ?? '.')
const routeAt = args.indexOf('--route-base')
const ROUTE_BASE = routeAt > -1 ? args[routeAt + 1].replace(/\/$/, '') : '/api'
const QUIET_OK = args.includes('--quiet-ok')

// ---------------------------------------------------------------- walk

const walk = (dir) => {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (name.endsWith('.md') || name.endsWith('.mdx')) out.push(full)
  }
  return out.sort()
}

// strip frontmatter, then strip fenced code so neither headings nor links inside a fence count
const parse = (raw) => {
  const noFm = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
  const lines = noFm.split('\n')
  const out = []
  let fence = null
  for (const line of lines) {
    const m = line.match(/^\s*(```+|~~~+)/)
    if (m) {
      if (!fence) fence = m[1]
      else if (m[1].startsWith(fence)) fence = null
      out.push('')
      continue
    }
    out.push(fence ? '' : line)
  }
  return out.join('\n')
}

// the generator drops typedoc's `# <module>` H1 because starlight renders the frontmatter title
// as the page H1 outside the markdown pipeline, so the slugger never sees it
const dropH1 = (body) => body.replace(/^#\s+.+\n+/m, '')

const anchorsOf = (body) => {
  const slugger = new GithubSlugger()
  const list = []
  for (const line of body.split('\n')) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (!m) continue
    list.push({ depth: m[1].length, raw: m[2], slug: slugger.slug(cleanText(m[2])) })
  }
  return list
}

// ---------------------------------------------------------------- index

const files = walk(DIR)
if (!files.length) {
  console.error(`[check-links] FATAL: no markdown files under ${DIR}`)
  process.exit(2)
}

const pages = new Map() // repo-relative md path -> { anchors:Set, body, bytes }
const routeToPath = new Map() // site route -> md path
let totalBytes = 0

console.log(`[check-links] scanning ${DIR}`)
for (const file of files) {
  const raw = readFileSync(file, 'utf8')
  const bytes = Buffer.byteLength(raw)
  totalBytes += bytes
  const rel = relative(DIR, file)
  const body = dropH1(parse(raw))
  const list = anchorsOf(body)
  // github-slugger always returns a unique slug, so the interesting number is how many headings
  // only became unique by taking a -N suffix
  const dupes = list.filter((h) => /-\d+$/.test(h.slug)).length
  pages.set(rel, { anchors: new Set(list.map((h) => h.slug)), headings: list, bytes })

  const slug = rel.replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '$1').replace(/\/$/, '')
  const route = `${ROUTE_BASE}${slug ? `/${slug}` : ''}/`
  routeToPath.set(route, rel)
  routeToPath.set(route.replace(/\/$/, ''), rel) // tolerate a missing trailing slash

  console.log(
    `[check-links]   read ${rel.padEnd(24)} ${String(bytes).padStart(7)} bytes  ` +
      `${String(list.length).padStart(4)} headings` +
      (dupes ? `  ${String(dupes).padStart(3)} needed a -N suffix` : ''),
  )
}
console.log(`[check-links] ${files.length} files, ${totalBytes} bytes total`)

// ---------------------------------------------------------------- check

const LINK = /\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g

const problems = []
let internal = 0
let external = 0

for (const file of files) {
  const rel = relative(DIR, file)
  const body = parse(readFileSync(file, 'utf8'))
  let lineNo = 0
  for (const line of body.split('\n')) {
    lineNo++
    for (const m of line.matchAll(LINK)) {
      const [, label, url] = m
      if (/^(https?:|mailto:|tel:|data:)/.test(url)) {
        external++
        continue
      }
      internal++
      const hashAt = url.indexOf('#')
      const target = hashAt === -1 ? url : url.slice(0, hashAt)
      const anchor = hashAt === -1 ? '' : decodeURIComponent(url.slice(hashAt + 1))

      let targetPath
      if (target === '') targetPath = rel
      else if (target.startsWith('/')) targetPath = routeToPath.get(target) ?? routeToPath.get(target.replace(/\/$/, ''))
      else targetPath = join(dirname(rel), target).replace(/^\.\//, '')

      const page = targetPath && pages.get(targetPath)
      if (!page) {
        problems.push({ kind: 'missing-page', rel, lineNo, label, url, detail: `no page for ${target || '(self)'}` })
        continue
      }
      if (anchor && !page.anchors.has(anchor)) {
        const near = [...page.anchors].filter((a) => a.replace(/-\d+$/, '') === anchor.replace(/-\d+$/, ''))
        problems.push({
          kind: 'missing-anchor',
          rel,
          lineNo,
          label,
          url,
          detail: `${targetPath} has no #${anchor}${near.length ? `; siblings: ${near.slice(0, 6).join(', ')}` : ''}`,
        })
      }
    }
  }
}

console.log(`[check-links] ${internal} internal links, ${external} external links`)

if (problems.length) {
  const byKind = {}
  for (const p of problems) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1
  console.log(`[check-links] BROKEN: ${problems.length} (${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(', ')})`)
  for (const p of problems) {
    console.log(`  ${p.rel}:${p.lineNo}  [${p.label}](${p.url})  -> ${p.detail}`)
  }
} else if (!QUIET_OK) {
  console.log('[check-links] BROKEN: 0  all internal links resolve')
}

process.exit(problems.length ? 1 : 0)
