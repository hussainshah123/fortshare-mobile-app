package com.filesharing.fortshare

/**
 * Everything the native networking layer reports upward.
 *
 * The React module implements this by forwarding to its generated
 * `emitOn*` methods; the core classes below never touch React types, which
 * keeps them unit-testable and keeps React out of the socket threads.
 */
internal interface NetEvents {
    fun peerFound(json: String)
    fun peerLost(json: String)
    fun discoveryError(json: String)
    fun networkChanged(json: String)

    fun wifiDirectPeerFound(json: String)
    fun wifiDirectPeerLost(json: String)
    fun wifiDirectRawPeers(json: String)
    fun wifiDirectStateChanged(json: String)

    fun connection(json: String)
    fun control(json: String)
    fun disconnect(json: String)

    fun sendProgress(json: String)
    fun sendComplete(json: String)
    fun receiveProgress(json: String)
    fun receiveComplete(json: String)
    fun transferError(json: String)
}
