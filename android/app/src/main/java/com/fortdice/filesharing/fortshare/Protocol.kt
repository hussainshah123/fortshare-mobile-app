package com.fortdice.filesharing.fortshare

/**
 * Values shared with src/constants/protocol.ts. Keep the two in step; the
 * TypeScript file is the reference.
 */
internal object Protocol {
    const val SERVICE_TYPE: String = "_fortshare._tcp"
    const val PROTOCOL_VERSION: Int = 1

    const val CHUNK_SIZE: Int = 256 * 1024
    /** Slice size for socket->disk copies. Independent of the frame size. */
    const val IO_BUFFER_SIZE: Int = 64 * 1024

    const val PROGRESS_THROTTLE_MS: Long = 250
    const val PROGRESS_THROTTLE_BYTES: Long = 1024L * 1024L

    /**
     * How long a read waits before the connection is probed.
     *
     * This is *not* a failure threshold: an idle session is normal, so a
     * timeout sends a PING and keeps waiting. Only [MAX_IDLE_STRIKES]
     * consecutive silent probes mean the peer is genuinely gone.
     */
    const val READ_TIMEOUT_MS: Int = 20_000

    /**
     * Silent probes tolerated before a connection is declared dead — about a
     * minute of true silence. Long enough to survive a Wi-Fi hiccup, short
     * enough that a peer which walked out of range becomes a recoverable
     * pause rather than a transfer that hangs forever.
     */
    const val MAX_IDLE_STRIKES: Int = 3

    /** TXT record keys. Deliberately terse — mDNS TXT records are small. */
    const val TXT_VERSION = "v"
    const val TXT_DEVICE_ID = "did"
    const val TXT_NAME = "dn"
    const val TXT_PLATFORM = "pf"
    const val TXT_TYPE = "dt"
    const val TXT_FINGERPRINT = "fp"
}
