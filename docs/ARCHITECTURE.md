# FortShare — Architecture

Backendless, peer-to-peer file sharing for Android and iOS. No server exists anywhere in this
system. Every byte travels directly from one device's socket to the other's, over the local
network. Every record — devices, pairings, transfers, statistics — lives in SQLite on the device
that created it.

---

## 0. The one decision that shapes everything

A P2P transfer app has two very different jobs:

1. **Control plane** — deciding *what* happens: handshakes, identity proofs, trust decisions,
   transfer negotiation, resume offsets, acknowledgements, completion. Small JSON messages,
   complex logic, must be *byte-identical in meaning* on Android and iOS or the two platforms
   cannot talk.
2. **Data plane** — moving *the bytes*: potentially 5 GB of them, which must never enter
   JavaScript memory.

The naive approaches both fail:

- *Everything in native code* → the protocol gets implemented twice (Kotlin + Swift), the two
  implementations drift, and Android↔iOS transfers break in ways that are miserable to debug.
- *Everything in JavaScript* → a 5 GB file gets base64'd across the bridge. Dead on arrival.

**FortShare splits the two.** The control plane is one TypeScript implementation shared by both
platforms. The data plane is native, and JavaScript never touches a file byte.

```
┌──────────────────────── JavaScript / TypeScript ────────────────────────┐
│  Protocol state machines · trust decisions · crypto handshake ·         │
│  resume negotiation · SQLite persistence · UI                           │
│                                                                          │
│  sends/receives:  small JSON control frames                             │
│  issues commands: "stream file X from offset N over connection C"       │
│  consumes:        throttled progress events                             │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │  Native module boundary
┌───────────────────────────────┴──────────────────────────────────────────┐
│                      Kotlin (Android) · Swift (iOS)                     │
│                                                                          │
│  TCP listener + sockets · frame codec · file→socket streaming ·          │
│  socket→file streaming · backpressure · SHA-256 over file streams ·      │
│  mDNS/NSD advertise + browse · foreground service · notifications        │
│                                                                          │
│  file bytes: disk ──► socket ──► disk        (never crosses the bridge)  │
└──────────────────────────────────────────────────────────────────────────┘
```

Consequence: protocol compatibility between Android and iOS is *structural*, not something we
have to keep testing into existence. There is exactly one implementation of the protocol.

---

## 1. Device identity

Identity is generated once, on first launch, and never derived from anything the network can
change.

```
deviceId   uuid v4, generated on first launch, persisted in MMKV        ← the identity
identityKeys  Ed25519 signing keypair + X25519 agreement keypair        ← proves the identity
fingerprint   base64url(sha256(ed25519PublicKey))[0..16]                ← human-comparable
```

- `deviceId` survives app restarts, Wi-Fi changes, IP changes, router changes, phone restarts.
- The Ed25519 private key never leaves the device. It is what makes `deviceId` *unforgeable*:
  anyone can claim a deviceId in a TXT record, but only the holder of the key can complete the
  handshake for it.
- `deviceName` and `avatar` are mutable display data. Changing them does not touch `deviceId`.
- **IP addresses are cache, never identity.** `lastKnownAddress` exists only to make reconnection
  faster; it is refreshed on every discovery and is never used to decide *who* a device is.

This is what makes requirement §39 fall out for free: a device that moves from `192.168.1.20` to
`192.168.1.45` re-advertises the same `deviceId` under a new address, matches the same history
row, and updates its address. No duplicate is possible, because the primary key is the UUID.

---

## 2. Discovery — DNS-SD / mDNS

One standard protocol, spoken natively on both platforms, so the two interoperate without any
custom bridging.

```
service type:  _fortshare._tcp   (local domain)
instance name: FortShare-<first 8 chars of deviceId>
port:          the ephemeral port the device's own TCP listener bound to
```

The TXT record carries identity, so **discovery alone is enough to recognise a known device** —
no connection required:

| key  | value                                        |
|------|----------------------------------------------|
| `v`  | protocol version (`1`)                       |
| `did`| deviceId (uuid)                              |
| `dn` | device name, base64url (allows any unicode)  |
| `pf` | platform: `android` \| `ios`                  |
| `dt` | device type: `phone` \| `tablet` \| `desktop` |
| `fp` | identity key fingerprint                     |

Platform implementations:

| | Advertise | Browse |
|---|---|---|
| **Android** | `NsdManager.registerService` | `NsdManager.discoverServices` + `resolveService` for host/port |
| **iOS** | `NWListener.service` (the listener *is* the advertiser) | `NWBrowser`, TXT read straight from `NWBrowser.Result.metadata` |

