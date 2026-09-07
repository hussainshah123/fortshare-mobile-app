import type { EventSubscription } from 'react-native';
import Notify from './specs/NativeFortShareNotify';
import { typedEvent } from './events';

export interface NotificationActionEvent {
  action: 'pause' | 'resume' | 'cancel' | 'open';
  transferId: string;
}

export interface TransferServiceState {
  transferId: string;
  title: string;
  body: string;
  /** 0-100. Ignored when `indeterminate` is true. */
  progress: number;
  indeterminate: boolean;
}

/**
 * Transfer notifications, and on Android the foreground service that keeps a
 * transfer running while the app is backgrounded (§36).
 *
 * On iOS the service calls degrade to a background task: the OS grants a
 * bounded window rather than open-ended execution, and we do not pretend
 * otherwise.
 */
export const Notifications = {
  requestPermission(): Promise<boolean> {
    return Notify.requestPermission();
  },

  hasPermission(): Promise<boolean> {
    return Notify.hasPermission();
  },

  start(state: Omit<TransferServiceState, 'progress' | 'indeterminate'>) {
    return Notify.startTransferService(JSON.stringify(state));
  },

  update(state: TransferServiceState): Promise<void> {
    return Notify.updateTransferService(JSON.stringify(state));
  },

  stop(): Promise<void> {
    return Notify.stopTransferService();
  },

  notify(id: string, title: string, body: string): Promise<void> {
    return Notify.notify(JSON.stringify({ id, title, body, channel: 'events' }));
  },

  cancel(id: string): Promise<void> {
    return Notify.cancelNotification(id);
  },

  onAction(
    handler: (event: NotificationActionEvent) => void,
  ): EventSubscription {
    return typedEvent<NotificationActionEvent>(
      Notify.onNotificationAction,
      'onNotificationAction',
    )(handler);
  },
};
