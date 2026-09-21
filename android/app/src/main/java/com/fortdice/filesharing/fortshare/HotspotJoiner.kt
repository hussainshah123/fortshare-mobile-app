package com.fortdice.filesharing.fortshare

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import java.net.Inet4Address
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Join a Wi-Fi network by name and passphrase, with no router involved.
 *
 * This is the other half of hosting a Wi-Fi Direct group. The host calls
 * `createGroup` and ends up owning a real Wi-Fi network — SSID, WPA2
 * passphrase and all — and this joins it exactly as a phone joins any network.
 *
 * Why not Wi-Fi Direct's own `connect()` on this side too: that path makes the
 * *host* device show Android's invitation dialog and wait for a human to
 * accept it. Joining by credentials needs nothing from the host at all, which
 * is what lets one person scan a QR code and have the transfer simply work.
 *
 * The joined network carries no internet, so the OS will not make it the
 * default route on its own. The process is therefore bound to it explicitly
 * for as long as the connection is held — see [bind].
 */
internal class HotspotJoiner(private val context: Context) {

    private val connectivity: ConnectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    /** Held for the life of the connection: releasing it drops the network. */
    private var callback: ConnectivityManager.NetworkCallback? = null

    @Volatile private var joined: Network? = null

    /**
     * Connect to [ssid] and stay connected until [leave].
     *
     * Returns the host address to dial — the network's gateway, which for a
     * Wi-Fi Direct group is always the group owner.
     */
    fun join(ssid: String, passphrase: String, timeoutMs: Int): String {
        val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        if (wifi?.isWifiEnabled != true) {
            throw IllegalStateException(
                "Turn Wi-Fi on to join the other device. It does not need to " +
                    "be connected to a network, and no internet is required.",
            )
        }

        // Re-joining the network we are already on is a no-op, not an error.
        joined?.let { return gatewayOf(it) }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return joinLegacy(wifi, ssid, passphrase, timeoutMs)
        }

        val specifier = WifiNetworkSpecifier.Builder()
            .setSsid(ssid)
            .setWpa2Passphrase(passphrase)
            .build()

        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            // Crucial: this network has no internet and never will. Leaving
            // the default INTERNET capability in the request means the OS
            // waits for a route that cannot exist and then abandons the
            // network as unusable.
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(specifier)
            .build()

        val latch = CountDownLatch(1)
        val network = AtomicReference<Network>(null)
        val failure = AtomicReference<String>(null)

        val handler = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(available: Network) {
                network.set(available)
                latch.countDown()
            }

            override fun onUnavailable() {
                failure.set(
                    "Could not join $ssid. Check that the other device is still " +
                        "showing its code, and that you are within a few metres.",
                )
                latch.countDown()
            }

            override fun onLost(lost: Network) {
                if (joined == lost) {
                    joined = null
                    unbind()
                }
            }
        }

        connectivity.requestNetwork(request, handler, timeoutMs)
        callback = handler

        if (!latch.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)) {
            leave()
            throw IllegalStateException("Joining $ssid timed out")
        }
        failure.get()?.let { reason ->
            leave()
            throw IllegalStateException(reason)
        }

        val available = network.get() ?: run {
            leave()
            throw IllegalStateException("Joined $ssid but the network did not come up")
        }

        joined = available
        bind(available)
        return gatewayOf(available)
    }

    /**
     * Pre-Android 10: add the network to the system's saved list.
     *
     * Deprecated on newer releases and a no-op there — which is why the
     * specifier path above exists — but on API 24-28 it is the only way, and
     * those devices are exactly the ones most likely to be handed a file by
     * someone standing next to them.
     */
    @Suppress("DEPRECATION")
    private fun joinLegacy(
        wifi: WifiManager,
        ssid: String,
        passphrase: String,
        timeoutMs: Int,
    ): String {
        val config = android.net.wifi.WifiConfiguration().apply {
            SSID = "\"$ssid\""
            preSharedKey = "\"$passphrase\""
            status = android.net.wifi.WifiConfiguration.Status.ENABLED
        }

        val networkId = wifi.addNetwork(config)
        if (networkId == -1) {
            throw IllegalStateException("Could not add the network $ssid")
        }
        legacyNetworkId = networkId
        wifi.disconnect()
        if (!wifi.enableNetwork(networkId, true)) {
            throw IllegalStateException("Could not join $ssid")
        }
        wifi.reconnect()

        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val info = wifi.connectionInfo
            if (info != null && info.ssid?.trim('"') == ssid) {
                @Suppress("DEPRECATION")
                val gateway = wifi.dhcpInfo?.gateway ?: 0
                if (gateway != 0) return formatIpv4(gateway)
                return GROUP_OWNER_ADDRESS
            }
            Thread.sleep(POLL_MS)
        }
        throw IllegalStateException("Joining $ssid timed out")
    }

    private var legacyNetworkId: Int = -1

    /**
     * Route this app's sockets over the joined network.
     *
     * Without this the TCP connection goes out of whatever the system
     * considers the default network — mobile data, typically — and fails with
     * "no route to host" while the phone is visibly connected to the peer.
     */
    private fun bind(network: Network) {
        runCatching { connectivity.bindProcessToNetwork(network) }
    }

    private fun unbind() {
        runCatching { connectivity.bindProcessToNetwork(null) }
    }

    /** Disconnect and restore normal routing. */
    fun leave() {
        unbind()
        callback?.let { handler ->
            runCatching { connectivity.unregisterNetworkCallback(handler) }
        }
        callback = null
        joined = null

        if (legacyNetworkId != -1) {
            @Suppress("DEPRECATION")
            val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            @Suppress("DEPRECATION")
            runCatching { wifi?.removeNetwork(legacyNetworkId) }
            legacyNetworkId = -1
        }
    }

    /** Whether we are currently holding a joined network. */
    fun isJoined(): Boolean = joined != null || legacyNetworkId != -1

    /**
     * The gateway of a network, which on a Wi-Fi Direct group is the owner.
     *
     * Read from the routing table rather than assumed, because a hotspot
     * created by the tethering path sits on 192.168.43.1 instead.
     */
    private fun gatewayOf(network: Network): String {
        val link: LinkProperties = connectivity.getLinkProperties(network)
            ?: return GROUP_OWNER_ADDRESS

        for (route in link.routes) {
            if (!route.isDefaultRoute) continue
            val gateway = route.gateway
            if (gateway is Inet4Address) {
                gateway.hostAddress?.let { return it }
            }
        }

        // No default route is normal on a network with no internet: derive the
        // owner from our own address instead, which is .1 on the same /24.
        for (linkAddress in link.linkAddresses) {
            val address = linkAddress.address
            if (address is Inet4Address && !address.isLoopbackAddress) {
                val text = address.hostAddress ?: continue
                val lastDot = text.lastIndexOf('.')
                if (lastDot > 0) return text.substring(0, lastDot) + ".1"
            }
        }
        return GROUP_OWNER_ADDRESS
    }

    private fun formatIpv4(value: Int): String =
        "${value and 0xff}.${value shr 8 and 0xff}." +
            "${value shr 16 and 0xff}.${value shr 24 and 0xff}"

    private companion object {
        /** Android always places a Wi-Fi Direct group owner here. */
        const val GROUP_OWNER_ADDRESS = "192.168.49.1"
        const val POLL_MS = 400L
    }
}
