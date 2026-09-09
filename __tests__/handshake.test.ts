import type { ControlMessage } from '../src/models/protocol';
import type { LocalIdentity, PairingRecord } from '../src/models/device';
import { generateIdentity, fingerprintOf } from '../src/services/crypto';

/**
 * An in-memory pairing store, standing in for SQLite.
 *
 * The handshake's trust decisions are the security-critical part of FortShare,
 * so they are exercised against a real store's semantics rather than stubbed
 * out per-test.
 */
// The `mock` prefix is required: babel-plugin-jest-hoist lifts jest.mock calls
// above the imports, and only mock-prefixed bindings may be referenced there.
const mockPinned = new Map<string, PairingRecord>();
/** Stands in for the `devices` table, which `pairings` has a foreign key into. */
const mockDevices = new Map<string, { deviceId: string; name: string }>();
/**
 * Milliseconds each simulated database write takes.
 *
 * Defaults to 0 (a microtask). Raising it models real SQLite, which resolves
 * on a macrotask — the difference that hid a frame-ordering bug from this
 * suite while every real device hit it.
 */
const mockDbDelay = { ms: 0 };

const mockWrite = async (): Promise<void> => {
  if (mockDbDelay.ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, mockDbDelay.ms));
};

jest.mock('../src/database/repositories', () => ({
  deviceRepository: {
    upsertOnConnect: async (peer: { deviceId: string; deviceName: string }) => {
      await mockWrite();
      const existing = mockDevices.get(peer.deviceId);
      mockDevices.set(peer.deviceId, {
        deviceId: peer.deviceId,
        name: peer.deviceName,
      });
      return existing ?? { deviceId: peer.deviceId, name: peer.deviceName };
    },
  },
  pairingRepository: {
    // Parameters are annotated with keywords only: the hoisted factory cannot
    // reference an imported type like PairingRecord.
    find: async (deviceId: string) => mockPinned.get(deviceId) ?? null,
    pin: async (record: {
      deviceId: string;
      edPublicKey: string;
      xPublicKey: string;
      fingerprint: string;
      pairedAt: number;
      method: 'qr' | 'manual' | 'auto';
      trusted: boolean;
    }) => {
      await mockWrite();
      // Mirrors `FOREIGN KEY (deviceId) REFERENCES devices (deviceId)` with
      // PRAGMA foreign_keys = ON. Pinning before the device row exists must
      // fail here, or this suite would keep passing while the real app broke.
      if (!mockDevices.has(record.deviceId)) {
        throw new Error(
          `FOREIGN KEY constraint failed: no devices row for ${record.deviceId}`,
        );
      }
      mockPinned.set(record.deviceId, { ...record, revokedAt: null });
    },
    revoke: async (deviceId: string) => {
      const existing = mockPinned.get(deviceId);
      if (existing) {
        mockPinned.set(deviceId, {
          ...existing,
          trusted: false,
          revokedAt: Date.now(),
        });
      }
    },
    all: async () => [...mockPinned.values()],
    remove: async (deviceId: string) => {
      mockPinned.delete(deviceId);
    },
  },
  transferRepository: {},
  settingsRepository: {},
}));

// Imported after the mock so the handshake picks it up.
import { Handshake, HandshakeError } from '../src/network/pairing/handshake';
import { generateQr, revokeAll, rememberScannedPsk, scannedPsk } from '../src/network/pairing/qr';
import { evaluateTrust } from '../src/network/pairing/trust';

interface Party {
  identity: LocalIdentity;
  secrets: { edSecretKey: string; xSecretKey: string };
}

function makeParty(name: string, deviceId: string): Party {
  const keys = generateIdentity();
  return {
    identity: {
      deviceId,
      deviceName: name,
      avatar: '📱',
      platform: name.includes('iPhone') ? 'ios' : 'android',
      deviceType: 'phone',
      edPublicKey: keys.edPublicKey,
      xPublicKey: keys.xPublicKey,
      fingerprint: keys.fingerprint,
      createdAt: Date.now(),
    },
    secrets: { edSecretKey: keys.edSecretKey, xSecretKey: keys.xSecretKey },
  };
}

