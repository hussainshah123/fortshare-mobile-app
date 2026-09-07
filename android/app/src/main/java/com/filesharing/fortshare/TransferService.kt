package com.filesharing.fortshare

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.filesharing.MainActivity

/**
 * Keeps a transfer alive while the app is backgrounded (§36).
 *
 * Android will freeze a backgrounded process and kill its sockets; a
 * foreground service with a visible notification is the only sanctioned way to
 * keep a long upload running. The notification doubles as the transfer's
 * progress indicator and carries Pause/Cancel actions.
 */
class TransferService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_PAUSE, ACTION_CANCEL -> {
                // Broadcast so the React module can forward it to JavaScript.
                sendBroadcast(
                    Intent(BROADCAST_ACTION).apply {
                        setPackage(packageName)
                        putExtra(EXTRA_ACTION, if (intent.action == ACTION_PAUSE) "pause" else "cancel")
                        putExtra(EXTRA_TRANSFER_ID, intent.getStringExtra(EXTRA_TRANSFER_ID))
                    },
                )
                return START_STICKY
            }
        }

        val transferId = intent?.getStringExtra(EXTRA_TRANSFER_ID) ?: ""
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Transferring files"
        val body = intent?.getStringExtra(EXTRA_BODY) ?: ""
        val progress = intent?.getIntExtra(EXTRA_PROGRESS, 0) ?: 0
        val indeterminate = intent?.getBooleanExtra(EXTRA_INDETERMINATE, true) ?: true

        val notification = build(this, transferId, title, body, progress, indeterminate)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        return START_STICKY
    }

    companion object {
        const val NOTIFICATION_ID = 4201
        const val CHANNEL_TRANSFERS = "fortshare.transfers"
        const val CHANNEL_EVENTS = "fortshare.events"

        const val ACTION_START = "com.filesharing.fortshare.START"
        const val ACTION_UPDATE = "com.filesharing.fortshare.UPDATE"
        const val ACTION_STOP = "com.filesharing.fortshare.STOP"
        const val ACTION_PAUSE = "com.filesharing.fortshare.PAUSE"
        const val ACTION_CANCEL = "com.filesharing.fortshare.CANCEL"

        const val BROADCAST_ACTION = "com.filesharing.fortshare.NOTIFICATION_ACTION"
        const val EXTRA_ACTION = "action"
        const val EXTRA_TRANSFER_ID = "transferId"
        const val EXTRA_TITLE = "title"
        const val EXTRA_BODY = "body"
        const val EXTRA_PROGRESS = "progress"
        const val EXTRA_INDETERMINATE = "indeterminate"

        fun ensureChannels(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager =
                context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_TRANSFERS,
                    "Transfers",
                    // Low: a progress bar should not buzz the phone every update.
                    NotificationManager.IMPORTANCE_LOW,
                ).apply { description = "Ongoing file transfers" },
            )
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_EVENTS,
                    "Transfer events",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply { description = "Completed, failed and incoming transfers" },
            )
        }

        fun build(
            context: Context,
            transferId: String,
            title: String,
            body: String,
            progress: Int,
            indeterminate: Boolean,
        ): Notification {
            ensureChannels(context)

            val open = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            fun action(name: String, label: String, code: Int) =
                NotificationCompat.Action.Builder(
                    0,
                    label,
                    PendingIntent.getService(
                        context,
                        code,
                        Intent(context, TransferService::class.java).apply {
                            this.action = name
                            putExtra(EXTRA_TRANSFER_ID, transferId)
                        },
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    ),
                ).build()

            return NotificationCompat.Builder(context, CHANNEL_TRANSFERS)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(open)
                .setProgress(100, progress.coerceIn(0, 100), indeterminate)
                .addAction(action(ACTION_PAUSE, "Pause", 1))
                .addAction(action(ACTION_CANCEL, "Cancel", 2))
                .build()
        }
    }
}
