#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <FortShareSpecs/FortShareSpecs.h>

// The generated `filesharing-Swift.h` re-declares every @objc class in the app
// target — including AppDelegate's `ReactNativeDelegate`, whose superclass is
// declared here. Importing this first is what lets the Swift header compile.
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>

#import "filesharing-Swift.h"

/**
 * TurboModule shim for FortShareNet.
 *
 * Codegen's base class is Objective-C++ (it holds a C++ EventEmitterCallback),
 * so Swift cannot subclass it directly. This file is the thinnest possible
 * bridge: it subclasses the generated base, forwards each method to
 * `FortShareNetCore`, and wires the twelve event blocks to the generated
 * `emitOn*` methods. No logic lives here.
 */
@interface FortShareNet : NativeFortShareNetSpecBase <NativeFortShareNetSpec>
@end

@implementation FortShareNet {
  FortShareNetCore *_core;
}

RCT_EXPORT_MODULE(FortShareNet)

- (instancetype)init
{
  if (self = [super init]) {
    _core = [FortShareNetCore new];
    __weak __typeof(self) weakSelf = self;
    [_core setPeerFound:^(NSString *json) { [weakSelf emitOnPeerFound:json]; }];
    [_core setPeerLost:^(NSString *json) { [weakSelf emitOnPeerLost:json]; }];
    [_core setDiscoveryError:^(NSString *json) { [weakSelf emitOnDiscoveryError:json]; }];
    [_core setNetworkChanged:^(NSString *json) { [weakSelf emitOnNetworkChanged:json]; }];
    [_core setConnection:^(NSString *json) { [weakSelf emitOnConnection:json]; }];
    [_core setControl:^(NSString *json) { [weakSelf emitOnControl:json]; }];
    [_core setDisconnect:^(NSString *json) { [weakSelf emitOnDisconnect:json]; }];
    [_core setSendProgress:^(NSString *json) { [weakSelf emitOnSendProgress:json]; }];
    [_core setSendComplete:^(NSString *json) { [weakSelf emitOnSendComplete:json]; }];
    [_core setReceiveProgress:^(NSString *json) { [weakSelf emitOnReceiveProgress:json]; }];
    [_core setReceiveComplete:^(NSString *json) { [weakSelf emitOnReceiveComplete:json]; }];
    [_core setTransferError:^(NSString *json) { [weakSelf emitOnTransferError:json]; }];
  }
  return self;
}

- (void)invalidate
{
  [_core teardown];
}

/**
 * Socket work must never run on the JavaScript thread: `connect` blocks on a
 * TCP handshake and `startServer` blocks until the listener binds.
 */
+ (BOOL)requiresMainQueueSetup { return NO; }

- (dispatch_queue_t)methodQueue
{
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("fortshare.net.methods", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

/** Run `work`, settling the promise with its result or a readable rejection. */
static void settle(RCTPromiseResolveBlock resolve,
                   RCTPromiseRejectBlock reject,
                   id (^work)(NSError **))
{
  NSError *error = nil;
  id result = work(&error);
  if (error) {
    reject(@"fortshare_net", error.localizedDescription, error);
  } else {
    resolve(result);
  }
}

#pragma mark - Discovery

- (void)startDiscovery:(NSString *)configJson
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  settle(resolve, reject, ^id(NSError **error) {
    [self->_core startDiscoveryWithConfigJson:configJson error:error];
    return nil;
  });
}

- (void)stopDiscovery:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  [_core stopDiscovery];
  resolve(nil);
}

- (void)refreshDiscovery:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  [_core refreshDiscovery];
  resolve(nil);
}

- (void)getLocalAddress:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  resolve([_core getLocalAddress]);
}

#pragma mark - Sockets

- (void)getNetworkInfo:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  resolve([_core getNetworkInfo]);
}

#pragma mark - Wi-Fi Direct

- (void)wifiDirectSupported:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  resolve([_core wifiDirectSupported]);
}

- (void)startWifiDirect:(NSString *)configJson
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  settle(resolve, reject, ^id(NSError **error) {
    [self->_core startWifiDirectWithConfigJson:configJson error:error];
    return nil;
  });
}

- (void)stopWifiDirect:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  [_core stopWifiDirect];
  resolve(nil);
}

