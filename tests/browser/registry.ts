import type { Transport } from '../../src'

import { base } from './base-tests'
import * as base64 from './base64'
import { baseMemory } from './base-memory-tests'
import { gc } from './gc-tests'
import * as connectionContext from './connection-context'
import * as customRevivables from './custom-revivables'
import * as identityTests from './identity'
import * as identityChain from './identity-chain'
import * as transferTests from './transfer'
import * as eventPort from './event-port'
import * as gettingStarted from './getting-started'
import * as lifecycle from './lifecycle'
import * as messageChannel from './message-channel-transport'
import * as platformTransports from './platform-transports'
import * as portInPortTests from './port-in-port'
import * as relayTests from './relay'
import * as reorderTests from './reorder'
import * as streamCompat from './stream-compat'
import * as teardownTests from './teardown'
import * as typeGuards from './type-guards'
import * as webExtPortDisconnect from './webext-port-disconnect'
import * as workerChannels from './worker-channels'
import * as workerHandshake from './worker-handshake'

const fns = <Fn extends (...args: any[]) => any>(o: Record<string, unknown>): Record<string, Fn> =>
  Object.fromEntries(
    Object.entries(o).filter((entry): entry is [string, Fn] => typeof entry[1] === 'function'),
  )

export const transportTests: Readonly<Record<string, Readonly<Record<string, (transport: Transport) => Promise<void>>>>> = {
  Base: base,
  Identity: fns(identityTests),
  Transfer: fns(transferTests),
  PortInPort: {
    osraRpcOverReturnedRelayedPort: portInPortTests.osraRpcOverReturnedRelayedPort,
    osraRpcOverArgumentRelayedPort: portInPortTests.osraRpcOverArgumentRelayedPort,
    userBoxShapedObjectsPreserved: portInPortTests.userBoxShapedObjectsPreserved,
    abortSignalDeferredBoxShapedReasonNoDoubleRevive: portInPortTests.abortSignalDeferredBoxShapedReasonNoDoubleRevive,
    userRevivableShapedObjectsPreservedAtEveryEntryPoint: portInPortTests.userRevivableShapedObjectsPreservedAtEveryEntryPoint,
  },
  CustomRevivables: {
    userPoint: customRevivables.userPoint,
    userPointReturn: customRevivables.userPointReturn,
    userPointDefaultsStillWork: customRevivables.userPointDefaultsStillWork,
    callArgsAreWalkedOnce: customRevivables.callArgsAreWalkedOnce,
    aRevivingChunkThatThrowsErrorsTheStream: customRevivables.aRevivingChunkThatThrowsErrorsTheStream,
  },
}

export const memoryTests: Readonly<Record<string, (transport: Transport, iterations: number) => Promise<void>>> =
  fns(baseMemory)

export const gcTests: Readonly<Record<string, (transport: Transport) => Promise<void>>> =
  fns(gc)

export const standaloneTests: Readonly<Record<string, Readonly<Record<string, () => Promise<void>>>>> = {
  Base64: fns(base64),
  ConnectionContext: fns(connectionContext),
  EventPort: fns(eventPort),
  GettingStarted: fns(gettingStarted),
  IdentityChain: fns(identityChain),
  Lifecycle: fns(lifecycle),
  MessageChannelTransport: fns(messageChannel),
  PlatformTransports: fns(platformTransports),
  PortInPort: {
    strictJsonPortInPortCarriesAllPayloads: portInPortTests.strictJsonPortInPortCarriesAllPayloads,
    twoHopPortInPortRelayOverJson: portInPortTests.twoHopPortInPortRelayOverJson,
    threeHopPortInPortRelayOverJson: portInPortTests.threeHopPortInPortRelayOverJson,
    threeLayerNestedQuotedBoxesRoundTrip: portInPortTests.threeLayerNestedQuotedBoxesRoundTrip,
    circularBoxUnderQuotingThrowsAndRollsBack: portInPortTests.circularBoxUnderQuotingThrowsAndRollsBack,
    rawMessagesOverRelayedPortKeepBuffersAndSpecials: portInPortTests.rawMessagesOverRelayedPortKeepBuffersAndSpecials,
    customRevivableOwnProtoOnRelayedPort: portInPortTests.customRevivableOwnProtoOnRelayedPort,
    throwingBoxMarkerRollsBackWalk: portInPortTests.throwingBoxMarkerRollsBackWalk,
    strictJsonRelayedPortPreservesIdentity: portInPortTests.strictJsonRelayedPortPreservesIdentity,
    relayedPortPreservesUserBoxShapedObjects: portInPortTests.relayedPortPreservesUserBoxShapedObjects,
    quotedTransferOverEventPortThroughCloneChannel: portInPortTests.quotedTransferOverEventPortThroughCloneChannel,
    clonableAndTransferableRejectOnJsonAndRawPort: portInPortTests.clonableAndTransferableRejectOnJsonAndRawPort,
    nestedConnectionsMoveTransfersThroughThreeQuoteLayers: portInPortTests.nestedConnectionsMoveTransfersThroughThreeQuoteLayers,
    boxingAnOsraBoxTwiceLeavesItUntouched: portInPortTests.boxingAnOsraBoxTwiceLeavesItUntouched,
  },
  Relay: fns(relayTests),
  Reorder: fns(reorderTests),
  StreamCompat: fns(streamCompat),
  Teardown: fns(teardownTests),
  TypeGuards: fns(typeGuards),
  WebExtPortDisconnect: fns(webExtPortDisconnect),
  WorkerChannels: fns(workerChannels),
  WorkerHandshake: fns(workerHandshake),
}
