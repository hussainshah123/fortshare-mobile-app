import Foundation
import CryptoKit
import UIKit
import UniformTypeIdentifiers

/// Filesystem, hashing and OS integration for iOS.
///
/// Hashing lives here rather than in JavaScript because a SHA-256 over a
/// multi-gigabyte file has to stream: the file is read in 256 KB blocks and
/// only the 64-character digest crosses the bridge.
@objc(FortShareFsCore)
final class FortShareFsCore: NSObject {

    // MARK: - Hashing

    @objc func sha256(path: String) throws -> String {
        try digest(path: clean(path), offset: 0, length: -1)
    }

    @objc func sha256Range(path: String, offset: Double, length: Double) throws -> String {
        try digest(path: clean(path), offset: Int64(offset), length: Int64(length))
    }

    private func digest(path: String, offset: Int64, length: Int64) throws -> String {
        guard let handle = FileHandle(forReadingAtPath: path) else {
            throw FortShareError.message("no such file: \(path)")
        }
        defer { try? handle.close() }

        if offset > 0 { try handle.seek(toOffset: UInt64(offset)) }

        var hasher = CryptoKit.SHA256()
        var remaining = length < 0 ? Int64.max : length

        while remaining > 0 {
            let want = Int(min(Int64(FortShareProtocol.chunkSize), remaining))
            guard let block = try handle.read(upToCount: want), !block.isEmpty else { break }
            hasher.update(data: block)
            remaining -= Int64(block.count)
        }

        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Inspection

    @objc func stat(path: String) -> String {
        let target = clean(path)
        let attributes = try? FileManager.default.attributesOfItem(atPath: target)
        let exists = FileManager.default.fileExists(atPath: target)
        let size = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
        let isDir = (attributes?[.type] as? FileAttributeType) == .typeDirectory
        let mtime = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0

        return FortShareJSON.encode([
            ("exists", exists),
            ("size", size),
            ("isDir", isDir),
            ("mtime", Int64(mtime * 1000)),
        ])
    }

    @objc func exists(path: String) -> Bool {
        FileManager.default.fileExists(atPath: clean(path))
    }

    @objc func storageInfo() -> String {
        let url = URL(fileURLWithPath: NSHomeDirectory())
        let values = try? url.resourceValues(forKeys: [
            .volumeTotalCapacityKey,
            .volumeAvailableCapacityForImportantUsageKey,
        ])
        let total = Int64(values?.volumeTotalCapacity ?? 0)
        let free = values?.volumeAvailableCapacityForImportantUsage ?? 0

        return FortShareJSON.encode([
            ("totalBytes", total),
            ("freeBytes", free),
            ("usedBytes", max(0, total - free)),
        ])
    }

    // MARK: - Directories

    /// Where received files land.
    ///
    /// Documents/FortShare, which is what the Files app exposes when
    /// `UISupportsDocumentBrowser`/`LSSupportsOpeningDocumentsInPlace` are set
    /// — so received files are reachable without any extra permission (§37).
    @objc func receivedDir() throws -> String {
        let documents = try FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let target = documents.appendingPathComponent("FortShare", isDirectory: true)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        return target.path
    }

    @objc func ensureDir(path: String) throws {
        try FileManager.default.createDirectory(
            atPath: clean(path),
            withIntermediateDirectories: true
        )
    }

    @objc func listDir(path: String) -> String {
        let target = clean(path)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: target)) ?? []
        var entries: [[String: Any]] = []

        for name in names.sorted(by: { $0.lowercased() < $1.lowercased() }) {
            let full = (target as NSString).appendingPathComponent(name)
            let attributes = try? FileManager.default.attributesOfItem(atPath: full)
            entries.append([
                "name": name,
                "path": full,
                "size": (attributes?[.size] as? NSNumber)?.int64Value ?? 0,
                "isDir": (attributes?[.type] as? FileAttributeType) == .typeDirectory,
                "mtime": Int64(
                    ((attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000
                ),
                "mimeType": mimeType(for: name),
            ])
        }

        guard let data = try? JSONSerialization.data(withJSONObject: entries),
              let json = String(data: data, encoding: .utf8)
        else { return "[]" }
        return json
    }

    /// Turn a picker URI into something streamable.
    ///
    /// iOS hands out `file://` URLs, often inside a security-scoped container
    /// the picker only keeps open briefly. When the file is not readable in
    /// place we copy it into app storage once, up front — never during the
    /// transfer, where a stall would look like a network problem.
    @objc func resolveUri(uri: String) throws -> String {
        let path = clean(uri)
        let manager = FileManager.default

        if manager.isReadableFile(atPath: path) {
            let attributes = try? manager.attributesOfItem(atPath: path)
            return FortShareJSON.encode([
                ("path", path),
                ("name", (path as NSString).lastPathComponent),
                ("size", (attributes?[.size] as? NSNumber)?.int64Value ?? 0),
                ("mimeType", mimeType(for: path)),
            ])
        }

        guard let source = URL(string: uri) ?? URL(fileURLWithPath: path) as URL? else {
            throw FortShareError.message("cannot read \(uri)")
        }

        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }

        let staging = try manager.url(
            for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ).appendingPathComponent("outgoing", isDirectory: true)
        try manager.createDirectory(at: staging, withIntermediateDirectories: true)

        let name = source.lastPathComponent
        let target = staging.appendingPathComponent(
            "\(Int(Date().timeIntervalSince1970 * 1000))-\(name)"
        )
        if manager.fileExists(atPath: target.path) {
            try manager.removeItem(at: target)
        }
        try manager.copyItem(at: source, to: target)

        let attributes = try? manager.attributesOfItem(atPath: target.path)
        return FortShareJSON.encode([
            ("path", target.path),
            ("name", name),
            ("size", (attributes?[.size] as? NSNumber)?.int64Value ?? 0),
            ("mimeType", mimeType(for: name)),
        ])
    }

