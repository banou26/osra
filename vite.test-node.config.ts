import { defineConfig } from 'vite'

// The browser test registry bundled for node: same test modules, tests/node/run.ts as the entry.
// A bundle rather than node's own type stripping because the test sources use extensionless
// relative imports, which node's ESM loader refuses.
export default defineConfig({
  build: {
    target: 'node22',
    // its own directory, not build-test: the browser bundle empties that one, so a browser build
    // after a node build would silently delete the bundle the node runner is about to execute
    outDir: 'build-test-node',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      name: 'osra-node-tests',
      fileName: 'node',
      entry: 'tests/node/run.ts',
      formats: ['es'],
    },
    rollupOptions: {
      external: [/^node:/, 'chai', 'chai-as-promised', 'ws'],
    },
  },
})
