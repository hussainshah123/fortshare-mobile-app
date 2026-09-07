import 'react-native-get-random-values';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  KDF_CONTEXT,
  KDF_INFO_QR,
  KDF_INFO_SESSION,
  KDF_INFO_TOKEN,
} from '../constants/protocol';

/**
 * All FortShare cryptography, built on audited primitives (@noble/curves,
 * @noble/hashes). Nothing here talks to the network or to storage.
 *
 *   Ed25519  — long-term identity. Signing proves you own your deviceId.
 *   X25519   — ephemeral key agreement, fresh per connection.
 *   HKDF-SHA256 — derives the session key and session token.
 *   HMAC-SHA256 — proves possession of a QR pre-shared key.
 */

// ---------------------------------------------------------------- base64url

const B64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * base64url without padding. Hand-rolled because React Native has no Buffer
 * and `btoa` mangles bytes above 0x7f.
 */
export function toB64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;

    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function fromB64Url(text: string): Uint8Array {
  const clean = text.replace(/[=]+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64URL_ALPHABET.indexOf(clean[i]!);
    if (v < 0) throw new Error('invalid base64url input');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * UTF-8 encode. Written out rather than using TextEncoder so the module has no
 * ambient-global dependency and behaves identically under Hermes, Node (tests)
 * and any future runtime.
 */
export function utf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.codePointAt(i)!;
    if (cp > 0xffff) i++; // consumed a surrogate pair
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

// -------------------------------------------------------------- key material

export interface IdentityKeyPair {
  edPublicKey: string;
  edSecretKey: string;
  xPublicKey: string;
  xSecretKey: string;
  fingerprint: string;
}

/**
 * Generate this device's long-term identity. Called exactly once, on first
 * launch. The secret keys never leave the device and are never transmitted.
 */
export function generateIdentity(): IdentityKeyPair {
  const ed = ed25519.keygen();
  const x = x25519.keygen();
  return {
    edPublicKey: toB64Url(ed.publicKey),
    edSecretKey: toB64Url(ed.secretKey),
    xPublicKey: toB64Url(x.publicKey),
    xSecretKey: toB64Url(x.secretKey),
    fingerprint: fingerprintOf(toB64Url(ed.publicKey)),
  };
}

/**
 * Short, human-comparable digest of a public key. Shown in the UI so two
 * users can verify out of band that they paired with each other.
 */
export function fingerprintOf(edPublicKeyB64: string): string {
  return toB64Url(sha256(fromB64Url(edPublicKeyB64))).slice(0, 16);
}

/** Formats a fingerprint as "abcd-efgh-ijkl-mnop" for display. */
export function formatFingerprint(fingerprint: string): string {
  return (fingerprint.match(/.{1,4}/g) ?? []).join('-');
}

export interface EphemeralKeyPair {
  publicKey: string;
  secretKey: string;
}

/** Fresh per connection. Gives the handshake forward secrecy. */
export function generateEphemeral(): EphemeralKeyPair {
  const kp = x25519.keygen();
  return {
    publicKey: toB64Url(kp.publicKey),
    secretKey: toB64Url(kp.secretKey),
  };
}

export function randomNonce(): string {
  return toB64Url(randomBytes(32));
}

/** A single-use QR pre-shared key. 32 bytes of entropy. */
export function generatePsk(): string {
  return toB64Url(randomBytes(32));
}

// ---------------------------------------------------------------- transcript

/**
 * Fields each side contributes to the handshake transcript.
 */
export interface TranscriptParty {
  deviceId: string;
  edPub: string;
  xPub: string;
  ephPub: string;
  nonce: string;
}

/**
 * Bind the whole handshake into one digest.
 *
 * Both parties' contributions are sorted by deviceId before hashing, so
 * initiator and responder derive an identical transcript without needing to
 * agree on who is "first". Because the digest covers both nonces and both
 * ephemeral keys, a captured signature cannot be replayed into another
 * session, and a man-in-the-middle cannot swap in its own ephemeral key
 * without invalidating both signatures.
 */
export function handshakeTranscript(
  a: TranscriptParty,
  b: TranscriptParty,
): Uint8Array {
  const [first, second] = a.deviceId < b.deviceId ? [a, b] : [b, a];
  const encode = (p: TranscriptParty) =>
    [p.deviceId, p.edPub, p.xPub, p.ephPub, p.nonce].join('|');
  return sha256(utf8(`${KDF_CONTEXT}\n${encode(first)}\n${encode(second)}`));
}

// ----------------------------------------------------------------- handshake

export function signTranscript(
  transcript: Uint8Array,
  edSecretKeyB64: string,
): string {
  return toB64Url(ed25519.sign(transcript, fromB64Url(edSecretKeyB64)));
}

/**
 * Verify a peer's transcript signature. Returns false rather than throwing on
 * malformed input, so a hostile peer cannot crash the handshake by sending
 * garbage where a signature should be.
 */
export function verifyTranscript(
  transcript: Uint8Array,
  signatureB64: string,
  edPublicKeyB64: string,
): boolean {
  try {
    return ed25519.verify(
      fromB64Url(signatureB64),
      transcript,
      fromB64Url(edPublicKeyB64),
    );
  } catch {
    return false;
  }
}

export interface SessionSecrets {
  /** base64url. Handed to native as the hook for future payload AEAD. */
  sessionKey: string;
  /** base64url. Authorises transfer requests for the life of the connection. */
  sessionToken: string;
}

/**
 * Derive the session key and token from the ECDH shared secret, salted with
 * the transcript so the output is bound to this specific handshake.
 */
export function deriveSession(
  ownEphemeralSecretB64: string,
  peerEphemeralPublicB64: string,
  transcript: Uint8Array,
): SessionSecrets {
  const shared = x25519.getSharedSecret(
    fromB64Url(ownEphemeralSecretB64),
    fromB64Url(peerEphemeralPublicB64),
  );
  const sessionKey = hkdf(
    sha256,
    shared,
    transcript,
    utf8(KDF_INFO_SESSION),
    32,
  );
  const sessionToken = hkdf(
    sha256,
    sessionKey,
    transcript,
    utf8(KDF_INFO_TOKEN),
    32,
  );
  return {
    sessionKey: toB64Url(sessionKey),
    sessionToken: toB64Url(sessionToken),
  };
}

// ------------------------------------------------------------------ QR proof

/**
 * Prove possession of a QR pre-shared key.
 *
 * The scanner sends this alongside its signature. Because the PSK reached it
 * over the camera rather than the network, a man-in-the-middle on the LAN
 * cannot produce it — which is what makes QR pairing safe on first contact.
 */
export function qrProof(psk: string, transcript: Uint8Array): string {
  return toB64Url(
    hmac(sha256, fromB64Url(psk), concat(utf8(KDF_INFO_QR), transcript)),
  );
}

export function verifyQrProof(
  psk: string,
  transcript: Uint8Array,
  proof: string,
): boolean {
  try {
    return constantTimeEqual(fromB64Url(qrProof(psk, transcript)), fromB64Url(proof));
  } catch {
    return false;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Compares without an early return, so timing does not leak the prefix. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Compares two hex digests case-insensitively and in constant time. */
export function digestsMatch(a: string, b: string): boolean {
  const x = utf8(a.toLowerCase());
  const y = utf8(b.toLowerCase());
  return constantTimeEqual(x, y);
}

export function randomId(): string {
  return toHex(randomBytes(16));
}

/** UUID v4, used for the persistent device identity. */
export function uuidV4(): string {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(
    16,
    20,
  )}-${h.slice(20)}`;
}
