import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P7-03 — the envelope is pinned to the contract that EXISTS, and the device
 * clock decides nothing.
 *
 * Two different jobs are done here, and only the second could be done in Kotlin.
 *
 * ONE: pin the server contract the Android client is written against, by
 * reading the server's own source. The client decides whether a sale was
 * created or replayed from the status and the `replayed` field; if the
 * controller stopped answering `result.replayed ? 200 : 201`, or
 * `inventory.idempotency_conflict` left the 409 set, the client would be
 * reading a contract that no longer holds and no Kotlin test could tell. The
 * files under `apps/api/**` are outside this lane's ownership and are READ
 * here, never written.
 *
 * TWO: enforce an ABSENCE — no device clock anywhere in the envelope. An
 * absence claim needs a probe proven able to find the thing, so every case
 * below runs its probe against a planted positive control first.
 *
 * This lane needs no database and no JDK, which is why these checks exist at
 * all: on the host this card was executed on, `tests/integration/**` cannot run
 * (the embedded PostgreSQL cluster does not work on Windows) and neither can
 * Kotlin (no `kotlinc`).
 */

const ROOT = join(__dirname, '..');
const KERNEL = join(ROOT, 'apps', 'android', 'offline-kernel');
const ENVELOPE = join(KERNEL, 'src', 'main', 'java', 'app', 'daftar', 'offline', 'SyncEnvelope.kt');
const SUITE = join(KERNEL, 'src', 'test', 'java', 'app', 'daftar', 'offline', 'SyncEnvelopeTest.kt');
const CONTROLLER = join(ROOT, 'apps', 'api', 'src', 'modules', 'inventory', 'inventory-movements.controller.ts');
const FILTER = join(ROOT, 'apps', 'api', 'src', 'common', 'error.filter.ts');

const envelope = () => readFileSync(ENVELOPE, 'utf8');
const suite = () => readFileSync(SUITE, 'utf8');

describe('P7-03: the server contract the client is written against', () => {
  /**
   * THE ONE CONTROL THIS LANE COULD NOT APPLY, said rather than skipped.
   *
   * Every other absence here is proven by planting the defect in the file and
   * watching the probe find it. These three cases read `apps/api/**`, which is
   * OUTSIDE this lane's ownership — planting a defect there, even for a second
   * and even restored byte-identically, is an edit to a file this lane was told
   * not to touch. So the probes are armed against planted STRINGS instead: the
   * regex is proven able to find the contract and to notice it changed, which
   * bounds the probe without writing to a file that is not ours. What remains
   * unproven is narrow and worth naming: that the probe reads THAT path
   * correctly, which `readFileSync` either does or throws on.
   */
  it('the status-mapping probe finds the contract, and notices it changing', () => {
    const probe = /res\.status\(result\.replayed \? 200 : 201\)/;
    expect(probe.test('    res.status(result.replayed ? 200 : 201);')).toBe(true);
    // The three ways this contract could be broken, each caught.
    expect(probe.test('    res.status(result.replayed ? 200 : 200);')).toBe(false);
    expect(probe.test('    res.status(201);')).toBe(false);
    expect(probe.test('    res.status(result.replayed ? 204 : 201);')).toBe(false);
  });

  it('still answers 200 on a replay and 201 otherwise, at every site', () => {
    const controller = readFileSync(CONTROLLER, 'utf8');
    const sites = controller.match(/res\.status\(result\.replayed \? 200 : 201\)/g) ?? [];
    // Five sites were measured when this card was written. Pinned rather than
    // ">= 1": a site that lost the ternary is the defect this guard is for.
    expect(sites).toHaveLength(5);
    // And the flag travels in the body, which is what `sameTruth` compares on.
    expect(controller).toContain('replayed');
  });

  it('still refuses a replayed key with a different intent, as a 409', () => {
    const filter = readFileSync(FILTER, 'utf8');
    expect(filter).toContain("'inventory.idempotency_conflict'");
    // The code sits in the set the filter renders as CONFLICT.
    const conflictSet = filter.slice(filter.indexOf('P3_S3_INVENTORY_CODES'));
    expect(conflictSet).toContain("'inventory.idempotency_conflict'");
    expect(filter).toContain('HttpStatus.CONFLICT');
  });

  it('is compared on a stored intent digest by the services that write', () => {
    const services = ['inventory-transfer.service.ts', 'inventory-adjustment.service.ts', 'inventory-opening.service.ts', 'inventory-stocktake.service.ts'];
    const without: string[] = [];
    for (const name of services) {
      const source = readFileSync(join(ROOT, 'apps', 'api', 'src', 'modules', 'inventory', name), 'utf8');
      if (!/intentSha256 !==/.test(source) || !source.includes('inventory.idempotency_conflict')) {
        without.push(name);
      }
    }
    expect(without).toEqual([]);
  });

  it('the client names exactly the codes and statuses the server uses', () => {
    expect(envelope()).toContain('const val IDEMPOTENCY_CONFLICT: String = "inventory.idempotency_conflict"');
    expect(envelope()).toContain('const val REPLAYED_FIELD: String = "replayed"');
    // The three statuses, and nothing read as a success by default.
    expect(envelope()).toMatch(/201 ->/);
    expect(envelope()).toMatch(/200 ->/);
    expect(envelope()).toMatch(/409 ->/);
    expect(envelope()).toMatch(/else -> ServerAnswer\.NoUsableAnswer/);
  });
});

