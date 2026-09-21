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

### What the iOS Simulator can and cannot test

Worth knowing before relying on it, because the parts it cannot do are the
parts most worth testing.

| | Simulator |
|---|---|
| UI, theme, navigation, database, identity, history | ✅ works |
| Crypto (handshake, digests) | ✅ works — pure JavaScript |
| **QR scanning** | ❌ no camera exists at all |
| **iOS↔iOS peer-to-peer (AWDL)** | ❌ no Wi-Fi hardware |
| **Local Network permission** | ❌ not enforced as on a device |
| Discovery/transfer with a real device | ⚠️ sometimes — see below |

The simulator shares the **host Mac's** network stack, so a FortShare app
running in it advertises Bonjour on the Mac's LAN address and binds its
listener there. If the Mac is on the same Wi-Fi as a physical Android phone,
the two can genuinely discover each other — which makes this the cheapest way
to exercise the Android↔iOS *protocol* path. It is not a substitute for a real
iPhone: nothing about the radio, AWDL, or the permission prompt is real.

Two simulators on one Mac can also discover each other, for the same reason.
That tests the iOS↔iOS protocol, minus AWDL.

**On an Intel Mac**, simulator builds must be `x86_64`:

    xcodebuild ... -sdk iphonesimulator ARCHS=x86_64

An `arm64` build compiles and links perfectly but the simulator refuses to
install it with "This app needs to be updated by the developer" — which sounds
like a project problem and is only an architecture mismatch. Physical iPhones
are `arm64` regardless.

### A crash worth re-testing after any iOS change

`FortSharePeerLink` uses two serial queues on purpose: `fortshare.state` for
mutable state and `fortshare.connection` for Network framework's callbacks.
They must never be the same queue. When they were, the first inbound frame
deadlocked — a callback delivered *on* `stateQueue` read `isClosed`, which
does `stateQueue.sync`, and libdispatch aborted the process with
`EXC_BAD_INSTRUCTION` inside `__DISPATCH_WAIT_FOR_QUEUE__`.

For the same reason `sendBlocking` must never be called from a connection
callback: it waits on a semaphore that only the callback queue can signal. The
PING handler therefore replies with the non-blocking `sendRaw`.

Quickest way to exercise it without a second device — find the advertised port
with `dns-sd -B _fortshare._tcp local`, then connect and send the preamble
(`FSHARE\x00\x01`), a CONTROL frame, and a PING. A healthy build answers with
its own preamble and a `0x04` PONG frame and stays alive; a regressed one dies
immediately.

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

**Payload encryption (§42).** Chunks are sealed with AES-256-GCM, so this is
worth confirming rather than assuming:

1. Start a transfer and check the card shows "End-to-end encrypted".
2. The log line on both devices should read
   `session established with … (trust: …, cipher: aes-256-gcm)`.
3. To prove it on the wire, capture on the router (or `tcpdump` on a rooted
   device) and confirm the TCP payload is not the file's plaintext — a text
   file is the easiest case to eyeball.
4. Tamper test: an altered chunk must drop the connection with
   "chunk failed authentication", never write to disk.

**Content dedup.** Send the same file twice, the second time renamed. The
second transfer should report it as "Already on this device — not transferred"
and move zero bytes. Then delete the received file and repeat: it must
transfer normally, because a history row for a deleted file must not cause a
silent skip.

**Surviving the app being closed (§36).** A transfer must not die when the
user switches away, and must pick itself up on return:

1. Start a transfer of 500 MB+.
2. Switch to another app. The notification should show live progress — that
   notification *is* the Android foreground service keeping the process alive.
3. Return to FortShare. The transfer should still be running, not restarted.
4. Now force-stop the app mid-transfer (swipe away, or `adb shell am
   force-stop com.fortdice.filesharing`).
5. Reopen it. The transfer should appear as paused with "interrupted", and
   resume on its own within a few seconds of the peer being rediscovered —
   from the byte it stopped at, not from zero.
6. Confirm the final file verifies. That is what proves the seam is correct.

Worth checking explicitly with notifications **denied** as well: the service
should still keep the transfer alive, just without a visible progress bar.

**Ads must never intrude.** The rules are enforced in code and covered by
`__tests__/ads.test.ts`, but the placement is worth eyeballing on a device:

1. Complete a transfer. An interstitial may appear *after* it finishes.
1b. Return to the Home tab after being in the app a little while — an
   interstitial may appear there too, about a second after the screen paints.
   It must **not** appear on a cold launch: an interstitial at app-open is an
   "unexpected interstitial" under AdMob policy and a documented cause of
   account enforcement. Google's format for that moment is an App Open ad.
2. Start a large transfer and leave it running. The Home banner must be gone
   while it runs, and no interstitial may appear — ads are suppressed
   entirely while a transfer is live.
3. On a fresh install, the very first transfer must complete without an ad.
4. Two transfers in quick succession must not produce two ads.
5. Turn the internet off (Wi-Fi only, no data). Everything must still work,
   and the banner slot must collapse to nothing rather than leaving a gap.

Note that debug builds use Google's **test** ad units, so what appears will be
a test ad. That is intentional — requesting real ads from a development build
is a common way to get an AdMob account flagged for invalid traffic.

**Memory during a large transfer (§17).** The claim is that a 5 GB transfer
costs one 256 KB buffer per direction and that JavaScript never sees a file
byte. Verify it rather than trusting it:

- Android: `adb shell dumpsys meminfo com.fortdice.filesharing` during a 1 GB+ transfer.
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

- **Different networks need Wi-Fi Direct (Android) or AWDL (iOS↔iOS).**
  Discovery is mDNS over IP, so two devices on *different* Wi-Fi networks find
  nothing over the LAN path — multicast does not cross networks. Turn on
  Wi-Fi Direct in Devices and they connect with no shared network at all,
  provided they are within radio range of each other. iOS↔iOS does this
  automatically via AWDL. Neither path has been verified on hardware yet.
- **Physical proximity is still required.** Nothing here reaches a device in
  another location — that needs a relay server, which this app deliberately
  does not have.
- **No 1→many group send**, and no desktop or web client.
- **iOS background transfers are bounded.** iOS grants a background task, not
  open-ended execution. A long transfer with the app backgrounded will
  eventually be suspended; it becomes a paused, resumable transfer rather than
  a failed one. Android uses a foreground service and does not have this limit.
- **Folder transfers flatten.** A picked folder's files are sent individually;
  directory structure is not recreated on the receiver.
