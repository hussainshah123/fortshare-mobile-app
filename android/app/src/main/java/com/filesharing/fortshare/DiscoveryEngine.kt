package com.filesharing.fortshare

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import android.util.Base64

/**
 * mDNS/DNS-SD advertise and browse, on top of Android's NsdManager (§6).
 *
 * The TXT record carries the persistent deviceId, so a peer is recognised
 * against local history the moment it is *seen* — no connection needed. That
 * is what makes a device which changed IP update in place instead of showing
 * up as a stranger (§39).
 */
internal class DiscoveryEngine(
    private val context: Context,
    private val events: NetEvents,
) {
    private val nsd: NsdManager =
        context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val connectivity: ConnectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private var registrationListener: NsdManager.RegistrationListener? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private val running = AtomicBoolean(false)
    private var config: AdvertiseConfig? = null

    /** deviceId -> last known peer, so a lost/found cycle can be de-duplicated. */
    private val seen = ConcurrentHashMap<String, String>()

    /**
     * Older Android builds fail concurrent resolveService calls, so resolves
     * are serialised through this queue.
     */
    private val resolveQueue = ConcurrentLinkedQueue<NsdServiceInfo>()
    private val resolving = AtomicBoolean(false)

    data class AdvertiseConfig(
        val deviceId: String,
        val deviceName: String,
        val platform: String,
        val deviceType: String,
        val fingerprint: String,
        val port: Int,
    )

    fun start(config: AdvertiseConfig) {
        this.config = config
        if (!running.compareAndSet(false, true)) {
            // Already up: re-publish so a rename takes effect immediately.
            stopAdvertising()
            advertise(config)
            return
        }
        advertise(config)
        browse()
        watchNetwork()
    }

    fun stop() {
        running.set(false)
        stopAdvertising()
        stopBrowsing()
        unwatchNetwork()
        seen.clear()
    }

    /** Re-announce and re-browse, e.g. after a network change. */
    fun refresh() {
        val current = config ?: return
        stopBrowsing()
        stopAdvertising()
        seen.clear()
        advertise(current)
        browse()
    }

    // --------------------------------------------------------------- advertise

    private fun advertise(config: AdvertiseConfig) {
        val info = NsdServiceInfo().apply {
            // Instance names must be unique on the network; the deviceId
            // prefix guarantees that without leaking the whole identity.
            serviceName = "FortShare-${config.deviceId.take(8)}"
            serviceType = Protocol.SERVICE_TYPE
            port = config.port
            setAttribute(Protocol.TXT_VERSION, Protocol.PROTOCOL_VERSION.toString())
            setAttribute(Protocol.TXT_DEVICE_ID, config.deviceId)
            // base64url so any unicode device name survives a TXT record.
            setAttribute(Protocol.TXT_NAME, encodeName(config.deviceName))
            setAttribute(Protocol.TXT_PLATFORM, config.platform)
            setAttribute(Protocol.TXT_TYPE, config.deviceType)
            setAttribute(Protocol.TXT_FINGERPRINT, config.fingerprint)
        }

        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) = Unit
            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
                events.discoveryError(
                    Json.obj("message" to "could not advertise this device (code $errorCode)"),
                )
            }
            override fun onServiceUnregistered(info: NsdServiceInfo) = Unit
            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) = Unit
        }

        registrationListener = listener
        runCatching { nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener) }
            .onFailure {
                registrationListener = null
                events.discoveryError(
                    Json.obj("message" to (it.message ?: "advertising failed")),
                )
            }
    }

    private fun stopAdvertising() {
        registrationListener?.let { listener ->
            runCatching { nsd.unregisterService(listener) }
        }
        registrationListener = null
    }

    // ------------------------------------------------------------------ browse

    private fun browse() {
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                events.discoveryError(
                    Json.obj("message" to "could not scan the network (code $errorCode)"),
                )
            }

            override fun onServiceFound(info: NsdServiceInfo) {
                if (info.serviceName == ownServiceName()) return
                resolveQueue.offer(info)
                drainResolveQueue()
            }

            override fun onServiceLost(info: NsdServiceInfo) {
                // NsdManager only gives us the instance name here, so map it
                // back to the deviceId we recorded when we resolved it.
                val deviceId = seen.entries
                    .firstOrNull { it.value == info.serviceName }
                    ?.key ?: return
                seen.remove(deviceId)
                events.peerLost(Json.obj("deviceId" to deviceId))
            }

            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
        }

        discoveryListener = listener
        runCatching {
            nsd.discoverServices(Protocol.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        }.onFailure {
            discoveryListener = null
            events.discoveryError(Json.obj("message" to (it.message ?: "scan failed")))
        }
    }

    private fun stopBrowsing() {
        discoveryListener?.let { listener ->
            runCatching { nsd.stopServiceDiscovery(listener) }
        }
        discoveryListener = null
        resolveQueue.clear()
        resolving.set(false)
    }

    private fun drainResolveQueue() {
        if (!resolving.compareAndSet(false, true)) return
        val next = resolveQueue.poll()
        if (next == null) {
            resolving.set(false)
            return
        }
        resolve(next)
    }

    private fun finishResolve() {
        resolving.set(false)
        if (resolveQueue.isNotEmpty()) drainResolveQueue()
    }

    @Suppress("DEPRECATION")
    private fun resolve(info: NsdServiceInfo) {
        val listener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                finishResolve()
            }

            override fun onServiceResolved(resolved: NsdServiceInfo) {
                try {
                    emitPeer(resolved)
                } finally {
                    finishResolve()
                }
            }
        }
        runCatching { nsd.resolveService(info, listener) }.onFailure { finishResolve() }
    }

    private fun emitPeer(info: NsdServiceInfo) {
        val attributes = info.attributes ?: return
        fun attr(key: String): String? =
            attributes[key]?.let { String(it, Charsets.UTF_8) }

        val deviceId = attr(Protocol.TXT_DEVICE_ID) ?: return
        val config = this.config
        if (config != null && deviceId == config.deviceId) return // our own echo

        val host = hostOf(info) ?: return
        val version = attr(Protocol.TXT_VERSION)?.toIntOrNull() ?: 0

        seen[deviceId] = info.serviceName ?: ""

        events.peerFound(
            Json.obj(
                "deviceId" to deviceId,
                "deviceName" to decodeName(attr(Protocol.TXT_NAME)),
                "platform" to (attr(Protocol.TXT_PLATFORM) ?: "android"),
                "deviceType" to (attr(Protocol.TXT_TYPE) ?: "phone"),
                "fingerprint" to (attr(Protocol.TXT_FINGERPRINT) ?: ""),
                "protocolVersion" to version,
                "host" to host,
                "port" to info.port,
                "discoveredAt" to System.currentTimeMillis(),
            ),
        )
    }

    @Suppress("DEPRECATION")
    private fun hostOf(info: NsdServiceInfo): String? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val v4 = info.hostAddresses.firstOrNull { it is Inet4Address }
            if (v4 != null) return v4.hostAddress
            return info.hostAddresses.firstOrNull()?.hostAddress
        }
        return info.host?.hostAddress
    }

    private fun ownServiceName(): String =
        config?.let { "FortShare-${it.deviceId.take(8)}" } ?: ""

    // ------------------------------------------------------------------ network

    /**
     * Watch for Wi-Fi coming and going.
     *
     * Note there is no internet capability in the request: FortShare must work
     * on a network with no internet route at all, which is the normal case for
     * a phone hotspot (§8, §43).
     */
    private fun watchNetwork() {
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            .build()

        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                events.networkChanged(
                    Json.obj("available" to true, "address" to localAddress()),
                )
                if (running.get()) refresh()
            }

            override fun onLost(network: Network) {
                events.networkChanged(Json.obj("available" to false, "address" to ""))
            }

            override fun onLinkPropertiesChanged(network: Network, props: LinkProperties) {
                // A DHCP renewal that changed our address invalidates every
                // address we learned; re-announce rather than trust the cache.
                events.networkChanged(
                    Json.obj("available" to true, "address" to localAddress()),
                )
                if (running.get()) refresh()
            }
        }

        networkCallback = callback
        runCatching { connectivity.registerNetworkCallback(request, callback) }
    }

    private fun unwatchNetwork() {
        networkCallback?.let { callback ->
            runCatching { connectivity.unregisterNetworkCallback(callback) }
        }
        networkCallback = null
    }

    /** One local address, classified by the interface it belongs to. */
    data class LocalAddress(
        val interfaceName: String,
        val address: String,
        val kind: String,
    )

    /**
     * Classify an interface by name.
     *
     * A phone commonly has several site-local IPv4 addresses up at once, and
     * they are *not* interchangeable: a peer on the Wi-Fi LAN cannot reach a
     * mobile-data or VPN address. Picking blindly is what produces
     * "EHOSTUNREACH (No route to host)" on a connection attempt.
     */
    private fun classify(name: String): String {
        val lower = name.lowercase()
        return when {
            lower.startsWith("wlan") || lower.startsWith("eth0.wlan") -> "wifi"
            // Tethering/hotspot bridges, which differ by vendor.
            lower.startsWith("ap") || lower.startsWith("swlan") ||
                lower.startsWith("wigig") || lower.startsWith("bridge") -> "hotspot"
            lower.startsWith("eth") -> "ethernet"
            // Mobile data: Qualcomm (rmnet), MediaTek (ccmni), and PPP links.
            lower.startsWith("rmnet") || lower.startsWith("ccmni") ||
                lower.startsWith("pdp") || lower.startsWith("ppp") ||
                lower.startsWith("clat") -> "cellular"
            lower.startsWith("tun") || lower.startsWith("tap") ||
                lower.startsWith("ipsec") -> "vpn"
            else -> "other"
        }
    }

    /** Rank: what a LAN peer is most likely to be able to reach. */
    private fun preference(kind: String): Int = when (kind) {
        "wifi" -> 0
        "hotspot" -> 1
        "ethernet" -> 2
        "other" -> 3
        // Never advertise these: unreachable from a local peer, and offering
        // them just produces a connection that times out.
        "cellular" -> 90
        "vpn" -> 91
        else -> 50
    }

    /**
     * Every candidate address, best first.
     *
     * The active network reported by ConnectivityManager is authoritative, so
     * its addresses are ranked ahead of anything found by enumerating
     * interfaces.
     */
    fun localAddresses(): List<LocalAddress> {
        val preferred = LinkedHashSet<String>()
        runCatching {
            val active = connectivity.activeNetwork ?: return@runCatching
            val link = connectivity.getLinkProperties(active) ?: return@runCatching
            for (linkAddress in link.linkAddresses) {
                val address = linkAddress.address
                if (address is Inet4Address && !address.isLoopbackAddress) {
                    address.hostAddress?.let { preferred.add(it) }
                }
            }
        }

        val found = mutableListOf<LocalAddress>()
        runCatching {
            for (nic in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nic.isUp || nic.isLoopback) continue
                val kind = classify(nic.name)
                for (address in Collections.list(nic.inetAddresses)) {
                    if (address !is Inet4Address) continue
                    if (address.isLoopbackAddress || address.isLinkLocalAddress) continue
                    val text = address.hostAddress ?: continue
                    found.add(LocalAddress(nic.name, text, kind))
                }
            }
        }

        return found
            .distinctBy { it.address }
            .sortedWith(
                compareBy(
                    // Anything on the OS's active network wins outright.
                    { if (preferred.contains(it.address)) 0 else 1 },
                    { preference(it.kind) },
                    { it.interfaceName },
                ),
            )
    }

    /**
     * The single best local address, or "" when there is none.
     *
     * Cellular and VPN addresses are excluded outright: advertising one means
     * every peer that tries it gets "no route to host".
     */
    fun localAddress(): String =
        localAddresses()
            .firstOrNull { it.kind != "cellular" && it.kind != "vpn" }
            ?.address
            .orEmpty()

    /** { primary, addresses[] } JSON, for QR payloads and diagnostics. */
    fun networkInfo(): String {
        val candidates = localAddresses()
        val array = org.json.JSONArray()
        for (candidate in candidates) {
            array.put(
                org.json.JSONObject()
                    .put("interfaceName", candidate.interfaceName)
                    .put("address", candidate.address)
                    .put("kind", candidate.kind),
            )
        }
        return org.json.JSONObject()
            .put("primary", localAddress())
            .put("addresses", array)
            .toString()
    }

    private fun encodeName(name: String): String =
        Base64.encodeToString(
            name.toByteArray(Charsets.UTF_8),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
        )

    private fun decodeName(encoded: String?): String {
        if (encoded.isNullOrEmpty()) return "Unknown device"
        return runCatching {
            String(
                Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP),
                Charsets.UTF_8,
            )
        }.getOrDefault("Unknown device")
    }
}
