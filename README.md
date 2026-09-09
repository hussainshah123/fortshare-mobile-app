# FortShare

Peer-to-peer file sharing for Android and iOS, with no backend of any kind.

Files travel directly from one device's socket to the other's over the local
network. Devices, pairings, transfers and statistics live in SQLite on the
device that created them. There is no server, no account, no cloud, and no
step that needs an internet connection — discovery, pairing, transfer, resume
and history all work with the internet switched off.

The product idea in one line:

> **Connect once → the device is remembered forever → it is recognised
> automatically when nearby → pick it from history → send immediately.**

---

## How it works

The full design is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. The one
decision worth knowing up front:

**The control plane is TypeScript; the data plane is native.**

- *Control* — handshakes, identity proofs, trust decisions, transfer
  negotiation, resume offsets: one TypeScript implementation, shared by both
  platforms. Android↔iOS compatibility is therefore structural rather than
  something that has to be tested into existence.
- *Data* — mDNS, TCP sockets, the frame codec, and file↔socket streaming: Kotlin
  on Android, Swift on iOS. **File bytes never cross into JavaScript.** A 5 GB
  transfer costs one 256 KB buffer per direction; JavaScript sees only
  throttled counters.

```
Device A ── local Wi-Fi / hotspot / peer-to-peer ── Device B
   │                                                   │
   └── mDNS `_fortshare._tcp` ──► discovery ◄──────────┘
   └── TCP + framed protocol ──► transfer ◄────────────┘
```

| Concern | Approach |
|---|---|
| Identity | UUID v4 + Ed25519 keypair, generated once. Stable across restarts, IP changes, router changes, renames. **Never derived from an IP.** |
| Discovery | DNS-SD. `NsdManager` on Android, `NWListener`/`NWBrowser` on iOS. The TXT record carries the deviceId, so a known device is recognised *before* any connection. |
| Pairing | Authenticated X25519 + Ed25519 handshake over a transcript binding both nonces and both ephemeral keys. Keys are pinned; a remembered deviceId presenting a *different* key is refused, not re-pinned. |
| Transfer | Length-prefixed frames on one TCP connection. DATA frames are absolutely addressed (`fileIndex` + `offset`), which is what makes resume a seek rather than a replay. |
| Resume | The receiver's on-disk `.part` length is the only authority. Survives app restart and phone restart. |
| Integrity | SHA-256 streamed natively over each whole file, verified on receipt before the file is published. |
| Storage | MMKV for identity and preferences; SQLite for devices, pairings, transfers and files. |

---

## Getting started

Requires the standard React Native CLI environment — Node 22+, JDK 17, Android
SDK, Xcode 16+ with CocoaPods. No Expo.

```bash
npm install
cd ios && RCT_NEW_ARCH_ENABLED=1 pod install && cd ..

npm start            # Metro
npm run android
npm run ios
```

