package com.fortdice.filesharing.fortshare

import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * The TCP listener and every live [PeerLink].
 *
 * This is the "temporary local server" the architecture allows: it binds an
 * ephemeral port on this device, speaks only to peers on the local network,
 * and is torn down with the app. Nothing it does reaches the internet.
 */
internal class ConnectionRegistry(private val events: NetEvents) {
    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private val accepting = AtomicBoolean(false)
    private val counter = AtomicLong(0)

    private val links = ConcurrentHashMap<String, PeerLink>()

    /** Binds an ephemeral port and returns it, for the TXT record. */
    fun startServer(): Int {
        serverSocket?.let { existing ->
            if (!existing.isClosed) return existing.localPort
        }

        val socket = ServerSocket()
        socket.reuseAddress = true
        // Port 0: let the OS pick. Nothing hard-codes a port, so two FortShare
        // apps on one network never collide.
        socket.bind(InetSocketAddress(0))
        serverSocket = socket
        accepting.set(true)

        acceptThread = Thread({ acceptLoop(socket) }, "fortshare-accept").apply {
            isDaemon = true
            start()
        }
        return socket.localPort
    }

    fun stopServer() {
        accepting.set(false)
        runCatching { serverSocket?.close() }
        serverSocket = null
        for (link in links.values) link.close("server stopped")
        links.clear()
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (accepting.get() && !socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (_: IOException) {
                if (!accepting.get()) return
                continue
            }
            register(client, inbound = true)
        }
    }

    /**
     * Dial a peer. Blocking, so callers run it off the JavaScript thread.
     */
    fun connect(host: String, port: Int, timeoutMs: Int): String {
        val socket = Socket()
        socket.connect(InetSocketAddress(host, port), timeoutMs)
        return register(socket, inbound = false)
    }

    private fun register(socket: Socket, inbound: Boolean): String {
        val connectionId = "c${counter.incrementAndGet()}"
        val host = socket.inetAddress?.hostAddress ?: ""

        val link = PeerLink(
            connectionId = connectionId,
            socket = socket,
            host = host,
            port = socket.port,
            inbound = inbound,
            events = events,
            onClosed = { closed, reason ->
                links.remove(closed.connectionId)
                events.disconnect(
                    Json.obj("connectionId" to closed.connectionId, "reason" to reason),
                )
            },
        )

        links[connectionId] = link

        // Announce the connection *before* starting the reader.
        //
        // `link.start()` spawns a thread that can read the peer's HELLO within
        // microseconds on a LAN and emit onControl. React Native delivers
        // events to JavaScript in emission order, so emitting this first is
        // what guarantees the session layer has registered a handshake for
        // this connectionId before the first frame arrives. With the old
        // order, an inbound HELLO could reach JavaScript for an unknown
        // connection and be dropped, and the peer would just time out.
        events.connection(
            Json.obj(
                "connectionId" to connectionId,
                "host" to host,
                "port" to socket.port,
                "inbound" to inbound,
            ),
        )

        try {
            link.start()
        } catch (error: Throwable) {
            links.remove(connectionId)
            runCatching { socket.close() }
            events.disconnect(
                Json.obj(
                    "connectionId" to connectionId,
                    "reason" to (error.message ?: "could not start connection"),
                ),
            )
            throw error
        }

        return connectionId
    }

    fun link(connectionId: String): PeerLink =
        links[connectionId] ?: throw IOException("unknown connection $connectionId")

    fun disconnect(connectionId: String) {
        links[connectionId]?.close("closed locally")
    }

    val localPort: Int get() = serverSocket?.localPort ?: 0
}
