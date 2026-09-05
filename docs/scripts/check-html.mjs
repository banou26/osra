// Verifies the BUILT html: every internal href with a fragment must land on a real id.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { resolve, relative } from 'node:path'
const DIST = resolve(process.argv[2])
const ONLY = process.argv[3]
const walk=(d)=>{const o=[];for(const n of readdirSync(d)){const f=resolve(d,n);if(statSync(f).isDirectory())o.push(...walk(f));else if(n.endsWith('.html'))o.push(f)}return o.sort()}
const files=walk(DIST)
const idsByRoute=new Map()
let bytes=0
for(const f of files){
  const html=readFileSync(f,'utf8'); bytes+=Buffer.byteLength(html)
  const route='/'+relative(DIST,f).replace(/index\.html$/,'')
  const ids=new Set()
  for(const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1])
  idsByRoute.set(route,ids)
  idsByRoute.set(route.replace(/\/$/,''),ids)
}
console.log(`[check-html] ${files.length} html files, ${bytes} bytes`)
let checked=0, broken=0
for(const f of files){
  const route='/'+relative(DIST,f).replace(/index\.html$/,'')
  if(ONLY && !route.startsWith(ONLY)) continue
  const html=readFileSync(f,'utf8')
  const ids=idsByRoute.get(route)
  console.log(`[check-html] ${route.padEnd(24)} ${String(Buffer.byteLength(html)).padStart(8)} bytes  ${ids.size} ids`)
  for(const m of html.matchAll(/<a\s[^>]*href="([^"]+)"/g)){
    const href=m[1]
    if(/^(https?:|mailto:|#$)/.test(href)) continue
    const i=href.indexOf('#'); if(i===-1) continue
    const target=href.slice(0,i)||route
    const frag=decodeURIComponent(href.slice(i+1))
    const set=idsByRoute.get(target)??idsByRoute.get(target.replace(/\/$/,''))
    checked++
    if(!set){broken++;console.log(`   BROKEN PAGE ${route} -> ${href}`);continue}
    if(!set.has(frag)){broken++;console.log(`   BROKEN ANCHOR ${route} -> ${href}`)}
  }
}
console.log(`[check-html] fragment links checked ${checked}, broken ${broken}`)

// The twoslash pretty-printer is a build-time plugin whose absence is SILENT: the page still
// builds, the message is still there, it just collapses back into one paragraph. So assert the
// rewritten markup, and fail on zero boxes too, since a check that finds nothing to look at is
// not a check.
let boxes=0, flat=0
for(const f of files){
  const html=readFileSync(f,'utf8')
  for(const m of html.matchAll(/<span class="twoslash-error-box-content-message">/g)){
    boxes++
    if(!html.slice(m.index,m.index+400).includes('osra-tserr-step')){
      flat++
      console.log(`   FLAT TWOSLASH ERROR ${'/'+relative(DIST,f)} at ${m.index}`)
    }
  }
}
console.log(`[check-html] twoslash error boxes ${boxes}, not pretty-printed ${flat}`)
if(!boxes) console.log('   NO TWOSLASH ERROR BOXES FOUND, the check proves nothing')

// The root is the page a link to the site unfurls from, and until 2026-09-05 it was a redirect
// stub, which unfurls to "Redirecting to: /general/getting-started" and nothing else. Assert the
// tags an unfurler reads, that each of the ones starlight merges from the frontmatter head landed
// exactly once, and that the image they point at is really in dist at the declared size: a wrong
// path or a stale width is a broken card that nothing else would report.
const SITE='https://osra.banou.dev'
let embedProblems=0
const embedFail=(msg)=>{embedProblems++;console.log(`   EMBED ${msg}`)}
const index=readFileSync(resolve(DIST,'index.html'),'utf8')
const meta=(attr,key)=>index.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`))?.[1]
const count=(re)=>(index.match(re)??[]).length
const embed={
  title: index.match(/<title>([^<]*)<\/title>/)?.[1],
  canonical: index.match(/<link rel="canonical" href="([^"]*)"/)?.[1],
  description: meta('name','description'),
  'og:title': meta('property','og:title'),
  'og:description': meta('property','og:description'),
  'og:type': meta('property','og:type'),
  'og:url': meta('property','og:url'),
  'og:site_name': meta('property','og:site_name'),
  'og:image': meta('property','og:image'),
  'og:image:type': meta('property','og:image:type'),
  'og:image:width': meta('property','og:image:width'),
  'og:image:height': meta('property','og:image:height'),
  'twitter:card': meta('name','twitter:card'),
  'twitter:image': meta('name','twitter:image'),
  'theme-color': meta('name','theme-color'),
}
for(const [k,v] of Object.entries(embed)) console.log(`[check-html] / ${k.padEnd(16)} ${v??'(missing)'}`)
if(/http-equiv="refresh"/.test(index)||/^Redirecting/.test(embed.title??'')) embedFail('/ is a redirect stub, not a page')
for(const [k,v] of Object.entries(embed)) if(!v) embedFail(`/ has no ${k}`)
if(embed['og:type']!=='website') embedFail(`/ og:type is ${embed['og:type']}, expected website`)
if(embed['og:url']!==`${SITE}/`) embedFail(`/ og:url is ${embed['og:url']}, expected ${SITE}/`)
if(embed.canonical!==embed['og:url']) embedFail(`/ canonical ${embed.canonical} differs from og:url`)
if(embed['og:image:type']!=='image/png') embedFail(`/ og:image:type is ${embed['og:image:type']}`)
if((embed.description??'').length>160) embedFail(`/ description is ${embed.description.length} characters, a search result clips near 160`)
for(const [what,re] of [['<title>',/<title>/g],['og:title',/property="og:title"/g],['og:type',/property="og:type"/g],['description',/<meta name="description"/g]]){
  const n=count(re); if(n!==1) embedFail(`/ has ${n} ${what} tags, expected exactly 1`)
}
if(embed['og:image']){
  let path
  try{path=new URL(embed['og:image']).pathname}catch{embedFail(`og:image is not an absolute url: ${embed['og:image']}`)}
  if(path){
    const file=resolve(DIST,'.'+path)
    if(!existsSync(file)) embedFail(`og:image points at ${path}, which is not in dist`)
    else{
      // png: 8 byte signature, then the IHDR chunk whose data starts at 16 with width and height as big-endian u32
      const png=readFileSync(file)
      const isPng=png.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))
      if(!isPng) embedFail(`${path} is not a png`)
      else{
        const w=png.readUInt32BE(16), h=png.readUInt32BE(20)
        console.log(`[check-html] / og.png            ${w}x${h}, ${png.byteLength} bytes`)
        if(String(w)!==embed['og:image:width']||String(h)!==embed['og:image:height']) embedFail(`${path} is ${w}x${h}, tags say ${embed['og:image:width']}x${embed['og:image:height']}`)
        if(embed['twitter:image']!==embed['og:image']) embedFail(`twitter:image ${embed['twitter:image']} differs from og:image`)
      }
    }
  }
}
console.log(`[check-html] root embed problems ${embedProblems}`)
process.exit(broken||flat||!boxes||embedProblems?1:0)
