// Hand-written. Maps an osra export to the hand-written page that EXPLAINS it, as opposed to the
// generated page that merely lists its signature.
//
// Two consumers, and they pull in opposite directions on purpose:
//   * scripts/gen-reference.mjs stamps a "Guide:" line under the symbol on the generated page, so a
//     reader who lands on a bare signature is one click from the prose.
//   * src/lib/code-links.mjs suppresses the auto-link when a code span sits on the very page named
//     here, so the prose never links a symbol to a listing that says less than the paragraph
//     around it.
//
// Only add an entry when the target page really discusses the symbol. A wrong entry is worse than a
// missing one: it suppresses a useful link AND points readers somewhere that does not answer them.
export const GUIDE_LINKS = {
  expose: { route: '/reference/expose/', label: 'expose()' },

  Remote: { route: '/reference/typescript/', label: 'TypeScript' },
  Capable: { route: '/reference/typescript/', label: 'TypeScript' },
  Exposed: { route: '/reference/typescript/', label: 'TypeScript' },
  Connected: { route: '/reference/typescript/', label: 'TypeScript' },
  Jsonable: { route: '/reference/typescript/', label: 'TypeScript' },
  Structurable: { route: '/reference/typescript/', label: 'TypeScript' },
  StructurableTransferable: { route: '/reference/typescript/', label: 'TypeScript' },

  relay: { route: '/reference/low-level/', label: 'Low-level API' },
  RelayOptions: { route: '/reference/low-level/', label: 'Low-level API' },
  registerOsraMessageListener: { route: '/reference/low-level/', label: 'Low-level API' },
  sendOsraMessage: { route: '/reference/low-level/', label: 'Low-level API' },
  getTransferableObjects: { route: '/reference/low-level/', label: 'Low-level API' },
  recursiveBox: { route: '/reference/low-level/', label: 'Low-level API' },
  recursiveRevive: { route: '/reference/low-level/', label: 'Low-level API' },
  isRevivableBox: { route: '/reference/low-level/', label: 'Low-level API' },
  MessageContext: { route: '/reference/low-level/', label: 'Low-level API' },
  OSRA_KEY: { route: '/reference/low-level/', label: 'Low-level API' },
  OSRA_DEFAULT_KEY: { route: '/reference/low-level/', label: 'Low-level API' },
  OSRA_BOX: { route: '/reference/low-level/', label: 'Low-level API' },

  identity: { route: '/guides/identity-and-transfer/', label: 'identity() and transfer()' },
  transfer: { route: '/guides/identity-and-transfer/', label: 'identity() and transfer()' },

  context: { route: '/guides/connections/', label: 'Connections' },
  Contextual: { route: '/guides/connections/', label: 'Connections' },

  RevivableModule: { route: '/guides/custom-revivables/', label: 'Custom revivables' },
  RevivableContext: { route: '/guides/custom-revivables/', label: 'Custom revivables' },
  defaultRevivableModules: { route: '/guides/custom-revivables/', label: 'Custom revivables' },
  BoxBase: { route: '/guides/custom-revivables/', label: 'Custom revivables' },

  CustomTransport: { route: '/guides/custom-transports/', label: 'Custom transports' },
  CustomEmitTransport: { route: '/guides/custom-transports/', label: 'Custom transports' },
  CustomReceiveTransport: { route: '/guides/custom-transports/', label: 'Custom transports' },
  EmitHandler: { route: '/guides/custom-transports/', label: 'Custom transports' },
  ReceiveHandler: { route: '/guides/custom-transports/', label: 'Custom transports' },

  Transport: { route: '/guides/transports/', label: 'Transports' },
  PlatformTransport: { route: '/guides/transports/', label: 'Transports' },
}
