#!/usr/bin/env bash
# P7 — provision a Gradle-free Kotlin/JVM toolchain and export its paths.
#
# Why no Gradle: this kernel is pure Kotlin stdlib with no Android and no
# third-party dependency, so the standalone compiler plus the JUnit platform
# console runner compile it and run its tests with clean exit codes (0 green,
# 1 red). That is the whole requirement, and it holds without an Android SDK,
# which is what lets the suite be MEASURED wherever a JDK exists.
#
# Sourced, not executed: it sets KOTLINC, TEST_CP and P7_LIB.
set -euo pipefail

KOTLIN_VERSION="${KOTLIN_VERSION:-2.0.21}"
JUNIT_VERSION="${JUNIT_VERSION:-1.10.2}"
P7_TOOLS_DIR="${P7_TOOLS_DIR:-${TMPDIR:-/tmp}/daftar-p7-kotlin}"

mkdir -p "$P7_TOOLS_DIR/dl"
KOTLINC="$P7_TOOLS_DIR/kotlinc/bin/kotlinc"
JUNIT_JAR="$P7_TOOLS_DIR/dl/junit-platform-console-standalone-$JUNIT_VERSION.jar"

fetch() {
  # Maven Central rate-limits (observed 429), so every download retries with
  # backoff rather than being declared unreachable on one answer.
  curl -sS -L --fail --retry 5 --retry-all-errors --retry-delay 3 \
    --cacert /root/.ccr/ca-bundle.crt -o "$1" "$2"
}

if [ ! -x "$KOTLINC" ]; then
  ZIP="$P7_TOOLS_DIR/dl/kotlin-compiler-$KOTLIN_VERSION.zip"
  [ -f "$ZIP" ] || fetch "$ZIP" \
    "https://github.com/JetBrains/kotlin/releases/download/v$KOTLIN_VERSION/kotlin-compiler-$KOTLIN_VERSION.zip"
  unzip -q -o "$ZIP" -d "$P7_TOOLS_DIR"
fi
[ -f "$JUNIT_JAR" ] || fetch "$JUNIT_JAR" \
  "https://repo1.maven.org/maven2/org/junit/platform/junit-platform-console-standalone/$JUNIT_VERSION/junit-platform-console-standalone-$JUNIT_VERSION.jar"

# kotlin-test and its JUnit 5 bridge ship inside the compiler distribution, so
# no dependency resolution is needed for them.
P7_LIB="$P7_TOOLS_DIR/kotlinc/lib"
# kotlin-stdlib is explicit: the compiler puts it on the COMPILE classpath by
# itself, and a suite compiled without complaint then fails at RUN time with
# NoClassDefFoundError on kotlin.Pair. A green compile is not a runnable suite.
TEST_CP="$P7_LIB/kotlin-stdlib.jar:$P7_LIB/kotlin-test.jar:$P7_LIB/kotlin-test-junit5.jar:$JUNIT_JAR"
export KOTLINC TEST_CP P7_LIB JUNIT_JAR
