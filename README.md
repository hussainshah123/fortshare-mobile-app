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

### One gap, stated plainly

**File chunk payloads are not encrypted.** The handshake is authenticated and
every file is integrity-verified, but the bytes themselves cross the LAN in the
clear — someone capturing packets on your network can read a transfer in
flight. Encrypting them requires an AEAD in the native data path, since
JavaScript never sees the bytes by design; the session key is already derived
and handed to the native layer, and `docs/ARCHITECTURE.md` §4 marks where it
would land. This is documented rather than hidden behind vague wording.

Other limitations — bounded iOS background execution, flattened folder
transfers — are in [docs/TESTING.md](docs/TESTING.md).

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