interface RunOptions {
  /** Responder's answer when asked about an unknown device. */
  approve?: boolean;
  /** PSK the initiator holds because it scanned the responder's QR. */
  initiatorPsk?: (deviceId: string) => string | null;
  /** Lets a test corrupt messages in flight. */
  tamper?: (message: ControlMessage, from: 'initiator' | 'responder') => ControlMessage | null;
}

/**
 * Run a complete handshake between two Handshake instances over a direct
 * in-memory link.
 *
 * This is the test that matters most: the control plane is one TypeScript
 * implementation used by both Android and iOS, so proving initiator and
 * responder agree here *is* proving cross-platform compatibility — there is no
 * second implementation to drift.
 */
async function runHandshake(
  initiator: Party,
  responder: Party,
  options: RunOptions = {},
) {
  const approvals: string[] = [];

  // Declared before use because the two handshakes reference each other.
  let a: Handshake;
  let b: Handshake;

  const deliver = (
    from: 'initiator' | 'responder',
    message: ControlMessage,
  ): void => {
    const shaped = options.tamper ? options.tamper(message, from) : message;
    if (!shaped) return;
    // setImmediate keeps delivery asynchronous, so neither side can rely on a
    // synchronous reply — which is how a real socket behaves.
    setImmediate(() => {
      if (from === 'initiator') b.handle(shaped);
      else a.handle(shaped);
    });
  };

  a = new Handshake({
    role: 'initiator',
    identity: initiator.identity,
    secrets: initiator.secrets,
    send: async (message) => deliver('initiator', message),
    requestApproval: async () => true,
    scannedPskFor: (deviceId) => options.initiatorPsk?.(deviceId) ?? null,
  });

  b = new Handshake({
    role: 'responder',
    identity: responder.identity,
    secrets: responder.secrets,
    send: async (message) => deliver('responder', message),
    requestApproval: async (peer) => {
      approvals.push(peer.deviceId);
      return options.approve ?? true;
    },
    scannedPskFor: () => null,
  });

  const results = await Promise.allSettled([a.start(), b.start()]);
  return { results, approvals };
}

beforeEach(() => {
  mockPinned.clear();
  mockDevices.clear();
  mockDbDelay.ms = 0;
  revokeAll();
});

describe('first contact between two unknown devices', () => {
  it('completes, prompts only the responder, and pins both keys', async () => {
    const iphone = makeParty("Hussain's iPhone", 'ios-1111');
    const samsung = makeParty('Samsung S25', 'android-2222');

    const { results, approvals } = await runHandshake(iphone, samsung);

    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('fulfilled');

    // §44: the device that was tapped asks its user; the initiator does not.
    expect(approvals).toEqual(['ios-1111']);

    // Both sides now hold the other's key, which is what makes the next
    // connection silent (§45).
    expect(mockPinned.get('ios-1111')?.edPublicKey).toBe(iphone.identity.edPublicKey);
    expect(mockPinned.get('android-2222')?.edPublicKey).toBe(
      samsung.identity.edPublicKey,
    );
  });

  it('gives both sides the same session secrets', async () => {
    const a = makeParty('Pixel 8', 'android-a');
    const b = makeParty('iPad Pro', 'ios-b');

    const { results } = await runHandshake(a, b);
    const [initiator, responder] = results;
    if (initiator!.status !== 'fulfilled' || responder!.status !== 'fulfilled') {
      throw new Error('handshake did not complete');
    }

    // Each side's own token is the other's peer token, and vice versa —
    // that pairing is what authorises transfer offers in both directions.
    expect(initiator!.value.sessionToken).toBe(responder!.value.peerSessionToken);
    expect(responder!.value.sessionToken).toBe(initiator!.value.peerSessionToken);
    expect(initiator!.value.sessionKey).toBe(responder!.value.sessionKey);
    expect(initiator!.value.expiresAt).toBeGreaterThan(Date.now());
  });

  it('reports the peer identity it verified', async () => {
    const a = makeParty('Pixel 8', 'android-a');
    const b = makeParty("Ahmed's iPhone", 'ios-b');

    const { results } = await runHandshake(a, b);
    const initiator = results[0];
    if (initiator!.status !== 'fulfilled') throw new Error('did not complete');

    expect(initiator!.value.peer.deviceId).toBe('ios-b');
    expect(initiator!.value.peer.deviceName).toBe("Ahmed's iPhone");
    expect(initiator!.value.peer.platform).toBe('ios');
    expect(initiator!.value.peer.fingerprint).toBe(
      fingerprintOf(b.identity.edPublicKey),
    );
  });

  it('fails and pins nothing when the responder rejects', async () => {
    const a = makeParty('Pixel 8', 'android-a');
    const b = makeParty('iPad', 'ios-b');

    const { results } = await runHandshake(a, b, { approve: false });

    expect(results[0]!.status).toBe('rejected');
    expect(results[1]!.status).toBe('rejected');
    expect(mockPinned.size).toBe(0);
  });
});

