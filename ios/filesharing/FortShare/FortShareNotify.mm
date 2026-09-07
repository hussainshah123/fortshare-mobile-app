#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <FortShareSpecs/FortShareSpecs.h>

// The generated `filesharing-Swift.h` re-declares every @objc class in the app
// target — including AppDelegate's `ReactNativeDelegate`, whose superclass is
// declared here. Importing this first is what lets the Swift header compile.
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>

#import "filesharing-Swift.h"

/**
 * TurboModule shim for FortShareNotify. Forwards to `FortShareNotifyCore`.
 */
@interface FortShareNotify : NativeFortShareNotifySpecBase <NativeFortShareNotifySpec>
@end

@implementation FortShareNotify {
  FortShareNotifyCore *_core;
}

RCT_EXPORT_MODULE(FortShareNotify)

- (instancetype)init
{
  if (self = [super init]) {
    _core = [FortShareNotifyCore new];
    __weak __typeof(self) weakSelf = self;
    [_core setNotificationAction:^(NSString *json) {
      [weakSelf emitOnNotificationAction:json];
    }];
  }
  return self;
}

+ (BOOL)requiresMainQueueSetup { return NO; }

- (void)requestPermission:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  [_core requestPermissionWithCompletion:^(BOOL granted) { resolve(@(granted)); }];
}

- (void)hasPermission:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  [_core hasPermissionWithCompletion:^(BOOL granted) { resolve(@(granted)); }];
}

- (void)startTransferService:(NSString *)json
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject
{
  [_core startTransferServiceWithJson:json];
  resolve(nil);
}

- (void)updateTransferService:(NSString *)json
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  [_core updateTransferServiceWithJson:json];
  resolve(nil);
}

- (void)stopTransferService:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  [_core stopTransferService];
  resolve(nil);
}

- (void)notify:(NSString *)json
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject
{
  [_core notifyWithJson:json];
  resolve(nil);
}

- (void)cancelNotification:(NSString *)id
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [_core cancelNotificationWithId:id];
  resolve(nil);
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeFortShareNotifySpecJSI>(params);
}

@end
