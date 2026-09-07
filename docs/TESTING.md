# FortShare — Test plan

Covers §46 (full offline test) and §47 (the required scenarios). Read
docs/ARCHITECTURE.md first if you want to know *why* a step should work.

## What is already automated

`npm test` — 91 tests, no device needed. These cover the parts that are pure
logic, which is most of the protocol:

| Suite | What it proves |
|---|---|
| `crypto.test.ts` | base64url round-trips every byte; UTF-8 handles emoji; transcript is symmetric (so both sides derive the same key) and changes if *any* field changes; signatures reject a wrong key, a replayed session, and malformed input; QR proofs reject a wrong PSK and a replay |
| `handshake.test.ts` | a complete two-party handshake, in-memory. First contact prompts only the responder; reconnect prompts nobody; a remembered deviceId presented with a different key is refused; a forged signature is caught; a QR code works once and only once |
| `recognition.test.ts` | the history↔discovery join: remembered+online reads as "Previously connected", remembered+offline keeps its stats, an IP change updates one row instead of creating two, a *different* device on the old IP does not match |
| `qr.test.ts` | QR payload contains no private key; codes expire, are single-use, and are revoked on screen close; a non-FortShare barcode is rejected without throwing |
| `format.test.ts` | sizes/speeds/ETAs; calendar-day grouping; `SpeedTracker` smoothing, ETA, and resume behaviour |

Because the control plane is one TypeScript implementation used by both
platforms, `handshake.test.ts` passing *is* the cross-platform compatibility
test for the handshake — there is no second implementation to drift.

    npm test              # all suites
    npm run typecheck     # tsc --noEmit, strict
    npm run lint          # zero warnings expected

## What must be tested on real devices

Discovery, sockets and file streaming are native and cannot be meaningfully
faked. Two physical devices are needed; a simulator plus a device works for
some cases but **iOS simulators do not reliably do mDNS to physical devices**,
so treat simulator-only results as inconclusive.

### Setup

    npm start                                  # Metro
    npm run android                            # device A
    npm run ios                                # device B

Grant the prompts when they appear: Local Network on iOS (without it discovery
silently returns nothing), notifications when the first transfer starts, media
access when you first open Photos in the picker.

### §46 — the full offline test

The point of this one is that *nothing* here needs the internet.

1. Join both devices to the same Wi-Fi.
2. **Turn the internet off at the router** (or use a phone hotspot with mobile
   data disabled). Leave Wi-Fi up.
3. Verify, in order:
   - each device appears on the other's Devices → Nearby;
   - tapping one raises "wants to connect" on the other; accept;
   - a multi-file transfer completes and every file shows Verified;
   - the device now appears under Devices → History;
   - transfer history, statistics and favourites all persist;
   - force-quit both apps, reopen: history and pairing survive;
   - kill Wi-Fi mid-transfer, restore it, resume from where it stopped.

No step should require a DNS lookup or an outbound connection. If you want to
prove that, run `tcpdump` on the router: the only traffic should be mDNS
(224.0.0.251:5353) and TCP between the two device addresses.

### §47 — required scenarios

| # | Scenario | How to run it | Expected |
|---|---|---|---|
| 1 | Android → Android | two Android devices | discovery, pair, transfer |
| 2 | Android → iOS | send from Android | works; iOS shows the approval prompt |
| 3 | iOS → Android | send from iOS | works; the iOS side dials the Bonjour endpoint, Android resolves via NSD |
| 4 | iOS → iOS | two iPhones | works, including over AWDL peer-to-peer |
| 5 | Same Wi-Fi | both on a router | Devices → Nearby lists the peer |
| 6 | Wi-Fi hotspot | A creates a hotspot, B joins | same behaviour; no internet needed |
| 7 | Small file | send a 1 KB text file | completes near-instantly, digest verified |
| 8 | Large file | send 1 GB+ | steady progress; memory flat (see below) |
| 9 | Multiple files | select 12 files | "4 / 12 files", current filename updates |
| 10 | Folder | pick a folder in the picker | contents enumerate and send |
| 11 | Interrupted | turn Wi-Fi off mid-transfer | "Paused — no longer reachable", partial kept |
| 12 | Resume | turn Wi-Fi back on, tap Resume | continues from the byte it stopped at, final digest passes |
| 13 | IP change | reboot the router, or renew DHCP | same device, one row, new address |
| 14 | Device offline | close FortShare on the peer | goes Offline; history, stats and last-seen remain |
| 15 | Comes back online | reopen it | flips to Online · Previously connected, no re-pairing |
| 16 | Duplicate file | send the same file twice | Replace / Keep Both / Skip; Keep Both writes "name (1).ext" |
| 17 | Unknown device | fresh install on the peer | approval prompt with a security code |
| 18 | QR pairing | Settings → Show pairing QR, scan it | pairs with no approval prompt |
| 19 | App restart | force-quit and reopen | identity, devices, pairings, history intact |
| 20 | Phone restart | reboot both devices | same; a paused transfer is still resumable |

### Checks worth making explicitly

**Memory during a large transfer (§17).** The claim is that a 5 GB transfer
costs one 256 KB buffer per direction and that JavaScript never sees a file
byte. Verify it rather than trusting it:

- Android: `adb shell dumpsys meminfo com.filesharing` during a 1 GB+ transfer.
  Java/native heap should stay flat, not track transferred bytes.
- iOS: Xcode → Debug → Memory. Same expectation.

If memory grows with the file, something is buffering that should be streaming.

**Resume correctness (§19).** The interesting failure mode is a transfer that
resumes and *appears* to finish but has a corrupt seam. This is exactly what
the final SHA-256 catches, so:

1. Send a 500 MB+ file. Interrupt at roughly 40%.
2. Note the byte count shown.
3. Resume. It must restart from that offset, not from zero.
4. The transfer must end with the file marked Verified.
5. Independently confirm: `shasum -a 256` the file on both devices.

Step 5 is the one that actually proves it. A green tick from the app is the
app's own opinion; matching digests computed outside the app are evidence.

**Identity stability (§5).** Rename the device in Settings, change Wi-Fi
networks, reboot. The Device ID shown in Settings → My device → Identity must
not change, and peers that had paired with it must still connect silently.

**Impersonation (§15).** Worth doing once, because it is the check that makes
"remember the device forever" safe:

1. Pair A with B.
2. Uninstall and reinstall FortShare on B (new keypair, and on Android a new
   `deviceId` too — to reuse the id you would have to tamper with storage).
3. B must **not** be silently trusted. Either it appears as a new device, or —
   if the deviceId was preserved — the connection is refused with a key
   mismatch and an explicit re-pair is required.

## Known limitations

- **Chunk payloads are not encrypted.** The handshake is authenticated
  (Ed25519 + X25519 + HKDF) and every file is SHA-256 verified, but the bytes
  themselves cross the LAN in the clear. Someone with packet capture on your
  network can read a transfer in flight. See docs/ARCHITECTURE.md §4 for where
  the AEAD would go.
- **iOS background transfers are bounded.** iOS grants a background task, not
  open-ended execution. A long transfer with the app backgrounded will
  eventually be suspended; it becomes a paused, resumable transfer rather than
  a failed one. Android uses a foreground service and does not have this limit.
- **Folder transfers flatten.** A picked folder's files are sent individually;
  directory structure is not recreated on the receiver.
