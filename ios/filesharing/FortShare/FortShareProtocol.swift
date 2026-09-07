import Foundation

/// Values shared with `src/constants/protocol.ts` and `Protocol.kt`.
/// The TypeScript file is the reference; keep all three in step.
enum FortShareProtocol {
    static let serviceType = "_fortshare._tcp"
    static let version = 1

    static let chunkSize = 256 * 1024
    /// Slice size for socket->disk copies. Independent of the frame size.
    static let ioBufferSize = 64 * 1024

    static let progressThrottleMs: Double = 250
    static let progressThrottleBytes: Int64 = 1024 * 1024

    /// TXT record keys. Deliberately terse — TXT records are small.
    static let txtVersion = "v"
    static let txtDeviceId = "did"
    static let txtName = "dn"
    static let txtPlatform = "pf"
    static let txtType = "dt"
    static let txtFingerprint = "fp"
}

/// The FortShare frame codec.
///
///   `[1 byte type][4 bytes big-endian length][length bytes payload]`
///
/// A DATA payload is self-locating — it carries its own file index and
/// absolute offset — which is what makes resume a matter of seeking rather
/// than replaying a stream.
enum FrameCodec {
    static let control: UInt8 = 0x01
    static let data: UInt8 = 0x02
    static let ping: UInt8 = 0x03
    static let pong: UInt8 = 0x04

    static let headerSize = 5
    /// DATA payload prefix: 4-byte file index + 8-byte offset.
    static let dataHeaderSize = 12
    /// Refuse absurd frames rather than trying to allocate for them.
    static let maxFrameSize = 4 * 1024 * 1024

    /// "FSHARE" + 0x00 + protocol version. Sent once per connection.
    static let hello = Data([0x46, 0x53, 0x48, 0x41, 0x52, 0x45, 0x00, 0x01])

    static func header(type: UInt8, length: Int) -> Data {
        var out = Data(capacity: headerSize)
        out.append(type)
        out.append(UInt8((length >> 24) & 0xff))
        out.append(UInt8((length >> 16) & 0xff))
        out.append(UInt8((length >> 8) & 0xff))
        out.append(UInt8(length & 0xff))
        return out
    }

    static func dataHeader(fileIndex: Int32, offset: Int64) -> Data {
        var out = Data(capacity: dataHeaderSize)
        let index = UInt32(bitPattern: fileIndex)
        for shift in stride(from: 24, through: 0, by: -8) {
            out.append(UInt8((index >> UInt32(shift)) & 0xff))
        }
        let unsignedOffset = UInt64(bitPattern: offset)
        for shift in stride(from: 56, through: 0, by: -8) {
            out.append(UInt8((unsignedOffset >> UInt64(shift)) & 0xff))
        }
        return out
    }

    static func readUInt32(_ data: Data, at index: Int) -> UInt32 {
        var value: UInt32 = 0
        for offset in 0..<4 {
            value = (value << 8) | UInt32(data[data.startIndex + index + offset])
        }
        return value
    }

    static func readUInt64(_ data: Data, at index: Int) -> UInt64 {
        var value: UInt64 = 0
        for offset in 0..<8 {
            value = (value << 8) | UInt64(data[data.startIndex + index + offset])
        }
        return value
    }
}

/// Small JSON helper for the native<->JavaScript boundary.
///
/// Every method argument and event payload is a JSON string rather than a
/// dictionary, so there is no marshalling behaviour to diverge between
/// Android and iOS.
enum FortShareJSON {
    /// Marks a value that is already JSON and must not be re-encoded.
    struct Raw {
        let json: String
        init(_ json: String) { self.json = json }
    }

    static func encode(_ fields: [(String, Any?)]) -> String {
        var object: [String: Any] = [:]
        for (key, value) in fields {
            switch value {
            case .none:
                object[key] = NSNull()
            case .some(let raw as Raw):
                object[key] = embedded(raw.json)
            case .some(let other):
                object[key] = other
            }
        }
        guard
            let data = try? JSONSerialization.data(withJSONObject: object),
            let text = String(data: data, encoding: .utf8)
        else { return "{}" }
        return text
    }

    /// Embed a pre-serialised value. Invalid JSON degrades to a string rather
    /// than corrupting the whole envelope.
    private static func embedded(_ json: String) -> Any {
        guard let data = json.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(
                  with: data,
                  options: [.fragmentsAllowed]
              )
        else { return json }
        return parsed
    }

    static func decode(_ json: String) -> [String: Any] {
        guard let data = json.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return parsed
    }
}

extension Dictionary where Key == String, Value == Any {
    func string(_ key: String, _ fallback: String = "") -> String {
        self[key] as? String ?? fallback
    }
    func int(_ key: String, _ fallback: Int = 0) -> Int {
        if let value = self[key] as? Int { return value }
        if let value = self[key] as? Double { return Int(value) }
        if let value = self[key] as? NSNumber { return value.intValue }
        return fallback
    }
    func int64(_ key: String, _ fallback: Int64 = 0) -> Int64 {
        if let value = self[key] as? Int64 { return value }
        if let value = self[key] as? Int { return Int64(value) }
        if let value = self[key] as? Double { return Int64(value) }
        if let value = self[key] as? NSNumber { return value.int64Value }
        return fallback
    }
}
