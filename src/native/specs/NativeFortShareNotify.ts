import { TurboModuleRegistry, type TurboModule } from 'react-native';
import type { EventEmitter } from 'react-native/Libraries/Types/CodegenTypes';

/**
 * Transfer notifications and, on Android, the foreground service that keeps a
 * transfer alive while the app is backgrounded.
 *
 * iOS has no equivalent of a foreground service; there the service calls are
 * no-ops and only the local notifications land. That asymmetry is deliberate —
 * we do not pretend to background behaviour the OS will not grant.
 */
export interface Spec extends TurboModule {
  /** True once the user has granted notification permission. */
  requestPermission(): Promise<boolean>;
  hasPermission(): Promise<boolean>;

  /**
   * Android: start the foreground service so the OS keeps the process alive.
   * iOS: begins a background task and returns.
   * @param json { transferId, title, body }
   */
  startTransferService(json: string): Promise<void>;
  /** @param json { transferId, title, body, progress (0-100), indeterminate } */
  updateTransferService(json: string): Promise<void>;
  stopTransferService(): Promise<void>;

  /** @param json { id, title, body, channel } */
  notify(json: string): Promise<void>;
  cancelNotification(id: string): Promise<void>;

  /** { action, transferId } JSON — fired when the user taps a notification action. */
  readonly onNotificationAction: EventEmitter<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('FortShareNotify');
