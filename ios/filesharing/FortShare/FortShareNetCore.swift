import Foundation

/// The Swift entry point the Objective-C++ TurboModule shim talks to.
///
/// Nothing here references React. The shim wires the twelve event blocks to
/// the generated `emitOn*` methods, parses the JSON arguments, and forwards.
@objc(FortShareNetCore)
final class FortShareNetCore: NSObject {
    private let events = FortShareNetEvents()
    private let server: FortShareServer
    private let discovery: FortShareDiscovery

    @objc override init() {
        server = FortShareServer(events: events)
        discovery = FortShareDiscovery(events: events)
        super.init()
        discovery.attach(server: server)
    }

    // MARK: - Event wiring

    @objc func setPeerFound(_ block: @escaping (String) -> Void) { events.peerFound = block }
    @objc func setPeerLost(_ block: @escaping (String) -> Void) { events.peerLost = block }
    @objc func setDiscoveryError(_ block: @escaping (String) -> Void) {
        events.discoveryError = block
    }
    @objc func setNetworkChanged(_ block: @escaping (String) -> Void) {
        events.networkChanged = block
    }
    @objc func setConnection(_ block: @escaping (String) -> Void) { events.connection = block }
    @objc func setControl(_ block: @escaping (String) -> Void) { events.control = block }
    @objc func setDisconnect(_ block: @escaping (String) -> Void) { events.disconnect = block }
    @objc func setSendProgress(_ block: @escaping (String) -> Void) {
        events.sendProgress = block
    }
    @objc func setSendComplete(_ block: @escaping (String) -> Void) {
        events.sendComplete = block
    }
    @objc func setReceiveProgress(_ block: @escaping (String) -> Void) {
        events.receiveProgress = block
    }
    @objc func setReceiveComplete(_ block: @escaping (String) -> Void) {
        events.receiveComplete = block
    }
    @objc func setTransferError(_ block: @escaping (String) -> Void) {
        events.transferError = block
    }

    // MARK: - Discovery

    @objc func startDiscovery(configJson: String) throws {
        let config = FortShareJSON.decode(configJson)
        discovery.start(config: FortShareDiscovery.AdvertiseConfig(
            deviceId: config.string("deviceId"),
            deviceName: config.string("deviceName"),
            platform: config.string("platform", "ios"),
            deviceType: config.string("deviceType", "phone"),
            fingerprint: config.string("fingerprint"),
            port: config.int("port")
        ))
    }

    @objc func stopDiscovery() { discovery.stop() }
    @objc func refreshDiscovery() { discovery.refresh() }
    @objc func getLocalAddress() -> String { discovery.localAddress() }
    @objc func getNetworkInfo() -> String { discovery.networkInfo() }

    // MARK: - Sockets

    @objc func startServer() throws -> NSNumber {
        NSNumber(value: try server.startListening())
    }

    @objc func stopServer() { server.stopListening() }

    @objc func connect(host: String, port: Double, serviceRef: String, timeoutMs: Double) throws
        -> String {
        try server.connect(
            host: host,
            port: Int(port),
            serviceRef: serviceRef,
            timeoutMs: Int(timeoutMs)
        )
    }

    @objc func disconnect(connectionId: String) { server.disconnect(connectionId) }

    @objc func sendControl(connectionId: String, json: String) throws {
        try server.link(connectionId).sendControl(json)
    }

    @objc func setSessionKey(connectionId: String, keyB64: String) throws {
        var padded = keyB64.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while padded.count % 4 != 0 { padded.append("=") }
        guard let key = Data(base64Encoded: padded) else {
            throw FortShareError.message("session key is not valid base64url")
        }
        try server.link(connectionId).setSessionKey(key)
    }

    // MARK: - Transfer

    @objc func sendFile(connectionId: String, paramsJson: String) throws {
        let params = FortShareJSON.decode(paramsJson)
        try server.link(connectionId).sendFile(
            transferId: params.string("transferId"),
            fileId: params.string("fileId"),
            fileIndex: Int32(params.int("fileIndex")),
            path: clean(params.string("uri")),
            offset: params.int64("offset"),
            size: params.int64("size"),
            chunkSize: params.int("chunkSize", FortShareProtocol.chunkSize)
        )
    }

    @objc func receiveFile(connectionId: String, paramsJson: String) throws {
        let params = FortShareJSON.decode(paramsJson)
        try server.link(connectionId).receiveFile(
            transferId: params.string("transferId"),
            fileId: params.string("fileId"),
            fileIndex: Int32(params.int("fileIndex")),
            destPath: clean(params.string("destPath")),
            offset: params.int64("offset"),
            size: params.int64("size")
        )
    }

    @objc func pauseTransfer(connectionId: String, transferId: String) throws {
        try server.link(connectionId).pauseTransfer(transferId)
    }

    @objc func cancelTransfer(connectionId: String, transferId: String) throws {
        try server.link(connectionId).cancelTransfer(transferId)
    }

    @objc func teardown() {
        discovery.stop()
        server.stopListening()
    }

    private func clean(_ path: String) -> String {
        path.hasPrefix("file://") ? String(path.dropFirst("file://".count)) : path
    }
}
