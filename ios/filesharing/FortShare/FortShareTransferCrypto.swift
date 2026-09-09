import Foundation
import CryptoKit

/// AES-256-GCM over the file data path.
///
/// The Swift counterpart of `TransferCrypto.kt`; the two must stay byte
/// compatible or Android↔iOS transfers will fail authentication. Layout of an
/// encrypted DATA frame payload:
///
///     [4B fileIndex][8B offset]  ← header, also the AAD
///     [12B nonce]
///     [ciphertext || 16B tag]
///
/// The header is authenticated but not encrypted, because the receiver needs
/// `offset` to know where to write before it can decrypt. Authenticating it is
/// what stops a valid chunk being relocated to a different offset or file.
enum TransferCrypto {
    static let nonceSize = 12
    static let tagSize = 16

    enum CryptoFault: LocalizedError {
        case badKeyLength(Int)
        case authenticationFailed

        var errorDescription: String? {
            switch self {
            case .badKeyLength(let length):
                return "session key must be 32 bytes, got \(length)"
            case .authenticationFailed:
                return "chunk failed authentication"
            }
        }
    }

    private static func symmetricKey(_ key: Data) throws -> SymmetricKey {
        // AES-256 needs exactly 32 bytes; the HKDF output is that length, and
        // anything else means the handshake and this code have diverged.
        guard key.count == 32 else { throw CryptoFault.badKeyLength(key.count) }
        return SymmetricKey(data: key)
    }

    static func newNonce() -> Data {
        var bytes = Data(count: nonceSize)
        // SecRandomCopyBytes is the platform CSPRNG; a plain random would not
        // be acceptable for a GCM nonce.
        _ = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, nonceSize, buffer.baseAddress!)
        }
        return bytes
    }

    /// Encrypt one chunk. Returns `ciphertext || tag`.
    static func seal(
        key: Data,
        nonce: Data,
        aad: Data,
        plaintext: Data
    ) throws -> Data {
        let sealed = try AES.GCM.seal(
            plaintext,
            using: try symmetricKey(key),
            nonce: try AES.GCM.Nonce(data: nonce),
            authenticating: aad
        )
        // `combined` would prepend the nonce again; the frame already carries
        // it, so only ciphertext+tag goes on the wire.
        return sealed.ciphertext + sealed.tag
    }

    /// Decrypt one chunk.
    ///
    /// Throws when the tag does not verify — the bytes were altered in flight,
    /// or the peer does not hold the session key. The caller drops the
    /// connection rather than writing unverified data to the user's disk.
    static func open(
        key: Data,
        nonce: Data,
        aad: Data,
        sealed: Data
    ) throws -> Data {
        guard sealed.count >= tagSize else { throw CryptoFault.authenticationFailed }

        let ciphertext = sealed.prefix(sealed.count - tagSize)
        let tag = sealed.suffix(tagSize)

        do {
            let box = try AES.GCM.SealedBox(
                nonce: try AES.GCM.Nonce(data: nonce),
                ciphertext: ciphertext,
                tag: tag
            )
            return try AES.GCM.open(
                box,
                using: try symmetricKey(key),
                authenticating: aad
            )
        } catch {
            throw CryptoFault.authenticationFailed
        }
    }
}
