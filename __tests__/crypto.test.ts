import {
  constantTimeEqual,
  deriveSession,
  digestsMatch,
  fingerprintOf,
  formatFingerprint,
  fromB64Url,
  generateEphemeral,
  generateIdentity,
  generatePsk,
  handshakeTranscript,
  qrProof,
  randomNonce,
  signTranscript,
  toB64Url,
  toHex,
  utf8,
  uuidV4,
  verifyQrProof,
  verifyTranscript,
  type TranscriptParty,
} from '../src/services/crypto';

describe('base64url', () => {
  it('round-trips every byte value', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(fromB64Url(toB64Url(all))).toEqual(all);
  });

  it('round-trips every length remainder, so padding is handled', () => {
    for (let length = 0; length <= 8; length++) {
      const bytes = new Uint8Array(length).fill(0xab);
      expect(fromB64Url(toB64Url(bytes))).toEqual(bytes);
    }
  });

  it('emits only URL-safe characters', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(toB64Url(bytes)).toMatch(/^[A-Za-z0-9\-_]*$/);
  });

  it('rejects invalid input rather than returning junk', () => {
    expect(() => fromB64Url('not/valid+base64url')).toThrow();
  });
});

describe('utf8', () => {
  it('encodes multi-byte and astral characters correctly', () => {
    expect(Array.from(utf8('a'))).toEqual([0x61]);
    expect(Array.from(utf8('é'))).toEqual([0xc3, 0xa9]);
    expect(Array.from(utf8('€'))).toEqual([0xe2, 0x82, 0xac]);
    // An emoji is a surrogate pair in JS but must encode as one 4-byte
    // sequence — this is what lets a device be named "📱 Phone".
    expect(Array.from(utf8('📱'))).toEqual([0xf0, 0x9f, 0x93, 0xb1]);
  });
});

