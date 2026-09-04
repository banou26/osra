// Verifies the BUILT html: every internal href with a fragment must land on a real id.
import { readdirSync, readFileSync, statSync } from 'node:fs'
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
process.exit(broken||flat||!boxes?1:0)
