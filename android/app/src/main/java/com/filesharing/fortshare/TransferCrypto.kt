package com.filesharing.fortshare

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * AES-256-GCM over the file data path.
 *
 * This is what makes a FortShare transfer private on the wire, rather than
 * merely verified after the fact. The key comes from the handshake's X25519
 * agreement (see services/crypto.ts) and never touches the network.
 *
 * Layout of an encrypted DATA frame payload:
 *
 *   [4B fileIndex][8B offset]  ← header, also the AAD
 *   [12B nonce]
 *   [ciphertext || 16B tag]
 *
 * The header is authenticated but not encrypted, because the receiver needs
 * `offset` to know where to write before it can decrypt. Using it as AAD is
 * what stops an attacker relocating a valid chunk to a different offset or a
 * different file — the tag would no longer verify.
 */
internal object TransferCrypto {
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val TAG_BITS = 128
    const val NONCE_SIZE = 12
    const val TAG_SIZE = 16

    private val random = SecureRandom()

    fun newNonce(): ByteArray = ByteArray(NONCE_SIZE).also { random.nextBytes(it) }

    private fun keyOf(key: ByteArray): SecretKeySpec {
        // AES-256 needs exactly 32 bytes; the HKDF output is that length, and
        // anything else means the handshake and this code have diverged.
        require(key.size == 32) { "session key must be 32 bytes, got ${key.size}" }
        return SecretKeySpec(key, "AES")
    }

    /**
     * Encrypt one chunk in place-ish: returns ciphertext||tag.
     *
     * @param aad the 12-byte frame header (fileIndex + offset).
     */
    fun seal(
        key: ByteArray,
        nonce: ByteArray,
        aad: ByteArray,
        plaintext: ByteArray,
        offset: Int,
        length: Int,
    ): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, keyOf(key), GCMParameterSpec(TAG_BITS, nonce))
        cipher.updateAAD(aad)
        return cipher.doFinal(plaintext, offset, length)
    }

    /**
     * Decrypt one chunk.
     *
     * Throws when the tag does not verify — which means the bytes were altered
     * in flight or the peer does not hold the session key. The caller drops
     * the connection rather than writing unverified data to the user's disk.
     */
    fun open(
        key: ByteArray,
        nonce: ByteArray,
        aad: ByteArray,
        ciphertext: ByteArray,
        offset: Int,
        length: Int,
    ): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, keyOf(key), GCMParameterSpec(TAG_BITS, nonce))
        cipher.updateAAD(aad)
        return cipher.doFinal(ciphertext, offset, length)
    }
}