- (void)connectWifiDirect:(NSString *)deviceAddress
                timeoutMs:(NSInteger)timeoutMs
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  settle(resolve, reject, ^id(NSError **error) {
    return [self->_core connectWifiDirectWithDeviceAddress:deviceAddress
                                                 timeoutMs:(double)timeoutMs
                                                     error:error];
  });
}

- (void)disconnectWifiDirect:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  [_core disconnectWifiDirect];
  resolve(nil);
}

#pragma mark - Readiness

- (void)systemReadiness:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  resolve([_core systemReadiness]);
}

- (void)openSystemSetting:(NSString *)which
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  resolve([_core openSystemSettingWithWhich:which]);
}

#pragma mark - Direct group host

- (void)createDirectGroup:(NSInteger)timeoutMs
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  settle(resolve, reject, ^id(NSError **error) {
    return [self->_core createDirectGroupWithTimeoutMs:(double)timeoutMs error:error];
  });
}

- (void)removeDirectGroup:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [_core removeDirectGroup];
  resolve(nil);
}

- (void)joinDirectGroup:(NSString *)ssid
             passphrase:(NSString *)passphrase
              timeoutMs:(NSInteger)timeoutMs
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject
{
  settle(resolve, reject, ^id(NSError **error) {
    return [self->_core joinDirectGroupWithSsid:ssid
                                     passphrase:passphrase
                                      timeoutMs:(double)timeoutMs
                                          error:error];
  });
}

- (void)leaveDirectGroup:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  [_core leaveDirectGroup];
  resolve(nil);
}

#pragma mark - Sockets

- (void)startServer:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  settle(resolve, reject, ^id(NSError **error) {
    return [self->_core startServerAndReturnError:error];
  });
}

- (void)stopServer:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  [_core stopServer];
  resolve(nil);
}

- (void)connect:(NSString *)paramsJson
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject
{
  settle(resolve, reject, ^id(NSError **error) {
    NSData *data = [paramsJson dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *params = data
      ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil]
      : @{};
    return [self->_core connectWithHost:params[@"host"] ?: @""
                                   port:[params[@"port"] doubleValue]
                             serviceRef:params[@"serviceRef"] ?: @""
                              timeoutMs:[params[@"timeoutMs"] doubleValue] ?: 10000
                                  error:error];
  });
}

- (void)disconnect:(NSString *)connectionId
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  [_core disconnectWithConnectionId:connectionId];
  resolve(nil);
}

- (void)sendControl:(NSString *)connectionId
               json:(NSString *)json
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  settle(resolve, reject, ^id(NSError **error) {
    [self->_core sendControlWithConnectionId:connectionId json:json error:error];
    return nil;
  });
}

- (void)setSessionKey:(NSString *)connectionId
               keyB64:(NSString *)keyB64
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  settle(resolve, reject, ^id(NSError **error) {
    [self->_core setSessionKeyWithConnectionId:connectionId keyB64:keyB64 error:error];
    return nil;
  });
}

#pragma mark - Transfer

- (void)sendFile:(NSString *)connectionId
      paramsJson:(NSString *)paramsJson
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  settle(resolve, reject, ^id(NSError **error) {
    [self->_core sendFileWithConnectionId:connectionId paramsJson:paramsJson error:error];
    return nil;
  });
}

- (void)receiveFile:(NSString *)connectionId
         paramsJson:(NSString *)paramsJson
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  settle(resolve, reject, ^id(NSError **error) {
    [self->_core receiveFileWithConnectionId:connectionId paramsJson:paramsJson error:error];
    return nil;
  });
}

- (void)pauseTransfer:(NSString *)connectionId
           transferId:(NSString *)transferId
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  settle(resolve, reject, ^id(NSError **error) {
    [self->_core pauseTransferWithConnectionId:connectionId transferId:transferId error:error];
    return nil;
  });
}

- (void)cancelTransfer:(NSString *)connectionId
            transferId:(NSString *)transferId
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  settle(resolve, reject, ^id(NSError **error) {
    [self->_core cancelTransferWithConnectionId:connectionId transferId:transferId error:error];
    return nil;
  });
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeFortShareNetSpecJSI>(params);
}

@end
