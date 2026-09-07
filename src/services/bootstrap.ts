import { AppState as RNAppState, type AppStateStatus } from 'react-native';
import { initDatabase } from '../database';
import { DiscoveryService } from '../network/discovery/DiscoveryService';
import { SessionManager } from '../network/session/SessionManager';
import { TransferEngine } from '../network/transfer/TransferEngine';
import { Notifications } from '../native';
import {
  useAppStore,
  useDeviceStore,
  useTransferStore,
  useUiStore,
} from '../store';
import { loadIdentity } from './identity';
import { evaluateTrust } from '../network/pairing/trust';
import type { HandshakePeer } from '../network/pairing/handshake';
import type { PeerSession } from '../network/session/SessionManager';
import type { TransferOfferMessage } from '../models/protocol';
import type { ActiveTransfer } from '../models/transfer';
import type { DiscoveredPeer } from '../models/device';
import { formatBytes, percentOf } from '../utils/format';
import { DeviceDiscovery } from '../native';
import { logger } from './log';

const log = logger('boot');

/**
 * Wires the app together, in the one order that works (§48 phases 3-9):
 *
 *   database  →  identity  →  TCP listener  →  advertise + browse
 *
 * The listener must bind before discovery starts, because the port it binds is
 * what goes into the mDNS TXT record. Identity must exist before either,
 * because the deviceId is what we advertise and the keys are what prove it.
 *
 * Nothing here contacts a network service: every step is local.
 */

let started = false;
let unsubscribers: (() => void)[] = [];
let appStateSubscription: { remove: () => void } | null = null;

export async function startFortShare(): Promise<void> {
  if (started) return;
  started = true;

  const app = useAppStore.getState();

  try {
    await initDatabase();

    const identity = await loadIdentity();
    app.setIdentity(identity);

    await useDeviceStore.getState().refreshHistory();
    await Promise.all([
      useTransferStore.getState().refreshHistory(),
      useTransferStore.getState().refreshReceived(),
    ]);
    void app.refreshStorage();

    wireStoreBridges();

    // Listener first: discovery advertises the port it returns.
    const port = await SessionManager.start(identity, (peer) =>
      handlePairingRequest(peer),
    );
    app.setPort(port);

    TransferEngine.start({
      approveTransfer: (session, offer) => handleTransferOffer(session, offer),
      resolveDuplicate: (fileName, size) =>
        useUiStore.getState().requestDuplicateResolution(fileName, size),
    });

    await DiscoveryService.start(identity, port);

    // Logged once at startup because almost every "cannot connect" report
    // comes down to which interface the device is advertising. Having this in
    // the log makes the next such report answerable without guessing.
    void DeviceDiscovery.getNetworkInfo()
      .then((info) => {
        log.info(`advertising on ${info.primary || '(no address)'}:${port}`, {
          deviceId: identity.deviceId,
          deviceName: identity.deviceName,
          interfaces: info.addresses.map(
            (entry) => `${entry.interfaceName}=${entry.address} (${entry.kind})`,
          ),
        });
        if (!info.primary) {
          log.warn(
            'no usable local address — peers will not be able to reach this device',
          );
        }
      })
      .catch((error: unknown) => log.warn('could not read network info', error));

    watchAppState();
    app.setPhase('ready');
  } catch (error) {
    started = false;
    app.setPhase(
      'failed',
      error instanceof Error ? error.message : 'FortShare could not start',
    );
  }
}

export async function stopFortShare(): Promise<void> {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  appStateSubscription?.remove();
  appStateSubscription = null;

  TransferEngine.stop();
  await DiscoveryService.stop().catch(() => undefined);
  await SessionManager.stop().catch(() => undefined);
  await Notifications.stop().catch(() => undefined);
  started = false;
}

/** Re-advertise after a rename, without disturbing the deviceId. */
export async function republishIdentity(): Promise<void> {
  const identity = useAppStore.getState().identity;
  if (!identity) return;
  SessionManager.updateIdentity(identity);
  await DiscoveryService.republish(identity).catch(() => undefined);
}

// -------------------------------------------------------------- store bridges

function wireStoreBridges(): void {
  // Discovery → device store.
  unsubscribers.push(
    DiscoveryService.subscribe((state) => {
      useDeviceStore.getState().applyDiscovery(state);
      void maybeAutoResume(state.peers);
    }),
  );

  // A successful handshake writes history; reload so the row appears at once.
  unsubscribers.push(
    SessionManager.onSession((session) => {
      void useDeviceStore.getState().refreshHistory();
      useDeviceStore.getState().setConnecting(session.peer.deviceId, false);
    }),
  );

  unsubscribers.push(
    SessionManager.onSessionEnd((deviceId) => {
      useDeviceStore.getState().setConnecting(deviceId, false);
    }),
  );

  // Transfer engine → transfer store, plus the notification mirror.
  unsubscribers.push(
    TransferEngine.subscribe((transfer) => {
      useTransferStore.getState().applyActive(transfer);
      void mirrorToNotification(transfer);
    }),
  );

  unsubscribers.push(
    TransferEngine.onComplete((record) => {
      void useDeviceStore.getState().refreshHistory();
      void useAppStore.getState().refreshStorage();
      void Notifications.stop().catch(() => undefined);

      const store = useUiStore.getState();
      if (record.status === 'completed') {
        const verb = record.direction === 'send' ? 'Sent' : 'Received';
        store.toast(
          `${verb} ${record.fileCount} ${record.fileCount === 1 ? 'file' : 'files'} · ${formatBytes(record.transferredBytes)}`,
          'success',
        );
        void notifyQuietly(
          record.id,
          'Transfer complete',
          `${verb} ${record.fileCount} ${record.fileCount === 1 ? 'file' : 'files'} · ${record.deviceName}`,
        );
      } else if (record.status === 'failed') {
        store.toast(record.errorReason ?? 'Transfer failed', 'error');
        void notifyQuietly(
          record.id,
          'Transfer failed',
          record.errorReason ?? `Could not finish with ${record.deviceName}`,
        );
      }
    }),
  );

  // Notification actions (§36): Pause/Cancel from the shade.
  unsubscribers.push(
    (() => {
      const subscription = Notifications.onAction((event) => {
        const store = useTransferStore.getState();
        if (event.action === 'pause') void store.pause(event.transferId);
        if (event.action === 'cancel') void store.cancel(event.transferId);
      });
      return () => subscription.remove();
    })(),
  );
}

