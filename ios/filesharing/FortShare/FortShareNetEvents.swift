import Foundation

/// Everything the native networking layer reports upward.
///
/// Held as blocks so the Objective-C++ TurboModule shim can wire each one
/// straight to its generated `emitOn*` method. The Swift cores below never
/// reference React types, which keeps React off the socket queues.
final class FortShareNetEvents {
    var peerFound: ((String) -> Void)?
    var peerLost: ((String) -> Void)?
    var discoveryError: ((String) -> Void)?
    var networkChanged: ((String) -> Void)?

    var connection: ((String) -> Void)?
    var control: ((String) -> Void)?
    var disconnect: ((String) -> Void)?

    var sendProgress: ((String) -> Void)?
    var sendComplete: ((String) -> Void)?
    var receiveProgress: ((String) -> Void)?
    var receiveComplete: ((String) -> Void)?
    var transferError: ((String) -> Void)?

    func onPeerFound(_ json: String) { peerFound?(json) }
    func onPeerLost(_ json: String) { peerLost?(json) }
    func onDiscoveryError(_ json: String) { discoveryError?(json) }
    func onNetworkChanged(_ json: String) { networkChanged?(json) }

    func onConnection(_ json: String) { connection?(json) }
    func onControl(_ json: String) { control?(json) }
    func onDisconnect(_ json: String) { disconnect?(json) }

    func onSendProgress(_ json: String) { sendProgress?(json) }
    func onSendComplete(_ json: String) { sendComplete?(json) }
    func onReceiveProgress(_ json: String) { receiveProgress?(json) }
    func onReceiveComplete(_ json: String) { receiveComplete?(json) }
    func onTransferError(_ json: String) { transferError?(json) }
}
