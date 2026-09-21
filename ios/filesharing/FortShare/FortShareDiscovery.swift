import Foundation
import Network

/// Bonjour advertise and browse on top of the Network framework (§6).
///
/// `NWListener` does double duty: it accepts the TCP connections *and*
/// publishes the Bonjour service, so the advertised port is by construction
/// the port we are actually listening on.
///
/// The TXT record carries the persistent deviceId, so a peer is recognised
/// against local history the moment it is *seen* — which is what lets a device
/// that changed IP update in place instead of appearing as a stranger (§39).
final class FortShareDiscovery {
    private let events: FortShareNetEvents
    private let queue = DispatchQueue(label: "fortshare.discovery")

    private var browser: NWBrowser?
    private var pathMonitor: NWPathMonitor?
    private var addressWatcher: DispatchSourceTimer?

    /// The address last reported to JS, so the poll is silent when nothing has
    /// changed. Starts as nil — distinct from "", which means "no network" and
    /// is itself a state worth reporting once.
    private var lastNetworkState: String?

    /// Short enough that enabling a hotspot feels immediate, long enough to
    /// be free.
    private let addressPollInterval: DispatchTimeInterval = .seconds(2)

    /// deviceId -> peer, so repeated announcements are de-duplicated and a
    /// `.removed` change can be mapped back to a deviceId.
    private var seen: [String: String] = [:]
    private var config: AdvertiseConfig?
    /// Set by the connection registry, which owns the listener.
    private weak var listenerOwner: FortShareServer?

    struct AdvertiseConfig {
        let deviceId: String
        let deviceName: String
        let platform: String
        let deviceType: String
        let fingerprint: String
        let port: Int
    }

    init(events: FortShareNetEvents) {
        self.events = events
    }

    func attach(server: FortShareServer) {
        listenerOwner = server
    }

    func start(config: AdvertiseConfig) {
        self.config = config
        // The listener publishes the service; ask it to (re-)advertise.
        listenerOwner?.advertise(config: config)
        startBrowsing()
        startPathMonitor()
    }

    func stop() {
        browser?.cancel()
        browser = nil
        pathMonitor?.cancel()
        pathMonitor = nil
        addressWatcher?.cancel()
        addressWatcher = nil
        lastNetworkState = nil
        listenerOwner?.stopAdvertising()
        seen.removeAll()
        config = nil
    }

    func refresh() {
        guard let config else { return }
        browser?.cancel()
        browser = nil
        seen.removeAll()
        listenerOwner?.advertise(config: config)
        startBrowsing()
    }

    // MARK: - Browsing

