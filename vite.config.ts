import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: { semi: false, singleQuote: true },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
    // typeCheck stays off: it resolves types on its own, without the repo's tsconfigs, so it invents
    // errors for the ambient globals (chrome, Uint8Array.toHex) that `npm run type-check` resolves
    // correctly. That is tsc's job here; the lint is for the rules below.
    options: { typeAware: true, typeCheck: false },
    overrides: [
      {
        files: ['tests/**', '**/*.spec.ts', '**/*.test.ts', 'examples/**'],
        rules: {
          'no-floating-promises': 'off',
          'no-unused-vars': 'off',
          'no-unused-expressions': 'off',
        },
      },
    ],
  },
  build: {
    target: 'esnext',
    outDir: 'build',
    sourcemap: true,
    lib: {
      name: 'osra',
      fileName: 'index',
      entry: 'src/index.ts',
      formats: ['es'],
    },
  },
})
