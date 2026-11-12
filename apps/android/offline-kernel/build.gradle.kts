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

    // Robolectric needs the merged resources and the manifest of the module it
    // runs in; without this flag its runtime refuses to start and every case in
    // a Robolectric suite errors for a reason that has nothing to do with the
    // law under test.
    testOptions {
        unitTests.isIncludeAndroidResources = true
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
    // And the TEST root, for the one convention check that reads its OWN
    // source: `QueueModelCheckTest` derives it from `p7.test`, falling back
    // to the sibling of `p7.src` -- which was `prep/phase7/kotlin/test` before
    // the promotion and is `src/main/test` after it, a directory that has
    // never existed. It failed closed for exactly that reason: "a convention
    // check that silently reads an empty file is the one failure mode worse
    // than the convention being unenforced". Measured on run 41762264315:
    // 133 tests completed, 1 failed, and this was the one.
    systemProperty("p7.test", file("src/test/java").absolutePath)
}

dependencies {
    // The suites are written against `kotlin.test`, not against JUnit's own
    // annotations: all ten import `kotlin.test.Test`. On the JVM that facade
    // needs its JUnit 4 binding present, or `@Test` resolves to nothing and the
    // ninety-nine cases are collected as zero. Both are named explicitly rather
    // than left to a transitive resolution.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.1.0")

    // A REAL SQLite engine under the crash law, by the owner's condition
    // (2026-11-11). `CrashMidWriteRealEngineTest` kills the caller between
    // `write` and `markSuccessful`, and until now that law was only ever
    // tested against fakes this module wrote: a rollback this module's own
    // test implemented is not evidence about an engine. Robolectric runs the
    // case against Android's own `SQLiteDatabase` with `SQLiteMode.NATIVE`, and
    // the suite reads `sqlite_version()` out of that database so the claim
    // "real engine" is measured in the case itself rather than implied by a
    // dependency being present.
    //
    // 4.14.1 is the version whose supported SDK range includes this module's
    // `compileSdk = 35`. It is a TEST dependency only: nothing in `src/main`
    // gains an import, and `ci.yml` is untouched -- `testDebugUnitTest`
    // already runs this source set.
    testImplementation("org.robolectric:robolectric:4.14.1")
}
