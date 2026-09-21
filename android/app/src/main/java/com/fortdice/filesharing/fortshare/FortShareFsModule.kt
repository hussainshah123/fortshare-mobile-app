package com.fortdice.filesharing.fortshare

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.media.MediaScannerConnection
import android.provider.MediaStore
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import com.fortdice.filesharing.specs.NativeFortShareFsSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * Filesystem, hashing and OS integration.
 *
 * Hashing lives here rather than in JavaScript because a SHA-256 over a
 * multi-gigabyte file has to stream: the file is read in 256 KB blocks and
 * only the 64-character digest crosses the bridge.
 */
@ReactModule(name = NativeFortShareFsSpec.NAME)
class FortShareFsModule(private val reactContext: ReactApplicationContext) :
    NativeFortShareFsSpec(reactContext) {

    private val io = Executors.newFixedThreadPool(3) { runnable ->
        Thread(runnable, "fortshare-fs").apply { isDaemon = true }
    }

    override fun invalidate() {
        io.shutdownNow()
        super.invalidate()
    }

    // ------------------------------------------------------------------ hashing

    override fun sha256(path: String, promise: Promise) {
        background(promise) { digest(File(clean(path)), 0L, -1L) }
    }

    override fun sha256Range(path: String, offset: Double, length: Double, promise: Promise) {
        background(promise) { digest(File(clean(path)), offset.toLong(), length.toLong()) }
    }

    private fun digest(file: File, offset: Long, length: Long): String {
        if (!file.exists()) throw IOException("no such file: ${file.path}")
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { stream ->
            if (offset > 0) {
                var toSkip = offset
                while (toSkip > 0) {
                    val skipped = stream.skip(toSkip)
                    if (skipped <= 0) throw IOException("could not seek to $offset")
                    toSkip -= skipped
                }
            }
            val buffer = ByteArray(Protocol.CHUNK_SIZE)
            var remaining = if (length < 0) Long.MAX_VALUE else length
            while (remaining > 0) {
                val want = minOf(buffer.size.toLong(), remaining).toInt()
                val read = stream.read(buffer, 0, want)
                if (read <= 0) break
                md.update(buffer, 0, read)
                remaining -= read
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    // --------------------------------------------------------------- inspection

    override fun stat(path: String, promise: Promise) {
        background(promise) {
            val file = File(clean(path))
            Json.obj(
                "exists" to file.exists(),
                "size" to file.length(),
                "isDir" to file.isDirectory,
                "mtime" to file.lastModified(),
            )
        }
    }

    override fun exists(path: String, promise: Promise) {
        background(promise) { File(clean(path)).exists() }
    }

    override fun storageInfo(promise: Promise) {
        background(promise) {
            val stat = StatFs(Environment.getDataDirectory().path)
            val total = stat.blockCountLong * stat.blockSizeLong
            val free = stat.availableBlocksLong * stat.blockSizeLong
            Json.obj(
                "totalBytes" to total,
                "freeBytes" to free,
                "usedBytes" to (total - free),
            )
        }
    }

    // ------------------------------------------------------------- directories

    /**
     * Where received files land.
     *
     * Public Downloads/FortShare when it is writable, so files are visible in
     * the Files app and survive uninstall; app-private storage otherwise. No
     * broad storage permission is requested for either (§37).
     */
    override fun receivedDir(promise: Promise) {
        background(promise) {
            val public = File(
                Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_DOWNLOADS,
                ),
                "FortShare",
            )
            val usePublic = runCatching {
                public.mkdirs()
                public.isDirectory && public.canWrite()
            }.getOrDefault(false)

            val target =
                if (usePublic) public else File(reactContext.filesDir, "FortShare")
            target.mkdirs()
            target.absolutePath
        }
    }

    override fun ensureDir(path: String, promise: Promise) {
        background(promise) {
            File(clean(path)).mkdirs()
            null
        }
    }

    override fun listDir(path: String, promise: Promise) {
        background(promise) {
            val dir = File(clean(path))
            val out = JSONArray()
            for (entry in dir.listFiles().orEmpty().sortedBy { it.name.lowercase() }) {
                out.put(
                    JSONObject()
                        .put("name", entry.name)
                        .put("path", entry.absolutePath)
                        .put("size", entry.length())
                        .put("isDir", entry.isDirectory)
                        .put("mtime", entry.lastModified())
                        .put("mimeType", guessMime(entry.name)),
                )
            }
            out.toString()
        }
    }

    /**
     * Turn a picker URI into something streamable.
     *
     * A `content://` URI is not a path, and the provider behind it may not
     * expose one. When we cannot resolve a real file we copy into app storage
     * once, up front — never during the transfer, where a stall would look
     * like a network problem.
     */
    override fun resolveUri(uri: String, promise: Promise) {
        background(promise) {
            if (!uri.startsWith("content://")) {
                val file = File(clean(uri))
                return@background Json.obj(
                    "path" to file.absolutePath,
                    "name" to file.name,
                    "size" to file.length(),
                    "mimeType" to guessMime(file.name),
                )
            }

            val parsed = Uri.parse(uri)
            val resolver = reactContext.contentResolver
            var name = "file"
            var size = 0L

            resolver.query(parsed, null, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
                        name = cursor.getString(nameIndex)
                    }
                    val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                        size = cursor.getLong(sizeIndex)
                    }
                }
            }

            val mime = resolver.getType(parsed) ?: guessMime(name)
            val staging = File(reactContext.cacheDir, "outgoing").apply { mkdirs() }
            val target = File(staging, "${System.currentTimeMillis()}-$name")

            resolver.openInputStream(parsed)?.use { input ->
                target.outputStream().use { output ->
                    input.copyTo(output, Protocol.IO_BUFFER_SIZE)
                }
            } ?: throw IOException("could not open $uri")

            Json.obj(
                "path" to target.absolutePath,
                "name" to name,
                "size" to if (size > 0) size else target.length(),
                "mimeType" to mime,
            )
        }
    }

    /** "Vacation.mp4" -> ".../Vacation (1).mp4" when the name is taken (§26). */
    override fun uniquePath(dir: String, name: String, promise: Promise) {
        background(promise) {
            val directory = File(clean(dir))
            val dot = name.lastIndexOf('.')
            val base = if (dot > 0) name.substring(0, dot) else name
            val ext = if (dot > 0) name.substring(dot) else ""

            var candidate = File(directory, name)
            var counter = 1
            while (candidate.exists() || File("${candidate.absolutePath}${PART}").exists()) {
                candidate = File(directory, "$base ($counter)$ext")
                counter += 1
            }
            candidate.absolutePath
        }
    }

    override fun rename(from: String, to: String, promise: Promise) {
        background(promise) {
            val source = File(clean(from))
            val target = File(clean(to))
            target.parentFile?.mkdirs()
            if (target.exists()) target.delete()
            if (!source.renameTo(target)) {
                // Rename fails across mount points; fall back to a copy.
                source.inputStream().use { input ->
                    target.outputStream().use { output ->
                        input.copyTo(output, Protocol.IO_BUFFER_SIZE)
                    }
                }
                source.delete()
            }
            null
        }
    }

    override fun unlink(path: String, promise: Promise) {
        background(promise) {
            File(clean(path)).delete()
            null
        }
    }

    // ------------------------------------------------------------- integration

    override fun openFile(path: String, mimeType: String, promise: Promise) {
        background(promise) {
            val uri = shareUri(File(clean(path)))
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mimeType.ifEmpty { guessMime(path) })
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
            null
        }
    }

    override fun shareFile(path: String, mimeType: String, promise: Promise) {
        background(promise) {
            val uri = shareUri(File(clean(path)))
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType.ifEmpty { guessMime(path) }
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            reactContext.startActivity(
                Intent.createChooser(intent, "Share").apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                },
            )
            null
        }
    }

    /** Make a received file show up in the gallery / Files app. */
    override fun scanMedia(path: String, mimeType: String, promise: Promise) {
        background(promise) {
            MediaScannerConnection.scanFile(
                reactContext,
                arrayOf(clean(path)),
                arrayOf(mimeType.ifEmpty { guessMime(path) }),
                null,
            )
            null
        }
    }

    /**
     * Installed, user-visible apps.
     *
     * An installed APK lives under /data/app, which the system document picker
     * cannot browse — so enumerating them here is the only way "share an app"
     * can work. `applicationInfo.sourceDir` is world-readable for normal apps,
     * so the transfer can stream straight from it with no copy.
     */
    override fun listInstalledApps(promise: Promise) {
        background(promise) {
            val manager = reactContext.packageManager
            val out = JSONArray()

            val installed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                manager.getInstalledApplications(
                    PackageManager.ApplicationInfoFlags.of(0L),
                )
            } else {
                @Suppress("DEPRECATION")
                manager.getInstalledApplications(0)
            }

            val apps = installed.mapNotNull { info ->
                // System apps are excluded: their APKs are usually unreadable
                // and installing them on another device is pointless anyway.
                // An updated system app (Chrome, Maps) keeps a readable APK, so
                // those are kept.
                val isSystem = (info.flags and ApplicationInfo.FLAG_SYSTEM) != 0
                val isUpdatedSystem =
                    (info.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
                if (isSystem && !isUpdatedSystem) return@mapNotNull null

                val apk = File(info.sourceDir)
                if (!apk.exists() || !apk.canRead()) return@mapNotNull null

                val label = runCatching { manager.getApplicationLabel(info).toString() }
                    .getOrDefault(info.packageName)
                val version = runCatching {
                    manager.getPackageInfo(info.packageName, 0).versionName
                }.getOrNull().orEmpty()

                Triple(info, label, version) to apk
            }

            // Largest first: on a phone with 200 apps, size is what the user is
            // actually deciding between.
            for ((meta, apk) in apps.sortedByDescending { it.second.length() }) {
                val (info, label, version) = meta
                out.put(
                    JSONObject()
                        .put("name", "$label.apk")
                        .put("packageName", info.packageName)
                        .put("versionName", version)
                        .put("size", apk.length())
                        .put("path", apk.absolutePath)
                        .put("iconPath", cacheAppIcon(info, manager)),
                )
            }
            out.toString()
        }
    }

    /**
     * Render an app icon to a PNG in the cache directory once, and reuse it.
     *
     * Returning a file path rather than a base64 data URI keeps the JSON small:
     * inlining icons for 150 apps would push a megabyte across the bridge on
     * every open of the Apps tab.
     */
    private fun cacheAppIcon(info: ApplicationInfo, manager: PackageManager): String {
        return runCatching {
            val dir = File(reactContext.cacheDir, "app-icons").apply { mkdirs() }
            val target = File(dir, "${info.packageName}.png")
            if (target.exists() && target.length() > 0) return@runCatching target.absolutePath

            val drawable: Drawable = manager.getApplicationIcon(info)
            val size = 96
            val bitmap = if (drawable is BitmapDrawable && drawable.bitmap != null) {
                Bitmap.createScaledBitmap(drawable.bitmap, size, size, true)
            } else {
                Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888).also { bmp ->
                    val canvas = Canvas(bmp)
                    drawable.setBounds(0, 0, size, size)
                    drawable.draw(canvas)
                }
            }
            target.outputStream().use { stream ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
            }
            bitmap.recycle()
            target.absolutePath
        }.getOrDefault("")
    }

    /**
     * The music library, from MediaStore.
     *
     * Browsing by title and artist is the whole point: the document picker can
     * only offer filenames, which is a poor way to find a song.
     *
     * `DATA` (the real path) is preferred when it is readable, so a transfer
     * streams the file in place. Otherwise the content URI is returned and
     * `resolveUri` copies it once, up front.
     */
    override fun listAudio(promise: Promise) {
        background(promise) {
            val out = JSONArray()
            val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
            } else {
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
            }

            val columns = arrayOf(
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.SIZE,
                MediaStore.Audio.Media.MIME_TYPE,
                @Suppress("DEPRECATION") MediaStore.Audio.Media.DATA,
            )

            reactContext.contentResolver.query(
                collection,
                columns,
                "${MediaStore.Audio.Media.IS_MUSIC} != 0",
                null,
                "${MediaStore.Audio.Media.TITLE} COLLATE NOCASE ASC",
            )?.use { cursor ->
                fun col(name: String) = cursor.getColumnIndex(name)
                val idCol = col(MediaStore.Audio.Media._ID)
                val nameCol = col(MediaStore.Audio.Media.DISPLAY_NAME)
                val titleCol = col(MediaStore.Audio.Media.TITLE)
                val artistCol = col(MediaStore.Audio.Media.ARTIST)
                val albumCol = col(MediaStore.Audio.Media.ALBUM)
                val durationCol = col(MediaStore.Audio.Media.DURATION)
                val sizeCol = col(MediaStore.Audio.Media.SIZE)
                val mimeCol = col(MediaStore.Audio.Media.MIME_TYPE)
                @Suppress("DEPRECATION")
                val dataCol = col(MediaStore.Audio.Media.DATA)

                while (cursor.moveToNext()) {
                    fun str(index: Int) =
                        if (index >= 0 && !cursor.isNull(index)) cursor.getString(index) else ""
                    fun num(index: Int) =
                        if (index >= 0 && !cursor.isNull(index)) cursor.getLong(index) else 0L

                    val direct = str(dataCol)
                    val usable = direct.isNotEmpty() && File(direct).canRead()
                    val path = if (usable) {
                        direct
                    } else {
                        val id = num(idCol)
                        if (id == 0L) continue
                        "$collection/$id"
                    }

                    val display = str(nameCol).ifEmpty {
                        val title = str(titleCol).ifEmpty { "Track" }
                        "$title.mp3"
                    }

                    out.put(
                        JSONObject()
                            .put("name", display)
                            .put("path", path)
                            .put("size", num(sizeCol))
                            .put("mimeType", str(mimeCol).ifEmpty { "audio/mpeg" })
                            .put("title", str(titleCol).ifEmpty { display })
                            .put("artist", str(artistCol))
                            .put("album", str(albumCol))
                            .put("durationMs", num(durationCol)),
                    )
                }
            }
            out.toString()
        }
    }

    override fun deviceInfo(promise: Promise) {
        background(promise) {
            val model = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"
                .trim()
            val isTablet = reactContext.resources.configuration.smallestScreenWidthDp >= 600
            Json.obj(
                "model" to model,
                "platform" to "android",
                "deviceType" to if (isTablet) "tablet" else "phone",
                "osVersion" to Build.VERSION.RELEASE,
                "defaultName" to model.ifEmpty { "Android device" },
            )
        }
    }

    // ------------------------------------------------------------------ helpers

    private fun shareUri(file: File): Uri = FileProvider.getUriForFile(
        reactContext,
        "${reactContext.packageName}.fileprovider",
        file,
    )

    private fun guessMime(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
            ?: "application/octet-stream"
    }

    private fun clean(path: String): String =
        if (path.startsWith("file://")) path.removePrefix("file://") else path

    private fun background(promise: Promise, work: () -> Any?) {
        io.execute {
            try {
                promise.resolve(work())
            } catch (error: Throwable) {
                promise.reject("fortshare_fs", error.message ?: error.toString(), error)
            }
        }
    }

    private companion object {
        const val PART = ".fortshare-part"
    }
}
