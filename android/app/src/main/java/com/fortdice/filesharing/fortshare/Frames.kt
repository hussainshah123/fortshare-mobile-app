package com.fortdice.filesharing.fortshare

import java.io.DataInputStream
import java.io.EOFException
import java.io.OutputStream

/**
 * The FortShare frame codec.
 *
 * Mirrors src/constants/protocol.ts and ios/.../FrameCodec.swift. All three
 * must agree byte for byte; the TypeScript file is the reference.
 *
 *   [1 byte type][4 bytes big-endian length][length bytes payload]
 *
 * A DATA payload is self-locating — it carries its own file index and absolute
 * offset — which is what makes resume a matter of seeking rather than
 * replaying a stream.
 */
internal object Frames {
    const val TYPE_CONTROL: Int = 0x01
    const val TYPE_DATA: Int = 0x02
    const val TYPE_PING: Int = 0x03
    const val TYPE_PONG: Int = 0x04

    /** "FSHARE" + 0x00 + protocol version. Sent once per connection. */
    val HELLO: ByteArray =
        byteArrayOf('F'.code.toByte(), 'S'.code.toByte(), 'H'.code.toByte(),
                    'A'.code.toByte(), 'R'.code.toByte(), 'E'.code.toByte(), 0x00, 0x01)

    const val HEADER_SIZE: Int = 5
    /** DATA payload prefix: 4-byte file index + 8-byte offset. */
    const val DATA_HEADER_SIZE: Int = 12

    /** Refuse absurd frames rather than trying to allocate for them. */
    const val MAX_FRAME_SIZE: Int = 4 * 1024 * 1024

    fun writeHeader(out: OutputStream, type: Int, length: Int) {
        out.write(type)
        out.write((length ushr 24) and 0xff)
        out.write((length ushr 16) and 0xff)
        out.write((length ushr 8) and 0xff)
        out.write(length and 0xff)
    }

    fun putDataHeader(buffer: ByteArray, fileIndex: Int, offset: Long) {
        buffer[0] = ((fileIndex ushr 24) and 0xff).toByte()
        buffer[1] = ((fileIndex ushr 16) and 0xff).toByte()
        buffer[2] = ((fileIndex ushr 8) and 0xff).toByte()
        buffer[3] = (fileIndex and 0xff).toByte()
        for (i in 0 until 8) {
            buffer[4 + i] = ((offset ushr (56 - 8 * i)) and 0xff).toByte()
        }
    }

    fun readInt(input: DataInputStream): Int = input.readInt()

    fun readFully(input: DataInputStream, target: ByteArray, length: Int) {
        var read = 0
        while (read < length) {
            val n = input.read(target, read, length - read)
            if (n < 0) throw EOFException("peer closed mid-frame")
            read += n
        }
    }

    /** Skips a frame body we cannot use, so the stream stays aligned. */
    fun skip(input: DataInputStream, length: Int) {
        var remaining = length.toLong()
        while (remaining > 0) {
            val skipped = input.skip(remaining)
            if (skipped <= 0) throw EOFException("peer closed while skipping")
            remaining -= skipped
        }
    }
}
