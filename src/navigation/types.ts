import type { NavigatorScreenParams } from '@react-navigation/native';
import type { SelectedFile } from '../models/transfer';

/** Bottom tabs (§31). */
export type TabParamList = {
  Home: undefined;
  Devices: undefined;
  Transfers: undefined;
  Files: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList>;
  DeviceDetail: { deviceId: string };
  TransferDetail: { transferId: string };
  /**
   * The picker. `deviceId` is carried through so "Send Files" from a device
   * lands back on that device without the user re-picking it (§11).
   */
  FilePicker: { deviceId: string };
  SendReview: { deviceId: string; files: SelectedFile[] };
  ActiveTransfer: { transferId: string };
  QrShow: undefined;
  QrScan: undefined;
  Search: undefined;
  DeviceProfile: undefined;
};
