import Foundation
import Network

/// One TCP connection to one peer: the frame reader, the frame writer, and the
/// file handles for whatever is currently being received on it.
///
/// Everything that touches file bytes lives here. The JavaScript layer never
/// sees them — it gets throttled counters and parsed control messages.
final class FortSharePeerLink {
    let connectionId: String
    let host: String
    let port: Int
    let inbound: Bool

    private let connection: NWConnection
    private let events: FortShareNetEvents
    private let onClosed: (FortSharePeerLink, String) -> Void

    /// Serialises frame writes. `NWConnection.send` is already ordered, but a
    /// file stream must not interleave *within* a frame, and the send loop
    /// waits on each completion here to get backpressure.
    private let writeQueue = DispatchQueue(label: "fortshare.write")

    /**
     * Guards mutable state. Never used as the connection's callback queue.
     *
     * These two used to be the same queue, which deadlocked the moment any
     * frame arrived: Network framework delivered the callback *on*
     * `stateQueue`, the handler read `isClosed`, and that does
     * `stateQueue.sync` — a queue waiting on itself. libdispatch detects that
     * and aborts the process (EXC_BAD_INSTRUCTION inside
     * `__DISPATCH_WAIT_FOR_QUEUE__`), so it was a hard crash on the first
     * inbound frame rather than a subtle stall.
     */
    private let stateQueue = DispatchQueue(label: "fortshare.state")

    /**
     * Where Network framework delivers this connection's callbacks.
     *
     * Serial, as NWConnection requires, and deliberately distinct from
     * `stateQueue` so that reading state from inside a callback is safe.
     */
    private let callbackQueue = DispatchQueue(label: "fortshare.connection")

    private var buffer = Data()
    private var sawHello = false
    private var closed = false

    /// Files currently being received, keyed by the wire's file index.
    private var receiving: [Int32: ReceiveTarget] = [:]
    /// Send jobs in flight, keyed by transferId, so a pause can find them.
    private var sending: [String: SendJob] = [:]

    /// Reserved for AEAD on the data path (see docs/ARCHITECTURE.md §4).
    private var sessionKey: Data?

    private final class ReceiveTarget {
        let transferId: String
        let fileId: String
        let fileIndex: Int32
        let handle: FileHandle
        let path: String
        let expectedSize: Int64
        var received: Int64
        var lastEmitAt: TimeInterval = 0
        var lastEmitBytes: Int64 = 0

        init(transferId: String, fileId: String, fileIndex: Int32, handle: FileHandle,
             path: String, expectedSize: Int64, received: Int64) {
            self.transferId = transferId
            self.fileId = fileId
            self.fileIndex = fileIndex
            self.handle = handle
            self.path = path
            self.expectedSize = expectedSize
            self.received = received
            self.lastEmitBytes = received
        }
    }

    private final class SendJob {
        var paused = false
        var cancelled = false
    }