Two devices on the same Wi-Fi (or one device on the other's hotspot) are needed
to see anything interesting — a single device has nobody to discover.

### Checks

```bash
npm run typecheck    # tsc --noEmit, strict, no `any`
npm run lint         # zero warnings
npm test             # 83 tests
npm run codegen      # regenerate native module specs after editing src/native/specs
```

---

## Permissions, and why

Each is requested at the moment it is needed, never at launch.

| Permission | Why | When |
|---|---|---|
| Local Network (iOS) | Bonjour returns nothing without it | first time the Devices screen browses |
| `INTERNET` (Android) | Android gates *all* socket creation behind it, including purely local ones | install time; no narrower permission exists |
| `CHANGE_WIFI_MULTICAST_STATE` | mDNS is multicast | install time |
| Camera | reading a pairing QR code | opening the scanner |
| `READ_MEDIA_IMAGES` / `_VIDEO` / `_AUDIO`, Photo Library | showing you which media to send | opening Photos/Videos in the picker |
| Notifications | transfer progress and completion | first transfer |
| `FOREGROUND_SERVICE_DATA_SYNC` | keeping a transfer alive when backgrounded | install time |

There is no blanket storage permission. Arbitrary files go through the system
document picker, which needs none.

---

## Project layout

```
src/
  native/        the three TurboModules + typed TS facades
    specs/       codegen specs — the native contract
  network/
    discovery/   advertise + browse
    pairing/     handshake, trust decisions, QR
    transfer/    protocol engine, speed/ETA
    session/     connection lifecycle, session tokens
  database/      schema, migrations, repositories
  services/      crypto, identity, storage, permissions, bootstrap
  store/         zustand slices — the only thing screens talk to
  models/        shared types
  components/    design system + composed UI
  screens/       Home · Devices · Transfers · Files · Settings + details
  theme/         tokens + light/dark provider

android/app/src/main/java/com/filesharing/fortshare/   Kotlin
ios/filesharing/FortShare/                             Swift + ObjC++ shims
```

Dependency direction is one-way: `screens → store → network/database → native`.
Screens never import from `network/`.

---

## Security

- Long-term Ed25519 identity. A deviceId is public — it is in every mDNS TXT
  record — so what actually authenticates a peer is the key, not the id.
- Ephemeral X25519 per connection, HKDF-SHA256 session key bound to a
  transcript covering both nonces and both ephemeral keys. A captured
  signature cannot be replayed into another session.
- Being on the same Wi-Fi grants a device exactly one privilege: the right to
  ask. Trust needs a pinned key, a valid QR proof, or an explicit Accept.
- Session credentials are memory-only and expire.
- QR codes are single-use and expire in five minutes; possession proves
  identity *out of band*, which is what defeats a man-in-the-middle on first
  contact.

### Payloads are encrypted

Every file chunk is sealed with **AES-256-GCM** on the native data path, using
a key derived from the handshake's X25519 agreement — so the key never touches
the network and is fresh for every connection.

- 12-byte random nonce per chunk, carried in the frame. Random rather than
  derived from `(fileIndex, offset)`, because a derived nonce would repeat if a
  chunk were re-sent under the same session key — and a repeated nonce under
  GCM is catastrophic, not untidy.
- The frame header (`fileIndex` + `offset`) is the AAD, so a valid chunk cannot
  be relocated to a different offset or file.
- A tag that fails to verify drops the connection. Altered bytes are never
  written to disk.
- Negotiated in HELLO, and the preference order is ours — a peer cannot
  downgrade a mutually-supported cipher. If a peer genuinely cannot encrypt,
  the transfer still runs and the UI **says so** rather than showing a badge
  that lies.

Hardware-accelerated on every ARMv8 device, so a multi-gigabyte transfer pays
no meaningful cost for it.

### Remaining limitations

- **Android needs a shared network.** Discovery is mDNS over IP, so two Android
  devices need the same Wi-Fi or a hotspot. iOS↔iOS already works with no
  shared network via AWDL peer-to-peer. Wi-Fi Direct is the missing piece for
  Android — see the roadmap note below.
- **No desktop or web client.** Android and iOS only.
- **One device per transfer.** No 1→many group send.
- **iOS background execution is bounded** — a long transfer that gets
  suspended becomes a paused, resumable transfer rather than a failed one.
- **Folder transfers flatten.** Directory structure is not recreated.

More detail in [docs/TESTING.md](docs/TESTING.md).

---

## Testing

83 automated tests cover the protocol, crypto, trust decisions and the
history↔discovery join, including a full two-party handshake run in memory.

Discovery, sockets and streaming are native and need real hardware.
[docs/TESTING.md](docs/TESTING.md) has the device test plan: the complete
offline test, all twenty required scenarios, and the checks worth doing
explicitly — memory flatness during a multi-gigabyte transfer, resume seam
correctness verified with `shasum` outside the app, and impersonation
resistance.
