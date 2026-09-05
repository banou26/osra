// Pins the SHAPE of the compile error a consumer gets from `expose()` for a value that cannot cross.
//
//   node scripts/check-error-chain.mjs [path/to/index.d.ts]     (default: build/index.d.ts)
//
// The message chain TypeScript prints is derived from the structure of the `value` parameter type,
// one line per layer. Until 2026-09-05 that parameter was `CapableCheck<...> | Contextual<...>`, and
// the union added a step to every error: "not assignable to (T & {...}) | Contextual<...>" before the
// line that names the bad field. It also made a union-typed value infer one member at a time, so
// `expose(either, ...)` with `either: A | B` was rejected. Both are checked here against the shipped
// declarations, the way an npm consumer sees them, with the repo's own compiler (typescript7 is the
// native tsc and ships no JavaScript API, so this drives the CLI and reads its `--pretty false` output,
// where every continuation line of a chain is indented two spaces further than the one above).
//
// Pass the published package's declarations to see it fail: node_modules/osra/build/index.d.ts at
// 0.6.11 prints a three-line chain and rejects the union.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript7/bin/tsc')
const declarations = resolve(process.argv[2] ?? resolve(ROOT, 'build/index.d.ts'))
if (!existsSync(declarations)) {
  console.error(`[check-error-chain] no declarations at ${declarations}, run \`npm run build\` first`)
  process.exit(2)
}

// the js path next to the d.ts, as a consumer would import it
const specifier = declarations.replace(/\.d\.ts$/, '.js')
const dir = resolve(ROOT, 'node_modules/.cache/osra-check-error-chain')
const fixture = resolve(dir, 'fixture.ts')
const source = `import { expose } from '${specifier}'
// FILE: fine on a worker and not on a WebSocket, so this is the JSON message
expose({ foo: new File([], '') }, { transport: new WebSocket('') })
// UNION: a value typed as a union must infer as a whole and pass
declare const either: { v: string } | { v: number }
expose(either, { transport: new Worker('') })
`
const lines = source.split('\n')
const fileLine = lines.findIndex((l) => l.startsWith('expose({ foo')) + 1
const unionLine = lines.findIndex((l) => l.startsWith('expose(either')) + 1

mkdirSync(dir, { recursive: true })
writeFileSync(fixture, source)
let output = ''
try {
  execFileSync(process.execPath, [
    TSC, '--noEmit', '--strict', '--pretty', 'false', '--ignoreConfig',
    '--target', 'esnext', '--module', 'esnext', '--moduleResolution', 'bundler',
    '--lib', 'esnext,dom,dom.iterable', '--types', '', '--skipLibCheck', 'false',
    fixture,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error) {
  // tsc exits 2 on any diagnostic, which is the expected outcome here
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// `fixture.ts(3,10): error TS2345: head` followed by continuation lines indented two spaces more each
const diagnostics = []
for (const line of output.split('\n')) {
  const head = line.match(/^(.*?)\((\d+),\d+\): error TS(\d+): (.*)$/)
  if (head) diagnostics.push({ file: head[1], line: Number(head[2]), code: Number(head[3]), steps: [head[4]] })
  else if (/^\s{2,}\S/.test(line) && diagnostics.length) diagnostics.at(-1).steps.push(line.trim())
  else if (line.trim()) diagnostics.push({ file: '', line: 0, code: 0, steps: [line.trim()] })
}

let failures = 0
const fail = (msg) => { failures++; console.log(`   FAIL ${msg}`) }
const version = execFileSync(process.execPath, [TSC, '--version'], { encoding: 'utf8' }).trim()

console.log(`[check-error-chain] ${declarations} (${version}), ${diagnostics.length} diagnostic(s)`)
for (const d of diagnostics) {
  console.log(`[check-error-chain] line ${d.line} TS${d.code}, ${d.steps.length} line(s):`)
  for (const [i, step] of d.steps.entries()) console.log(`${'  '.repeat(i + 2)}${step.length > 220 ? step.slice(0, 220) + '...' : step}`)
}
if (!output.trim()) fail('tsc printed nothing: the fixture must error on the File line, so this run checked nothing')

const fileErrors = diagnostics.filter((d) => d.line === fileLine)
if (fileErrors.length !== 1) fail(`expected exactly one error on the File line, got ${fileErrors.length}`)
for (const d of fileErrors) {
  if (d.code !== 2345) fail(`File error is TS${d.code}, expected TS2345`)
  if (d.steps.length !== 2) fail(`File error chain is ${d.steps.length} lines, expected 2 (head + the missing-properties line)`)
  const leaf = d.steps.at(-1)
  if (!/^Type '\{ foo: File; \}' is missing the following properties from type '\{ \[ErrorMessage\]: "Value type is only supported on structured-clone transports, not on JSON transports"; \[BadValue\]: File; \[Path\]: "foo";/.test(leaf)) {
    fail(`last line does not name the bad field and message: ${leaf.slice(0, 200)}`)
  }
  if (!/\[ErrorMessage\], \[BadValue\], \[Path\], \[ParentObject\]$/.test(leaf)) fail(`last line does not end with the four brand keys: ${leaf.slice(-120)}`)
  if (/Contextual</.test(d.steps[0])) fail('head line still mentions Contextual: the union is back')
}
const unionErrors = diagnostics.filter((d) => d.line === unionLine)
if (unionErrors.length) fail(`a union-typed value is rejected: ${unionErrors[0].steps[0].slice(0, 200)}`)
const elsewhere = diagnostics.filter((d) => d.line !== fileLine && d.line !== unionLine)
for (const d of elsewhere) fail(`unexpected diagnostic on line ${d.line}: ${d.steps[0].slice(0, 200)}`)

console.log(`[check-error-chain] ${failures ? `${failures} failure(s)` : 'ok: two-line Capable error, union value accepted'}`)
process.exit(failures ? 1 : 0)