    init(connectionId: String,
         connection: NWConnection,
         host: String,
         port: Int,
         inbound: Bool,
         events: FortShareNetEvents,
         onClosed: @escaping (FortSharePeerLink, String) -> Void) {
        self.connectionId = connectionId
        self.connection = connection
        self.host = host
        self.port = port
        self.inbound = inbound
        self.events = events
        self.onClosed = onClosed
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.sendRaw(FrameCodec.hello)
                self.receiveNext()
            case .failed(let error):
                self.close(reason: error.localizedDescription)
            case .cancelled:
                self.close(reason: "connection cancelled")
            default:
                break
            }
        }
        connection.start(queue: callbackQueue)
    }

    // MARK: - Writing

    func sendControl(_ json: String) throws {
        guard let payload = json.data(using: .utf8) else {
            throw FortShareError.message("control payload is not valid UTF-8")
        }
        var frame = FrameCodec.header(type: FrameCodec.control, length: payload.count)
        frame.append(payload)
        try sendBlocking(frame)
    }

    private func sendRaw(_ data: Data) {
        connection.send(content: data, completion: .contentProcessed { _ in })
    }

    /// Send and wait for the OS to take the bytes.
    ///
    /// Waiting is the point: it is what gives the file send loop backpressure.
    /// If the peer's receive window closes, this blocks and the loop stalls
    /// instead of buffering the rest of a multi-gigabyte file in memory.
    private func sendBlocking(_ data: Data) throws {
        var failure: Error?
        let semaphore = DispatchSemaphore(value: 0)
        connection.send(content: data, completion: .contentProcessed { error in
            failure = error
            semaphore.signal()
        })
        semaphore.wait()
        if let failure { throw failure }
    }

    /// Stream a file to the peer, starting at `offset`.
    ///
    /// Memory is one reusable slice regardless of file size.
    func sendFile(transferId: String,
                  fileId: String,
                  fileIndex: Int32,
                  path: String,
                  offset: Int64,
                  size: Int64,
                  chunkSize: Int) {
        let job = SendJob()
        stateQueue.sync { sending[transferId] = job }

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            var handle: FileHandle?
            do {
                guard let opened = FileHandle(forReadingAtPath: path) else {
                    throw FortShareError.message("source file is gone: \(path)")
                }
                handle = opened
                try opened.seek(toOffset: UInt64(offset))

                var position = offset
                var lastEmitAt: TimeInterval = 0
                var lastEmitBytes = offset
                // Captured once: the key cannot change mid-file.
                let key = self.stateQueue.sync { self.sessionKey }

                while position < size {
                    if job.cancelled || job.paused || self.isClosed { break }

                    let want = Int(min(Int64(chunkSize), size - position))
                    let chunk = try opened.read(upToCount: want) ?? Data()
                    if chunk.isEmpty { break }

                    let header = FrameCodec.dataHeader(
                        fileIndex: fileIndex,
                        offset: position
                    )

                    var frame: Data
                    if let key {
                        // [header][nonce][ciphertext||tag]
                        let nonce = TransferCrypto.newNonce()
                        let sealed = try TransferCrypto.seal(
                            key: key,
                            nonce: nonce,
                            aad: header,
                            plaintext: chunk
                        )
                        frame = FrameCodec.header(
                            type: FrameCodec.data,
                            length: FrameCodec.dataHeaderSize + nonce.count + sealed.count
                        )
                        frame.append(header)
                        frame.append(nonce)
                        frame.append(sealed)
                    } else {
                        frame = FrameCodec.header(
                            type: FrameCodec.data,
                            length: FrameCodec.dataHeaderSize + chunk.count
                        )
                        frame.append(header)
                        frame.append(chunk)
                    }
                    try self.sendBlocking(frame)

                    position += Int64(chunk.count)

                    let now = Date().timeIntervalSince1970 * 1000
                    if now - lastEmitAt >= FortShareProtocol.progressThrottleMs
                        || position - lastEmitBytes >= FortShareProtocol.progressThrottleBytes
                        || position >= size {
                        lastEmitAt = now
                        lastEmitBytes = position
                        self.events.onSendProgress(FortShareJSON.encode([
                            ("transferId", transferId),
                            ("fileId", fileId),
                            ("fileIndex", Int(fileIndex)),
                            ("transferredBytes", position),
                            ("totalBytes", size),
                        ]))
                    }
                }

                try? handle?.close()
                handle = nil

                if job.cancelled { return }
                if job.paused || self.isClosed {
                    // Not an error: partial state is intact on both sides and a
                    // resume will pick it up from the receiver's on-disk length.
                    self.events.onTransferError(FortShareJSON.encode([
                        ("transferId", transferId),
                        ("fileId", fileId),
                        ("message", "transfer interrupted"),
                        ("recoverable", true),
                    ]))
                    return
                }

                self.events.onSendComplete(FortShareJSON.encode([
                    ("transferId", transferId),
                    ("fileId", fileId),
                    ("fileIndex", Int(fileIndex)),
                    ("transferredBytes", position),
                ]))
            } catch {
                try? handle?.close()
                self.events.onTransferError(FortShareJSON.encode([
                    ("transferId", transferId),
                    ("fileId", fileId),
                    ("message", error.localizedDescription),
                    // A socket failure is recoverable; a missing source file is not.
                    ("recoverable", !self.isClosed && error is NWError),
                ]))
            }
            self.stateQueue.sync { self.sending.removeValue(forKey: transferId) }
        }
    }

    /// Arm a receiver for `fileIndex` before the peer starts streaming it.
    ///
    /// The TypeScript layer arms every file in a transfer up front, so there is
    /// no window where a DATA frame could arrive with nowhere to go.
    func receiveFile(transferId: String,
                     fileId: String,
                     fileIndex: Int32,
                     destPath: String,
                     offset: Int64,
                     size: Int64) throws {
        try stateQueue.sync {
            if let existing = receiving.removeValue(forKey: fileIndex) {
                try? existing.handle.close()
            }

            let manager = FileManager.default
            let directory = (destPath as NSString).deletingLastPathComponent
            try? manager.createDirectory(
                atPath: directory,
                withIntermediateDirectories: true
            )
            if !manager.fileExists(atPath: destPath) {
                manager.createFile(atPath: destPath, contents: nil)
            }

            guard let handle = FileHandle(forWritingAtPath: destPath) else {
                throw FortShareError.message("cannot open \(destPath) for writing")
            }
            // Discard anything past the resume point: bytes beyond the offset
            // the sender is resuming from were never acknowledged and must not
            // be mistaken for good data.
            try handle.truncate(atOffset: UInt64(offset))
            try handle.seek(toOffset: UInt64(offset))

            receiving[fileIndex] = ReceiveTarget(
                transferId: transferId,
                fileId: fileId,
                fileIndex: fileIndex,
                handle: handle,
                path: destPath,
                expectedSize: size,
                received: offset
            )
        }
    }

    func pauseTransfer(_ transferId: String) {
        stateQueue.sync { sending[transferId]?.paused = true }
    }

    func cancelTransfer(_ transferId: String) {
        stateQueue.sync {
            sending[transferId]?.cancelled = true
            for (index, target) in receiving where target.transferId == transferId {
                try? target.handle.close()
                // Cancelled means abandon: drop the partial so it cannot be
                // mistaken for resumable state.
                try? FileManager.default.removeItem(atPath: target.path)
                receiving.removeValue(forKey: index)
            }
        }
    }

    func setSessionKey(_ key: Data) {
        stateQueue.sync { sessionKey = key }
    }

    // MARK: - Reading

    private func receiveNext() {
        connection.receive(
            minimumIncompleteLength: 1,
            maximumLength: FortShareProtocol.ioBufferSize
        ) { [weak self] content, _, isComplete, error in
            guard let self else { return }

            if let error {
                self.close(reason: error.localizedDescription)
                return
            }
            if let content, !content.isEmpty {
                self.buffer.append(content)
                self.drainBuffer()
            }
            if isComplete {
                self.close(reason: "peer closed the connection")
                return
            }
            if !self.isClosed { self.receiveNext() }
        }
    }

    /// Consume as many whole frames as the buffer currently holds.
    ///
    /// A partial frame is left in place until the rest arrives — TCP gives us a
    /// byte stream, not messages, so the length prefix is the only framing.
    private func drainBuffer() {
        if !sawHello {
            guard buffer.count >= FrameCodec.hello.count else { return }
            let prefix = buffer.prefix(FrameCodec.hello.count)
            buffer.removeFirst(FrameCodec.hello.count)
            guard Data(prefix) == FrameCodec.hello else {
                close(reason: "not a FortShare peer")
                return
            }
            sawHello = true
        }

        while buffer.count >= FrameCodec.headerSize {
            let type = buffer[buffer.startIndex]
            let length = Int(FrameCodec.readUInt32(buffer, at: 1))

            if length < 0 || length > FrameCodec.maxFrameSize {
                close(reason: "oversized frame (\(length) bytes)")
                return
            }
            guard buffer.count >= FrameCodec.headerSize + length else { return }

            let payload = Data(
                buffer[
                    buffer.index(buffer.startIndex, offsetBy: FrameCodec.headerSize)
                        ..< buffer.index(
                            buffer.startIndex,
                            offsetBy: FrameCodec.headerSize + length
                        )
                ]
            )
            buffer.removeFirst(FrameCodec.headerSize + length)

            switch type {
            case FrameCodec.control:
                if let json = String(data: payload, encoding: .utf8) {
                    events.onControl(FortShareJSON.encode([
                        ("connectionId", connectionId),
                        ("message", FortShareJSON.Raw(json)),
                    ]))
                }
            case FrameCodec.data:
                handleDataFrame(payload)
            case FrameCodec.ping:
                // Fire-and-forget, never `sendBlocking`. This runs on the
                // callback queue, and the send completion is delivered on
                // that same serial queue — so waiting for it here would
                // deadlock exactly as the state queue did.
                sendRaw(FrameCodec.header(type: FrameCodec.pong, length: 0))
            default:
                break // PONG and anything unknown: ignore, stream stays aligned.
            }
        }
    }

    /// Write one DATA frame's payload to disk at the offset it declares.
    private func handleDataFrame(_ payload: Data) {
        guard payload.count >= FrameCodec.dataHeaderSize else { return }

        let fileIndex = Int32(bitPattern: FrameCodec.readUInt32(payload, at: 0))
        let offset = Int64(bitPattern: FrameCodec.readUInt64(payload, at: 4))
        // Retained verbatim: this is the AAD the sender authenticated, so it
        // must be the exact bytes.
        let header = Data(payload.prefix(FrameCodec.dataHeaderSize))
        let body = Data(payload.dropFirst(FrameCodec.dataHeaderSize))

        // Nothing armed for this index means a stale frame from a cancelled
        // transfer; dropping it is correct and the stream stays aligned.
        guard let target = stateQueue.sync(execute: { receiving[fileIndex] }) else { return }

        let key = stateQueue.sync { sessionKey }
        let bytes: Data

        if let key {
            guard body.count >= TransferCrypto.nonceSize + TransferCrypto.tagSize else {
                close(reason: "truncated encrypted chunk")
                return
            }
            let nonce = Data(body.prefix(TransferCrypto.nonceSize))
            let sealed = Data(body.dropFirst(TransferCrypto.nonceSize))
            do {
                bytes = try TransferCrypto.open(
                    key: key,
                    nonce: nonce,
                    aad: header,
                    sealed: sealed
                )
            } catch {
                // Altered in flight, or the peer does not hold the session
                // key. Drop the connection rather than writing unverified
                // data to the user's disk.
                close(reason: "chunk failed authentication")
                return
            }
        } else {
            bytes = body
        }

        do {
            try target.handle.seek(toOffset: UInt64(offset))
            try target.handle.write(contentsOf: bytes)
        } catch {
            events.onTransferError(FortShareJSON.encode([
                ("transferId", target.transferId),
                ("fileId", target.fileId),
                ("message", error.localizedDescription),
                ("recoverable", false),
            ]))
            return
        }

        target.received = offset + Int64(bytes.count)
        let complete = target.received >= target.expectedSize
        let now = Date().timeIntervalSince1970 * 1000

        if complete
            || now - target.lastEmitAt >= FortShareProtocol.progressThrottleMs
            || target.received - target.lastEmitBytes >= FortShareProtocol.progressThrottleBytes {
            target.lastEmitAt = now
            target.lastEmitBytes = target.received
            events.onReceiveProgress(FortShareJSON.encode([
                ("transferId", target.transferId),
                ("fileId", target.fileId),
                ("fileIndex", Int(target.fileIndex)),
                ("transferredBytes", target.received),
                ("totalBytes", target.expectedSize),
            ]))
        }

        if complete {
            stateQueue.sync { receiving.removeValue(forKey: fileIndex) }
            // Force the bytes down before telling JavaScript to hash them.
            try? target.handle.synchronize()
            try? target.handle.close()
            events.onReceiveComplete(FortShareJSON.encode([
                ("transferId", target.transferId),
                ("fileId", target.fileId),
                ("fileIndex", Int(target.fileIndex)),
                ("transferredBytes", target.received),
                ("path", target.path),
            ]))
        }
    }

    // MARK: - Closing

    var isClosed: Bool { stateQueue.sync { closed } }

    func close(reason: String) {
        let shouldNotify: Bool = stateQueue.sync {
            if closed { return false }
            closed = true
            for job in sending.values { job.paused = true }
            sending.removeAll()
            for target in receiving.values {
                // Deliberately keep the partial file: it is the resume state.
                try? target.handle.synchronize()
                try? target.handle.close()
            }
            receiving.removeAll()
            return true
        }
        guard shouldNotify else { return }
        connection.cancel()
        onClosed(self, reason)
    }
}

enum FortShareError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        }
    }
}
