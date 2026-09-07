import Foundation
import Network

/// The TCP listener and every live ``FortSharePeerLink``.
///
/// This is the "temporary local server" the architecture allows: it binds an
/// ephemeral port on this device, speaks only to peers on the local network,
/// and dies with the app. Nothing it does reaches the internet.
///
/// On iOS the listener is also the Bonjour advertiser, so the port we publish
/// is by construction the port we are listening on.
final class FortShareServer {
    private let events: FortShareNetEvents
    private let queue = DispatchQueue(label: "fortshare.server")
    private let stateQueue = DispatchQueue(label: "fortshare.server.state")

    private var listener: NWListener?
    private var links: [String: FortSharePeerLink] = [:]
    private var counter = 0
    private var advertiseConfig: FortShareDiscovery.AdvertiseConfig?

    init(events: FortShareNetEvents) {
        self.events = events
    }

    /// Bind an ephemeral port and return it, for the TXT record.
    ///
    /// Blocking, because the caller needs the port number before it can
    /// advertise; the wait is bounded and happens once at startup.
    func startListening() throws -> Int {
        if let existing = listener, let port = existing.port {
            return Int(port.rawValue)
        }

        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = true
        if let tcp = parameters.defaultProtocolStack.internetProtocol as? NWProtocolTCP.Options {
            tcp.noDelay = true
            tcp.enableKeepalive = true
        }

        // Port 0: let the OS pick. Nothing hard-codes a port, so two FortShare
        // apps on one network never collide.
        let created = try NWListener(using: parameters, on: .any)

        created.newConnectionHandler = { [weak self] connection in
            self?.register(connection: connection, inbound: true)
        }

        let ready = DispatchSemaphore(value: 0)
        var failure: Error?
        created.stateUpdateHandler = { state in
            switch state {
            case .ready:
                ready.signal()
            case .failed(let error):
                failure = error
                ready.signal()
            default:
                break
            }
        }

        created.start(queue: queue)
        _ = ready.wait(timeout: .now() + 10)

        if let failure {
            created.cancel()
            throw failure
        }
        guard let port = created.port else {
            created.cancel()
            throw FortShareError.message("listener did not bind a port")
        }

        listener = created
        if let config = advertiseConfig { advertise(config: config) }
        return Int(port.rawValue)
    }

    func stopListening() {
        listener?.cancel()
        listener = nil
        let current: [FortSharePeerLink] = stateQueue.sync { Array(links.values) }
        for link in current { link.close(reason: "server stopped") }
        stateQueue.sync { links.removeAll() }
    }

    /// Publish (or re-publish) the Bonjour service through the listener.
    func advertise(config: FortShareDiscovery.AdvertiseConfig) {
        advertiseConfig = config
        guard let listener else { return }

        var record = NWTXTRecord()
        record[FortShareProtocol.txtVersion] = String(FortShareProtocol.version)
        record[FortShareProtocol.txtDeviceId] = config.deviceId
        // base64url so any unicode device name survives a TXT record.
        record[FortShareProtocol.txtName] = encodeName(config.deviceName)
        record[FortShareProtocol.txtPlatform] = config.platform
        record[FortShareProtocol.txtType] = config.deviceType
        record[FortShareProtocol.txtFingerprint] = config.fingerprint

        // Instance names must be unique on the network; the deviceId prefix
        // guarantees that without publishing the whole identity.
        listener.service = NWListener.Service(
            name: "FortShare-\(config.deviceId.prefix(8))",
            type: FortShareProtocol.serviceType,
            domain: nil,
            txtRecord: record
        )
    }

    func stopAdvertising() {
        listener?.service = nil
        advertiseConfig = nil
    }

    var boundPort: Int {
        guard let port = listener?.port else { return 0 }
        return Int(port.rawValue)
    }

    // MARK: - Dialling

    /// Dial a peer.
    ///
    /// `serviceRef` is preferred when present: on iOS the browser hands us a
    /// Bonjour endpoint, and letting `NWConnection` resolve it avoids
    /// duplicating address resolution — and works over peer-to-peer links that
    /// have no routable address at all. `host`/`port` is the cross-platform
    /// path, used when dialling an Android peer or a QR-scanned address.
    func connect(host: String, port: Int, serviceRef: String, timeoutMs: Int) throws -> String {
        let endpoint: NWEndpoint
        let parts = serviceRef.split(separator: "|", omittingEmptySubsequences: false)
        if parts.count == 3, !parts[0].isEmpty {
            endpoint = .service(
                name: String(parts[0]),
                type: String(parts[1]),
                domain: String(parts[2]),
                interface: nil
            )
        } else if !host.isEmpty, port > 0, let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) {
            endpoint = .hostPort(host: NWEndpoint.Host(host), port: nwPort)
        } else {
            throw FortShareError.message("no reachable address for this device")
        }

        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = true
        if let tcp = parameters.defaultProtocolStack.internetProtocol as? NWProtocolTCP.Options {
            tcp.noDelay = true
            tcp.enableKeepalive = true
            tcp.connectionTimeout = max(1, timeoutMs / 1000)
        }

        let connection = NWConnection(to: endpoint, using: parameters)
        return register(connection: connection, inbound: false, host: host, port: port)
    }

    @discardableResult
    private func register(
        connection: NWConnection,
        inbound: Bool,
        host: String = "",
        port: Int = 0
    ) -> String {
        let connectionId: String = stateQueue.sync {
            counter += 1
            return "c\(counter)"
        }

        let resolvedHost = host.isEmpty ? describe(connection.endpoint) : host

        let link = FortSharePeerLink(
            connectionId: connectionId,
            connection: connection,
            host: resolvedHost,
            port: port,
            inbound: inbound,
            events: events,
            onClosed: { [weak self] closed, reason in
                guard let self else { return }
                self.stateQueue.sync { self.links.removeValue(forKey: closed.connectionId) }
                self.events.onDisconnect(FortShareJSON.encode([
                    ("connectionId", closed.connectionId),
                    ("reason", reason),
                ]))
            }
        )

        stateQueue.sync { links[connectionId] = link }

        // Announced before `start()` for the same reason as on Android: the
        // receive handler can deliver the peer's HELLO before JavaScript knows
        // this connection exists, and a dropped handshake frame shows up only
        // as an unexplained timeout.
        events.onConnection(FortShareJSON.encode([
            ("connectionId", connectionId),
            ("host", resolvedHost),
            ("port", port),
            ("inbound", inbound),
        ]))

        link.start()
        return connectionId
    }

    func link(_ connectionId: String) throws -> FortSharePeerLink {
        guard let link = stateQueue.sync(execute: { links[connectionId] }) else {
            throw FortShareError.message("unknown connection \(connectionId)")
        }
        return link
    }

    func disconnect(_ connectionId: String) {
        stateQueue.sync { links[connectionId] }?.close(reason: "closed locally")
    }

    private func describe(_ endpoint: NWEndpoint) -> String {
        switch endpoint {
        case .hostPort(let host, _):
            return "\(host)".split(separator: "%").first.map(String.init) ?? "\(host)"
        case .service(let name, _, _, _):
            return name
        default:
            return ""
        }
    }

    private func encodeName(_ name: String) -> String {
        Data(name.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