describe('reconnecting to a remembered device (§45)', () => {
  it('succeeds with no prompt at all', async () => {
    const iphone = makeParty("Hussain's iPhone", 'ios-1111');
    const samsung = makeParty('Samsung S25', 'android-2222');

    // Monday.
    const first = await runHandshake(iphone, samsung);
    expect(first.approvals).toHaveLength(1);

    // Friday: same devices, different IPs — which the handshake never sees,
    // because identity is the deviceId plus the key, not an address.
    const second = await runHandshake(iphone, samsung);

    expect(second.results[0]!.status).toBe('fulfilled');
    expect(second.results[1]!.status).toBe('fulfilled');
    // The whole promise of the product: no second prompt, ever.
    expect(second.approvals).toEqual([]);
  });

  it('reports how the trust was established', async () => {
    const a = makeParty('Pixel', 'android-a');
    const b = makeParty('iPhone', 'ios-b');

    await runHandshake(a, b);
    const { results } = await runHandshake(a, b);
    const initiator = results[0];
    if (initiator!.status !== 'fulfilled') throw new Error('did not complete');

    expect(initiator!.value.trustMethod).toBe('auto');
  });
});

describe('impersonation', () => {
  it('refuses a peer that reuses a remembered deviceId with a different key', async () => {
    const real = makeParty('Samsung S25', 'android-2222');
    const laptop = makeParty('Pixel', 'android-a');

    await runHandshake(laptop, real);
    expect(mockPinned.has('android-2222')).toBe(true);

    // Same deviceId, brand new keypair — an attacker, or a reinstall.
    const impostor = makeParty('Samsung S25', 'android-2222');
    const { results } = await runHandshake(laptop, impostor);

    expect(results[0]!.status).toBe('rejected');
    if (results[0]!.status !== 'rejected') throw new Error('unreachable');
    const error = results[0]!.reason as HandshakeError;
    expect(error.reason).toBe('key-mismatch');

    // The original pinning must survive the attempt untouched.
    expect(mockPinned.get('android-2222')?.edPublicKey).toBe(
      real.identity.edPublicKey,
    );
  });

  it('detects a forged signature', async () => {
    const a = makeParty('Pixel', 'android-a');
    const b = makeParty('iPhone', 'ios-b');

    const { results } = await runHandshake(a, b, {
      tamper: (message, from) => {
        if (from === 'initiator' && message.t === 'AUTH') {
          // A man-in-the-middle who swapped the ephemeral key would have to
          // produce a signature it cannot compute; this simulates the result.
          return { ...message, sig: message.sig.slice(0, -4) + 'AAAA' };
        }
        return message;
      },
    });

    expect(results[1]!.status).toBe('rejected');
    expect(mockPinned.size).toBe(0);
  });

  it('refuses to pair with itself', async () => {
    const solo = makeParty('Pixel', 'android-same');
    const { results } = await runHandshake(solo, solo);
    expect(results.some((result) => result.status === 'rejected')).toBe(true);
  });
});

