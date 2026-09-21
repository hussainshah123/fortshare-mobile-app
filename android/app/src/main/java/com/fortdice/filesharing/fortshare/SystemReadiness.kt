package com.fortdice.filesharing.fortshare

import android.content.Context
import android.content.Intent
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Build
import android.provider.Settings

/**
 * What the operating system still needs switched on before sharing can work.
 *
 * FortShare needs two things from the OS and nothing else: the Wi-Fi radio,
 * and — for scanning — the system Location toggle. It uses no Bluetooth and
 * no internet, so neither is checked or asked for.
 *
 * The point of asking at launch is that both failures are otherwise silent
 * and arrive much later disguised as something else. Wi-Fi off means no
 * address and an app that says it is "waiting"; Location off means
 * `discoverPeers` fails with a bare ERROR that names nothing. Asked up front,
 * each is one sentence and one tap.
 */
internal class SystemReadiness(private val context: Context) {

    fun state(): String {
        val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        return Json.obj(
            "wifiEnabled" to (wifi?.isWifiEnabled == true),
            "locationEnabled" to isLocationEnabled(),
            // Below Android 13 there is no NEARBY_WIFI_DEVICES, so scanning
            // genuinely requires the Location toggle. Newer releases are
            // supposed to be exempt, but enough OEM builds still enforce it
            // that this stays true wherever the app must scan.
            "locationRequired" to true,
            "canEnableWifiDirectly" to (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q),
        )
    }

    private fun isLocationEnabled(): Boolean {
        val manager = context.getSystemService(Context.LOCATION_SERVICE)
            as? LocationManager ?: return true

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            manager.isLocationEnabled
        } else {
            @Suppress("DEPRECATION")
            runCatching {
                Settings.Secure.getInt(
                    context.contentResolver,
                    Settings.Secure.LOCATION_MODE,
                ) != Settings.Secure.LOCATION_MODE_OFF
            }.getOrDefault(true)
        }
    }

    /**
     * Put the user where they can fix it — or just fix it.
     *
     * Up to Android 9 an app may switch the Wi-Fi radio on itself, which is
     * the better experience by a wide margin: one tap inside the app rather
     * than a trip to Settings and back. Android 10 removed that, so there the
     * best available is the inline Wi-Fi panel, which slides over the app
     * without losing its state.
     */
    fun open(which: String): String = when (which) {
        "wifi" -> openWifi()
        "location" -> openLocation()
        else -> "unavailable"
    }

    private fun openWifi(): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            @Suppress("DEPRECATION")
            if (wifi != null && runCatching { wifi.setWifiEnabled(true) }.getOrDefault(false)) {
                return "enabled"
            }
        }

        val action = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Settings.Panel.ACTION_WIFI
        } else {
            Settings.ACTION_WIFI_SETTINGS
        }
        return if (launch(action)) "opened" else "unavailable"
    }

    private fun openLocation(): String =
        if (launch(Settings.ACTION_LOCATION_SOURCE_SETTINGS)) "opened" else "unavailable"

    private fun launch(action: String): Boolean = runCatching {
        context.startActivity(
            Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        true
    }.getOrDefault(false)
}
