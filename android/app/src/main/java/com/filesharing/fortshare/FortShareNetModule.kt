package com.filesharing.fortshare

import android.util.Base64
import com.filesharing.specs.NativeFortShareNetSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * The React boundary for discovery, sockets and transfer.
 *
 * This class does nothing but marshal: parse the JSON in, hand off to
 * [DiscoveryEngine] / [ConnectionRegistry] / [PeerLink], and forward native
 * callbacks to the generated `emitOn*` methods. All the real work — and all
 * the file bytes — stay below it.
 */
@ReactModule(name = NativeFortShareNetSpec.NAME)
class FortShareNetModule(reactContext: ReactApplicationContext) :
    NativeFortShareNetSpec(reactContext) {

    /**
     * Socket work must never run on the JavaScript thread: connect() blocks on
     * a TCP handshake and startServer() binds. A small pool keeps those off it.
     */
    private val io = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "fortshare-io").apply { isDaemon = true }
    }

    private val events = object : NetEvents {
        override fun peerFound(json: String) = emitOnPeerFound(json)
        override fun peerLost(json: String) = emitOnPeerLost(json)
        override fun discoveryError(json: String) = emitOnDiscoveryError(json)
        override fun networkChanged(json: String) = emitOnNetworkChanged(json)
        override fun connection(json: String) = emitOnConnection(json)
        override fun control(json: String) = emitOnControl(json)
        override fun disconnect(json: String) = emitOnDisconnect(json)
        override fun sendProgress(json: String) = emitOnSendProgress(json)
        override fun sendComplete(json: String) = emitOnSendComplete(json)
        override fun receiveProgress(json: String) = emitOnReceiveProgress(json)
        override fun receiveComplete(json: String) = emitOnReceiveComplete(json)
        override fun transferError(json: String) = emitOnTransferError(json)
    }

    private val connections = ConnectionRegistry(events)
    private val discovery = DiscoveryEngine(reactContext.applicationContext, events)

    override fun invalidate() {
        runCatching { discovery.stop() }
        runCatching { connections.stopServer() }
        io.shutdownNow()
        super.invalidate()
    }

    // ---------------------------------------------------------------- discovery

    override fun startDiscovery(configJson: String, promise: Promise) {
        background(promise) {
            val config = JSONObject(configJson)
            discovery.start(
                DiscoveryEngine.AdvertiseConfig(
                    deviceId = config.getString("deviceId"),
                    deviceName = config.getString("deviceName"),
                    platform = config.optString("platform", "android"),
                    deviceType = config.optString("deviceType", "phone"),
                    fingerprint = config.optString("fingerprint", ""),
                    port = config.getInt("port"),
                ),
            )
            null
        }
    }

    override fun stopDiscovery(promise: Promise) {
        background(promise) {
            discovery.stop()
            null
        }
    }

    override fun refreshDiscovery(promise: Promise) {
        background(promise) {
            discovery.refresh()
            null
        }
    }

    override fun getLocalAddress(promise: Promise) {
        background(promise) { discovery.localAddress() }
    }

    override fun getNetworkInfo(promise: Promise) {
        background(promise) { discovery.networkInfo() }
    }

    // ------------------------------------------------------------------ sockets

    override fun startServer(promise: Promise) {
        background(promise) { connections.startServer() }
    }

    override fun stopServer(promise: Promise) {
        background(promise) {
            connections.stopServer()
            null
        }
    }

    override fun connect(paramsJson: String, promise: Promise) {
        background(promise) {
            val params = JSONObject(paramsJson)
            // serviceRef is an iOS-only concept (a Bonjour endpoint handle);
            // Android always has a resolved host and port from NsdManager.
            connections.connect(
                host = params.getString("host"),
                port = params.getInt("port"),
                timeoutMs = params.optInt("timeoutMs", 10_000),
            )
        }
    }

    override fun disconnect(connectionId: String, promise: Promise) {
        background(promise) {
            connections.disconnect(connectionId)
            null
        }
    }

    override fun sendControl(connectionId: String, json: String, promise: Promise) {
        background(promise) {
            connections.link(connectionId).sendControl(json)
            null
        }
    }

    override fun setSessionKey(connectionId: String, keyB64: String, promise: Promise) {
        background(promise) {
            connections.link(connectionId).sessionKey =
                Base64.decode(keyB64, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
            null
        }
    }

    // ----------------------------------------------------------------- transfer

    override fun sendFile(connectionId: String, paramsJson: String, promise: Promise) {
        background(promise) {
            val params = JSONObject(paramsJson)
            connections.link(connectionId).sendFile(
                transferId = params.getString("transferId"),
                fileId = params.getString("fileId"),
                fileIndex = params.getInt("fileIndex"),
                path = stripScheme(params.getString("uri")),
                offset = params.optLong("offset", 0L),
                size = params.getLong("size"),
                chunkSize = params.optInt("chunkSize", Protocol.CHUNK_SIZE),
            )
            null
        }
    }

    override fun receiveFile(connectionId: String, paramsJson: String, promise: Promise) {
        background(promise) {
            val params = JSONObject(paramsJson)
            connections.link(connectionId).receiveFile(
                transferId = params.getString("transferId"),
                fileId = params.getString("fileId"),
                fileIndex = params.getInt("fileIndex"),
                destPath = stripScheme(params.getString("destPath")),
                offset = params.optLong("offset", 0L),
                size = params.getLong("size"),
            )
            null
        }
    }

    override fun pauseTransfer(connectionId: String, transferId: String, promise: Promise) {
        background(promise) {
            connections.link(connectionId).pauseTransfer(transferId)
            null
        }
    }

    override fun cancelTransfer(connectionId: String, transferId: String, promise: Promise) {
        background(promise) {
            connections.link(connectionId).cancelTransfer(transferId)
            null
        }
    }

    // ------------------------------------------------------------------ helpers

    private fun stripScheme(path: String): String =
        if (path.startsWith("file://")) path.removePrefix("file://") else path

    /**
     * Run [work] off the JavaScript thread and settle [promise] with its
     * result. A thrown exception becomes a rejection with a readable message
     * rather than a crash on a socket thread.
     */
    private fun background(promise: Promise, work: () -> Any?) {
        io.execute {
            try {
                promise.resolve(work())
            } catch (error: Throwable) {
                promise.reject("fortshare_net", error.message ?: error.toString(), error)
            }
        }
    }
}
