package com.filesharing.fortshare

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pInfo
import android.net.wifi.p2p.WifiP2pManager
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceInfo
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceRequest
import android.os.Build
import android.util.Base64
import androidx.core.content.ContextCompat
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Wi-Fi Direct: device-to-device with no router in the path.
 *
 * This exists because the local-network path has a failure mode nothing in the
 * app can fix. When a router has AP/client isolation enabled — the default on
 * most guest networks — mDNS multicast still reaches both devices, so they
 * *see* each other, but unicast TCP between them is dropped and the connection
 * fails with EHOSTUNREACH. The devices are on the same subnet and still cannot
 * talk.
 *
 * Wi-Fi Direct sidesteps that entirely: the two devices negotiate their own
 * group over the Wi-Fi radio, one becomes the group owner at a P2P address,
 * and the existing TCP listener — already bound to all interfaces — is
 * reachable on it. Nothing above this layer changes: same frames, same
 * handshake, same encryption, same transfer engine.
 *
 * It also covers the case where the two devices are on *different* networks,
 * or on none at all.
 */
internal class WifiDirectEngine(
    private val context: Context,
    private val events: NetEvents,
) {
    private val manager: WifiP2pManager? =
        context.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
    private var channel: WifiP2pManager.Channel? = null
    private var receiver: BroadcastReceiver? = null

    private val running = AtomicBoolean(false)
    private var config: DiscoveryEngine.AdvertiseConfig? = null

    /** deviceId -> the P2P hardware address `connect` needs. */
    private val peerAddresses = ConcurrentHashMap<String, String>()
    /** deviceId -> the TCP port that peer published over P2P service discovery. */
    private val peerPorts = ConcurrentHashMap<String, Int>()

    @Volatile private var groupOwnerAddress: String = ""
    @Volatile private var isGroupOwner = false
    @Volatile private var connected = false
    /** Released when a group forms, so `connect` can wait for it. */
    @Volatile private var connectionLatch: CountDownLatch? = null

    private companion object {
        /** DNS-SD instance name for the P2P service. */
        const val SERVICE_INSTANCE = "fortshare"
        /** Wi-Fi Direct service discovery uses the bare type, without a dot. */
        const val SERVICE_TYPE = "_fortshare._tcp"
    }

    data class Support(val supported: Boolean, val reason: String)

    /**
     * Whether Wi-Fi Direct can be used right now.
     *
     * Distinguishes "this hardware cannot" from "you have not granted the
     * permission yet", because the two need completely different responses
     * from the UI.
     */
    fun support(): Support {
        if (manager == null) {
            return Support(false, "This device does not support Wi-Fi Direct.")
        }
        if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)) {
            return Support(false, "This device does not support Wi-Fi Direct.")
        }
        if (!isWifiRadioOn()) {
            return Support(false, "wifi-off")
        }
        if (!hasPermission()) {
            return Support(false, "permission-required")
        }
        return Support(true, "")
    }

    /**
     * Whether the Wi-Fi radio is on.
     *
     * Wi-Fi Direct rides the Wi-Fi radio, so it cannot work with Wi-Fi
     * switched off — but it does *not* need Wi-Fi to be connected to anything.
     * Without this check every P2P call returns BUSY and the user sees four
     * cryptic failures instead of "turn Wi-Fi on".
     */
    private fun isWifiRadioOn(): Boolean {
        val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        return wifi?.isWifiEnabled == true
    }

    /**
     * The permission Wi-Fi Direct scanning needs.
     *
     * From Android 13 this is NEARBY_WIFI_DEVICES, declared with
     * `neverForLocation`. Below that the OS genuinely requires fine location
     * to scan for peers — a platform constraint, not something FortShare
     * wants. Either way it is requested only when the user turns this on.
     */
    fun hasPermission(): Boolean {
        val permission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.NEARBY_WIFI_DEVICES
        } else {
            Manifest.permission.ACCESS_FINE_LOCATION
        }
        return ContextCompat.checkSelfPermission(context, permission) ==
            PackageManager.PERMISSION_GRANTED
    }

    fun requiredPermission(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.NEARBY_WIFI_DEVICES
        } else {
            Manifest.permission.ACCESS_FINE_LOCATION
        }

    // ------------------------------------------------------------------ start

    fun start(advertise: DiscoveryEngine.AdvertiseConfig) {
        val manager = this.manager ?: throw IllegalStateException(
            "Wi-Fi Direct is not available on this device",
        )
        if (!hasPermission()) {
            throw SecurityException("Wi-Fi Direct permission has not been granted")
        }

        if (!isWifiRadioOn()) {
            throw IllegalStateException(
                "Turn Wi-Fi on to use Wi-Fi Direct. It does not need to be " +
                    "connected to a network, and no internet is required — " +
                    "the radio just has to be switched on.",
            )
        }

        config = advertise
        if (!running.compareAndSet(false, true)) {
            // Already up: re-publish so a rename takes effect.
            publishService(advertise)
            return
        }

        channel = manager.initialize(context, context.mainLooper) {
            // The framework dropped the channel; surface it rather than going
            // quiet, because every later call would fail with no explanation.
            emitState("Wi-Fi Direct channel disconnected")
        }

        registerReceiver()
        publishService(advertise)
        discover()
        emitState(null)
    }

    fun stop() {
        if (!running.compareAndSet(true, false)) return
        val manager = this.manager
        val channel = this.channel

        if (manager != null && channel != null) {
            runCatching { manager.clearLocalServices(channel, null) }
            runCatching { manager.clearServiceRequests(channel, null) }
            runCatching { manager.stopPeerDiscovery(channel, null) }
            runCatching { manager.removeGroup(channel, null) }
        }

        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
        peerAddresses.clear()
        peerPorts.clear()
        connected = false
        groupOwnerAddress = ""
        this.channel = null
        emitState(null)
    }

    // -------------------------------------------------------------- advertise

    /**
     * Publish this device over P2P service discovery.
     *
     * Carries the same TXT payload as the mDNS path, so a peer found over
     * Wi-Fi Direct is recognised against history by exactly the same
     * deviceId comparison — no separate identity model.
     */
    private fun publishService(advertise: DiscoveryEngine.AdvertiseConfig) {
        val manager = this.manager ?: return
        val channel = this.channel ?: return

        val record = mapOf(
            Protocol.TXT_VERSION to Protocol.PROTOCOL_VERSION.toString(),
            Protocol.TXT_DEVICE_ID to advertise.deviceId,
            Protocol.TXT_NAME to Base64.encodeToString(
                advertise.deviceName.toByteArray(Charsets.UTF_8),
                Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
            ),
            Protocol.TXT_PLATFORM to advertise.platform,
            Protocol.TXT_TYPE to advertise.deviceType,
            Protocol.TXT_FINGERPRINT to advertise.fingerprint,
            // The port matters more here than over mDNS: a Wi-Fi Direct group
            // gives us the group owner's address but no port, so it has to
            // travel in the TXT record.
            "port" to advertise.port.toString(),
        )

        runCatching { manager.clearLocalServices(channel, null) }
        val info = WifiP2pDnsSdServiceInfo.newInstance(
            SERVICE_INSTANCE,
            SERVICE_TYPE,
            record,
        )
        manager.addLocalService(channel, info, actionListener("addLocalService"))
    }

    // --------------------------------------------------------------- discover

    private fun discover() {
        val manager = this.manager ?: return
        val channel = this.channel ?: return

        manager.setDnsSdResponseListeners(
            channel,
            { _, _, _ -> /* instance-level callback; the TXT one below is used */ },
            { _, record, device -> onServiceRecord(record, device) },
        )

        runCatching { manager.clearServiceRequests(channel, null) }

        /**
         * Chained rather than fired together.
         *
         * WifiP2pManager serialises internally and returns BUSY for anything
         * issued while another operation is in flight. Firing all four at once
         * produced four "busy" errors and left discovery not actually running;
         * each step now waits for the previous one.
         */
        manager.addServiceRequest(
            channel,
            WifiP2pDnsSdServiceRequest.newInstance(),
            object : WifiP2pManager.ActionListener {
                override fun onSuccess() {
                    manager.discoverServices(
                        channel,
                        object : WifiP2pManager.ActionListener {
                            override fun onSuccess() {
                                discoverPeersWithRetry(manager, channel)
                            }

                            override fun onFailure(reason: Int) {
                                // Peers alone are still useful: a group can be
                                // formed without a service record.
                                discoverPeersWithRetry(manager, channel)
                            }
                        },
                    )
                }

                override fun onFailure(reason: Int) {
                    reportFailure("addServiceRequest", reason)
                    discoverPeersWithRetry(manager, channel)
                }
            },
        )
    }

    private fun onServiceRecord(record: Map<String, String>, device: WifiP2pDevice) {
        val deviceId = record[Protocol.TXT_DEVICE_ID] ?: return
        if (deviceId == config?.deviceId) return // our own echo

        val port = record["port"]?.toIntOrNull() ?: 0
        peerAddresses[deviceId] = device.deviceAddress
        if (port > 0) peerPorts[deviceId] = port

        val name = record[Protocol.TXT_NAME]?.let { encoded ->
            runCatching {
                String(
                    Base64.decode(
                        encoded,
                        Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
                    ),
                    Charsets.UTF_8,
                )
            }.getOrNull()
        } ?: device.deviceName.ifEmpty { "Unknown device" }

        events.wifiDirectPeerFound(
            Json.obj(
                "deviceId" to deviceId,
                "deviceName" to name,
                "platform" to (record[Protocol.TXT_PLATFORM] ?: "android"),
                "deviceType" to (record[Protocol.TXT_TYPE] ?: "phone"),
                "fingerprint" to (record[Protocol.TXT_FINGERPRINT] ?: ""),
                "protocolVersion" to (record[Protocol.TXT_VERSION]?.toIntOrNull() ?: 0),
                // Filled in once a group forms: until then there is no IP to
                // give, only the P2P address to connect *with*.
                "host" to "",
                "port" to port,
                "p2pAddress" to device.deviceAddress,
                "discoveredAt" to System.currentTimeMillis(),
            ),
        )
    }

    // ---------------------------------------------------------------- connect

    /**
     * Form a group with a peer and wait until it is usable.
     *
     * Blocking, so the caller runs it off the JavaScript thread. Returns the
     * group owner's address and the peer's published port — everything the
     * existing TCP path needs.
     */
    fun connect(deviceAddress: String, timeoutMs: Int): String {
        val manager = this.manager ?: throw IllegalStateException(
            "Wi-Fi Direct is not available on this device",
        )
        val channel = this.channel ?: throw IllegalStateException(
            "Wi-Fi Direct has not been started",
        )

        val latch = CountDownLatch(1)
        connectionLatch = latch

        val p2pConfig = WifiP2pConfig().apply {
            this.deviceAddress = deviceAddress
            // Let the framework decide the group owner. Forcing it produces
            // negotiation failures when both sides have a preference.
            groupOwnerIntent = -1
        }

        manager.connect(channel, p2pConfig, actionListener("connect"))

        if (!latch.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)) {
            connectionLatch = null
            throw IllegalStateException(
                "The other device did not accept the Wi-Fi Direct invitation in time",
            )
        }
        connectionLatch = null

        val owner = groupOwnerAddress
        if (owner.isEmpty()) {
            throw IllegalStateException("Wi-Fi Direct group formed without an address")
        }

        // The group owner runs the listener the client dials. When *we* are
        // the owner, there is nothing to dial: the peer connects to us.
        val deviceId = peerAddresses.entries
            .firstOrNull { it.value == deviceAddress }
            ?.key
        val port = deviceId?.let { peerPorts[it] } ?: 0

        return Json.obj(
            "host" to owner,
            "port" to port,
            "isGroupOwner" to isGroupOwner,
        )
    }

    fun disconnect() {
        val manager = this.manager ?: return
        val channel = this.channel ?: return
        runCatching { manager.removeGroup(channel, null) }
        connected = false
        groupOwnerAddress = ""
        emitState(null)
    }

    // --------------------------------------------------------------- receiver

    private fun registerReceiver() {
        val filter = IntentFilter().apply {
            addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_THIS_DEVICE_CHANGED_ACTION)
        }

        val handler = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION -> {
                        val enabled = intent.getIntExtra(
                            WifiP2pManager.EXTRA_WIFI_STATE,
                            WifiP2pManager.WIFI_P2P_STATE_DISABLED,
                        ) == WifiP2pManager.WIFI_P2P_STATE_ENABLED
                        if (!enabled) {
                            emitState("Wi-Fi Direct is switched off — turn Wi-Fi on")
                        } else {
                            emitState(null)
                        }
                    }

                    WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> onPeersChanged()

                    WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION -> {
                        requestConnectionInfo()
                    }
                }
            }
        }

        receiver = handler
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(handler, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(handler, filter)
        }
    }

    private fun onPeersChanged() {
        val manager = this.manager ?: return
        val channel = this.channel ?: return
        if (!hasPermission()) return

        runCatching {
            manager.requestPeers(channel) { peers ->
                val present = peers.deviceList.map { it.deviceAddress }.toSet()
                // A peer whose P2P address disappeared is gone. Reported so
                // the list reflects reality, exactly as with mDNS.
                val vanished = peerAddresses.entries
                    .filter { !present.contains(it.value) }
                    .map { it.key }
                for (deviceId in vanished) {
                    peerAddresses.remove(deviceId)
                    peerPorts.remove(deviceId)
                    events.wifiDirectPeerLost(Json.obj("deviceId" to deviceId))
                }

                // Publish the raw list too.
                //
                // These are P2P devices, not confirmed FortShare peers — but a
                // group can be formed with any of them, and once it is, both
                // sides land on a 192.168.49.x network where ordinary mDNS
                // identifies the app. Previously this list was used only to
                // detect removals and then discarded, which meant Wi-Fi Direct
                // could only reach devices whose P2P service record had
                // already been discovered — and if it never was, the feature
                // silently did nothing.
                val array = org.json.JSONArray()
                for (device in peers.deviceList) {
                    array.put(
                        org.json.JSONObject()
                            .put("name", device.deviceName.ifEmpty { "Unknown device" })
                            .put("address", device.deviceAddress)
                            .put("status", statusLabel(device.status)),
                    )
                }
                events.wifiDirectRawPeers(
                    Json.obj("peers" to Json.raw(array.toString())),
                )
            }
        }
    }

    /** WifiP2pDevice status as something a user can read. */
    private fun statusLabel(status: Int): String = when (status) {
        WifiP2pDevice.CONNECTED -> "connected"
        WifiP2pDevice.INVITED -> "invited"
        WifiP2pDevice.FAILED -> "failed"
        WifiP2pDevice.UNAVAILABLE -> "unavailable"
        else -> "available"
    }

    private fun requestConnectionInfo() {
        val manager = this.manager ?: return
        val channel = this.channel ?: return

        runCatching {
            manager.requestConnectionInfo(channel) { info: WifiP2pInfo? ->
                connected = info?.groupFormed == true
                isGroupOwner = info?.isGroupOwner == true
                groupOwnerAddress = info?.groupOwnerAddress?.hostAddress.orEmpty()

                if (connected && groupOwnerAddress.isNotEmpty()) {
                    // Releases a waiting connect(). Re-publishing here matters:
                    // the group brings up a new interface, and the service has
                    // to be visible on it.
                    config?.let { publishService(it) }
                    connectionLatch?.countDown()
                }
                emitState(null)
            }
        }
    }

    // ----------------------------------------------------------------- events

    private fun emitState(message: String?) {
        events.wifiDirectStateChanged(
            Json.obj(
                "enabled" to running.get(),
                "connected" to connected,
                "isGroupOwner" to isGroupOwner,
                "groupOwnerAddress" to groupOwnerAddress,
                "message" to message,
            ),
        )
    }

    /**
     * WifiP2pManager reports failures through a listener rather than a return
     * value, and a silent failure here looks exactly like "no peers nearby".
     */
    private fun reportFailure(operation: String, reason: Int) {
        val text = when (reason) {
            WifiP2pManager.P2P_UNSUPPORTED ->
                "Wi-Fi Direct is not supported on this device"
            WifiP2pManager.BUSY ->
                "Wi-Fi Direct is busy — try again in a moment"
            WifiP2pManager.ERROR -> "Wi-Fi Direct reported an internal error"
            else -> "Wi-Fi Direct failed (code $reason)"
        }
        events.discoveryError(Json.obj("message" to "$operation: $text"))
    }

    private fun actionListener(operation: String) =
        object : WifiP2pManager.ActionListener {
            override fun onSuccess() = Unit
            override fun onFailure(reason: Int) = reportFailure(operation, reason)
        }

    /**
     * Peer discovery, retried once if the framework was busy.
     *
     * BUSY here means another P2P operation was still settling, not that
     * anything is wrong — and peer discovery is the one call that must succeed,
     * because a group can be formed from the raw peer list alone even when no
     * service record ever arrives.
     */
    private fun discoverPeersWithRetry(
        manager: WifiP2pManager,
        channel: WifiP2pManager.Channel,
    ) {
        manager.discoverPeers(
            channel,
            object : WifiP2pManager.ActionListener {
                override fun onSuccess() = Unit
                override fun onFailure(reason: Int) {
                    if (reason != WifiP2pManager.BUSY) {
                        reportFailure("discoverPeers", reason)
                        return
                    }
                    android.os.Handler(context.mainLooper).postDelayed({
                        if (running.get()) {
                            manager.discoverPeers(
                                channel,
                                actionListener("discoverPeers (retry)"),
                            )
                        }
                    }, 1500)
                }
            },
        )
    }
}
