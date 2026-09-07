package com.filesharing.fortshare

import java.io.DataInputStream
import java.io.EOFException
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * One TCP connection to one peer: the frame reader, the frame writer, and the
 * file handles for whatever is currently being received on it.
 *
 * Everything that touches file bytes lives here. The JavaScript layer never
 * sees them — it gets throttled counters and parsed control messages.
 */
internal class PeerLink(
    val connectionId: String,
    private val socket: Socket,
    val host: String,
    val port: Int,
    val inbound: Boolean,
    private val events: NetEvents,
    private val onClosed: (PeerLink, String) -> Unit,
) {
    private val input = DataInputStream(socket.getInputStream().buffered(64 * 1024))
    private val output = socket.getOutputStream().buffered(64 * 1024)

    /**
     * Guards whole frames rather than the whole stream.
     *
     * Held for the duration of one frame only, so a control frame (a pause, a
     * verification result) can slip between two chunks of a multi-gigabyte
     * file instead of queueing behind all of it. Fair, so a busy send loop
     * cannot starve control traffic.
     */
    private val writeLock = ReentrantLock(true)

    private val closed = AtomicBoolean(false)
    private var readerThread: Thread? = null

    /** Files currently being received, keyed by the wire's file index. */
    private val receiving = ConcurrentHashMap<Int, ReceiveTarget>()
    /** Send jobs in flight, keyed by transferId, so a pause can find them. */
    private val sending = ConcurrentHashMap<String, SendJob>()

    /** Reserved for AEAD on the data path (see docs/ARCHITECTURE.md §4). */
    @Volatile var sessionKey: ByteArray? = null

    private class ReceiveTarget(
        val transferId: String,
        val fileId: String,
        val fileIndex: Int,
        val handle: RandomAccessFile,
        val path: String,
        val expectedSize: Long,
        @Volatile var received: Long,
    ) {
        var lastEmitAt: Long = 0L
        var lastEmitBytes: Long = 0L
    }

    private class SendJob(val transferId: String) {
        @Volatile var cancelled = false
        @Volatile var paused = false
    }

    fun start() {
        socket.tcpNoDelay = true
        socket.keepAlive = true
        // A stalled peer must not wedge the reader forever; the read timeout
        // is what turns "gone" into a recoverable pause rather than a hang.
        socket.soTimeout = Protocol.READ_TIMEOUT_MS

        writeLock.withLock {
            output.write(Frames.HELLO)
            output.flush()
        }

        readerThread = Thread({ readLoop() }, "fortshare-read-$connectionId").apply {
            isDaemon = true
            start()
        }
    }

    // ------------------------------------------------------------------ writing

    fun sendControl(json: String) {
        val payload = json.toByteArray(Charsets.UTF_8)
        writeLock.withLock {
            if (closed.get()) throw IOException("connection closed")
            Frames.writeHeader(output, Frames.TYPE_CONTROL, payload.size)
            output.write(payload)
            output.flush()
        }
    }

    private fun sendPong() {
        writeLock.withLock {
            if (closed.get()) return
            Frames.writeHeader(output, Frames.TYPE_PONG, 0)
            output.flush()
        }
    }

    private fun sendPing() {
        writeLock.withLock {
            if (closed.get()) return
            Frames.writeHeader(output, Frames.TYPE_PING, 0)
            output.flush()
        }
    }

    /**
     * Stream a file to the peer, starting at [offset].
     *
     * Memory is one reusable buffer regardless of file size, and the blocking
     * socket write *is* the backpressure: if the peer's receive window closes,
     * this loop stalls instead of buffering.
     */
    fun sendFile(
        transferId: String,
        fileId: String,
        fileIndex: Int,
        path: String,
        offset: Long,
        size: Long,
        chunkSize: Int,
    ) {
        val job = SendJob(transferId)
        sending[transferId] = job

        Thread({
            var handle: RandomAccessFile? = null
            try {
                val file = File(path)
                if (!file.exists()) throw IOException("source file is gone: $path")

                handle = RandomAccessFile(file, "r")
                handle.seek(offset)

                val buffer = ByteArray(Frames.DATA_HEADER_SIZE + chunkSize)
                var position = offset
                var lastEmitAt = 0L
                var lastEmitBytes = offset

                while (position < size) {
                    if (job.cancelled || job.paused || closed.get()) break

                    val want = minOf(chunkSize.toLong(), size - position).toInt()
                    val read = handle.read(buffer, Frames.DATA_HEADER_SIZE, want)
                    if (read <= 0) break

                    Frames.putDataHeader(buffer, fileIndex, position)
                    writeLock.withLock {
                        if (closed.get()) throw IOException("connection closed")
                        Frames.writeHeader(
                            output,
                            Frames.TYPE_DATA,
                            Frames.DATA_HEADER_SIZE + read,
                        )
                        output.write(buffer, 0, Frames.DATA_HEADER_SIZE + read)
                        output.flush()
                    }
                    position += read

                    val now = System.currentTimeMillis()
                    if (now - lastEmitAt >= Protocol.PROGRESS_THROTTLE_MS ||
                        position - lastEmitBytes >= Protocol.PROGRESS_THROTTLE_BYTES ||
                        position >= size
                    ) {
                        lastEmitAt = now
                        lastEmitBytes = position
                        events.sendProgress(
                            Json.obj(
                                "transferId" to transferId,
                                "fileId" to fileId,
                                "fileIndex" to fileIndex,
                                "transferredBytes" to position,
                                "totalBytes" to size,
                            ),
                        )
                    }
                }

                if (job.cancelled) return@Thread
                if (job.paused || closed.get()) {
                    // Not an error: the partial state is intact on both sides
                    // and a resume will pick it up from the receiver's length.
                    events.transferError(
                        Json.obj(
                            "transferId" to transferId,
                            "fileId" to fileId,
                            "message" to "transfer interrupted",
                            "recoverable" to true,
                        ),
                    )
                    return@Thread
                }

                events.sendComplete(
                    Json.obj(
                        "transferId" to transferId,
                        "fileId" to fileId,
                        "fileIndex" to fileIndex,
                        "transferredBytes" to position,
                    ),
                )
            } catch (error: Throwable) {
                events.transferError(
                    Json.obj(
                        "transferId" to transferId,
                        "fileId" to fileId,
                        "message" to (error.message ?: "send failed"),
                        // An IO failure on the socket is recoverable; a missing
                        // or unreadable source file is not.
                        "recoverable" to (error is IOException && !closed.get()),
                    ),
                )
            } finally {
                try { handle?.close() } catch (_: IOException) {}
                sending.remove(transferId, job)
            }
        }, "fortshare-send-$transferId").apply {
            isDaemon = true
            start()
        }
    }

    /**
     * Arm a receiver for [fileIndex] before the peer starts streaming it.
     *
     * The TypeScript layer arms every file in a transfer up front, so there is
     * no window where a DATA frame could arrive with nowhere to go.
     */
    fun receiveFile(
        transferId: String,
        fileId: String,
        fileIndex: Int,
        destPath: String,
        offset: Long,
        size: Long,
    ) {
        receiving.remove(fileIndex)?.let { runCatching { it.handle.close() } }

        val file = File(destPath)
        file.parentFile?.mkdirs()

        val handle = RandomAccessFile(file, "rw")
        // Truncate anything past the resume point: bytes beyond the offset the
        // sender is resuming from were never acknowledged and must not be
        // mistaken for good data.
        handle.setLength(offset)
        handle.seek(offset)

        receiving[fileIndex] = ReceiveTarget(
            transferId = transferId,
            fileId = fileId,
            fileIndex = fileIndex,
            handle = handle,
            path = destPath,
            expectedSize = size,
            received = offset,
        )
    }

    fun pauseTransfer(transferId: String) {
        sending[transferId]?.paused = true
    }

    fun cancelTransfer(transferId: String) {
        sending[transferId]?.cancelled = true
        val indexes = receiving.filterValues { it.transferId == transferId }.keys
        for (index in indexes) {
            receiving.remove(index)?.let { target ->
                runCatching { target.handle.close() }
                // Cancelled means abandon: drop the partial file so it cannot
                // be mistaken for resumable state.
                runCatching { File(target.path).delete() }
            }
        }
    }

    // ------------------------------------------------------------------ reading

    private fun readLoop() {
        var reason = "closed"
        try {
            val hello = ByteArray(Frames.HELLO.size)
            Frames.readFully(input, hello, hello.size)
            if (!hello.contentEquals(Frames.HELLO)) {
                reason = "not a FortShare peer"
                return
            }

            var idleStrikes = 0

            while (!closed.get()) {
                val type = try {
                    input.read()
                } catch (_: SocketTimeoutException) {
                    // An idle session is normal — a paired device may sit for
                    // hours before anyone sends anything. Probe instead of
                    // hanging up: PING, and only give up after several
                    // consecutive silent rounds. Previously this tore the
                    // connection down after one quiet period, so a session
                    // died about a minute after pairing.
                    idleStrikes += 1
                    if (idleStrikes >= Protocol.MAX_IDLE_STRIKES) {
                        reason = "peer stopped responding"
                        return
                    }
                    runCatching { sendPing() }.onFailure {
                        reason = it.message ?: "connection lost"
                        return
                    }
                    continue
                }

                if (type < 0) {
                    reason = "peer closed the connection"
                    return
                }
                // Any frame at all, PONG included, proves the peer is alive.
                idleStrikes = 0
                val length = Frames.readInt(input)
                if (length < 0 || length > Frames.MAX_FRAME_SIZE) {
                    reason = "oversized frame ($length bytes)"
                    return
                }

                when (type) {
                    Frames.TYPE_CONTROL -> {
                        val payload = ByteArray(length)
                        Frames.readFully(input, payload, length)
                        events.control(
                            Json.obj(
                                "connectionId" to connectionId,
                                "message" to Json.raw(String(payload, Charsets.UTF_8)),
                            ),
                        )
                    }
                    Frames.TYPE_DATA -> readDataFrame(length)
                    Frames.TYPE_PING -> {
                        Frames.skip(input, length)
                        sendPong()
                    }
                    Frames.TYPE_PONG -> Frames.skip(input, length)
                    else -> Frames.skip(input, length)
                }
            }
        } catch (_: EOFException) {
            reason = "peer closed the connection"
        } catch (error: Throwable) {
            reason = error.message ?: "read failed"
        } finally {
            close(reason)
        }
    }

    /**
     * Stream one DATA frame from the socket straight onto disk.
     *
     * The payload is read in bounded slices and written at the absolute offset
     * the frame declares, so nothing accumulates in memory and a resumed
     * transfer lands its bytes in exactly the right place.
     */
    private fun readDataFrame(length: Int) {
        if (length < Frames.DATA_HEADER_SIZE) {
            Frames.skip(input, length)
            return
        }

        val header = ByteArray(Frames.DATA_HEADER_SIZE)
        Frames.readFully(input, header, header.size)
        val fileIndex =
            ((header[0].toInt() and 0xff) shl 24) or
                ((header[1].toInt() and 0xff) shl 16) or
                ((header[2].toInt() and 0xff) shl 8) or
                (header[3].toInt() and 0xff)
        var offset = 0L
        for (i in 0 until 8) {
            offset = (offset shl 8) or (header[4 + i].toLong() and 0xff)
        }

        val payloadLength = length - Frames.DATA_HEADER_SIZE
        val target = receiving[fileIndex]
        if (target == null) {
            // Nothing armed for this index — a stale frame from a cancelled
            // transfer. Discard it but keep the stream aligned.
            Frames.skip(input, payloadLength)
            return
        }

        val buffer = ByteArray(minOf(payloadLength, Protocol.IO_BUFFER_SIZE))
        var written = 0
        synchronized(target.handle) {
            target.handle.seek(offset)
            while (written < payloadLength) {
                val want = minOf(buffer.size, payloadLength - written)
                val read = input.read(buffer, 0, want)
                if (read < 0) throw EOFException("peer closed mid-chunk")
                target.handle.write(buffer, 0, read)
                written += read
            }
        }
        target.received = offset + payloadLength

        val now = System.currentTimeMillis()
        val complete = target.received >= target.expectedSize
        if (complete ||
            now - target.lastEmitAt >= Protocol.PROGRESS_THROTTLE_MS ||
            target.received - target.lastEmitBytes >= Protocol.PROGRESS_THROTTLE_BYTES
        ) {
            target.lastEmitAt = now
            target.lastEmitBytes = target.received
            events.receiveProgress(
                Json.obj(
                    "transferId" to target.transferId,
                    "fileId" to target.fileId,
                    "fileIndex" to target.fileIndex,
                    "transferredBytes" to target.received,
                    "totalBytes" to target.expectedSize,
                ),
            )
        }

        if (complete) {
            receiving.remove(fileIndex)
            synchronized(target.handle) {
                // Force the bytes down before we tell JavaScript to hash them.
                runCatching { target.handle.fd.sync() }
                runCatching { target.handle.close() }
            }
            events.receiveComplete(
                Json.obj(
                    "transferId" to target.transferId,
                    "fileId" to target.fileId,
                    "fileIndex" to target.fileIndex,
                    "transferredBytes" to target.received,
                    "path" to target.path,
                ),
            )
        }
    }

    // ------------------------------------------------------------------ closing

    fun close(reason: String) {
        if (!closed.compareAndSet(false, true)) return

        for (job in sending.values) job.paused = true
        sending.clear()

        for (target in receiving.values) {
            // Deliberately keep the partial file: it is the resume state.
            runCatching { target.handle.fd.sync() }
            runCatching { target.handle.close() }
        }
        receiving.clear()

        runCatching { socket.close() }
        onClosed(this, reason)
    }

    val isClosed: Boolean get() = closed.get()
}