    private func startBrowsing() {
        let descriptor = NWBrowser.Descriptor.bonjourWithTXTRecord(
            type: FortShareProtocol.serviceType,
            domain: nil
        )
        let parameters = NWParameters()
        // Peer-to-peer so this also works over a hotspot with no router (§8).
        parameters.includePeerToPeer = true

        let browser = NWBrowser(for: descriptor, using: parameters)

        browser.stateUpdateHandler = { [weak self] state in
            if case .failed(let error) = state {
                self?.events.onDiscoveryError(FortShareJSON.encode([
                    ("message", "could not scan the network: \(error.localizedDescription)"),
                ]))
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, changes in
            guard let self else { return }
            for change in changes {
                switch change {
                case .added(let result):
                    self.emitPeer(result)
                case .changed(let old, let new, _):
                    _ = old
                    self.emitPeer(new)
                case .removed(let result):
                    self.emitLost(result)
                default:
                    break
                }
            }
            // Re-announce anything still present that we have no record of;
            // a browser restart delivers these as `.added`, but a `.changed`
            // batch can otherwise leave a gap.
            for result in results where self.deviceId(of: result) == nil {
                self.emitPeer(result)
            }
        }

        self.browser = browser
        browser.start(queue: queue)
    }

    /// TXT records arrive with the browse result, so no resolve step is needed
    /// to learn who a peer is — only to learn where it is, which `NWConnection`
    /// does for us when we dial the service endpoint.
    private func emitPeer(_ result: NWBrowser.Result) {
        guard case .bonjour(let record) = result.metadata else { return }

        let deviceId = record[FortShareProtocol.txtDeviceId] ?? ""
        guard !deviceId.isEmpty else { return }
        if deviceId == config?.deviceId { return } // our own echo

        guard case .service(let name, let type, let domain, _) = result.endpoint else { return }

        seen[deviceId] = name
        let version = Int(record[FortShareProtocol.txtVersion] ?? "0") ?? 0

        // `host`/`port` are left empty on iOS: we dial the Bonjour service
        // endpoint directly, so there is no address to resolve by hand. The
        // service reference below is what `connect` uses.
        events.onPeerFound(FortShareJSON.encode([
            ("deviceId", deviceId),
            ("deviceName", decodeName(record[FortShareProtocol.txtName])),
            ("platform", record[FortShareProtocol.txtPlatform] ?? "ios"),
            ("deviceType", record[FortShareProtocol.txtType] ?? "phone"),
            ("fingerprint", record[FortShareProtocol.txtFingerprint] ?? ""),
            ("protocolVersion", version),
            ("host", ""),
            ("port", 0),
            ("serviceRef", "\(name)|\(type)|\(domain)"),
            ("discoveredAt", Int64(Date().timeIntervalSince1970 * 1000)),
        ]))
    }

    private func emitLost(_ result: NWBrowser.Result) {
        guard let deviceId = deviceId(of: result) else { return }
        seen.removeValue(forKey: deviceId)
        // Deliberately no persistence change: a device going offline must not
        // alter its history row or statistics (§9).
        events.onPeerLost(FortShareJSON.encode([("deviceId", deviceId)]))
    }

    private func deviceId(of result: NWBrowser.Result) -> String? {
        if case .bonjour(let record) = result.metadata,
           let deviceId = record[FortShareProtocol.txtDeviceId],
           !deviceId.isEmpty {
            return seen[deviceId] != nil ? deviceId : nil
        }
        if case .service(let name, _, _, _) = result.endpoint {
            return seen.first(where: { $0.value == name })?.key
        }
        return nil
    }

    // MARK: - Network changes

    /// Whether this device can be reached, and at which address.
    ///
    /// The only proof of a usable network is a usable address. `NWPath.status`
    /// describes whether a *route* exists, which is a different question and
    /// the wrong one here: sharing over a personal hotspot, over a Wi-Fi
    /// network whose internet has gone, or over an interface the path monitor
    /// does not consider satisfying all work perfectly well, and all used to
    /// be reported as having no network at all.
    ///
    /// Emitted only on change, since the watcher below re-checks on a timer.
    private func emitNetworkState() {
        let address = localAddress()
        guard address != lastNetworkState else { return }
        lastNetworkState = address
        events.onNetworkChanged(FortShareJSON.encode([
            ("available", !address.isEmpty),
            ("address", address),
        ]))
    }

    /// Watch for the network coming and going.
    ///
    /// Deliberately not gated on internet reachability: FortShare must work on
    /// a network with no internet route at all, which is the normal case for a
    /// phone hotspot (§8, §43).
    private func startPathMonitor() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            self.emitNetworkState()
            // Re-announce on any change: addresses learned on the old network
            // are meaningless on the new one.
            if path.status == .satisfied || !self.localAddress().isEmpty {
                self.refresh()
            }
        }
        pathMonitor = monitor
        monitor.start(queue: queue)
        startAddressWatcher()
    }

    /// Re-check the local addresses on a timer.
    ///
    /// The path monitor does not report the interfaces that matter most here:
    /// a personal hotspot coming up, or an AWDL peer-to-peer link forming,
    /// brings an interface up without changing the satisfied path. Without
    /// this the app cannot tell that it went from unreachable to reachable.
    ///
    /// `getifaddrs` is a local syscall and this runs only while discovery is
    /// running, which is only while the app is in use.
    private func startAddressWatcher() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + addressPollInterval,
                       repeating: addressPollInterval)
        timer.setEventHandler { [weak self] in self?.emitNetworkState() }
        addressWatcher = timer
        timer.resume()
    }

    /// One local address, classified by the interface it belongs to.
    struct LocalAddress {
        let interfaceName: String
        let address: String
        let kind: String
    }

    /// Classify a BSD interface name.
    ///
    /// As on Android, a device can hold several usable-looking IPv4 addresses
    /// at once and they are not interchangeable — a peer on the Wi-Fi LAN
    /// cannot reach a cellular or VPN address, and offering one produces
    /// "no route to host".
    private func classify(_ name: String) -> String {
        if name == "en0" { return "wifi" }
        // en1+ is Ethernet-over-USB/Thunderbolt on iPads, and the hotspot
        // bridge on iPhones.
        if name.hasPrefix("bridge") || name.hasPrefix("ap") { return "hotspot" }
        if name.hasPrefix("en") { return "ethernet" }
        // Cellular (pdp_ip) and the peer-to-peer AWDL/link-local interfaces.
        if name.hasPrefix("pdp_ip") { return "cellular" }
        if name.hasPrefix("utun") || name.hasPrefix("ipsec") || name.hasPrefix("tap") {
            return "vpn"
        }
        if name.hasPrefix("awdl") || name.hasPrefix("llw") { return "p2p" }
        return "other"
    }

    private func preference(_ kind: String) -> Int {
        switch kind {
        case "wifi": return 0
        case "hotspot": return 1
        case "ethernet": return 2
        // AWDL carries link-local addresses only; Network framework dials it
        // through the Bonjour endpoint rather than a literal address.
        case "p2p": return 4
        case "other": return 3
        case "cellular": return 90
        case "vpn": return 91
        default: return 50
        }
    }

    /// Every candidate address, best first.
    func localAddresses() -> [LocalAddress] {
        var found: [LocalAddress] = []
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }

        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let current = cursor {
            defer { cursor = current.pointee.ifa_next }

            let flags = Int32(current.pointee.ifa_flags)
            guard (flags & IFF_UP) == IFF_UP, (flags & IFF_LOOPBACK) == 0 else { continue }
            guard let addr = current.pointee.ifa_addr,
                  addr.pointee.sa_family == UInt8(AF_INET) else { continue }

            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(
                addr,
                socklen_t(addr.pointee.sa_len),
                &hostname, socklen_t(hostname.count),
                nil, 0, NI_NUMERICHOST
            ) == 0 else { continue }

            let name = String(cString: current.pointee.ifa_name)
            let text = String(cString: hostname)
            // 169.254/16 is link-local: never routable to a peer by address.
            if text.hasPrefix("169.254.") { continue }

            found.append(
                LocalAddress(interfaceName: name, address: text, kind: classify(name))
            )
        }

        var seen = Set<String>()
        return found
            .filter { seen.insert($0.address).inserted }
            .sorted { preference($0.kind) < preference($1.kind) }
    }

    /// The single best local address, or "" when there is none.
    func localAddress() -> String {
        localAddresses()
            .first { $0.kind != "cellular" && $0.kind != "vpn" && $0.kind != "p2p" }?
            .address ?? ""
    }

    /// { primary, addresses[] } JSON, for QR payloads and diagnostics.
    func networkInfo() -> String {
        let entries = localAddresses().map { candidate -> [String: Any] in
            [
                "interfaceName": candidate.interfaceName,
                "address": candidate.address,
                "kind": candidate.kind,
            ]
        }
        let payload: [String: Any] = [
            "primary": localAddress(),
            "addresses": entries,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else { return "{\"primary\":\"\",\"addresses\":[]}" }
        return json
    }

    private func decodeName(_ encoded: String?) -> String {
        guard let encoded, !encoded.isEmpty else { return "Unknown device" }
        var padded = encoded.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded.append("=") }
        guard let data = Data(base64Encoded: padded),
              let text = String(data: data, encoding: .utf8)
        else { return "Unknown device" }
        return text
    }
}
