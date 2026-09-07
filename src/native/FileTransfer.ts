import type { EventSubscription } from 'react-native';
import Net from './specs/NativeFortShareNet';
import { typedEvent } from './events';
import type {
  ReceiveCompleteEvent,
  SendCompleteEvent,
  TransferErrorEvent,
  TransferProgressEvent,
} from './events';
import { CHUNK_SIZE } from '../constants/protocol';

export interface SendFileParams {
  transferId: string;
  fileId: string;
  /** Also the `fileIndex` written into every DATA frame header. */
  fileIndex: number;
  uri: string;
  /** Byte offset to start from. Non-zero resumes an interrupted file. */
  offset: number;
  size: number;
}

export interface ReceiveFileParams {
  transferId: string;
  fileId: string;
  fileIndex: number;
  /** Where native writes. Always a `.fortshare-part` path until verified. */
  destPath: string;
  offset: number;
  size: number;
}

/**
 * The data plane, as required by §35.
 *
 * These calls hand native a path and an offset and return immediately; native
 * streams disk<->socket on a background thread with the socket write providing
 * backpressure. A 5 GB transfer costs one 256 KB buffer, and JavaScript sees
 * only throttled counters.
 */
export const FileTransfer = {
  send(connectionId: string, params: SendFileParams): Promise<void> {
    return Net.sendFile(
      connectionId,
      JSON.stringify({ ...params, chunkSize: CHUNK_SIZE }),
    );
  },

  /** Arm the receiver *before* the peer's FILE_BEGIN, so no chunk is missed. */
  receive(connectionId: string, params: ReceiveFileParams): Promise<void> {
    return Net.receiveFile(connectionId, JSON.stringify(params));
  },

  /** Stop streaming but keep partial state, so a resume can pick it up. */
  pause(connectionId: string, transferId: string): Promise<void> {
    return Net.pauseTransfer(connectionId, transferId);
  },

  /**
   * Resuming is just `send`/`receive` again with a new offset — there is no
   * separate native resume call, because DATA frames are absolutely addressed.
   */
  cancel(connectionId: string, transferId: string): Promise<void> {
    return Net.cancelTransfer(connectionId, transferId);
  },

  onSendProgress(
    handler: (event: TransferProgressEvent) => void,
  ): EventSubscription {
    return typedEvent<TransferProgressEvent>(
      Net.onSendProgress,
      'onSendProgress',
    )(handler);
  },

  onSendComplete(handler: (event: SendCompleteEvent) => void): EventSubscription {
    return typedEvent<SendCompleteEvent>(Net.onSendComplete, 'onSendComplete')(
      handler,
    );
  },

  onReceiveProgress(
    handler: (event: TransferProgressEvent) => void,
  ): EventSubscription {
    return typedEvent<TransferProgressEvent>(
      Net.onReceiveProgress,
      'onReceiveProgress',
    )(handler);
  },

  onReceiveComplete(
    handler: (event: ReceiveCompleteEvent) => void,
  ): EventSubscription {
    return typedEvent<ReceiveCompleteEvent>(
      Net.onReceiveComplete,
      'onReceiveComplete',
    )(handler);
  },

  onError(handler: (event: TransferErrorEvent) => void): EventSubscription {
    return typedEvent<TransferErrorEvent>(Net.onTransferError, 'onTransferError')(
      handler,
    );
  },
};