describe('P7-03: the device clock reaches no amount and no ordering', () => {
  /**
   * The probe. A device clock enters Kotlin through a small, closed set of
   * calls; a field merely NAMED `timestamp` is not the risk, reading the clock
   * is.
   */
  const CLOCK_READS = /System\.currentTimeMillis|System\.nanoTime|Instant\.now|LocalDate(Time)?\.now|Clock\.System|Date\(\)|SystemClock\./;

  it('the probe finds a clock read when one is there', () => {
    // Positive control, run before any absence below is read.
    expect(CLOCK_READS.test('val t = System.currentTimeMillis()')).toBe(true);
    expect(CLOCK_READS.test('val t = Instant.now()')).toBe(true);
    expect(CLOCK_READS.test('val t = SystemClock.elapsedRealtime()')).toBe(true);
    expect(CLOCK_READS.test('val total = lines.sumOf { it.amountMinor }')).toBe(false);
  });

  it('the envelope reads no clock at all', () => {
    expect(CLOCK_READS.test(envelope())).toBe(false);
  });

  /**
   * The envelope's FIELDS, read from the `data class` declaration rather than
   * from the whole file, so that the word `capturedAt` inside a comment
   * explaining why there is no such field does not fail its own rule.
   */
  it('declares no time-bearing field', () => {
    const declaration = envelope().slice(
      envelope().indexOf('data class SyncEnvelope('),
      envelope().indexOf(') {', envelope().indexOf('data class SyncEnvelope(')),
    );
    const fields = [...declaration.matchAll(/^ {4}val ([A-Za-z0-9_]+):/gm)].map((m) => m[1] ?? '');
    expect(fields).toEqual(['idempotencyKey', 'envelopeVersion', 'payloadSchemaVersion', 'intentSha256', 'payload']);

    const timeLike = /at$|^at|time|clock|date|stamp|now|epoch|seconds|millis/i;
    // Probe proven able to find one.
    expect(timeLike.test('capturedAt')).toBe(true);
    expect(timeLike.test('sentAtMillis')).toBe(true);
    expect(fields.filter((f) => timeLike.test(f))).toEqual([]);
  });

  /**
   * The ordering half, which the clock-immunity criterion needs or it is
   * satisfied by a client that orders nothing. The suite must assert a real
   * attempt order BEFORE it asserts that moving the clock leaves amounts alone.
   */
  it('the suite asserts a real attempt order before asserting the clock changes nothing', () => {
    const source = suite();
    const clockCase = source.indexOf('advancing the device clock by a year');
    expect(clockCase).toBeGreaterThan(-1);
    const body = source.slice(clockCase);
    const control = body.indexOf('the attempt order must be real');
    const amount = body.indexOf('an amount moved when the clock did');
    expect(control).toBeGreaterThan(-1);
    expect(amount).toBeGreaterThan(-1);
    // The positive control comes first, or it is not a control.
    expect(control).toBeLessThan(amount);
    // And the jump really is a year.
    expect(body).toContain('365L * 24 * 60 * 60 * 1000');
  });

  it('the suite pins one 201 and nine 200s, not ten identical responses', () => {
    const source = suite();
    expect(source).toMatch(/assertEquals\(1, answers\.count \{ it is ServerAnswer\.Created \}/);
    expect(source).toMatch(/assertEquals\(9, answers\.count \{ it is ServerAnswer\.Replayed \}/);
    expect(source).toMatch(/assertEquals\(1, server\.rowsWritten/);
    expect(source).toContain('Replay.sameTruth');
  });

  it('carries no skipped, focused or pending marker', () => {
    const banned = /@Ignore\b|\.skip\b|\.only\b|\.todo\b|@Disabled\b/;
    expect(banned.test('@Ignore')).toBe(true);
    expect(banned.test(suite())).toBe(false);
    expect(banned.test(envelope())).toBe(false);
  });
});

describe('P7-03: the real-concurrency proof is written, and named as not run', () => {
  /**
   * The ten-requests-one-row case needs two live PostgreSQL connections and a
   * held lock. `Promise.all` is explicitly rejected by this project's own
   * convention (`tests/integration/accounting-concurrency.test.ts`), so the
   * guard checks the integration suite does not reach for it — a check that is
   * worth something precisely because the suite could not be RUN here.
   */
  const INTEGRATION = join(ROOT, 'tests', 'integration', 'p7-03-envelope-replay-concurrency.test.ts');

  /**
   * WHAT THE CONVENTION ACTUALLY BANS, which is not a string.
   *
   * The first version of this check asserted that `Promise.all` does not appear
   * in the suite at all. That is the letter and not the reason, and it failed
   * against a suite that forces interleaving correctly: the convention in
   * `accounting-concurrency.test.ts` rejects firing promises and TRUSTING THE
   * SCHEDULER to produce contention. Collecting requests that are already in
   * flight and already proven blocked on a held lock is the opposite of that.
   *
   * So what is checked is the mechanism: a second connection, its own
   * transaction, a `FOR UPDATE` lock, the requests issued BEFORE anything is
   * awaited, and — the part that makes the rest evidence — an assertion that
   * the sends had NOT finished while the lock was held. Starting the contended
   * work inside a `Promise.all` is still refused, by shape.
   */
  it('forces interleaving with a second connection and a held lock', () => {
    const source = readFileSync(INTEGRATION, 'utf8');

    // A second real connection, its own transaction, a real row lock.
    expect(source).toContain('ownerPool().connect()');
    expect(source).toContain("holder.query('BEGIN')");
    expect(source).toContain('FOR UPDATE');
    expect(source).toContain("holder.query('COMMIT')");

    // The requests are issued without awaiting, so they are in flight together.
    expect(source).toMatch(/Array\.from\(\{ length: 10 \}, \(\) => sendAdjustment\(body\)\)/);

    // And they are PROVEN to have been blocked before the lock was released.
    // Without this, the lock could have been taken on a row the writing path
    // never touches and the case would measure nothing.
    expect(source).toContain('still-blocked');
    expect(source).toContain('the sends did not block on the held lock');

    // The banned shape: starting the contended work inside the combinator and
    // hoping the scheduler interleaves it. Probe proven able to find it.
    const schedulerTrusted = /Promise\.all\(\s*(Array\.from|\[|[A-Za-z0-9_]+\.map)/;
    expect(schedulerTrusted.test('await Promise.all(Array.from({length:10},()=>send()))')).toBe(true);
    expect(schedulerTrusted.test('await Promise.all([send(), send()])')).toBe(true);
    expect(schedulerTrusted.test('await Promise.all(sends.map((s) => s()))')).toBe(true);
    expect(schedulerTrusted.test(source)).toBe(false);
  });

  /**
   * Added after CI caught the one real defect in that suite: the conflict case
   * read `body.code`, which is always `undefined`, because
   * `GlobalExceptionFilter` wraps every refusal as
   * `{ error: { code, message, requestId } }`. A `toBe` against `undefined`
   * fails loudly, so nothing was silently green — but the shape is a project
   * convention worth pinning rather than remembering, and it is read from the
   * filter itself.
   */
  it('reads a refusal code at body.error.code, the shape the filter actually sends', () => {
    const filter = readFileSync(FILTER, 'utf8');
    expect(filter).toContain('const payload: ApiErrorBody = { error: { code, message, requestId');
    const source = readFileSync(INTEGRATION, 'utf8');
    expect(source).toContain('conflicting.body.error.code');
    // Probe proven able to find the defect it denies: the bare `body.code`
    // form, which reads undefined on every refusal this API returns.
    //
    // It matches an ASSERTION, not the bare string. A plain /body\.code/ failed
    // on its first run against the prose above, which names the wrong form in
    // order to explain it — a guard that cannot tell code from the comment
    // describing it would force the explanation out of the file.
    const bare = /expect\([A-Za-z0-9_.]*\.body\.code\b/;
    expect(bare.test('expect(res.body.code).toBe(1)')).toBe(true);
    expect(bare.test('// the first version read body.code and got undefined')).toBe(false);
    expect(bare.test(source)).toBe(false);
  });

  it('asserts one row and the 1-plus-9 status split', () => {
    const source = readFileSync(INTEGRATION, 'utf8');
    expect(source).toMatch(/toBe\(1\)|toHaveLength\(1\)/);
    expect(source).toContain('201');
    expect(source).toContain('200');
    expect(source).toContain('replayed');
  });
});
