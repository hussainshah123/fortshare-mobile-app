package com.fortdice.filesharing.fortshare

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers FortShare's three native modules.
 *
 * All are TurboModules generated from the TypeScript specs in
 * src/native/specs, so `isTurboModule = true` and the bridgeless runtime
 * resolves them directly.
 */
class FortSharePackage : BaseReactPackage() {

    override fun getModule(
        name: String,
        reactContext: ReactApplicationContext,
    ): NativeModule? = when (name) {
        "FortShareNet" -> FortShareNetModule(reactContext)
        "FortShareFs" -> FortShareFsModule(reactContext)
        "FortShareNotify" -> FortShareNotifyModule(reactContext)
        else -> null
    }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider =
        ReactModuleInfoProvider {
            listOf("FortShareNet", "FortShareFs", "FortShareNotify").associateWith { name ->
                ReactModuleInfo(
                    name,
                    name,
                    false, // canOverrideExistingModule
                    false, // needsEagerInit
                    false, // isCxxModule
                    true, // isTurboModule
                )
            }
        }
}
