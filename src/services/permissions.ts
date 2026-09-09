import { PermissionsAndroid, Platform } from 'react-native';
import {
  iosReadGalleryPermission,
  iosRequestReadWriteGalleryPermission,
} from '@react-native-camera-roll/camera-roll';
import { Camera } from 'react-native-vision-camera';
import { Notifications } from '../native';

/**
 * Permission handling (§37).
 *
 * Every request happens at the moment the feature is used, never at launch,
 * and each one is scoped as narrowly as the platform allows:
 *
 *   - No blanket storage permission. Media access uses the scoped
 *     READ_MEDIA_* permissions on Android 13+, and arbitrary files go through
 *     the system document picker, which needs no permission at all.
 *   - Camera is requested only when opening the QR scanner.
 *   - Notifications only when a transfer is about to start.
 *   - iOS Local Network has no request API: the prompt appears by itself the
 *     first time we browse, which is why discovery starts on the Devices
 *     screen rather than silently at launch.
 */

/**
 * Access to the photo library, for the Photos/Videos picker categories.
 *
 * Android 13+ has separate image and video permissions, so only the one being
 * browsed is requested.
 */
export async function requestMediaAccess(
  kind: 'photos' | 'videos' | 'music',
): Promise<boolean> {
  if (Platform.OS === 'ios') {
    const current = await iosReadGalleryPermission('readWrite').catch(
      () => 'not-determined' as const,
    );
    // "limited" means the user picked specific photos — that is a legitimate
    // answer, not a failure, and the picker works fine with it.
    if (current === 'granted' || current === 'limited') return true;
    if (current === 'blocked' || current === 'denied') return false;

    const requested = await iosRequestReadWriteGalleryPermission().catch(
      () => 'denied' as const,
    );
    return requested === 'granted' || requested === 'limited';
  }

  // Platform.Version is a string on iOS and a number on Android.
  const androidApi =
    typeof Platform.Version === 'number'
      ? Platform.Version
      : Number.parseInt(String(Platform.Version), 10);

  if (androidApi >= 33) {
    const permission =
      kind === 'photos'
        ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES
        : kind === 'videos'
          ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO
          : PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO;
    const result = await PermissionsAndroid.request(permission, {
      title: 'Allow FortShare to read your media',
      message:
        'FortShare needs this only to show you which files to send. Nothing is uploaded anywhere.',
      buttonPositive: 'Allow',
      buttonNegative: 'Not now',
    });
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }

  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
    {
      title: 'Allow FortShare to read your files',
      message: 'Needed to show you which files to send.',
      buttonPositive: 'Allow',
      buttonNegative: 'Not now',
    },
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/** Camera access, requested only when opening the QR scanner (§14). */
export async function requestCameraAccess(): Promise<boolean> {
  const current = Camera.getCameraPermissionStatus();
  if (current === 'granted') return true;
  const requested = await Camera.requestCameraPermission();
  return requested === 'granted';
}

/**
 * The permission Wi-Fi Direct scanning needs.
 *
 * From Android 13 this is NEARBY_WIFI_DEVICES, declared `neverForLocation`.
 * Below that Android genuinely requires fine location to scan for P2P peers —
 * an OS constraint, not a FortShare choice, and the rationale text says so
 * rather than leaving the user to wonder why a file-sharing app wants their
 * location. Requested only when the user turns Wi-Fi Direct on.
 */
export async function requestWifiDirectAccess(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;

  const androidApi =
    typeof Platform.Version === 'number'
      ? Platform.Version
      : Number.parseInt(String(Platform.Version), 10);

  if (androidApi >= 33) {
    const result = await PermissionsAndroid.request(
      'android.permission.NEARBY_WIFI_DEVICES' as Parameters<
        typeof PermissionsAndroid.request
      >[0],
      {
        title: 'Allow FortShare to find nearby devices',
        message:
          'Wi-Fi Direct connects the two phones to each other without a router, so it works even when your Wi-Fi blocks devices from talking.',
        buttonPositive: 'Allow',
        buttonNegative: 'Not now',
      },
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }

  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    {
      title: 'Location permission is required for Wi-Fi Direct',
      message:
        'Android requires location permission to scan for nearby Wi-Fi Direct devices. FortShare does not read, store or send your location — this is an Android requirement on this version.',
      buttonPositive: 'Allow',
      buttonNegative: 'Not now',
    },
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/** Notification access, requested only when a transfer is about to start. */
export async function requestNotificationAccess(): Promise<boolean> {
  if (await Notifications.hasPermission().catch(() => false)) return true;
  return Notifications.requestPermission().catch(() => false);
}
