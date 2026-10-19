/**
 * ROUND 49 — the law's own bytes, pinned OUTSIDE the law.
 *
 * THE COORDINATOR'S RULING ON CD-48-01 (P1, a one-path fail-open), and it is a
 * ruling about when to stop: *stop adding audits around audits*.
 *
 * The history is four rounds long and it is one shape. F-73 bounded the lines
 * a scan entered; CD-44-01 and CD-46-01 bounded the characters it read; F-76
 * bounded the documents it was given; CD-47-01 bounded the text it was handed
 * against disk; F-77 moved the audit out of the function it audited. Each fix
 * was right and each one left the next layer out unbounded, because every one
 * of them was still a check written INSIDE the thing it checks. CD-48-01 is
 * the last layer there is: the CALLER decides whether the audit runs at all.
 * Measured, each as a single edit to the caller loop with an un-isolated
 * command planted in a document, each giving 23 passed:
 *
 *   (a) record the label and `continue` before the scan;
 *   (b) wrap the scan in a `try`/`catch` that swallows a throw;
 *   (c) filter the scan's own offences before pushing them.
 *
 * (a) and (b) are closed structurally -- the auditor records the label itself
 * now, so a label nobody audited is a label nobody recorded. (c) is not, and
 * no further audit can close it: whoever calls the audit can always discard
 * what it returns, and an audit written to catch that would itself be called
 * by someone.
 *
 * So the regress stops somewhere that is not a check at all: THE BYTES.
 * `tools/law-bytes.json` holds a sha256 for each file the law is written in,
 * and that pin lives OUTSIDE those files. Any edit to the law -- in any path,
 * in any function, on any line, whether it skips, swallows, filters or
 * rewrites -- changes those bytes and is refused BY NAME. The edit does not
 * have to be understood, classified or anticipated. It only has to exist.
 *
 * WHY THIS FILE IS SEPARATE, and why the duplication in it is deliberate.
 * This reader shares NO CODE with the law: its own `readFileSync`, its own
 * `createHash`, its own comparison. If it imported a helper from the law, an
 * edit to that helper would move both the subject and the instrument together,
 * which is F-73 (B) and CD-47-01 again. The two files PIN EACH OTHER through
 * the same JSON: deleting this file reds in the law, deleting the law's arm
 * changes the law's bytes and reds here, and dropping an entry from the pin
 * reds in both because each checks the pinned SET as well as the digests.
 *
 * THE DECLARED LIMIT, and it is one sentence: an edit to the law AND to its
 * external pin together passes, and is bounded only by review of the diff,
 * where it is a changed digest sitting beside the change it licenses -- EXCEPT
 * where the same edit also stops this reader from being collected, which one
 * edit to `package.json`'s test script does: then no digest changes and the
 * diff shows that one file alone (R51-F1, measured). That is
 * the whole of it. There is no further instrument to add, and the next round
 * of this class is a reviewer reading two lines rather than a seventh audit.
 *
 * Updating the pin is therefore a DELIBERATE ACT with a visible diff line, and
 * that is the feature. A round that changes the law changes one digest here,
 * in the same commit, with the reason in the commit message.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The refusal, by name, so a deletion arm can read it rather than an exit code. */
const LAW_BYTES_MOVED = 'LAW-BYTES-MOVED';

/** This package's root, from this file, without asking the law where it is. */
const ROOT = dirname(__dirname);

/** The pin: paths relative to the package root, each to a sha256 of its bytes. */
const PIN = join(ROOT, 'tools', 'law-bytes.json');

/**
 * The files the law is written in AND the files that decide whether it runs.
 * Written out HERE as well as in the pin, so
 * that dropping an entry from the pin is a disagreement rather than a smaller
 * obligation -- an expectation the subject can shrink is no expectation, which
 * is F-76's lesson about named exemptions in a new place.
 */