describe('QR pairing (§14)', () => {
  it('pairs with no prompt when the initiator proves it scanned the code', async () => {
    const shower = makeParty('Samsung S25', 'android-2222');
    const scanner = makeParty("Hussain's iPhone", 'ios-1111');

    // The responder mints a code; the initiator "scans" it.
    const qr = generateQr(shower.identity, '192.168.1.20', 54312);
    rememberScannedPsk(qr.payload.deviceId, qr.payload.psk, qr.payload.exp);

    const { results, approvals } = await runHandshake(scanner, shower, {
      initiatorPsk: scannedPsk,
    });

    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('fulfilled');
    // Possession of the code replaces the Accept/Reject step.
    expect(approvals).toEqual([]);

    const record = mockPinned.get('ios-1111');
    expect(record?.method).toBe('qr');
  });

  it('does not accept the same code twice', async () => {
    const shower = makeParty('Samsung S25', 'android-2222');
    const first = makeParty('iPhone A', 'ios-a');
    const second = makeParty('iPhone B', 'ios-b');

    const qr = generateQr(shower.identity, '192.168.1.20', 54312);

    rememberScannedPsk(qr.payload.deviceId, qr.payload.psk, qr.payload.exp);
    const one = await runHandshake(first, shower, { initiatorPsk: scannedPsk });
    expect(one.results[0]!.status).toBe('fulfilled');
    expect(one.approvals).toEqual([]);

    // A second device replaying the same PSK gets no free pass: the token was
    // burned, so it falls back to needing a human.
    rememberScannedPsk(qr.payload.deviceId, qr.payload.psk, qr.payload.exp);
    const two = await runHandshake(second, shower, {
      initiatorPsk: scannedPsk,
      approve: false,
    });
    expect(two.approvals).toEqual(['ios-b']);
    expect(two.results[0]!.status).toBe('rejected');
  });
});

describe('trust evaluation', () => {
  it('classifies unknown, trusted, mismatched and revoked peers', async () => {
    const device = makeParty('Samsung', 'android-2222');

    expect((await evaluateTrust('android-2222', device.identity.edPublicKey)).kind)
      .toBe('unknown');

    mockPinned.set('android-2222', {
      deviceId: 'android-2222',
      edPublicKey: device.identity.edPublicKey,
      xPublicKey: device.identity.xPublicKey,
      fingerprint: device.identity.fingerprint,
      pairedAt: Date.now(),
      method: 'manual',
      trusted: true,
      revokedAt: null,
    });
    expect((await evaluateTrust('android-2222', device.identity.edPublicKey)).kind)
      .toBe('trusted');

    const other = makeParty('Impostor', 'android-2222');
    expect((await evaluateTrust('android-2222', other.identity.edPublicKey)).kind)
      .toBe('key-mismatch');

    mockPinned.set('android-2222', {
      ...mockPinned.get('android-2222')!,
      trusted: false,
      revokedAt: Date.now(),
    });
    expect((await evaluateTrust('android-2222', device.identity.edPublicKey)).kind)
      .toBe('revoked');
  });
});

/**
 * Regression: pairing used to fail with "bad signature".
 *
 * `pinTrust` writes to `pairings`, which has a foreign key into `devices`.
 * The device row was only created later, in `SessionManager.promote()`, so the
 * insert violated the constraint, SQLite threw, and the handshake's catch-all
 * relabelled a local database fault as a failed signature. Every first-time
 * pairing broke, and the error pointed at the wrong subsystem.
 */