Because both sides publish and consume plain DNS-SD, Android discovers iOS and iOS discovers
Android with no special-casing.

**Recognition flow (§10, §45).** Every discovery event produces a `DiscoveredPeer` keyed by
`did`. The discovery store left-joins it against the `devices` table:

```
discovered.did ∈ devices  →  status: online, badge: "Previously connected", trust from pairings
discovered.did ∉ devices  →  status: online, badge: "New device"
devices row not discovered →  status: offline, keep row, keep stats, show lastSeenAt
```

A device is *never* deleted for being offline. Offline is a rendering state, not a lifecycle event.

**Hotspot (§8) needs no extra code.** A phone's hotspot is a local network with mDNS multicast;
`_fortshare._tcp` resolves across it exactly as it does across a router. No internet route is
required at any point — nothing in the stack resolves a public hostname.

---

## 3. Wire protocol

### Framing

A single length-prefixed frame format on one TCP connection, multiplexing control and bulk data:

```
┌────────┬─────────────┬──────────────────────────────┐
│ type   │ length      │ payload                      │
│ 1 byte │ 4 bytes BE  │ `length` bytes               │
└────────┴─────────────┴──────────────────────────────┘

type 0x01  CONTROL   payload = UTF-8 JSON                    → surfaced to JavaScript
type 0x02  DATA      payload = [4B fileIndex BE][8B offset BE][chunk bytes]
                                                             → written straight to disk natively
type 0x03  PING      payload = empty                         → liveness
type 0x04  PONG      payload = empty
```

Preceded, once per connection, by an 8-byte hello: `"FSHARE" 0x00 0x01` (magic + version). A
peer that does not send it is not FortShare and the socket is dropped immediately.

DATA frames carry `fileIndex` + absolute `offset`, which is what makes resume simple: a chunk is
self-locating. The receiver `pwrite`s it at `offset`; there is no implicit stream position to get
out of sync.

Chunk size is 256 KB, negotiated in the handshake so the two sides can disagree about it in
future versions without breaking.

### Control messages

```
HELLO            → identity, static public keys, nonce, ephemeral pubkey, capabilities
HELLO_ACK        → same, from the responder
AUTH             → Ed25519 signature over the handshake transcript (+ optional QR PSK proof)
AUTH_OK          → session established, sessionToken, expiresAt
AUTH_FAIL        → reason

PAIR_REQUEST     → "I am unknown to you; ask your user"     (only when trust is absent)
PAIR_ACCEPT      → user tapped Accept; peer's key is now pinned
PAIR_REJECT      → user tapped Reject

TRANSFER_OFFER   → { transferId, files: [{fileId, name, size, mimeType, sha256}], totalBytes }
TRANSFER_ACCEPT  → { transferId, files: [{fileId, startOffset, resolution}] }
TRANSFER_REJECT  → { transferId, reason }

FILE_BEGIN       → { transferId, fileId, fileIndex, offset }
CHUNK_ACK        → { transferId, fileId, receivedBytes }     (every ~2 MB, drives sender UI)
FILE_END         → { transferId, fileId, sha256 }            (sender's declared digest)
FILE_VERIFIED    → { transferId, fileId, ok, sha256 }        (receiver's computed digest)
TRANSFER_DONE    → { transferId, filesCompleted, filesFailed }

TRANSFER_PAUSE   → either side may pause
TRANSFER_RESUME  → { transferId } — "what do you already have?"
RESUME_STATE     → { transferId, files: [{fileId, receivedBytes}] }
TRANSFER_CANCEL  → { transferId }
```

---

## 4. Secure pairing and session establishment

### The handshake

An authenticated key exchange built from audited primitives (`@noble/curves`, `@noble/hashes`) —
X25519 for agreement, Ed25519 for identity, HKDF-SHA256 for derivation.

```
A                                                            B
│  HELLO      { deviceId, edPub, xPub, ephPub_A, nonce_A }   │
│ ─────────────────────────────────────────────────────────► │
│  HELLO_ACK  { deviceId, edPub, xPub, ephPub_B, nonce_B }   │
│ ◄───────────────────────────────────────────────────────── │
│                                                             │
│  both compute:                                              │
│     transcript = H( "FortShare/v1" ‖ sorted(A_fields, B_fields) )
│     shared     = X25519(ephPriv_self, ephPub_peer)          │
│     sessionKey = HKDF(shared, salt=transcript, info="fortshare-session")
│                                                             │
│  AUTH  { sig = Ed25519_sign(staticPriv, transcript),        │
│          pskProof? = HMAC(qrPsk, transcript) }              │
│ ◄────────────────────────────────────────────────────────►  │
│  AUTH_OK { sessionToken = HKDF(sessionKey,"token"), expiresAt }
```