// ------------------------------------------------------------------- prompts

/**
 * An unknown device dialled us.
 *
 * Reached only when the handshake found no pinned key and no valid QR proof,
 * so this really is a stranger and the user has to decide (§15).
 */
async function handlePairingRequest(peer: HandshakePeer): Promise<boolean> {
  return useUiStore.getState().requestPairing(peer);
}

/**
 * A peer is offering us files.
 *
 * Auto-accept is opt-in and only ever applies to a device whose key we have
 * pinned — never to a stranger, however friendly its name (§42).
 */
async function handleTransferOffer(
  session: PeerSession,
  offer: TransferOfferMessage,
): Promise<boolean> {
  const preferences = useAppStore.getState().preferences;

  if (preferences.autoAcceptFromPaired) {
    const decision = await evaluateTrust(
      session.peer.deviceId,
      session.peer.edPub,
    );
    if (decision.kind === 'trusted') {
      useUiStore
        .getState()
        .toast(
          `Receiving ${offer.files.length} ${offer.files.length === 1 ? 'file' : 'files'} from ${session.peer.deviceName}`,
        );
      return true;
    }
  }

  return useUiStore.getState().requestTransferApproval(session, offer);
}

// ------------------------------------------------------------ auto behaviours

/** deviceIds we have already tried to auto-resume, so we do not loop. */
const autoResumeAttempted = new Set<string>();

/**
 * Resume a paused transfer when its peer reappears (§19, §38).
 *
 * Deliberately conservative: opt-in, only for transfers we were sending (the
 * receiver cannot pull), and only once per peer per appearance.
 */
async function maybeAutoResume(
  peers: Map<string, DiscoveredPeer>,
): Promise<void> {
  if (!useAppStore.getState().preferences.autoResume) return;

  for (const deviceId of autoResumeAttempted) {
    if (!peers.has(deviceId)) autoResumeAttempted.delete(deviceId);
  }

  const paused = useTransferStore
    .getState()
    .history.filter(
      (record) =>
        record.status === 'paused' &&
        record.direction === 'send' &&
        peers.has(record.deviceId) &&
        !autoResumeAttempted.has(record.deviceId),
    );

  for (const record of paused) {
    autoResumeAttempted.add(record.deviceId);
    if (!SessionManager.isConnected(record.deviceId)) continue;
    await useTransferStore
      .getState()
      .resume(record.id)
      .catch(() => undefined);
  }
}

/** Keep the Android foreground-service notification in step with progress. */
async function mirrorToNotification(transfer: ActiveTransfer): Promise<void> {
  if (!useAppStore.getState().preferences.notificationsEnabled) return;
  const { record } = transfer;

  if (record.status !== 'active') {
    if (record.status === 'paused') {
      await Notifications.update({
        transferId: record.id,
        title: 'Transfer paused',
        body: record.deviceName,
        progress: Math.round(
          percentOf(record.transferredBytes, record.totalBytes),
        ),
        indeterminate: false,
      }).catch(() => undefined);
    }
    return;
  }

  const verb = record.direction === 'send' ? 'Sending to' : 'Receiving from';
  await Notifications.update({
    transferId: record.id,
    title: `${verb} ${record.deviceName}`,
    body: `${formatBytes(record.transferredBytes)} of ${formatBytes(record.totalBytes)}`,
    progress: Math.round(percentOf(record.transferredBytes, record.totalBytes)),
    indeterminate: false,
  }).catch(() => undefined);
}

async function notifyQuietly(
  id: string,
  title: string,
  body: string,
): Promise<void> {
  if (!useAppStore.getState().preferences.notificationsEnabled) return;
  await Notifications.notify(id, title, body).catch(() => undefined);
}

// ----------------------------------------------------------------- lifecycle

/**
 * Re-scan when the app comes back to the foreground.
 *
 * While backgrounded the OS may have torn down our mDNS registration, and the
 * network may have changed entirely, so the peer list is assumed stale.
 */
function watchAppState(): void {
  let previous: AppStateStatus = RNAppState.currentState;

  appStateSubscription = RNAppState.addEventListener('change', (next) => {
    const returning = previous !== 'active' && next === 'active';
    previous = next;
    if (!returning) return;

    void DiscoveryService.refresh().catch(() => undefined);
    void useDeviceStore.getState().refreshHistory();
    void useAppStore.getState().refreshStorage();
  });
}
