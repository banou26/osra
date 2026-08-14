import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  site: 'https://osra.banou.dev',
  // the static build emits a meta-refresh page for local preview, while public/_redirects gives production a real 302 on Cloudflare Pages
  redirects: {
    '/': '/general/getting-started'
  },
  integrations: [
    starlight({
      title: 'osra',
      description:
        'Documentation for osra, the zero-dependency TypeScript RPC library that connects two JavaScript contexts over any message channel.',
      logo: { src: './src/assets/logo.svg', alt: 'osra' },
      favicon: '/favicon.svg',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/Banou26/osra' },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/osra' },
      ],
      components: {
        Header: './src/components/Header.astro',
      },
      sidebar: [
        {
          label: 'General',
          items: [
            { label: 'Getting started', slug: 'general/getting-started' },
            { label: 'Overview', slug: 'general/overview' },
            { label: 'Installation', slug: 'general/installation' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Transport modes', slug: 'guides/transport-modes' },
            { label: 'Transports', slug: 'guides/transports' },
            { label: 'Custom transports', slug: 'guides/custom-transports' },
            { label: 'Supported types', slug: 'guides/supported-types' },
            { label: 'Live values', slug: 'guides/live-values' },
            { label: 'identity() and transfer()', slug: 'guides/identity-and-transfer' },
            { label: 'Errors and lifecycle', slug: 'guides/lifecycle' },
            { label: 'Multiple peers', slug: 'guides/multiple-peers' },
            { label: 'Connections', slug: 'guides/connections' },
            { label: 'Custom revivables', slug: 'guides/custom-revivables' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'expose()', slug: 'reference/expose' },
            { label: 'TypeScript', slug: 'reference/typescript' },
            { label: 'Low-level API', slug: 'reference/low-level' },
            { label: 'Limitations', slug: 'reference/limitations' },
          ],
        },
        {
          label: 'Internals',
          collapsed: true,
          items: [
            { label: 'How it works', slug: 'internals/how-it-works' },
          ],
        },
      ],
      customCss: ['@fontsource-variable/inter', './src/styles/custom.css'],
    }),
  ],
})
