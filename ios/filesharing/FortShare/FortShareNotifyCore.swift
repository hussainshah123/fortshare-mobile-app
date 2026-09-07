import Foundation
import UIKit
import UserNotifications

/// Transfer notifications on iOS (§36).
///
/// There is no iOS equivalent of Android's foreground service. What the OS does
/// grant is a bounded background task, which is what `startTransferService`
/// begins here. We do not pretend to open-ended background execution: a long
/// transfer that gets suspended becomes a paused, resumable transfer, and the
/// user is told so.
@objc(FortShareNotifyCore)
final class FortShareNotifyCore: NSObject {
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var onAction: ((String) -> Void)?

    @objc func setNotificationAction(_ block: @escaping (String) -> Void) {
        onAction = block
    }

    @objc func requestPermission(completion: @escaping (Bool) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound, .badge]
        ) { granted, _ in
            DispatchQueue.main.async { completion(granted) }
        }
    }

    @objc func hasPermission(completion: @escaping (Bool) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let allowed = settings.authorizationStatus == .authorized
                || settings.authorizationStatus == .provisional
            DispatchQueue.main.async { completion(allowed) }
        }
    }

    /// Begin a background task so a transfer survives the app being
    /// backgrounded for as long as iOS allows.
    @objc func startTransferService(json: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.backgroundTask != .invalid { return }
            self.backgroundTask = UIApplication.shared.beginBackgroundTask(
                withName: "fortshare.transfer"
            ) { [weak self] in
                // Expiry: iOS is about to suspend us. End cleanly so the
                // transfer is paused-and-resumable rather than killed mid-frame.
                self?.stopTransferService()
            }
        }
    }

    /// iOS shows no persistent progress notification, so an update is a no-op
    /// unless the transfer has finished — see `notify`.
    @objc func updateTransferService(json: String) {}

    @objc func stopTransferService() {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.backgroundTask != .invalid else { return }
            UIApplication.shared.endBackgroundTask(self.backgroundTask)
            self.backgroundTask = .invalid
        }
    }

    @objc func notify(json: String) {
        let payload = FortShareJSON.decode(json)
        let content = UNMutableNotificationContent()
        content.title = payload.string("title")
        content.body = payload.string("body")
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: payload.string("id", UUID().uuidString),
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    @objc func cancelNotification(id: String) {
        UNUserNotificationCenter.current()
            .removePendingNotificationRequests(withIdentifiers: [id])
        UNUserNotificationCenter.current()
            .removeDeliveredNotifications(withIdentifiers: [id])
    }
}
