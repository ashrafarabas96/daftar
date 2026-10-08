#!/usr/bin/env python3
"""
Phase 10 red proofs (directive PART 40 — PROOF-OF-PROOF STANDARD).

For each law this pack claims, plant the MINIMAL defect that breaks it, then
require three things of the run, in this order:

  1. the mutation LANDED — the file's bytes changed, verified before the run
     (a replacement that matched nothing would otherwise go green and record a
     missing law as a satisfied one);
  2. the suite turned RED — a non-zero exit code;
  3. the NAMED test failed — the one that is supposed to catch this defect.

A non-empty list of failures names no law. Only (3) does.

ONE GUARD IS DELIBERATELY ABSENT FROM THIS LIST. `distributeBillDiscount`'s
per-line cap (`share.amountMinor < share.capMinor`) cannot be made to fire: when
the discount is below the subtotal every positive-gross line's floor is strictly
below its gross, and the leftover never exceeds the count of such lines. Removing
the cap therefore leaves the suite green, so claiming a red proof for it would be
a false claim. Its unreachability is MEASURED instead, by an exhaustive
enumeration in `test/bill-discount.test.ts`.

Usage, from the repository root:
    python3 phase-preparation/phase10/proofs/red-proofs.py
Exit code 0 means every law is proven to red on its own defect.
"""
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
BASE = ROOT / "phase-preparation" / "phase10"
VITEST = ROOT / "node_modules" / ".bin" / "vitest"
CONFIG = "phase-preparation/phase10/vitest.config.ts"

# (law, file, find, replace, the test title that must fail)
MUTATIONS = [
    (
        "LAW 4 — an even split conserves the total",
        "src/split-bill.ts",
        "shares.push(i < remainder ? base + 1n : base);",
        "shares.push(base);",
        "conserves the total for every total x parts in a wide grid",
    ),
    (
        "LAW 4 — an amount split that does not add up is refused",
        "src/split-bill.ts",
        "if (sum !== totalMinor) {",
        "if (false) {",
        "refuses a one-minor-unit shortfall by code, and reports the difference",
    ),
    (
        "LAW 4 — a line nobody pays for is refused",
        "src/split-bill.ts",
        "if (billIndex === undefined) {",
        "if (false) {",
        "refuses an unassigned line",
    ),
    (
        "bill discount — the apportioned parts sum to the discount",
        "src/bill-discount.ts",
        "if (leftover === 0n) break;",
        "break;",
        "conserves the discount exactly and never exceeds a line gross",
    ),
    (
        "bill discount — a discount above the subtotal is refused, not clamped",
        "src/bill-discount.ts",
        "if (discountTxnMinor > subtotal) {",
        "if (false) {",
        "refuses a discount above the subtotal by code, rather than clamping it",
    ),
    (
        "bill discount — a remainder tie breaks on the lower line index",
        "src/bill-discount.ts",
        "if (a.remainder === b.remainder) return a.index - b.index;",
        "if (a.remainder === b.remainder) return b.index - a.index;",
        "breaks a remainder tie on the lower line index",
    ),
    (
        "LAW 3 — a dish cancelled after cooking began owes a waste movement",
        "src/preparation-state.ts",
        "    case 'preparing':\n    case 'ready':\n      return true;",
        "    case 'preparing':\n    case 'ready':\n      return false;",
        "owes a waste movement once preparation began",
    ),
    (
        "preparation — a step may not be skipped",
        "src/preparation-state.ts",
        "  queued: Object.freeze({ start: 'preparing', cancel: 'cancelled' }),",
        "  queued: Object.freeze({ start: 'preparing', cancel: 'cancelled', finish: 'ready', serve: 'served' }),",
        "refuses skipping a step",
    ),
    (
        "table session — a session that placed orders is not abandoned",
        "src/table-session-state.ts",
        "if (event === 'abandon' && facts.placedLineCount > 0) {",
        "if (false) {",
        "refuses to abandon a session that placed orders",
    ),
    (
        "table session — a session with an unsettled bill does not close",
        "src/table-session-state.ts",
        "if (event === 'settle' && facts.unsettledBillCount > 0) {",
        "if (false) {",
        "refuses to close a session whose bill the SALE authority still reports unsettled",
    ),
    (
        "order to sale — an unpriced modifier never reaches the sale",
        "src/order-to-sale.ts",
        "      if (!modifier.priced) continue;",
        "      if (false) continue;",
        "keeps an unpriced modifier out of the sale entirely",
    ),
    (
        "order to sale — the sale line ceiling is enforced at 200, not 201",
        "src/order-to-sale.ts",
        "if (buckets.size > MAX_SALE_LINES) {",
        "if (buckets.size > MAX_SALE_LINES + 1) {",
        "refuses a bill that aggregates past the sale authority ceiling",
    ),
    (
        "order to sale — a bill of nothing is not committed as a sale",
        "src/order-to-sale.ts",
        "if (buckets.size === 0) {",
        "if (false) {",
        "refuses a bill whose every line is voided",
    ),
    (
        "order to sale — a priced modifier with no catalogue product is refused",
        "src/order-to-sale.ts",
        "      if (modifier.productId === null) {",
        "      if (false) {",
        "refuses a priced modifier with no catalogue product",
    ),
    (
        "§46 — the mode set is pinned at three; PRECONSUMED is not registered",
        "src/stock-effect.ts",
        "export const STOCK_EFFECT_MODES = ['direct', 'service', 'composed'] as const;",
        "export const STOCK_EFFECT_MODES = ['direct', 'service', 'composed', 'preconsumed'] as const;",
        "does not register PRECONSUMED for a future phase",
    ),
    (
        "I-1 — a product claiming two stock-effect modes is refused",
        "src/stock-effect.ts",
        "if (claims > 1) {",
        "if (false) {",
        "refuses a product that claims two modes",
    ),
    (
        "§48 — a duplicated component is refused as a duplicate",
        "src/stock-effect.ts",
        "if (actualByKey.has(k)) {",
        "if (false) {",
        "refuses a DUPLICATE component",
    ),
    (
        "§48 — an extra component is refused",
        "src/stock-effect.ts",
        "if (expectedByKey.has(k)) continue;",
        "if (true) continue;",
        "refuses an EXTRA component nobody asked for",
    ),
    (
        "§48 — a wrong variant is refused as its own case",
        "src/stock-effect.ts",
        "if (expectedProducts.has(movement.componentProductId)) {",
        "if (false) {",
        "refuses a WRONG VARIANT as its own case",
    ),
    (
        "§48 — a missing component is refused, not substituted",
        "src/stock-effect.ts",
        "const got = actualByKey.get(k);",
        "const got = actualByKey.get(k) ?? { ...want };",
        "refuses the MIDDLE component missing, naming it",
    ),
    (
        "§48 — a wrong quantity is refused",
        "src/stock-effect.ts",
        "if (got.quantityQ4 !== want.quantityQ4) {",
        "if (false) {",
        "refuses a WRONG QUANTITY, reporting both figures",
    ),
    (
        "§46 — a service line that moved stock is refused",
        "src/stock-effect.ts",
        "    if (actual.length > 0) {",
        "    if (false) {",
        "refuses a service line that moved stock, by its own code",
    ),
    (
        "§49 — movements against another recipe version are refused",
        "src/stock-effect.ts",
        "movement.recipeVersion !== options.boundRecipeVersion",
        "false",
        "refuses movements recorded against a different recipe version",
    ),
    (
        "§49 — a component that scales to zero is refused, not dropped",
        "src/recipe-version.ts",
        "    if (quantityQ4 <= 0n) {",
        "    if (false) {",
        "refuses a component that scales to zero instead of consuming none of it",
    ),
    (
        "§49 — the division is HALF_EVEN, not half-up",
        "src/recipe-version.ts",
        "  return quotient % 2n === 0n ? quotient : quotient + 1n;",
        "  return quotient + 1n;",
        "divides HALF_EVEN, so a half lands on the even quotient",
    ),
    (
        "§49 — the expansion is returned in a canonical order",
        "src/recipe-version.ts",
        "      if (a.componentProductId !== b.componentProductId) return a.componentProductId < b.componentProductId ? -1 : 1;",
        "      if (a.componentProductId !== b.componentProductId) return a.componentProductId < b.componentProductId ? 1 : -1;",
        "expands deterministically and in a canonical order",
    ),
]


