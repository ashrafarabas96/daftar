plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

/**
 * The Phase 7 offline kernel, promoted from `prep/phase7/` at commit
 * `9ae37881cf874f24371def3f0e0bad9f61bde0bc` byte for byte — every file's
 * sha256 is unchanged, and `tests-unit/p7-01-offline-kernel-promotion.test.ts`
 * fails if one moves.
 *
 * WHY AN ANDROID LIBRARY AND NOT `kotlin("jvm")`. The kernel itself is pure
 * Kotlin: its only non-stdlib imports are `java.io.File` and `kotlin.test.*`,
 * so a JVM module would compile it. But `ci.yml` runs, in `apps/android`:
 *
 *     ./gradlew lint testDebugUnitTest assembleDebug --no-daemon --stacktrace
 *
 * Those task names carry no project path, so Gradle runs them in every
 * subproject that has them, and it is NOT an error for a subproject to lack
 * one. A JVM module's unit tests hang off `test` — a name that command never
 * says — so its ninety-nine cases would never run and the job would still go
 * green. This module therefore takes the plugin whose variant task names CI
 * already asks for, which is also why nothing under `.github` had to change:
 * that path is outside this lane's ownership.
 */
android {
    namespace = "app.daftar.offline"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

/**
 * Where the source-sweeping suites look for the kernel's own text.
 *
 * Five suites read the kernel as TEXT -- `CommandEffectsTest`,
 * `CrashSafetyTest`, `QueueModelCheckTest`, `RecoveryTest` and
 * `ReentryAndRetentionTest` -- because the laws they defend are not ones a
 * type system can observe: no defaulted `EffectClass`, no fallback to
 * `BENIGN`, no refusal code that no sweep can see. Each reads its root from
 * the system property `p7.src` and falls back to `prep/phase7/kotlin/src`,
 * the path the kernel lived at BEFORE P7-01 promoted it. Nothing set the
 * property, that path does not exist in this repository, and every one of
 * those sweeps therefore found no subject and failed closed -- by design:
 * "an empty file list is a FAILURE, never a quiet pass".
 *
 * Measured on the first run that ever executed them (run 41749455670, job
 * 126310932907): 119 tests completed, 9 failed, and all nine are those
 * sweeps. The promotion moved the files and could not move a property it
 * had no way to discover was unset until the module compiled.
 *
 * The root is the promoted main source set, as an absolute path: the test
 * JVM's working directory is the module directory, and a relative root
 * would make the sweeps depend on it.
 */
tasks.withType<Test>().configureEach {
    systemProperty("p7.src", file("src/main/java").absolutePath)
}

dependencies {
    // The suites are written against `kotlin.test`, not against JUnit's own
    // annotations: all ten import `kotlin.test.Test`. On the JVM that facade
    // needs its JUnit 4 binding present, or `@Test` resolves to nothing and the
    // ninety-nine cases are collected as zero. Both are named explicitly rather
    // than left to a transitive resolution.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.1.0")
}
