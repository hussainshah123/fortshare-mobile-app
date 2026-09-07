import Fs from './specs/NativeFortShareFs';
import type { Platform, DeviceType } from '../models/device';

export interface FileStat {
  exists: boolean;
  size: number;
  isDir: boolean;
  mtime: number;
}

export interface StorageInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

export interface ResolvedUri {
  /** A path native can stream from. */
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface DirEntry {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  mtime: number;
  mimeType: string;
}

/** An installed app that can be shared as an APK (Android only). */
export interface InstalledApp {
  name: string;
  packageName: string;
  versionName: string;
  size: number;
  /** Readable path to the APK. */
  path: string;
  /** PNG in the cache directory, or "" if the icon could not be rendered. */
  iconPath: string;
}

/** A track from the device's music library. */
export interface AudioTrack {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
}

export interface NativeDeviceInfo {
  model: string;
  platform: Platform;
  deviceType: DeviceType;
  osVersion: string;
  /** Suggested initial device name, e.g. "Pixel 8" or "Hussain's iPhone". */
  defaultName: string;
}

/** Typed wrapper over the filesystem/hash/OS-integration native module. */
export const FortShareFs = {
  /** Streaming SHA-256 over the whole file. Safe for multi-gigabyte inputs. */
  sha256(path: string): Promise<string> {
    return Fs.sha256(path);
  },

  sha256Range(path: string, offset: number, length: number): Promise<string> {
    return Fs.sha256Range(path, offset, length);
  },

  async stat(path: string): Promise<FileStat> {
    return JSON.parse(await Fs.stat(path)) as FileStat;
  },

  exists(path: string): Promise<boolean> {
    return Fs.exists(path);
  },

  async storageInfo(): Promise<StorageInfo> {
    return JSON.parse(await Fs.storageInfo()) as StorageInfo;
  },

  receivedDir(): Promise<string> {
    return Fs.receivedDir();
  },

  ensureDir(path: string): Promise<void> {
    return Fs.ensureDir(path);
  },

  async listDir(path: string): Promise<DirEntry[]> {
    return JSON.parse(await Fs.listDir(path)) as DirEntry[];
  },

  /** Turn a picker URI into something streamable, copying only if unavoidable. */
  async resolveUri(uri: string): Promise<ResolvedUri> {
    return JSON.parse(await Fs.resolveUri(uri)) as ResolvedUri;
  },

  /** e.g. "Vacation.mp4" -> ".../Vacation (1).mp4" when the name is taken. */
  uniquePath(dir: string, name: string): Promise<string> {
    return Fs.uniquePath(dir, name);
  },

  rename(from: string, to: string): Promise<void> {
    return Fs.rename(from, to);
  },

  unlink(path: string): Promise<void> {
    return Fs.unlink(path);
  },

  openFile(path: string, mimeType: string): Promise<void> {
    return Fs.openFile(path, mimeType);
  },

  shareFile(path: string, mimeType: string): Promise<void> {
    return Fs.shareFile(path, mimeType);
  },

  /** Make a received file appear in the gallery / Files app. */
  scanMedia(path: string, mimeType: string): Promise<void> {
    return Fs.scanMedia(path, mimeType);
  },

  /**
   * Installed apps, largest first. Empty on iOS — see the spec for why.
   */
  async listInstalledApps(): Promise<InstalledApp[]> {
    return JSON.parse(await Fs.listInstalledApps()) as InstalledApp[];
  },

  /** The music library. Empty on iOS — see the spec for why. */
  async listAudio(): Promise<AudioTrack[]> {
    return JSON.parse(await Fs.listAudio()) as AudioTrack[];
  },

  async deviceInfo(): Promise<NativeDeviceInfo> {
    return JSON.parse(await Fs.deviceInfo()) as NativeDeviceInfo;
  },
};