describe('regression: pinning records the device first', () => {
  it('creates the devices row before the pairing row', async () => {
    const a = makeParty('Pixel 8', 'android-a');
    const b = makeParty('iPhone', 'ios-b');

    const { results } = await runHandshake(a, b);

    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('fulfilled');
    // Both sides must have a device row, or the pairing insert would have
    // thrown the foreign-key error the mock now enforces.
    expect(mockDevices.has('android-a')).toBe(true);
    expect(mockDevices.has('ios-b')).toBe(true);
  });

  it('records the device for a QR pairing too', async () => {
    const shower = makeParty('Samsung S25', 'android-2222');
    const scanner = makeParty('iPhone', 'ios-1111');

    const qr = generateQr(shower.identity, '192.168.1.20', 54312);
    rememberScannedPsk(qr.payload.deviceId, qr.payload.psk, qr.payload.exp);

    const { results } = await runHandshake(scanner, shower, {
      initiatorPsk: scannedPsk,
    });

    expect(results[0]!.status).toBe('fulfilled');
    expect(mockDevices.has('ios-1111')).toBe(true);
  });

  it('reports a local fault as internal, never as bad-signature', async () => {
    const a = makeParty('Pixel 8', 'android-a');
    const b = makeParty('iPhone', 'ios-b');

    // Force the pairing write to fail the way a constraint violation would.
    const store = mockDevices.set;
    mockDevices.set = () => {
      throw new Error('disk I/O error');
    };

    try {
      const { results } = await runHandshake(a, b);
      const failure = results.find((result) => result.status === 'rejected');
      expect(failure).toBeDefined();
      if (failure?.status !== 'rejected') throw new Error('unreachable');

      const error = failure.reason as HandshakeError;
      // The distinction that matters: our bug, not the peer's credentials.
      expect(error.reason).toBe('internal');
      expect(error.reason).not.toBe('bad-signature');
    } finally {
      mockDevices.set = store;
    }
  });
});

/**
 * Regression: "peer sent AUTH_OK before proving its identity".
 *
 * Observed on two phones: four consecutive failures, then success on the
 * fifth. `handle()` used to dispatch each frame without awaiting the previous
 * one, so AUTH_OK could be processed while AUTH was still awaiting its
 * database write — `peerAuthVerified` was still false and the peer was
 * accused of skipping authentication.
 *
 * The fifth attempt succeeded because by then the `devices` row already
 * existed, so the write was fast enough to win the race. That is exactly the
 * kind of bug that must be pinned by a test rather than by a lucky retry.
 */
describe('regression: frames are processed in order', () => {
  it('completes when database writes are slower than frame arrival', async () => {
    // Slow enough that AUTH_OK is guaranteed to arrive mid-write.
    mockDbDelay.ms = 25;

    const a = makeParty('INFINIX Infinix X6885', 'infinix-1');
    const b = makeParty('HUAWEI JSN-L22', 'huawei-2');

    const { results } = await runHandshake(a, b);

    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('fulfilled');
  });

  it('never blames the peer for a race on our own side', async () => {
    mockDbDelay.ms = 20;

    const a = makeParty('Pixel 8', 'android-a');
    const b = makeParty('iPhone', 'ios-b');
    const { results } = await runHandshake(a, b);

    for (const result of results) {
      if (result.status !== 'rejected') continue;
      const error = result.reason as HandshakeError;
      // The specific misdiagnosis this bug produced.
      expect(error.message).not.toContain('before proving its identity');
      expect(error.reason).not.toBe('bad-signature');
    }
  });

  it('still works first time, repeatedly, with slow writes', async () => {
    mockDbDelay.ms = 15;

    // The original bug failed the first four attempts, so one pass is not
    // evidence. Fresh identities each round, so nothing is warmed up.
    for (let attempt = 0; attempt < 5; attempt++) {
      mockPinned.clear();
      mockDevices.clear();

      const a = makeParty('Phone A', `a-${attempt}`);
      const b = makeParty('Phone B', `b-${attempt}`);
      const { results } = await runHandshake(a, b);

      expect(results[0]!.status).toBe('fulfilled');
      expect(results[1]!.status).toBe('fulfilled');
    }
  });
});

/**
 * Payload encryption is negotiated, not assumed.
 *
 * Neither ShareIt nor Zapya encrypts file payloads on the wire, so this is the
 * app's strongest security claim — which makes it worth pinning that the
 * negotiation cannot be talked down, and that a peer which cannot decrypt is
 * never handed ciphertext.
 */
