import { defineConfig } from 'vite'
import istanbul from 'vite-plugin-istanbul'

export default defineConfig({
  plugins: [
    istanbul({
      include: 'src/*',
      exclude: ['node_modules', 'tests/'],
      extension: ['.js', '.ts'],
      // requireEnv: instrument ONLY under VITE_COVERAGE. Unconditional instrumentation meant every
      // run of every test wrote a coverage dump nothing read: 19 GB and 54k files before anyone
      // noticed. `npm run test-with-coverage` sets it, plain `npm test` does not.
      requireEnv: true,
      forceBuildInstrument: true
    })
  ],
  build: {
    target: 'esnext',
    // NOT build/ - that's the publish root (files: ["build"]), a stray test bundle would ship
    outDir: 'build-test',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      name: 'osra',
      fileName: 'test',
      entry: 'tests/browser/_run.ts',
      formats: ['es']
    }
  }
})
