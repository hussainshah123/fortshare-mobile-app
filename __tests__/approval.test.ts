import { useUiStore } from '../src/store/uiStore';
import type { PeerSession } from '../src/network/session/SessionManager';
import type { TransferOfferMessage } from '../src/models/protocol';

/**
 * Incoming-offer approval.
 *
 * Reported from a release build: the receiver tapped Accept, and the *sender*
 * was told "declined by user". Two faults combined —
 *
 *   1. `TransferEngine.stop()` discarded its SessionManager unsubscribes, so a
 *      stop/start cycle left two listeners and every control frame was handled
 *      twice. The duplicated TRANSFER_OFFER found the first offer's prompt
 *      already open and refused it.
 *   2. That refusal was reported as "declined by the user" — a reason that was
 *      simply untrue, and which sent the diagnosis in the wrong direction.
 *
 * A third fault sat behind them: nothing ever retired a prompt whose session
 * had died, and a pending prompt refuses the next offer — so one dropped
 * connection poisoned every later transfer for the life of the app.
 */

function session(deviceId: string, deviceName: string): PeerSession {
  return {
    connectionId: `c-${deviceId}`,
    peer: {
      deviceId,
      deviceName,
      platform: 'android',
      deviceType: 'phone',
      edPub: 'ed',
      xPub: 'x',
      fingerprint: 'fp',
      chunkSize: 262144,
    },
    host: '192.168.1.5',
    port: 4000,
    inbound: true,
    sessionToken: 'token',
    peerSessionToken: 'peer-token',
    expiresAt: Date.now() + 60_000,
    establishedAt: Date.now(),
    cipher: 'aes-256-gcm',
  };
}

function offer(transferId: string): TransferOfferMessage {
  return {
    t: 'TRANSFER_OFFER',
    transferId,
    sessionToken: 'token',
    files: [],
    totalBytes: 0,
  };
}

beforeEach(() => {
  useUiStore.setState({ pairingPrompt: null, transferPrompt: null, toasts: [] });
});

describe('accepting an offer', () => {
  it('resolves as accepted when the user taps Accept', async () => {
    const store = useUiStore.getState();
    const pending = store.requestTransferApproval(session('a', 'Pixel'), offer('t1'));

    useUiStore.getState().answerTransferApproval(true);

    await expect(pending).resolves.toEqual({ accepted: true });
    expect(useUiStore.getState().transferPrompt).toBeNull();
  });

  it('reports a real decline as exactly that', async () => {
    const pending = useUiStore
      .getState()
      .requestTransferApproval(session('a', 'Pixel'), offer('t1'));

    useUiStore.getState().answerTransferApproval(false);

    await expect(pending).resolves.toEqual({
      accepted: false,
      reason: 'declined by the user',
    });
  });
});

describe('a second offer while one is open', () => {
  it('is refused, but never as a user decline', async () => {
    useUiStore
      .getState()
      .requestTransferApproval(session('a', 'HUAWEI JSN-L22'), offer('t1'));

    const second = useUiStore
      .getState()
      .requestTransferApproval(session('b', 'INFINIX'), offer('t2'));

    const result = await second;
    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error('unreachable');

    // The exact lie that made this bug so hard to place.
    expect(result.reason).not.toContain('declined by the user');
    expect(result.reason).toContain('HUAWEI JSN-L22');
  });

  it('leaves the first prompt untouched so the user can still answer it', async () => {
    const first = useUiStore
      .getState()
      .requestTransferApproval(session('a', 'Pixel'), offer('t1'));
    await useUiStore.getState().requestTransferApproval(session('b', 'Other'), offer('t2'));

    // The open prompt must still belong to the first device.
    expect(useUiStore.getState().transferPrompt?.offer.transferId).toBe('t1');

    useUiStore.getState().answerTransferApproval(true);
    await expect(first).resolves.toEqual({ accepted: true });
  });
});

describe('a prompt whose peer disappears', () => {
  it('is retired rather than left pending forever', async () => {
    const pending = useUiStore
      .getState()
      .requestTransferApproval(session('a', 'Pixel'), offer('t1'));

    useUiStore.getState().cancelPromptsForDevice('a', 'peer closed the connection');

    const result = await pending;
    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error('unreachable');
    // The reason travels through untouched — it is the caller that knows
    // why the peer went away, and the sender is told that exact thing.
    expect(result.reason).toBe('peer closed the connection');
    expect(useUiStore.getState().transferPrompt).toBeNull();
  });

  it('does not poison the next transfer', async () => {
    useUiStore.getState().requestTransferApproval(session('a', 'Pixel'), offer('t1'));
    useUiStore.getState().cancelPromptsForDevice('a', 'peer closed the connection');

    // Before the fix this refused every later offer for the life of the app.
    const next = useUiStore
      .getState()
      .requestTransferApproval(session('b', 'INFINIX'), offer('t2'));
    useUiStore.getState().answerTransferApproval(true);

    await expect(next).resolves.toEqual({ accepted: true });
  });

  it('leaves a prompt from a different device alone', async () => {
    const pending = useUiStore
      .getState()
      .requestTransferApproval(session('a', 'Pixel'), offer('t1'));

    useUiStore.getState().cancelPromptsForDevice('someone-else', 'gone');

    expect(useUiStore.getState().transferPrompt).not.toBeNull();
    useUiStore.getState().answerTransferApproval(true);
    await expect(pending).resolves.toEqual({ accepted: true });
  });
});
