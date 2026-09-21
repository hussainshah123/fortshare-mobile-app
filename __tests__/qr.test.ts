import {
  activeTokens,
  consumableToken,
  forgetScannedPsk,
  generateQr,
  parseQr,
  redeemToken,
  rememberScannedPsk,
  revokeAll,
  scannedPsk,
} from '../src/network/pairing/qr';
import { generateIdentity } from '../src/services/crypto';
import { PROTOCOL_VERSION, QR_TOKEN_TTL_MS } from '../src/constants/protocol';
import type { LocalIdentity } from '../src/models/device';

function identity(): LocalIdentity {
  const keys = generateIdentity();
  return {
    deviceId: 'android-2222',
    deviceName: 'Samsung S25',
    avatar: '📱',
    platform: 'android',
    deviceType: 'phone',
    edPublicKey: keys.edPublicKey,
    xPublicKey: keys.xPublicKey,
    fingerprint: keys.fingerprint,
    createdAt: Date.now(),
  };
}

beforeEach(() => revokeAll());

describe('generating a code (§14)', () => {
  it('carries what is needed to reach and verify one device, and no more', () => {
    const me = identity();
    const { payload } = generateQr(me, '192.168.1.20', 54312);

    expect(payload.v).toBe(PROTOCOL_VERSION);
    expect(payload.deviceId).toBe(me.deviceId);
    expect(payload.edPub).toBe(me.edPublicKey);
    expect(payload.host).toBe('192.168.1.20');
    expect(payload.port).toBe(54312);
    expect(payload.psk).toHaveLength(43); // 32 bytes, base64url, unpadded

    // No private key, ever.
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain('SecretKey');
    expect(Object.keys(payload)).not.toContain('edSecretKey');
    expect(Object.keys(payload)).not.toContain('xSecretKey');
  });

  it('mints a fresh single-use secret each time', () => {
    const me = identity();
    const first = generateQr(me, '192.168.1.20', 54312);
    const second = generateQr(me, '192.168.1.20', 54312);

    expect(first.payload.psk).not.toBe(second.payload.psk);
    expect(activeTokens()).toHaveLength(2);
  });

  it('expires within the advertised window', () => {
    const { payload, expiresAt } = generateQr(identity(), '192.168.1.20', 54312);
    expect(payload.exp).toBe(expiresAt);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(QR_TOKEN_TTL_MS);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('parsing a scanned code', () => {
  it('accepts a code we just generated', () => {
    const { encoded, payload } = generateQr(identity(), '192.168.1.20', 54312);
    const result = parseQr(encoded);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.payload.deviceId).toBe(payload.deviceId);
    expect(result.payload.psk).toBe(payload.psk);
  });

  it('rejects a non-FortShare barcode without throwing', () => {
    // A scanning screen sees every barcode in view and must not crash on
    // someone's boarding pass.
    expect(parseQr('https://example.com')).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(parseQr('')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseQr('[1,2,3]')).toEqual({ ok: false, reason: 'not-fortshare' });
    expect(parseQr('{"hello":"world"}')).toEqual({
      ok: false,
      reason: 'not-fortshare',
    });
    expect(parseQr('null')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an incompatible protocol version', () => {
    const { payload } = generateQr(identity(), '192.168.1.20', 54312);
    const bumped = JSON.stringify({ ...payload, v: PROTOCOL_VERSION + 1 });
    expect(parseQr(bumped)).toEqual({ ok: false, reason: 'version' });
  });

  it('rejects an expired code', () => {
    const { payload } = generateQr(identity(), '192.168.1.20', 54312);
    const stale = JSON.stringify({ ...payload, exp: Date.now() - 1 });
    expect(parseQr(stale)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a code missing a required field', () => {
    const { payload } = generateQr(identity(), '192.168.1.20', 54312);
    for (const field of ['deviceId', 'edPub', 'psk', 'host', 'port'] as const) {
      const partial: Record<string, unknown> = { ...payload };
      delete partial[field];
      expect(parseQr(JSON.stringify(partial)).ok).toBe(false);
    }
  });

  it('defaults optional display fields rather than failing', () => {
    const { payload } = generateQr(identity(), '192.168.1.20', 54312);
    const withoutOptional: Record<string, unknown> = { ...payload };
    delete withoutOptional.deviceType;
    delete withoutOptional.avatar;

    const result = parseQr(JSON.stringify(withoutOptional));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.payload.deviceType).toBe('phone');
    expect(result.payload.avatar).toBe('');
  });
});

describe('token lifecycle', () => {
  it('is single-use', () => {
    const { payload } = generateQr(identity(), '192.168.1.20', 54312);

    expect(consumableToken(payload.psk)).not.toBeNull();
    redeemToken(payload.psk, 'ios-1111');
    // A captured proof cannot be reused by a second device.
    expect(consumableToken(payload.psk)).toBeNull();
    expect(activeTokens()).not.toContain(payload.psk);
  });

  it('does not recognise a token it never issued', () => {
    expect(consumableToken('some-psk-we-never-minted')).toBeNull();
  });

  it('drops every token when the QR screen closes', () => {
    generateQr(identity(), '192.168.1.20', 54312);
    generateQr(identity(), '192.168.1.20', 54312);
    expect(activeTokens()).toHaveLength(2);

    // A photograph of the code taken afterwards is worthless.
    revokeAll();
    expect(activeTokens()).toHaveLength(0);
  });
});

describe('scanned-code memory', () => {
  it('holds a PSK for the device it belongs to', () => {
    rememberScannedPsk('android-2222', 'psk-value', Date.now() + 60_000);
    expect(scannedPsk('android-2222')).toBe('psk-value');
    expect(scannedPsk('someone-else')).toBeNull();
  });

  it('forgets an expired PSK', () => {
    rememberScannedPsk('android-2222', 'psk-value', Date.now() - 1);
    expect(scannedPsk('android-2222')).toBeNull();
  });

  it('forgets a PSK once the pairing has succeeded', () => {
    rememberScannedPsk('android-2222', 'psk-value', Date.now() + 60_000);
    forgetScannedPsk('android-2222');
    expect(scannedPsk('android-2222')).toBeNull();
  });
});

/**
 * Hosted-group credentials in the code.
 *
 * When the generating device has no network, it brings up a Wi-Fi Direct
 * group of its own and the code has to carry the credentials for it — that is
 * what lets two phones pair with no router, no internet, and nothing for the
 * hosting user to accept.
 */
describe('a code for a hosted network', () => {
  const me = identity();

  it('carries the network name and password', () => {
    const { payload } = generateQr(me, '192.168.49.1', 4000, [], {
      ssid: 'DIRECT-Ab-FortShare',
      passphrase: 'swordfish123',
    });

    expect(payload.ssid).toBe('DIRECT-Ab-FortShare');
    expect(payload.pass).toBe('swordfish123');
  });

  it('survives a round trip through the scanner', () => {
    const { encoded } = generateQr(me, '192.168.49.1', 4000, [], {
      ssid: 'DIRECT-Ab-FortShare',
      passphrase: 'swordfish123',
    });

    const result = parseQr(encoded);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.payload.ssid).toBe('DIRECT-Ab-FortShare');
    expect(result.payload.pass).toBe('swordfish123');
    expect(result.payload.host).toBe('192.168.49.1');
  });

  it('omits the fields entirely when no group is hosted', () => {
    const { payload, encoded } = generateQr(me, '192.168.1.5', 4000);

    expect(payload.ssid).toBeUndefined();
    // Absent, not empty: a scanner tests for presence to decide whether to
    // join a network at all.
    expect(encoded).not.toContain('"ssid"');
  });

  it('is treated as an ordinary code when only a name arrives', () => {
    // A truncated or hand-edited code must not send the scanner off trying to
    // join a network with no password.
    const { encoded } = generateQr(me, '192.168.1.5', 4000);
    const broken = JSON.stringify({ ...JSON.parse(encoded), ssid: '' });

    const result = parseQr(broken);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.payload.ssid).toBeUndefined();
  });
});
