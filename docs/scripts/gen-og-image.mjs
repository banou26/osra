// Draws public/og.png, the 1200x630 card a link to the site unfurls into (Discord, Slack, X, ...).
//
//   node scripts/gen-og-image.mjs
//
// Rendered with a headless Chromium screenshot rather than an SVG rasterizer so the type is the
// site's own Inter, loaded from the same @fontsource package the pages use. The PNG is committed:
// the Pages build has no browser, and the card only changes when this file does.
//
// Sizes are chosen for the ~500px wide box Discord shows the card in, a 0.42 downscale: nothing on
// it is under 26px, and the description and hostname stay off it because the unfurl prints both.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const root = new URL('..', import.meta.url).pathname
const out = join(root, 'public/og.png')
const WIDTH = 1200
const HEIGHT = 630

const resolveChrome = () => {
  if (process.env.OSRA_CHROME) return process.env.OSRA_CHROME
  const bundled = chromium.executablePath()
  if (existsSync(bundled)) return bundled
  // playwright 1.58 asks for chromium-1208 while the nix store holds a newer build; use what is there
  const store = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (store && existsSync(store)) {
    for (const dir of readdirSync(store).sort().reverse()) {
      const candidate = join(store, dir, 'chrome-linux64/chrome')
      if (/^chromium-\d+$/.test(dir) && existsSync(candidate)) return candidate
    }
  }
  return undefined
}

const font = readFileSync(join(root, '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')).toString('base64')
const logo = readFileSync(join(root, 'src/assets/logo.svg'), 'utf8').replace(/<!--[\s\S]*?-->/, '')

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: 'Inter Variable';
    font-style: normal;
    font-weight: 100 900;
    src: url(data:font/woff2;base64,${font}) format('woff2');
  }
  html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; }
  body {
    background: #131720 radial-gradient(900px 460px at 88% -8%, rgba(79, 156, 240, .18), transparent 62%) no-repeat;
    color: #e9edf5;
    font-family: 'Inter Variable', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    box-sizing: border-box;
    height: 100%;
    padding: 64px 76px 64px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .brand { display: flex; align-items: center; gap: 22px; }
  .brand svg { width: 76px; height: 76px; }
  .brand .word { font-size: 64px; font-weight: 800; letter-spacing: -.03em; }
  h1 {
    margin: 0 0 24px;
    font-size: 66px;
    font-weight: 700;
    letter-spacing: -.028em;
    line-height: 1.1;
    max-width: 16ch;
  }
  p {
    margin: 0;
    font-size: 33px;
    line-height: 1.35;
    color: #a3aabb;
    max-width: 30em;
  }
  .pills { display: flex; gap: 16px; }
  .pill {
    font-size: 27px;
    font-weight: 600;
    padding: 12px 24px;
    border-radius: 999px;
    background: #1a2c47;
    color: #8ec1ff;
    border: 1px solid #2a303e;
  }
  .pill.mint { background: #16332a; color: #3ecf8e; }
</style>
<div class="card">
  <div class="brand">${logo}<span class="word">osra</span></div>
  <div>
    <h1>Typed RPC across JavaScript contexts</h1>
    <p>Call functions and send complex types across workers, iframes, WebSockets and extensions, with the types intact.</p>
  </div>
  <div class="pills">
    <span class="pill">13 kB gzipped</span>
    <span class="pill mint">zero dependencies</span>
    <span class="pill">TypeScript</span>
  </div>
</div>`

const browser = await chromium.launch({
  headless: true,
  executablePath: resolveChrome(),
  args: ['--mute-audio'],
})
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  const loaded = await page.evaluate(() => document.fonts.check('700 54px "Inter Variable"'))
  if (!loaded) throw new Error('Inter did not load, the card would render in a fallback font')
  writeFileSync(out, await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } }))
  console.log(`[gen-og-image] wrote ${out} (${readFileSync(out).byteLength} bytes, ${WIDTH}x${HEIGHT})`)
} finally {
  await browser.close()
}
