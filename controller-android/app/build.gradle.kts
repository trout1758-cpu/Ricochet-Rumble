import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.ricochetrumble.controller"
    compileSdk = 35

    // CI builds number themselves so each upload is a newer version.
    val buildNumber = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1

    defaultConfig {
        applicationId = "com.ricochetrumble.controller"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber
        versionName = "1.0.$buildNumber"
    }

    // One fixed key for every build (local or CI), so a newer APK installs
    // over the old one instead of Android refusing a signature mismatch.
    // It only signs this hobby controller app; it is not a Play Store key.
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
