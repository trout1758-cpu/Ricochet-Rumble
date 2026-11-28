import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.ricochetrumble.tablet"
    compileSdk = 35

    // CI builds number themselves so each upload is a newer version
    // (Settings > Check for updates compares this "build" number too).
    val buildNumber = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1

    defaultConfig {
        applicationId = "com.ricochetrumble.tablet"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
    }

    // The game itself (../../game) is the app's assets, next to src/main/assets
    // (which holds rr-android/bridge.js).
    sourceSets {
        getByName("main") {
            assets.srcDirs("src/main/assets", "../../game")
        }
    }
    androidResources {
        // leave the game's tests out of the app
        ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~:!tests"
    }

    // One fixed key for every build (local or CI), so a newer APK installs
    // over the old one instead of Android refusing a signature mismatch.
    // The same hobby key as the Ricochet Pad controller app; not a Play Store key.
    signingConfigs {
        create("dev") {
            storeFile = file("ricochetpad-dev.keystore")
            storePassword = "ricochetpad"
            keyAlias = "ricochetpad"
            keyPassword = "ricochetpad"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("dev")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("dev")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}
