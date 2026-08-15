// The normalization the generator and the link checker must both use, so a heading's slug is
// computed from the same string remark hands to astro's rehypeHeadingIds. Astro slugs headings in
// @astrojs/markdown-remark's rehype-collect-headings with github-slugger, one slugger per file, in
// document order, no options. Starlight re-registers the same plugin but that second pass is a
// no-op. Deriving an anchor from a symbol NAME instead would be wrong: typedoc has its own slugger
// with a different dedup counter, and the two only agree on the current names by luck.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' }

export const cleanText = (t) =>
  t
    // inline links/images collapse to their label; the url must never reach the slug
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    // html entities typedoc can emit inside type text
    .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, e) => ENTITIES[e])
    // inline code delimiters (github-slugger drops backticks too, this keeps the key readable)
    .replace(/`/g, '')
    // gfm strikethrough delimiters
    .replace(/~~/g, '')
    // markdown backslash escapes: \_ \< \* \[ \| ...
    .replace(/\\([!-\/:-@\[-`{-~])/g, '$1')
    // remark-smartypants is on by default in astro, so a run of hyphens in a heading collapses to
    // one long-dash glyph that github-slugger then strips, where the raw hyphens would survive
    // into the slug. Written as code points so the glyphs never appear literally in the repo.
    .replace(/---/g, '\u2014')
    .replace(/--/g, '\u2013')
    .trim()

// symbol identifier out of a cleaned heading: `expose()` -> expose, `options?` -> options,
// `Remote<T>` -> Remote
export const identOf = (t) =>
  cleanText(t)
    .replace(/\(.*$/, '')
    .replace(/<.*$/, '')
    .replace(/\?$/, '')
    .replace(/^\[|\]$/g, '')
    .trim()