    /// "Vacation.mp4" -> ".../Vacation (1).mp4" when the name is taken (§26).
    @objc func uniquePath(dir: String, name: String) -> String {
        let directory = clean(dir) as NSString
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        let suffix = ext.isEmpty ? "" : ".\(ext)"

        var candidate = directory.appendingPathComponent(name)
        var counter = 1
        while FileManager.default.fileExists(atPath: candidate)
            || FileManager.default.fileExists(atPath: candidate + ".fortshare-part") {
            candidate = directory.appendingPathComponent("\(base) (\(counter))\(suffix)")
            counter += 1
        }
        return candidate
    }

    @objc func rename(from: String, to: String) throws {
        let manager = FileManager.default
        let source = clean(from)
        let target = clean(to)

        try manager.createDirectory(
            atPath: (target as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true
        )
        if manager.fileExists(atPath: target) {
            try manager.removeItem(atPath: target)
        }
        try manager.moveItem(atPath: source, toPath: target)
    }

    @objc func unlink(path: String) throws {
        let target = clean(path)
        if FileManager.default.fileExists(atPath: target) {
            try FileManager.default.removeItem(atPath: target)
        }
    }

    // MARK: - Integration

    @objc func openFile(path: String, mimeType: String) {
        present(path: path, share: false)
    }

    @objc func shareFile(path: String, mimeType: String) {
        present(path: path, share: true)
    }

    /// iOS has no media scanner: files in Documents/FortShare are already
    /// visible to the Files app. Kept so the TypeScript layer can call it
    /// unconditionally on both platforms.
    @objc func scanMedia(path: String, mimeType: String) {}

    private func present(path: String, share: Bool) {
        let url = URL(fileURLWithPath: clean(path))
        DispatchQueue.main.async {
            guard let root = Self.topViewController() else { return }
            let controller = UIActivityViewController(
                activityItems: [url],
                applicationActivities: nil
            )
            // iPad requires an anchor or the sheet will not present.
            controller.popoverPresentationController?.sourceView = root.view
            controller.popoverPresentationController?.sourceRect = CGRect(
                x: root.view.bounds.midX,
                y: root.view.bounds.maxY - 40,
                width: 0,
                height: 0
            )
            root.present(controller, animated: true)
        }
    }

    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
        let window = scenes
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? scenes.first?.windows.first

        var top = window?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }

    /// Installed apps — not possible on iOS.
    ///
    /// There is no app-enumeration API, and one app cannot read another's
    /// bundle. Returning an empty list lets the shared TypeScript UI show a
    /// clear explanation instead of a broken picker; the alternative would be
    /// pretending the feature exists and failing at transfer time.
    @objc func listInstalledApps() -> String {
        "[]"
    }

    /// The music library — deliberately empty on iOS.
    ///
    /// `MPMediaQuery` can enumerate tracks, but Apple Music items are
    /// DRM-protected and their asset URLs cannot be read or copied, so a list
    /// built from it would be mostly un-sendable entries. Local audio files
    /// are reachable through the document picker, which is what the UI falls
    /// back to.
    @objc func listAudio() -> String {
        "[]"
    }

    @objc func deviceInfo() -> String {
        let device = UIDevice.current
        let isPad = device.userInterfaceIdiom == .pad
        return FortShareJSON.encode([
            ("model", device.model),
            ("platform", "ios"),
            ("deviceType", isPad ? "tablet" : "phone"),
            ("osVersion", device.systemVersion),
            // "Hussain's iPhone" — the name the user already gave this device.
            ("defaultName", device.name),
        ])
    }

    // MARK: - Helpers

    private func mimeType(for name: String) -> String {
        let ext = (name as NSString).pathExtension
        guard !ext.isEmpty,
              let type = UTType(filenameExtension: ext),
              let mime = type.preferredMIMEType
        else { return "application/octet-stream" }
        return mime
    }

    private func clean(_ path: String) -> String {
        var value = path
        if value.hasPrefix("file://") {
            value = String(value.dropFirst("file://".count))
        }
        return value.removingPercentEncoding ?? value
    }
}
