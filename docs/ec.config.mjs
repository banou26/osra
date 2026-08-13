import { defineEcConfig } from 'astro-expressive-code'
import ecTwoSlash from 'expressive-code-twoslash'
import { definePlugin } from '@expressive-code/core'

// Strip the machine-specific prefix so build output is identical across machines.
const stripNodeModulesPaths = () =>
  definePlugin({
    name: 'osra-strip-node-modules-paths',
    hooks: {
      postprocessRenderedBlock({ renderData }) {
        const walk = (node) => {
          if (node.type === 'text' && node.value.includes('/node_modules/')) {
            node.value = node.value.replace(/(?:\/[^\s"')]+)?\/node_modules\//g, '')
          }
          for (const child of node.children ?? []) walk(child)
        }
        walk(renderData.blockAst)
      },
    },
  })

// Keep compilerOptions in sync with scripts/check-twoslash.mjs, the fast per-file checker.
// A failing twoslash block does NOT fail the build: it silently drops the whole page's body.
// ```ts twoslash blocks are checked against the PUBLISHED osra package (docs/package.json depends on osra ^0.6.3), so documenting an unreleased API blanks every page that mentions it until the release lands
// run `npm run docs-check-twoslash` before pushing docs, a red result there is a blank deployed page, not a warning
// expressive-code-twoslash caches the twoslasher FACTORY, not the instance, so it calls
// createTwoslasher() once per code block and each call builds its own TypeScript environment.
// 40 blocks meant 40 TS programs and a ~4.4GB heap, over node's 4.19GB default cap.
// Handing every instance the same env cache keeps it to one program, keyed on compilerOptions.
const twoslashEnvCache = new Map()

export default defineEcConfig({
  // Inlined: an interrupted transfer of the shared ec.*.css left code blocks colorless in Firefox.
  emitExternalStylesheet: false,
  themes: ['github-dark', 'github-light'],
  plugins: [
    ecTwoSlash({
      twoslashOptions: {
        cache: twoslashEnvCache,
        compilerOptions: {
          target: 99,
          module: 99,
          moduleResolution: 100,
          lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
          strict: true,
        },
      },
    }),
    stripNodeModulesPaths(),
  ],
})
