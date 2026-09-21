import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CHUNK_SIZE,
  CIPHER_AES_GCM,
  CIPHER_NONE,
  FrameType,
  NONCE_SIZE,
  PROTOCOL_VERSION,
  SERVICE_TYPE,
  SUPPORTED_CIPHERS,
  TAG_SIZE,
} from '../src/constants/protocol';

/**
 * Cross-platform protocol parity.
 *
 * The wire format is defined in three places by hand — TypeScript (the
 * reference), `Protocol.kt`/`Frames.kt`/`TransferCrypto.kt` on Android, and
 * `FortShareProtocol.swift`/`FortShareTransferCrypto.swift` on iOS. A single
 * mismatched constant does not fail to compile; it produces transfers that
 * silently corrupt or fail authentication, and only between the two platforms.
 *
 * So the constants are asserted against the native sources directly. This is
 * the cheapest possible guard against the most expensive class of bug in this
 * codebase.
 */

const ROOT = join(__dirname, '..');

function readNative(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

const KOTLIN_PROTOCOL = readNative(
  'android/app/src/main/java/com/fortdice/filesharing/fortshare/Protocol.kt',
);
const KOTLIN_FRAMES = readNative(
  'android/app/src/main/java/com/fortdice/filesharing/fortshare/Frames.kt',
);
const KOTLIN_CRYPTO = readNative(
  'android/app/src/main/java/com/fortdice/filesharing/fortshare/TransferCrypto.kt',
);
const SWIFT_PROTOCOL = readNative(
  'ios/filesharing/FortShare/FortShareProtocol.swift',
);
const SWIFT_CRYPTO = readNative(
  'ios/filesharing/FortShare/FortShareTransferCrypto.swift',
);

describe('frame type bytes', () => {
  it('match on Android', () => {
    expect(KOTLIN_FRAMES).toContain(`TYPE_CONTROL: Int = 0x0${FrameType.CONTROL}`);
    expect(KOTLIN_FRAMES).toContain(`TYPE_DATA: Int = 0x0${FrameType.DATA}`);
    expect(KOTLIN_FRAMES).toContain(`TYPE_PING: Int = 0x0${FrameType.PING}`);
    expect(KOTLIN_FRAMES).toContain(`TYPE_PONG: Int = 0x0${FrameType.PONG}`);
  });

  it('match on iOS', () => {
    expect(SWIFT_PROTOCOL).toContain(`control: UInt8 = 0x0${FrameType.CONTROL}`);
    expect(SWIFT_PROTOCOL).toContain(`data: UInt8 = 0x0${FrameType.DATA}`);
    expect(SWIFT_PROTOCOL).toContain(`ping: UInt8 = 0x0${FrameType.PING}`);
    expect(SWIFT_PROTOCOL).toContain(`pong: UInt8 = 0x0${FrameType.PONG}`);
  });
});

describe('frame geometry', () => {
  it('uses a 5-byte header and a 12-byte DATA header on both platforms', () => {
    // [1B type][4B length] then [4B fileIndex][8B offset].
    expect(KOTLIN_FRAMES).toContain('HEADER_SIZE: Int = 5');
    expect(KOTLIN_FRAMES).toContain('DATA_HEADER_SIZE: Int = 12');
    expect(SWIFT_PROTOCOL).toContain('headerSize = 5');
    expect(SWIFT_PROTOCOL).toContain('dataHeaderSize = 12');
  });

  it('agrees on the connection preamble', () => {
    // "FSHARE" + 0x00 + version. A peer that does not send it is dropped, so
    // a mismatch here means no connection at all.
    expect(KOTLIN_FRAMES).toContain("'F'.code.toByte()");
    expect(KOTLIN_FRAMES).toMatch(/0x00,\s*0x01/);
    // 0x46 'F' ... 0x45 'E', then 0x00 0x01.
    expect(SWIFT_PROTOCOL).toContain('0x46, 0x53, 0x48, 0x41, 0x52, 0x45, 0x00, 0x01');
  });
});

describe('AEAD parameters', () => {
  it('agrees on nonce and tag sizes', () => {
    // A mismatch here fails authentication on every chunk, and only across
    // platforms — the exact bug this file exists to prevent.
    expect(NONCE_SIZE).toBe(12);
    expect(TAG_SIZE).toBe(16);
    expect(KOTLIN_CRYPTO).toContain(`NONCE_SIZE = ${NONCE_SIZE}`);
    expect(KOTLIN_CRYPTO).toContain(`TAG_SIZE = ${TAG_SIZE}`);
    expect(SWIFT_CRYPTO).toContain(`nonceSize = ${NONCE_SIZE}`);
    expect(SWIFT_CRYPTO).toContain(`tagSize = ${TAG_SIZE}`);
  });

  it('uses AES-256-GCM with a 128-bit tag on both platforms', () => {
    expect(KOTLIN_CRYPTO).toContain('"AES/GCM/NoPadding"');
    expect(KOTLIN_CRYPTO).toContain('TAG_BITS = 128');
    expect(SWIFT_CRYPTO).toContain('AES.GCM');
    // Both must reject a key that is not exactly 32 bytes, or they would
    // disagree about what "AES-256" means.
    expect(KOTLIN_CRYPTO).toContain('key.size == 32');
    expect(SWIFT_CRYPTO).toContain('key.count == 32');
  });

  it('authenticates the frame header as AAD on both platforms', () => {
    // Without this an attacker could relocate a valid chunk to another
    // offset or file and the tag would still verify.
    expect(KOTLIN_CRYPTO).toContain('updateAAD(aad)');
    expect(SWIFT_CRYPTO).toContain('authenticating: aad');
  });
});

describe('service identity and chunking', () => {
  it('advertises the same DNS-SD service type', () => {
    expect(KOTLIN_PROTOCOL).toContain(`SERVICE_TYPE: String = "${SERVICE_TYPE}"`);
    expect(SWIFT_PROTOCOL).toContain(`serviceType = "${SERVICE_TYPE}"`);
  });

  it('agrees on the protocol version', () => {
    expect(KOTLIN_PROTOCOL).toContain(`PROTOCOL_VERSION: Int = ${PROTOCOL_VERSION}`);
    expect(SWIFT_PROTOCOL).toContain(`version = ${PROTOCOL_VERSION}`);
  });

  it('agrees on the chunk size', () => {
    expect(CHUNK_SIZE).toBe(256 * 1024);
    expect(KOTLIN_PROTOCOL).toContain('CHUNK_SIZE: Int = 256 * 1024');
    expect(SWIFT_PROTOCOL).toContain('chunkSize = 256 * 1024');
  });

  it('agrees on the TXT record keys', () => {
    // Discovery is where a device is recognised, so a renamed key means a
    // known peer shows up as a stranger.
    for (const key of ['v', 'did', 'dn', 'pf', 'dt', 'fp']) {
      expect(KOTLIN_PROTOCOL).toContain(`"${key}"`);
      expect(SWIFT_PROTOCOL).toContain(`"${key}"`);
    }
  });
});

describe('cipher suite list', () => {
  it('prefers AES-GCM and keeps plaintext as the last resort', () => {
    expect(SUPPORTED_CIPHERS[0]).toBe(CIPHER_AES_GCM);
    expect(SUPPORTED_CIPHERS).toContain(CIPHER_NONE);
    // Order is the negotiation preference, so this must not be reordered
    // casually — it decides what two peers actually use.
    expect(SUPPORTED_CIPHERS.indexOf(CIPHER_AES_GCM)).toBeLessThan(
      SUPPORTED_CIPHERS.indexOf(CIPHER_NONE),
    );
  });
});