The transcript binds *both* nonces, *both* static keys and *both* ephemeral keys, so the
signature cannot be replayed into a different session, and a MITM cannot substitute its own
ephemeral key without invalidating the signature.

### Trust — three ways in, and "same Wi-Fi" is not one of them

Being on the same network grants a device exactly one privilege: the right to ask.

```
peer's deviceId in `pairings` AND stored edPub == presented edPub
    → TRUSTED. Connect silently. This is §45: no QR, no prompt, no re-pairing, ever again.

peer's deviceId in `pairings` AND stored edPub != presented edPub
    → REFUSED, loudly. The deviceId is being impersonated, or the app was reinstalled.
      Requires the user to explicitly re-pair. Never silently accepted.

peer presents a valid, unexpired, unused QR PSK proof
    → TRUSTED via out-of-band channel. Pin the key. (§14)

otherwise
    → UNTRUSTED. PAIR_REQUEST → the user sees "Samsung S25 wants to connect" and must
      tap Accept. Rejection closes the socket.
```

The key-mismatch branch is the one that matters: without it, "remember the device forever" would
mean "trust anyone who claims a remembered UUID forever."

### QR pairing (§14)

The QR encodes only what is needed to reach and authenticate one device, once:

```json
{ "v":1, "did":"…", "dn":"…", "pf":"ios", "dt":"phone",
  "fp":"…", "edPub":"…", "host":"192.168.1.20", "port":54312,
  "psk":"<32 random bytes, base64url>", "exp":1757260000 }
```

`psk` is single-use and expires in 5 minutes. Proving possession of it authenticates the key
*out of band*, which is what defeats a MITM on first contact. No server is involved: the QR is
generated and verified entirely on the two devices.

### Session credentials

`sessionToken` is derived from the handshake, held **in memory only**, and expires (30 min
default). Every `TRANSFER_OFFER` carries it. It dies with the connection; nothing resumable is
authorised by a stale credential.

### What is encrypted

- Handshake: authenticated (Ed25519 + X25519 + HKDF). Real crypto, real MITM resistance.
- File integrity: SHA-256, computed natively over the file stream, verified on receipt before
  the file is published.
- **File chunk payloads: AES-256-GCM**, keyed from the handshake's X25519 agreement.
  Implemented in `TransferCrypto.kt` and `FortShareTransferCrypto.swift`, on the native data
  path — JavaScript never sees a file byte, so that is the only place it could live.

An encrypted DATA frame payload:

```
[4B fileIndex][8B offset]   <- header; authenticated, not encrypted (AAD)
[12B nonce]                 <- random per chunk
[ciphertext || 16B tag]
```

The header stays in the clear because the receiver needs `offset` to know where to write before
it can decrypt; authenticating it as AAD is what prevents a valid chunk being relocated to a
different offset or a different file.

The nonce is **random per chunk** rather than derived from `(fileIndex, offset)`. A derived
nonce repeats if the same chunk is ever re-sent under the same session key — which a
pause/resume on a still-open connection can do — and nonce reuse under GCM leaks the
authentication key. Twelve bytes per 256 KB chunk is 0.005% overhead to remove that entire
class of bug.

A tag that fails to verify drops the connection: altered bytes are never written to the user's
disk. Negotiated via `ciphers` in HELLO and resolved against *our* preference order, so a peer
cannot force a downgrade while AES-GCM is mutually supported. A peer that genuinely cannot
encrypt still transfers, and the UI reports it as unencrypted rather than showing a badge that
lies.

Cross-platform parity is guarded by `__tests__/protocolParity.test.ts`, which asserts the
TypeScript constants against the Kotlin and Swift sources. A mismatched nonce or tag size would
otherwise fail only between platforms, and only at runtime.

---

## 5. Transfer, streaming, and backpressure (§17)

### Sending

Native, per file, on a background thread:

```
open(uri) → loop {
    read 256 KB into a reused buffer
    write DATA frame to socket        ← blocks (Android) / awaits completion (iOS)
    offset += n
    if (offset - lastEmit > 1 MB or 250 ms elapsed) emit progress to JS
}
```

The blocking socket write **is** the backpressure. If the peer's TCP window closes, the read
loop stalls, and memory stays at one 256 KB buffer regardless of whether the file is 10 MB or
50 GB. There is no queue to grow.

### Receiving

```
read frame header → DATA? → stream `length` bytes from socket directly into
                            RandomAccessFile.seek(offset).write(...)  (Android)
                            FileHandle.write(at: offset)              (iOS)
```