const LAW_FILES = [
  // The law itself, and this reader.
  'test/tool-commands-are-isolated.test.ts',
  'test/law-bytes-are-pinned.test.ts',
  // ROUND 50, the coordinator's CD-49-01 (P1): round 49 pinned the law's
  // BYTES and nothing about whether the law RUNS. One line in the vitest
  // config, or one flag in the test script, left the law uncollected with a
  // green suite and an untouched pin. So the pin covers every file that
  // decides COLLECTION or EXECUTION, and the separate step `tools/law-ran.py`
  // (an npm script of its own, outside the suite) refuses by name when the
  // law's own cases did not run.
  'vitest.config.ts',
  'package.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'tools/law-ran.py',
  // R48-F3: everything the law reads as CONFIGURATION, because an enrolment
  // line here exempted a document from the law entirely and looked like
  // routine bookkeeping while doing it.
  'tools/reviewer-reports.json',
  // R49-S1 (P3), THE CHALLENGER'S: this was the one file of that class left
  // out. `tools/pack-set.json` names the author-owned pack documents the gate
  // measures, so an unpinned edit to it changes the gate's SUBJECT SET. The
  // challenger could not measure a hide through it -- adding a plant's name
  // removes the set refusal and the scan then catches the plant on its own,
  // 1 failed | 302 passed -- so it is pinned for the class, not for a hole.
  'tools/pack-set.json',
  // And the tools the law EXECUTES: an edit to one of these changes what the
  // law measures without touching the law.
  'tools/manifest-digests.py',
  'tools/status-block.py',
  'tools/context-sites.py',
  'tools/seal-check-run.py',
];

describe('the law is written in bytes that something outside it pins', () => {
  it('refuses by name when any file the law lives in has moved', () => {
    const pinned = JSON.parse(readFileSync(PIN, 'utf8')) as { pinned?: Record<string, string> };
    const table = pinned.pinned ?? {};

    // The SET first. A pin that names fewer files than the law is written in
    // has quietly stopped covering one of them, and a pin that names more has
    // a row nothing checks.
    expect(Object.keys(table).sort(), `${LAW_BYTES_MOVED}: the pin does not name exactly the files the law is written in`).toStrictEqual([...LAW_FILES].sort());

    // Then the bytes, each file named in its own refusal so a reader is told
    // WHICH file moved rather than that something did.
    const moved: string[] = [];
    for (const relative of LAW_FILES) {
      const digest = createHash('sha256')
        .update(readFileSync(join(ROOT, relative)))
        .digest('hex');
      if (digest !== table[relative]) moved.push(`${relative}: ${digest} is not the pinned ${table[relative] ?? '<no row>'}`);
    }
    expect(
      moved,
      `${LAW_BYTES_MOVED}: a file the law is written in does not match its external pin. If the change is intended, update tools/law-bytes.json in the SAME commit and say why in the message — that digest line is the record that the edit was meant`,
    ).toStrictEqual([]);

    // And the instrument is measured rather than trusted: a digest this reader
    // computes must actually depend on the bytes it reads. A hasher that
    // returned a constant would pass everything above.
    const ofLaw = createHash('sha256')
      .update(readFileSync(join(ROOT, LAW_FILES[0] ?? '')))
      .digest('hex');
    const ofSelf = createHash('sha256')
      .update(readFileSync(join(ROOT, LAW_FILES[1] ?? '')))
      .digest('hex');
    expect(ofLaw, 'the two files hash the same, so this reader is not hashing what it reads').not.toBe(ofSelf);
    expect(ofLaw, 'a sha256 is 64 hex characters; this is not one').toMatch(/^[0-9a-f]{64}$/);
    // And it is SHA-256 and not some other 64-hex digest, against the known
    // answer for a one-byte input, so the pin and this reader cannot be
    // computing two different functions of the same bytes.
    expect(
      createHash('sha256').update('a').digest('hex'),
      'this hasher does not compute sha256, so the digests above are a different function of the bytes than the pin records',
    ).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  });
});
