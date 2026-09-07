package com.filesharing.fortshare

import android.Manifest
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.filesharing.specs.NativeFortShareNotifySpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import org.json.JSONObject

/**
 * Transfer notifications and the Android foreground service (§36).
 */
@ReactModule(name = NativeFortShareNotifySpec.NAME)
class FortShareNotifyModule(private val reactContext: ReactApplicationContext) :
    NativeFortShareNotifySpec(reactContext) {

    private var receiver: BroadcastReceiver? = null

    init {
        TransferService.ensureChannels(reactContext)
        registerActionReceiver()
    }

    override fun invalidate() {
        receiver?.let { runCatching { reactContext.unregisterReceiver(it) } }
        receiver = null
        super.invalidate()
    }

    /** Forwards Pause/Cancel taps on the notification through to JavaScript. */
    private fun registerActionReceiver() {
        val handler = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                val action = intent?.getStringExtra(TransferService.EXTRA_ACTION) ?: return
                val transferId =
                    intent.getStringExtra(TransferService.EXTRA_TRANSFER_ID) ?: return
                emitOnNotificationAction(
                    Json.obj("action" to action, "transferId" to transferId),
                )
            }
        }
        receiver = handler
        val filter = IntentFilter(TransferService.BROADCAST_ACTION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            reactContext.registerReceiver(handler, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            reactContext.registerReceiver(handler, filter)
        }
    }

    // -------------------------------------------------------------- permission

    override fun hasPermission(promise: Promise) {
        promise.resolve(notificationsAllowed())
    }

    /**
     * POST_NOTIFICATIONS is a runtime permission from Android 13.
     * Requested only when a transfer is about to start, not at launch (§37).
     */
    override fun requestPermission(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            promise.resolve(true)
            return
        }
        if (notificationsAllowed()) {
            promise.resolve(true)
            return
        }

        val activity = reactContext.currentActivity as? PermissionAwareActivity
        if (activity == null) {
            promise.resolve(false)
            return
        }

        activity.requestPermissions(
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            REQUEST_CODE,
            PermissionListener { requestCode, _, results ->
                if (requestCode != REQUEST_CODE) return@PermissionListener false
                promise.resolve(
                    results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED,
                )
                true
            },
        )
    }

    private fun notificationsAllowed(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            reactContext,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    // ----------------------------------------------------------------- service

    override fun startTransferService(json: String, promise: Promise) {
        settle(promise) {
            val payload = JSONObject(json)
            val intent = Intent(reactContext, TransferService::class.java).apply {
                action = TransferService.ACTION_START
                putExtra(TransferService.EXTRA_TRANSFER_ID, payload.optString("transferId"))
                putExtra(TransferService.EXTRA_TITLE, payload.optString("title", "Transferring"))
                putExtra(TransferService.EXTRA_BODY, payload.optString("body", ""))
                putExtra(TransferService.EXTRA_INDETERMINATE, true)
            }
            ContextCompat.startForegroundService(reactContext, intent)
        }
    }

    override fun updateTransferService(json: String, promise: Promise) {
        settle(promise) {
            val payload = JSONObject(json)
            val intent = Intent(reactContext, TransferService::class.java).apply {
                action = TransferService.ACTION_UPDATE
                putExtra(TransferService.EXTRA_TRANSFER_ID, payload.optString("transferId"))
                putExtra(TransferService.EXTRA_TITLE, payload.optString("title", "Transferring"))
                putExtra(TransferService.EXTRA_BODY, payload.optString("body", ""))
                putExtra(TransferService.EXTRA_PROGRESS, payload.optInt("progress", 0))
                putExtra(
                    TransferService.EXTRA_INDETERMINATE,
                    payload.optBoolean("indeterminate", false),
                )
            }
            ContextCompat.startForegroundService(reactContext, intent)
        }
    }

    override fun stopTransferService(promise: Promise) {
        settle(promise) {
            reactContext.startService(
                Intent(reactContext, TransferService::class.java).apply {
                    action = TransferService.ACTION_STOP
                },
            )
        }
    }

    // ----------------------------------------------------------- notifications

    override fun notify(json: String, promise: Promise) {
        settle(promise) {
            if (!notificationsAllowed()) return@settle
            val payload = JSONObject(json)
            val manager = reactContext
                .getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            TransferService.ensureChannels(reactContext)
            val notification =
                NotificationCompat.Builder(reactContext, TransferService.CHANNEL_EVENTS)
                    .setContentTitle(payload.optString("title"))
                    .setContentText(payload.optString("body"))
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setAutoCancel(true)
                    .build()

            manager.notify(payload.optString("id").hashCode(), notification)
        }
    }

    override fun cancelNotification(id: String, promise: Promise) {
        settle(promise) {
            val manager = reactContext
                .getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.cancel(id.hashCode())
        }
    }

    private fun settle(promise: Promise, work: () -> Unit) {
        try {
            work()
            promise.resolve(null)
        } catch (error: Throwable) {
            promise.reject("fortshare_notify", error.message ?: error.toString(), error)
        }
    }

    private companion object {
        const val REQUEST_CODE = 7311
    }
}
