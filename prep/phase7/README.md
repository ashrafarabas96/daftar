# `prep/phase7` — Phase 7 offline kernel

**Status: `PREPARED / NOT PROMOTED`.** This directory is future-phase
preparation under the Tech Lead's acceleration directive (Part 9). It is not
canonical, it is not compiled by the Android application build, it is not wired
into required CI, and it allocates no migration.

Phase 7 is _Offline and Mobile Production Workflows_, and its absolute law is
that an offline device is never canonical financial authority: the server's
commit is the only thing that makes a sale or a stock movement true, and no
conflict over money or stock is ever resolved silently by a device.

## What is here

`kotlin/src/app/daftar/offline/` — the offline kernel: pure Kotlin stdlib, no
Android and no third-party dependency, so it compiles and its suite runs
wherever a JDK exists.

| File | What it holds |
| ---- | ------------- |
| `Laws.kt` | the eleven offline laws, as values the code cites and tests assert |
| `Model.kt` | effect classes, attempt results, decisions |
| `Outcome.kt` | the classifier: one attempt's result becomes one decision |
| `Backoff.kt` | the retry schedule, derived rather than drawn |
| `Queue.kt` | the operation state machine, as a pure reducer |
| `Conflict.kt` | the conflict model, as a permission table |
| `CommandEffects.kt` | which commands move money or stock — registered by each domain owner, never defaulted |

`kotlin/test/app/daftar/offline/` — seven suites, including an exhaustive sweep of
the classifier's input space and a breadth-first model check of every reachable
queue configuration.

## Running it

```sh
bash prep/phase7/kotlin/tools/run-tests.sh    # compile + run; 0 green, non-zero red
bash prep/phase7/kotlin/tools/red-proofs.sh   # plant one defect per law; each must redden a NAMED test
```

The first run provisions a Gradle-free Kotlin toolchain (the standalone compiler
plus the JUnit platform console runner) into a temporary directory;
`tools/toolchain.sh` is the only thing that downloads anything.

## Phase 7 registers no classification of its own: effect classification belongs beside
each domain's command definition and is owned by that domain, so an unregistered
command refuses by name rather than being assumed harmless.

The contract pack

The protocol, the conflict model, the replay-safety argument, the defects found
and the open questions are in the project's shared `phase7/` folder:
`P7-S0-CONTRACT-PACK.md`, `P7-S0-MIGRATION-PATCH-REQUEST.md` and
`P7-S0-EVIDENCE-AND-RUN-IDENTITY.md`.