Written to `<name>.fortshare-part`, `fsync`'d, then atomically renamed on verification.

### Progress reported to JavaScript

Throttled to ~4 events/sec/file, carrying counters only — never payload. Speed is an EWMA over a
2-second window; ETA is `remainingBytes / smoothedSpeed`.

**Memory ceiling for a 5 GB transfer: one 256 KB buffer per direction.** JavaScript's peak
allocation for the same transfer is a few hundred bytes of counters.

---

## 6. Resume (§19)

The correctness rule: **the receiver's partial file length on disk is the only source of truth.**

Sender-side acknowledgement counters are a UI convenience and are never trusted for resume,
because a sender cannot know whether the last chunk it wrote to a dying socket landed.

```
connection lost mid-file
    sender:   transfer → paused(reason), transfer_files.transferredBytes persisted
    receiver: .fortshare-part kept on disk, row kept in its own DB

device rediscovered → user taps Resume (or auto-resume if enabled)
    sender   → TRANSFER_RESUME { transferId }
    receiver → stat() every .part file, reply RESUME_STATE { fileId → receivedBytes }
    sender   → FILE_BEGIN at exactly that offset for each file; already-complete files skipped
```

Because DATA frames are absolutely-addressed (`offset`, not "next"), resuming is just starting
the read loop at a different `seek`. A 700 MB / 2 GB interruption resumes at 700 MB, and the
final SHA-256 over the whole reassembled file is what proves the seam is correct.

Resume survives app restart and phone restart: `transferId`, `fileId`, per-file `sha256`,
`size` and `transferredBytes` are all in SQLite, and the `.part` files are on disk.

---

## 7. Local persistence

MMKV for small hot settings (deviceId, keys, name, avatar, theme, preferences). SQLite
(`op-sqlite`) for everything relational.

```
devices        deviceId PK · name · platform · type · avatar
               firstConnectedAt · lastConnectedAt · lastSeenAt · lastKnownAddress
               isFavorite · filesSent · filesReceived · bytesSent · bytesReceived

pairings       deviceId PK→devices · edPublicKey · xPublicKey · fingerprint
               pairedAt · pairingMethod (qr|manual|auto) · trusted · revokedAt

transfers      id PK · deviceId→devices · direction(send|receive) · status
               createdAt · completedAt · totalBytes · transferredBytes
               fileCount · avgSpeed · durationMs · errorReason

transfer_files id PK · transferId→transfers · fileIndex · name · uri · destPath
               size · mimeType · sha256 · transferredBytes · status · verified

settings       key PK · value            (JSON, for anything not worth a column)
```

Indexed on `transfers.deviceId`, `transfers.createdAt DESC`, `transfer_files.transferId`.
Statistics (§28) are maintained incrementally on the `devices` row at transfer completion rather
than recomputed by aggregate scan, so the device list stays instant as history grows.

Nothing here has a remote counterpart. There is no sync, no account, no cloud, no export target.

---

## 8. Failure handling (§38)

| Event | Response |
|---|---|
| Wi-Fi disconnected | discovery stops, all peers → offline, active transfers → `paused(network)` |
| Wi-Fi changed / router changed | listener rebinds, re-advertise, re-browse, addresses refreshed |
| IP changed | matched by `deviceId`; `lastKnownAddress` updated; no duplicate row |
| Peer disappeared | peer → offline; history row and stats untouched |
| Connection timeout | `paused(timeout)` with Retry |
| Socket dropped mid-file | `.part` retained; resume path above |
| Destination unavailable | offline device detail screen with stats and Try Again (§12) |
| App backgrounded | Android foreground service; iOS best-effort within OS limits |
| Duplicate filename | Replace / Keep Both / Skip, decided *before* any byte is sent (§26) |

---

## 9. Module layout (§34)

Networking never appears inside a screen component.

```
src/
  native/          the three native module bridges + TypeScript interfaces
  network/
    discovery/     advertise + browse, DiscoveryService
    pairing/       handshake, trust decisions, QR encode/decode
    transfer/      protocol codec, TransferEngine (send + receive state machines)
    session/       connection lifecycle, session tokens, reconnection
  database/        schema, migrations, per-entity repositories
  services/        crypto, filesystem, identity, notifications, permissions
  store/           zustand slices — the only thing screens talk to
  models/          shared types (no `any`, strict mode)
  components/      design system + composed UI
  screens/         Home · Devices · Transfers · Files · Settings + details
  navigation/      tabs + stacks
  hooks/ utils/ constants/ assets/
```

Dependency direction is strictly one-way: `screens → store → network/database → native`.
Screens cannot import from `network/` at all.