describe('identity', () => {
  it('produces distinct keypairs with a stable fingerprint', () => {
    const a = generateIdentity();
    const b = generateIdentity();

    expect(a.edPublicKey).not.toEqual(b.edPublicKey);
    expect(fromB64Url(a.edPublicKey)).toHaveLength(32);
    expect(fromB64Url(a.xPublicKey)).toHaveLength(32);
    // The fingerprint is a pure function of the public key, so it can be
    // recomputed rather than stored.
    expect(fingerprintOf(a.edPublicKey)).toEqual(a.fingerprint);
  });

  it('formats a fingerprint into readable groups', () => {
    expect(formatFingerprint('abcdefghijklmnop')).toBe('abcd-efgh-ijkl-mnop');
  });

  it('generates RFC-4122 version 4 UUIDs', () => {
    for (let i = 0; i < 20; i++) {
      expect(uuidV4()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});

/** Builds the two parties of a handshake without any networking. */
function twoParties() {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const aliceEph = generateEphemeral();
  const bobEph = generateEphemeral();

  const aliceParty: TranscriptParty = {
    deviceId: 'aaaa-1111',
    edPub: alice.edPublicKey,
    xPub: alice.xPublicKey,
    ephPub: aliceEph.publicKey,
    nonce: randomNonce(),
  };
  const bobParty: TranscriptParty = {
    deviceId: 'bbbb-2222',
    edPub: bob.edPublicKey,
    xPub: bob.xPublicKey,
    ephPub: bobEph.publicKey,
    nonce: randomNonce(),
  };

  return { alice, bob, aliceEph, bobEph, aliceParty, bobParty };
}

describe('handshake transcript', () => {
  it('is identical whichever order the parties are given in', () => {
    const { aliceParty, bobParty } = twoParties();
    // Initiator and responder each build it with themselves first, so this
    // symmetry is what lets both sides derive the same session key.
    expect(handshakeTranscript(aliceParty, bobParty)).toEqual(
      handshakeTranscript(bobParty, aliceParty),
    );
  });

  it('changes if any field of either party changes', () => {
    const { aliceParty, bobParty } = twoParties();
    const base = handshakeTranscript(aliceParty, bobParty);

    const fields: (keyof TranscriptParty)[] = [
      'deviceId',
      'edPub',
      'xPub',
      'ephPub',
      'nonce',
    ];
    for (const field of fields) {
      const tampered = { ...bobParty, [field]: `${bobParty[field]}x` };
      expect(handshakeTranscript(aliceParty, tampered)).not.toEqual(base);
    }
  });

  it('changes when the nonce changes, so a signature cannot be replayed', () => {
    const { aliceParty, bobParty } = twoParties();
    const first = handshakeTranscript(aliceParty, bobParty);
    const second = handshakeTranscript(aliceParty, {
      ...bobParty,
      nonce: randomNonce(),
    });
    expect(first).not.toEqual(second);
  });
});

describe('session derivation', () => {
  it('gives both sides the same key and token', () => {
    const { aliceEph, bobEph, aliceParty, bobParty } = twoParties();
    const transcript = handshakeTranscript(aliceParty, bobParty);

    const fromAlice = deriveSession(
      aliceEph.secretKey,
      bobParty.ephPub,
      transcript,
    );
    const fromBob = deriveSession(bobEph.secretKey, aliceParty.ephPub, transcript);

    expect(fromAlice.sessionKey).toEqual(fromBob.sessionKey);
    expect(fromAlice.sessionToken).toEqual(fromBob.sessionToken);
    expect(fromB64Url(fromAlice.sessionKey)).toHaveLength(32);
  });

  it('derives a different key for a different transcript', () => {
    const { aliceEph, bobParty, aliceParty } = twoParties();
    const a = deriveSession(
      aliceEph.secretKey,
      bobParty.ephPub,
      handshakeTranscript(aliceParty, bobParty),
    );
    const b = deriveSession(
      aliceEph.secretKey,
      bobParty.ephPub,
      handshakeTranscript(aliceParty, { ...bobParty, nonce: randomNonce() }),
    );
    expect(a.sessionKey).not.toEqual(b.sessionKey);
  });

  it('keeps the session key and token distinct', () => {
    const { aliceEph, bobParty, aliceParty } = twoParties();
    const session = deriveSession(
      aliceEph.secretKey,
      bobParty.ephPub,
      handshakeTranscript(aliceParty, bobParty),
    );
    expect(session.sessionKey).not.toEqual(session.sessionToken);
  });
});

describe('transcript signatures', () => {
  it('verifies with the matching public key', () => {
    const { alice, aliceParty, bobParty } = twoParties();
    const transcript = handshakeTranscript(aliceParty, bobParty);
    const signature = signTranscript(transcript, alice.edSecretKey);

    expect(verifyTranscript(transcript, signature, alice.edPublicKey)).toBe(true);
  });

  it('rejects a signature from a different key — the impersonation case', () => {
    const { alice, bob, aliceParty, bobParty } = twoParties();
    const transcript = handshakeTranscript(aliceParty, bobParty);
    const signature = signTranscript(transcript, alice.edSecretKey);

    // Someone claiming Alice's deviceId but holding Bob's key must fail.
    expect(verifyTranscript(transcript, signature, bob.edPublicKey)).toBe(false);
  });

  it('rejects a signature captured from another session', () => {
    const first = twoParties();
    const second = twoParties();

    const signature = signTranscript(
      handshakeTranscript(first.aliceParty, first.bobParty),
      first.alice.edSecretKey,
    );
    const otherTranscript = handshakeTranscript(
      second.aliceParty,
      second.bobParty,
    );

    expect(
      verifyTranscript(otherTranscript, signature, first.alice.edPublicKey),
    ).toBe(false);
  });

  it('returns false instead of throwing on malformed input', () => {
    const { alice, aliceParty, bobParty } = twoParties();
    const transcript = handshakeTranscript(aliceParty, bobParty);
    // A hostile peer must not be able to crash the handshake with garbage.
    expect(verifyTranscript(transcript, 'not-a-signature', alice.edPublicKey)).toBe(
      false,
    );
    expect(verifyTranscript(transcript, toB64Url(new Uint8Array(64)), '!!')).toBe(
      false,
    );
  });
});

describe('QR proof', () => {
  it('verifies with the right PSK and transcript', () => {
    const { aliceParty, bobParty } = twoParties();
    const transcript = handshakeTranscript(aliceParty, bobParty);
    const psk = generatePsk();

    expect(verifyQrProof(psk, transcript, qrProof(psk, transcript))).toBe(true);
  });

  it('fails with a different PSK — an attacker who never saw the code', () => {
    const { aliceParty, bobParty } = twoParties();
    const transcript = handshakeTranscript(aliceParty, bobParty);
    const proof = qrProof(generatePsk(), transcript);

    expect(verifyQrProof(generatePsk(), transcript, proof)).toBe(false);
  });

  it('fails when replayed into a different handshake', () => {
    const first = twoParties();
    const second = twoParties();
    const psk = generatePsk();

    const proof = qrProof(
      psk,
      handshakeTranscript(first.aliceParty, first.bobParty),
    );
    const otherTranscript = handshakeTranscript(
      second.aliceParty,
      second.bobParty,
    );

    expect(verifyQrProof(psk, otherTranscript, proof)).toBe(false);
  });
});

describe('comparison helpers', () => {
  it('compares equal and unequal byte arrays', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(
      true,
    );
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(
      false,
    );
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(
      false,
    );
  });

  it('matches digests case-insensitively', () => {
    const digest = toHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(digestsMatch(digest, digest.toUpperCase())).toBe(true);
    expect(digestsMatch(digest, 'deadbeee')).toBe(false);
  });
});