describe('cipher negotiation', () => {
  it('agrees on AES-256-GCM when both sides support it', async () => {
    const a = makeParty('Pixel 8', 'android-a');
    const b = makeParty('iPhone', 'ios-b');

    const { results } = await runHandshake(a, b);
    const [initiator, responder] = results;
    if (initiator!.status !== 'fulfilled' || responder!.status !== 'fulfilled') {
      throw new Error('handshake did not complete');
    }

    expect(initiator!.value.cipher).toBe('aes-256-gcm');
    // Both sides must reach the *same* conclusion, or one encrypts while the
    // other writes ciphertext to disk as if it were the file.
    expect(responder!.value.cipher).toBe(initiator!.value.cipher);
  });

  it('falls back to plaintext against a peer that advertises no cipher', async () => {
    const a = makeParty('Pixel 8', 'android-a');
    const b = makeParty('Old build', 'legacy-b');

    const { results } = await runHandshake(a, b, {
      tamper: (message, from) => {
        // Simulate a build predating encryption: no `ciphers` field at all.
        if (from === 'responder' && message.t === 'HELLO_ACK') {
          const { ciphers, ...rest } = message;
          void ciphers;
          return rest as typeof message;
        }
        return message;
      },
    });

    const initiator = results[0];
    if (initiator!.status !== 'fulfilled') throw new Error('did not complete');
    // Degrades, but visibly: the UI reports the transfer as unencrypted
    // rather than implying protection that is not there.
    expect(initiator!.value.cipher).toBe('none');
  });

  it('cannot be downgraded while both sides still support AES-GCM', async () => {
    const a = makeParty('Pixel 8', 'android-a');
    const b = makeParty('iPhone', 'ios-b');

    const { results } = await runHandshake(a, b, {
      tamper: (message, from) => {
        // A peer claiming to prefer plaintext must not drag us down: our own
        // preference order decides, and AES-GCM is still mutually supported.
        if (from === 'responder' && message.t === 'HELLO_ACK') {
          return { ...message, ciphers: ['none', 'aes-256-gcm'] };
        }
        return message;
      },
    });

    const initiator = results[0];
    if (initiator!.status !== 'fulfilled') throw new Error('did not complete');
    expect(initiator!.value.cipher).toBe('aes-256-gcm');
  });
});

/**
 * Pairing is symmetric.
 *
 * A user reasonably expects that once two devices are paired, either one can
 * send to the other — it should not matter which phone held the camera. That
 * only holds if *both* sides pin the other's key during the handshake, so it
 * is worth asserting rather than assuming.
 */
describe('pairing works in both directions', () => {
  it('pins both devices when one scans the other\'s QR', async () => {
    const shower = makeParty('HUAWEI JSN-L22', 'huawei-2');
    const scanner = makeParty('INFINIX Infinix X6885', 'infinix-1');

    const qr = generateQr(shower.identity, '192.168.1.39', 45903);
    rememberScannedPsk(qr.payload.deviceId, qr.payload.psk, qr.payload.exp);

    const { results } = await runHandshake(scanner, shower, {
      initiatorPsk: scannedPsk,
    });
    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('fulfilled');

    // The device that showed the code trusts the scanner...
    expect(mockPinned.get('infinix-1')?.edPublicKey).toBe(
      scanner.identity.edPublicKey,
    );
    // ...and the scanner trusts the device that showed it. Either can now
    // initiate, so "who scanned" stops mattering the moment pairing succeeds.
    expect(mockPinned.get('huawei-2')?.edPublicKey).toBe(
      shower.identity.edPublicKey,
    );
  });

  it('lets the device that showed the QR later dial the scanner', async () => {
    const shower = makeParty('HUAWEI JSN-L22', 'huawei-2');
    const scanner = makeParty('INFINIX Infinix X6885', 'infinix-1');

    const qr = generateQr(shower.identity, '192.168.1.39', 45903);
    rememberScannedPsk(qr.payload.deviceId, qr.payload.psk, qr.payload.exp);
    await runHandshake(scanner, shower, { initiatorPsk: scannedPsk });

    // Roles reversed, no QR this time: the shower is now the initiator.
    const { results, approvals } = await runHandshake(shower, scanner);

    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('fulfilled');
    // And nobody is asked to approve anything, because both keys are pinned.
    expect(approvals).toEqual([]);
  });
});
