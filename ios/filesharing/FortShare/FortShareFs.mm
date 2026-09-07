#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <FortShareSpecs/FortShareSpecs.h>

// The generated `filesharing-Swift.h` re-declares every @objc class in the app
// target — including AppDelegate's `ReactNativeDelegate`, whose superclass is
// declared here. Importing this first is what lets the Swift header compile.
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>

#import "filesharing-Swift.h"

/**
 * TurboModule shim for FortShareFs. Forwards to `FortShareFsCore`; no logic
 * lives here.
 */
@interface FortShareFs : NSObject <NativeFortShareFsSpec>
@end

@implementation FortShareFs {
  FortShareFsCore *_core;
}

RCT_EXPORT_MODULE(FortShareFs)

- (instancetype)init
{
  if (self = [super init]) {
    _core = [FortShareFsCore new];
  }
  return self;
}

+ (BOOL)requiresMainQueueSetup { return NO; }

/** Hashing a multi-gigabyte file must not run on the JavaScript thread. */
- (dispatch_queue_t)methodQueue
{
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("fortshare.fs.methods", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

static void settleFs(RCTPromiseResolveBlock resolve,
                     RCTPromiseRejectBlock reject,
                     id (^work)(NSError **))
{
  NSError *error = nil;
  id result = work(&error);
  if (error) {
    reject(@"fortshare_fs", error.localizedDescription, error);
  } else {
    resolve(result);
  }
}

- (void)sha256:(NSString *)path
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject
{
  settleFs(resolve, reject, ^id(NSError **error) {
    return [self->_core sha256WithPath:path error:error];
  });
}

- (void)sha256Range:(NSString *)path
             offset:(double)offset
             length:(double)length
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  settleFs(resolve, reject, ^id(NSError **error) {
    return [self->_core sha256RangeWithPath:path offset:offset length:length error:error];
  });
}

- (void)stat:(NSString *)path
     resolve:(RCTPromiseResolveBlock)resolve
      reject:(RCTPromiseRejectBlock)reject
{
  resolve([_core statWithPath:path]);
}

- (void)exists:(NSString *)path
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject
{
  resolve(@([_core existsWithPath:path]));
}

- (void)storageInfo:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  resolve([_core storageInfo]);
}

- (void)receivedDir:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  settleFs(resolve, reject, ^id(NSError **error) {
    return [self->_core receivedDirAndReturnError:error];
  });
}

- (void)ensureDir:(NSString *)path
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  settleFs(resolve, reject, ^id(NSError **error) {
    [self->_core ensureDirWithPath:path error:error];
    return nil;
  });
}

- (void)listDir:(NSString *)path
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject
{
  resolve([_core listDirWithPath:path]);
}

- (void)resolveUri:(NSString *)uri
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  settleFs(resolve, reject, ^id(NSError **error) {
    return [self->_core resolveUriWithUri:uri error:error];
  });
}

- (void)uniquePath:(NSString *)dir
              name:(NSString *)name
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  resolve([_core uniquePathWithDir:dir name:name]);
}

- (void)rename:(NSString *)from
            to:(NSString *)to
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject
{
  settleFs(resolve, reject, ^id(NSError **error) {
    [self->_core renameFrom:from to:to error:error];
    return nil;
  });
}

- (void)unlink:(NSString *)path
       resolve:(RCTPromiseResolveBlock)resolve
        reject:(RCTPromiseRejectBlock)reject
{
  settleFs(resolve, reject, ^id(NSError **error) {
    [self->_core unlinkWithPath:path error:error];
    return nil;
  });
}

- (void)openFile:(NSString *)path
        mimeType:(NSString *)mimeType
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  [_core openFileWithPath:path mimeType:mimeType];
  resolve(nil);
}

- (void)shareFile:(NSString *)path
         mimeType:(NSString *)mimeType
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  [_core shareFileWithPath:path mimeType:mimeType];
  resolve(nil);
}

- (void)scanMedia:(NSString *)path
         mimeType:(NSString *)mimeType
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  [_core scanMediaWithPath:path mimeType:mimeType];
  resolve(nil);
}

- (void)listInstalledApps:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject
{
  resolve([_core listInstalledApps]);
}

- (void)listAudio:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  resolve([_core listAudio]);
}

- (void)deviceInfo:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  resolve([_core deviceInfo]);
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeFortShareFsSpecJSI>(params);
}

@end