def run_suite() -> tuple[int, str]:
    proc = subprocess.run(
        [str(VITEST), "run", "--config", CONFIG, "--reporter=verbose"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin:/usr/local/bin", "CI": "1", "FORCE_COLOR": "0", "HOME": str(pathlib.Path.home())},
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    if not VITEST.exists():
        print(f"FAIL: no vitest at {VITEST}; run `npm ci` first", file=sys.stderr)
        return 2

    baseline_rc, baseline_out = run_suite()
    if baseline_rc != 0:
        print("FAIL: the unmutated suite is not green, so no red proof below would mean anything")
        print(baseline_out[-4000:])
        return 1
    print(f"ok   baseline — the unmutated suite is green (exit {baseline_rc})")

    backup = pathlib.Path(tempfile.mkdtemp(prefix="p10-redproofs-"))
    shutil.copytree(BASE / "src", backup / "src")
    failures: list[str] = []
    try:
        for law, rel, find, replace, expected_title in MUTATIONS:
            path = BASE / rel
            original = path.read_text()
            mutated = original.replace(find, replace, 1)
            if mutated == original:
                failures.append(f"{law}: the mutation MATCHED NOTHING in {rel} — the proof is vacuous")
                print(f"FAIL {law}\n     the mutation text was not found in {rel}")
                continue
            path.write_text(mutated)
            try:
                rc, out = run_suite()
                if rc == 0:
                    failures.append(f"{law}: the suite stayed GREEN with the defect planted")
                    print(f"FAIL {law}\n     suite exit 0 with the defect planted in {rel}")
                    continue
                if expected_title not in out:
                    failures.append(f"{law}: the suite reddened but never named '{expected_title}'")
                    print(f"FAIL {law}\n     red (exit {rc}) but the expected test title never appeared")
                    continue
                named = [ln.strip() for ln in out.splitlines() if "×" in ln and expected_title in ln]
                if not named:
                    failures.append(f"{law}: '{expected_title}' appears in the output but not as a FAILING case")
                    print(f"FAIL {law}\n     the title appears without a failure marker")
                    continue
                print(f"ok   {law}\n     red (exit {rc}) naming: {named[0][:120]}")
            finally:
                path.write_text(original)
    finally:
        shutil.rmtree(BASE / "src")
        shutil.copytree(backup / "src", BASE / "src")
        shutil.rmtree(backup)

    rc, _ = run_suite()
    if rc != 0:
        print("FAIL: the suite is not green again after restoring the sources")
        return 1
    print(f"ok   restored — the suite is green again (exit {rc})")

    if failures:
        print(f"\nFAIL red-proofs: {len(failures)} of {len(MUTATIONS)} law(s) are not proven")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"\nPASS red-proofs: {len(MUTATIONS)} law(s), each red on its own planted defect, each naming its own case")
    return 0


if __name__ == "__main__":
    sys.exit(main())
