import { TurboModuleRegistry, type TurboModule } from 'react-native';
import type { Double } from 'react-native/Libraries/Types/CodegenTypes';

/**
 * Filesystem, hashing and OS-integration primitives.
 *
 * Hashing is here rather than in JavaScript because a SHA-256 over a 5 GB file
 * must stream: `sha256` reads the file in blocks natively and returns only the
 * 64-character digest.
 */
export interface Spec extends TurboModule {
  /** Streaming SHA-256 over the whole file. Returns lowercase hex. */
  sha256(path: string): Promise<string>;
  /** Streaming SHA-256 over a byte range. Used to spot-check resume seams. */
  sha256Range(path: string, offset: Double, length: Double): Promise<string>;

  /** { exists, size, isDir, mtime } JSON. */
  stat(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** { totalBytes, freeBytes, usedBytes } JSON. */
  storageInfo(): Promise<string>;

  /** Absolute path of the FortShare received-files directory (created if absent). */
  receivedDir(): Promise<string>;
  ensureDir(path: string): Promise<void>;
  /** Array of { name, path, size, isDir, mtime, mimeType } JSON. */
  listDir(path: string): Promise<string>;

  /**
   * Resolve a picker URI (`content://` on Android, `file://` on iOS) to
   * something streamable, copying into app storage only if unavoidable.
   * Returns { path, name, size, mimeType } JSON.
   */
  resolveUri(uri: string): Promise<string>;

  /** First non-colliding path in `dir` for `name`, e.g. "Vacation (1).mp4". */
  uniquePath(dir: string, name: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;

  /** Hand the file to the OS viewer. */
  openFile(path: string, mimeType: string): Promise<void>;
  /** Hand the file to the OS share sheet. */
  shareFile(path: string, mimeType: string): Promise<void>;
  /** Make a received file visible to the gallery/Files app (Android scanner). */
  scanMedia(path: string, mimeType: string): Promise<void>;

  /**
   * Installed, user-visible apps, as a JSON array of
   * { name, packageName, versionName, size, path, iconPath }.
   *
   * Android only. An installed app's APK lives under /data/app, which the
   * system document picker cannot browse, so listing them here is the only way
   * "share an app" can work at all. `path` is the readable APK, and `iconPath`
   * is a PNG written once into the cache directory.
   *
   * Returns `[]` on iOS, which has no app-enumeration API and no access to
   * another app's bundle. The UI explains that rather than showing an empty
   * list.
   */
  listInstalledApps(): Promise<string>;

  /**
   * The on-device music library, as a JSON array of
   * { name, path, size, mimeType, title, artist, album, durationMs }.
   *
   * Reads MediaStore on Android so tracks can be browsed by title and artist
   * instead of hunted for by filename in a file browser.
   *
   * Returns `[]` on iOS: Apple Music tracks are DRM-protected and cannot be
   * exported, so the UI falls back to the document picker for local files.
   */
  listAudio(): Promise<string>;

  /** { model, platform, deviceType, osVersion, defaultName } JSON. */
  deviceInfo(): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('FortShareFs');
