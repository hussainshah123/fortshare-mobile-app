package com.filesharing.fortshare

import org.json.JSONArray
import org.json.JSONObject

/**
 * Small JSON helpers for the native<->JavaScript boundary.
 *
 * Every native module method and event carries a JSON string rather than a
 * ReadableMap. That keeps the codegen surface to primitives, so there is no
 * map-marshalling behaviour to get subtly different between Android and iOS.
 */
internal object Json {
    /** Marks a string that is already JSON and must not be quoted again. */
    class Raw(val json: String)

    fun raw(json: String): Raw = Raw(json)

    fun obj(vararg pairs: Pair<String, Any?>): String {
        val out = JSONObject()
        for ((key, value) in pairs) {
            when (value) {
                null -> out.put(key, JSONObject.NULL)
                is Raw -> out.put(key, parseEmbedded(value.json))
                else -> out.put(key, value)
            }
        }
        return out.toString()
    }

    /**
     * Embed a pre-serialised value. A control message that is not valid JSON
     * would otherwise corrupt the whole envelope, so it degrades to a string.
     */
    private fun parseEmbedded(json: String): Any {
        val trimmed = json.trim()
        return try {
            when {
                trimmed.startsWith("{") -> JSONObject(trimmed)
                trimmed.startsWith("[") -> JSONArray(trimmed)
                else -> trimmed
            }
        } catch (_: Throwable) {
            trimmed
        }
    }

    fun array(items: List<String>): String {
        val out = JSONArray()
        for (item in items) out.put(JSONObject(item))
        return out.toString()
    }
}
