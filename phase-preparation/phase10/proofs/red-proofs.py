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

TWO GUARDS ARE DELIBERATELY ABSENT FROM THIS LIST, AND NEITHER IS COUNTED.

On both, what exists is a BOUNDED ENUMERATION, not a proof. An enumeration over
a finite grid is a LIMITED EXAMINATION: it shows no counterexample inside the
range tried and says nothing about the range outside it. So neither guard is
reclassified as a successful planted-red, neither is included in the law count
this script prints, and the honest reading of each is "no counterexample found
within the stated bounds" rather than "unreachable".

The second is `expandAggregatedSaleLine`'s folded-grain check. Every
contribution's quantity is already on its component's grain (§57), and the fold
refuses two versions that declare different precisions for one component, so a
sum of multiples of one step is a multiple of that step and the check cannot
fire. Removing it leaves the suite green, so claiming a red proof for it would be
a false claim. `test/aggregate-consumption.test.ts` enumerates 8,000 pairs across
all five precisions and finds no counterexample — which is a bounded check, not a
proof — and the guard is kept because it is the invariant the canonical stock
writer will actually test.

The first: `distributeBillDiscount`'s
per-line cap (`share.amountMinor < share.capMinor`) cannot be made to fire: when
the discount is below the subtotal every positive-gross line's floor is strictly
below its gross, and the leftover never exceeds the count of such lines. Removing
the cap therefore leaves the suite green, so claiming a red proof for it would be
a false claim. `test/bill-discount.test.ts` enumerates the shapes instead and
finds no counterexample within the range tried — a bounded check, not a proof.

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
        "!boundKeys.has(`${movement.recipeId}@${movement.recipeVersion}`)",
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
    (
        "§59 — a duplicated lineId is refused, not counted twice",
        "src/split-bill.ts",
        """    if (declared.has(line.lineId)) {""",
        """    if (false) {""",
        "refuses a duplicated lineId in middle position",
    ),
    (
        "§59 — the duplicate refusal names the repeat's own position",
        "src/split-bill.ts",
        """  const declared = new Set<string>();
  for (const [index, line] of lines.entries()) {""",
        """  const declared = new Set<string>();
  for (const [index, line] of [...lines.entries()].reverse()) {""",
        "reports the repeat position, so the caller can see which line it sent twice",
    ),
    (
        "§59 — a negative line total is refused, not aggregated",
        "src/split-bill.ts",
        "    if (line.lineTotalMinor < 0n) {",
        "    if (false) {",
        "refuses a negative lineTotalMinor rather than aggregating it",
    ),
    (
        "§59 — a ZERO line total stays allowed (the refusal is not widened)",
        "src/split-bill.ts",
        "    if (line.lineTotalMinor < 0n) {",
        "    if (line.lineTotalMinor <= 0n) {",
        "still allows a zero line total, which the canonical source allows",
    ),
    (
        "§56 — the recipe version binds only at the start of preparation",
        "src/recipe-binding.ts",
        "  return current === 'queued' && event === 'start';",
        "  return event === 'start' || current === 'ready';",
        "binds on queued/start and on nothing else",
    ),
    (
        "§56 — a bound version is never replaced",
        "src/recipe-binding.ts",
        "  if (existing !== null) {",
        "  if (false) {",
        "refuses to replace a binding a line already carries",
    ),
    (
        "§56 — a later version cannot govern a line already prepared",
        "src/recipe-binding.ts",
        "  if (binding.version !== usedVersion) {",
        "  if (false) {",
        "refuses a later version for every reader, which is the recipe-edited-mid-preparation case",
    ),
    (
        "§56 — an absent binding is refused rather than defaulted",
        "src/recipe-binding.ts",
        "  if (binding === null) {",
        "  if (false) {",
        "refuses an absent binding and a wrong recipe with distinct codes",
    ),
    (
        "§56 — the advisory candidate is offered only while queued",
        "src/recipe-binding.ts",
        "  if (state !== 'queued') return null;",
        "  if (state === 'cancelled') return null;",
        "offers the latest version only while queued",
    ),
    (
        "§57 — a non-canonical component unit is refused, not converted",
        "src/recipe-version.ts",
        "    if (component.recipeUnit !== component.stockUnit) {",
        "    if (false) {",
        "refuses a recipe unit that differs from the stock unit instead of converting it",
    ),
    (
        "§57 — a component that states no unit is refused",
        "src/recipe-version.ts",
        "    if (component.recipeUnit.length === 0 || component.stockUnit.length === 0) {",
        "    if (false) {",
        "refuses a component that states no unit at all",
    ),
    (
        "§57 — the unit check runs at validation, ahead of expansion",
        "src/recipe-version.ts",
        """export function expandRecipe(recipe: RecipeVersion, soldQuantityQ4: bigint): readonly ExpandedComponent[] {
  assertRecipeVersionWellFormed(recipe);""",
        "export function expandRecipe(recipe: RecipeVersion, soldQuantityQ4: bigint): readonly ExpandedComponent[] {",
        "refuses the mismatch at validation, before any expansion computes a quantity",
    ),
    (
        "§57 — a quantity off the component's own grain is refused, not stored",
        "src/recipe-version.ts",
        "    if (quantityQ4 > 0n && !isRepresentableAtPrecision(quantityQ4, component.unitDecimals)) {",
        "    if (false) {",
        "refuses a fractional portion of a dish whose component is counted in whole units",
    ),
    (
        "§57 — the grain is unit_decimals, not Q4 (a Q4-only test would pass anything)",
        "src/recipe-version.ts",
        "  return quantityQ4 % precisionStepQ4(unitDecimals) === 0n;",
        "  return quantityQ4 % 1n === 0n;",
        "reads representability the way inventory_quantity_is_representable does",
    ),
    (
        "§57 — the authored recipe is checked against its own grain too",
        "src/recipe-version.ts",
        "    if (component.quantityQ4 > 0n && !isRepresentableAtPrecision(component.quantityQ4, component.unitDecimals)) {",
        "    if (false) {",
        "refuses a recipe authored finer than its component can be counted",
    ),
    (
        "§57 — a precision outside the inventory authority's 0..4 is refused",
        "src/recipe-version.ts",
        "    if (!Number.isSafeInteger(component.unitDecimals) || component.unitDecimals < 0 || component.unitDecimals > 4) {",
        "    if (false) {",
        "refuses a declared precision the inventory authority does not allow",
    ),
    (
        "§57 — the refusal must not silently round onto the coarser grain instead",
        "src/recipe-version.ts",
        """    const quantityQ4 = halfEvenDiv(component.quantityQ4 * soldQuantityQ4, recipe.yieldQuantityQ4);
    if (quantityQ4 > 0n && !isRepresentableAtPrecision(quantityQ4, component.unitDecimals)) {""",
        """    const quantityQ4 = nearestRepresentableQuantity(halfEvenDiv(component.quantityQ4 * soldQuantityQ4, recipe.yieldQuantityQ4), component.unitDecimals);
    if (false) {""",
        "refuses a fractional portion of a dish whose component is counted in whole units",
    ),
    (
        "\u00a717 — aggregation records every contribution, not one per variant",
        "src/order-to-sale.ts",
        """    bucket.contributions.push(
      Object.freeze({ orderLineId, modifierId, quantityQ4, recipeBinding: recipeBinding === null ? null : Object.freeze({ ...recipeBinding }) }),
    );""",
        """    if (bucket.contributions.length === 0)
      bucket.contributions.push(
        Object.freeze({ orderLineId, modifierId, quantityQ4, recipeBinding: recipeBinding === null ? null : Object.freeze({ ...recipeBinding }) }),
      );""",
        "keeps both bindings on that one sale line, so the provenance survives the merge",
    ),
    (
        "\u00a717 — a contribution keeps its OWN binding, not the first one seen",
        "src/order-to-sale.ts",
        "recipeBinding: recipeBinding === null ? null : Object.freeze({ ...recipeBinding }) }),",
        "recipeBinding: bucket.contributions[0]?.recipeBinding ?? (recipeBinding === null ? null : Object.freeze({ ...recipeBinding })) }),",
        "keeps both bindings on that one sale line, so the provenance survives the merge",
    ),
    (
        "\u00a717 — consumption expands each contribution, not the aggregate quantity",
        "src/aggregate-consumption.ts",
        "    for (const component of expandRecipe(recipe, contribution.quantityQ4)) {",
        "    for (const component of expandRecipe(recipe, draft.quantityQ4)) {",
        "consumes each version its own components and folds the totals",
    ),
    (
        "\u00a717 — the set is folded, so two versions' components add up",
        "src/aggregate-consumption.ts",
        "        existing.quantityQ4 += component.quantityQ4;",
        "        existing.quantityQ4 = component.quantityQ4;",
        "consumes each version its own components and folds the totals",
    ),
    (
        "\u00a717 — a bound version is never substituted when it cannot be read",
        "src/aggregate-consumption.ts",
        "    if (recipe === null) {",
        "    if (false) {",
        "refuses rather than substitutes when a bound version cannot be read",
    ),
    (
        "\u00a717 — the recipe read back must be the version bound to the contribution",
        "src/aggregate-consumption.ts",
        "      assertBindingGoverns('sale_component_mapping', binding, recipe.recipeId, recipe.version);",
        "      void binding;",
        "refuses a recipe read back under a version other than the bound one",
    ),
    (
        "\u00a717 — a composed contribution with no binding is refused",
        "src/aggregate-consumption.ts",
        "    if (contribution.recipeBinding === null) {",
        "    if (false) {",
        "refuses a composed contribution that carries no binding",
    ),
    (
        "\u00a717 — the contributions must account for the billed quantity",
        "src/aggregate-consumption.ts",
        "  if (sum !== draft.quantityQ4) {",
        "  if (false) {",
        "refuses contributions that do not account for the billed quantity",
    ),
    (
        "\u00a717 — two versions disagreeing on a component's precision is refused, not resolved",
        "src/aggregate-consumption.ts",
        "        if (existing.unitDecimals !== declared.unitDecimals) {",
        "        if (false) {",
        "refuses two bound versions that declare different precisions for one component",
    ),
    (
        "\u00a717/\u00a758 — the verifier reads the bound SET, so a single version would reject this line's own movements",
        "src/stock-effect.ts",
        "      if (!boundKeys.has(`${movement.recipeId}@${movement.recipeVersion}`)) {",
        "      if (movement.recipeVersion !== bound[0]?.version) {",
        "accepts movements recorded under either of the line's two versions",
    ),
    (
        "V2 \u00a717 — the bound set is identities, so two recipes at one version stay distinct",
        "src/order-to-sale.ts",
        "    byKey.set(`${binding.recipeId}@${binding.version}`, Object.freeze({ ...binding }));",
        "    byKey.set(String(binding.version), Object.freeze({ ...binding }));",
        "keeps both identities distinct when two recipes share a version number",
    ),
    (
        "V2 \u00a717 — a foreign recipe at the same version number is refused",
        "src/stock-effect.ts",
        "      if (!boundKeys.has(`${movement.recipeId}@${movement.recipeVersion}`)) {",
        "      if (!bound.some((one) => one.version === movement.recipeVersion)) {",
        "refuses a movement from a foreign recipe at the same version number",
    ),
    (
        "V2 \u00a717 — half an identity is refused, not matched on the number",
        "src/stock-effect.ts",
        "      if (movement.recipeId === undefined || movement.recipeVersion === undefined) {",
        "      if (false) {",
        "refuses half an identity rather than matching on the number alone",
    ),
    (
        "PART 7.7 — one order line takes its stock at most once",
        "src/consumption-occasion.ts",
        """      throw new ConsumptionRefusal(
        'restaurant.consumption.occasion_repeated',""",
        """      return 'recorded';
      throw new ConsumptionRefusal(
        'restaurant.consumption.occasion_repeated',""",
        "refuses the waste-then-sell pair that would take one dish out of stock twice",
    ),
    (
        "PART 7.7 — the same command arriving twice is one consumption, not two",
        "src/consumption-occasion.ts",
        "if (existing.commandId === record.commandId && existing.occasion === record.occasion) {",
        "if (false) {",
        "accepts the same command arriving twice as one consumption",
    ),
    (
        "PART 7.7 — a line is charged on the occasion its fate owes, not another",
        "src/consumption-occasion.ts",
        "if (owed !== record.occasion) {",
        "if (false) {",
        "refuses a sold line that tries to take its stock as waste, and the reverse",
    ),
    (
        "PART 7.7 — a fate that owes no movement accepts none",
        "src/consumption-occasion.ts",
        "    if (owed === null) {",
        "    if (false) {",
        "refuses a movement on an occasion the line does not owe",
    ),
    (
        "PART 7.7 — waste is owed from `preparing`, not from `queued`",
        "src/consumption-occasion.ts",
        "return cancellationWastesStock(state) ? 'cancellation_waste' : null;",
        "return 'cancellation_waste';",
        "agrees with the kitchen's own waste boundary on every preparation state",
    ),
    (
        "PART 8 — only the inventory authority moves stock",
        "src/consumption-occasion.ts",
        "if (record.authority !== INVENTORY_AUTHORITY) {",
        "if (false) {",
        "refuses a movement made by anyone but the inventory authority",
    ),
    (
        "PART 8 — a rejected writer does not occupy the line's one slot",
        "src/consumption-occasion.ts",
        "  record(fate: OrderLineFate, record: ConsumptionRecord): RecordOutcome {",
        """  record(fate: OrderLineFate, record: ConsumptionRecord): RecordOutcome {
    this.entries.set(record.orderLineId, Object.freeze({ occasion: record.occasion, commandId: record.commandId, movementCount: record.movementCount }));""",
        "does not let a foreign writer's record occupy the line's one slot",
    ),
    (
        "PART 8 — a valuation is refused AS a valuation, not as an unknown field",
        "src/consumption-occasion.ts",
        "  if (valuation.length > 0) {",
        "  if (false) {",
        "refuses every valuation spelling, including ones no list anticipated",
    ),
    (
        "PART 7.7 — a refund of a composed line restocks nothing",
        "src/consumption-occasion.ts",
        "  if (requestedReturnMovementCount > 0) {",
        "  if (false) {",
        "refuses a return movement for a composed line",
    ),
    (
        "P1-01 — a modifier is scaled HALF_EVEN, not truncated toward zero",
        "src/order-to-sale.ts",
        "const scaledQuantityQ4 = halfEvenDiv(modifier.quantityQ4 * line.quantityQ4, QUANTITY_SCALE);",
        "const scaledQuantityQ4 = (modifier.quantityQ4 * line.quantityQ4) / QUANTITY_SCALE;",
        "rounds HALF_EVEN rather than truncating a billed quantity toward zero",
    ),
    (
        "P1-01 — the multiplication happens at all",
        "src/order-to-sale.ts",
        "const scaledQuantityQ4 = halfEvenDiv(modifier.quantityQ4 * line.quantityQ4, QUANTITY_SCALE);",
        "const scaledQuantityQ4 = line.quantityQ4;",
        "never silently loses a step across a grid of line and modifier quantities",
    ),
    (
        "P1-01 — a modifier that scales away is named as the modifier, not the line",
        "src/order-to-sale.ts",
        "      if (scaledQuantityQ4 <= 0n) {",
        "      if (false) {",
        "refuses a modifier that scales away, and names the MODIFIER rather than the line",
    ),
    (
        "P2-03 — the identity law applies to a movement that names neither half",
        "src/stock-effect.ts",
        "    if (bound !== undefined && boundKeys !== null) {",
        "    if (bound !== undefined && boundKeys !== null && (movement.recipeVersion !== undefined || movement.recipeId !== undefined)) {",
        "refuses a movement that names NEITHER half of a recipe identity",
    ),
    (
        "P2-03 — an empty bound set refuses rather than disabling the law",
        "src/stock-effect.ts",
        "  if (bound !== undefined && bound.length === 0 && actual.length > 0) {",
        "  if (false) {",
        "refuses an EMPTY bound set rather than letting it disable the law",
    ),
    (
        "P2-04 — a direct line is held to the stock product's own grain",
        "src/stock-effect.ts",
        "    if (!isRepresentableAtPrecision(soldQuantityQ4, unitDecimals)) {",
        "    if (false) {",
        "refuses a half bottle on a whole-counted product, naming the nearest representable quantity",
    ),
    (
        "P2-04 — a stock-tracked product without a usable grain is refused",
        "src/stock-effect.ts",
        "    if (unitDecimals === null || !Number.isInteger(unitDecimals) || unitDecimals < 0 || unitDecimals > 4) {",
        "    if (false) {",
        "refuses a stock-tracked product that declares no usable precision at all",
    ),
    (
        "P2-05 — waste is expanded at the cancelled quantity, from the bound version",
        "src/waste-expansion.ts",
        "  return expandRecipe(recipe, line.quantityQ4);",
        "  return expandRecipe(recipe, line.quantityQ4 * 2n);",
        "expands the whole bound recipe at the cancelled quantity",
    ),
    (
        "P2-05 — a waste set is refused where no waste is owed",
        "src/waste-expansion.ts",
        "  if (!cancellationWastesStock(line.stateAtCancellation)) {",
        "  if (false) {",
        "owes a set in exactly the states the kitchen says waste from",
    ),
    (
        "P2-05 — a composed cancellation with nothing bound is refused, never guessed",
        "src/waste-expansion.ts",
        "  if (binding === null) {",
        "  if (false) {",
        "refuses a composed line cancelled mid-preparation with nothing bound",
    ),
    (
        "P2-05 — a bound version that cannot be read is never substituted",
        "src/waste-expansion.ts",
        "  if (recipe === null) {",
        "  if (false) {",
        "never substitutes a version it cannot read",
    ),
    (
        "P2-05 — the waste obligation separates a queued void from a started one",
        "src/waste-expansion.ts",
        "  return Object.freeze(lines.filter((line) => line.mode !== 'service' && cancellationWastesStock(line.stateAtCancellation)));",
        "  return Object.freeze(lines.filter((line) => line.mode !== 'service'));",
        "separates a line voided while queued from one voided after the cook started",
    ),
    (
        "P3-07 — the record contract is an ALLOW-list, so an unanticipated valuation spelling is refused",
        "src/consumption-occasion.ts",
        "  const unexpected = Object.keys(record).filter((k) => !CONSUMPTION_RECORD_KEYS.includes(k));",
        "  const unexpected = Object.keys(record).filter((k) => ['costMinor', 'valueMinor'].includes(k));",
        "refuses every valuation spelling, including ones no list anticipated",
    ),
    (
        "P3-07 — the allow-list itself is pinned, and cannot be shortened unnoticed",
        "src/consumption-occasion.ts",
        "export const CONSUMPTION_RECORD_KEYS: readonly string[] = Object.freeze(['orderLineId', 'occasion', 'commandId', 'authority', 'movementCount']);",
        "export const CONSUMPTION_RECORD_KEYS: readonly string[] = Object.freeze(['orderLineId', 'occasion', 'commandId', 'authority']);",
        "names the five fields a record may carry, and no more",
    ),
    (
        "P3-07 — an undefined field is refused rather than ignored",
        "src/consumption-occasion.ts",
        "  if (unexpected.length === 0) return;",
        "  if (unexpected.length >= 0) return;",
        "refuses a field the contract does not define, even when it is not a valuation",
    ),
    (
        "P3-08 — a replay must match the OCCASION as well as the command",
        "src/consumption-occasion.ts",
        "      if (existing.commandId === record.commandId && existing.occasion === record.occasion) {",
        "      if (existing.commandId === record.commandId) {",
        "refuses the same command re-presented under a DIFFERENT fate, which is a real double take",
    ),
    (
        "P3-09 — the scaled modifier quantity reaches the grain check unrounded by truncation",
        "src/order-to-sale.ts",
        "const scaledQuantityQ4 = halfEvenDiv(modifier.quantityQ4 * line.quantityQ4, QUANTITY_SCALE);",
        "const scaledQuantityQ4 = (modifier.quantityQ4 * line.quantityQ4) / QUANTITY_SCALE;",
        "carries a HALF_EVEN rounding result into the grain check, not a truncated one",
    ),
    (
        "P3-09 — the grain check still fires on a quantity that came through aggregation",
        "src/stock-effect.ts",
        "    if (!isRepresentableAtPrecision(soldQuantityQ4, unitDecimals)) {",
        "    if (false) {",
        "lets a fractional modifier through aggregation and refuses it at the stock grain, before service",
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


LAWS_BEGIN = "<!-- RED-PROOF-LAWS:BEGIN (generated by proofs/red-proofs.py --list; do not edit by hand) -->"
LAWS_END = "<!-- RED-PROOF-LAWS:END -->"


def law_block() -> str:
    """The law register is the MUTATION TABLE ABOVE, never a prose copy of it.

    The independent challenge at `b40f05c` found the evidence record still
    enumerating 26 laws while the code ran 56: a hand-kept list beside a growing
    table drifts the moment someone adds a law and forgets the prose. So the
    list is printed from the table, and `--check-doc` fails when a document's
    copy has gone stale.
    """
    lines = [LAWS_BEGIN, "", f"The **{len(MUTATIONS)}** laws proven to red, each by its own planted defect:", ""]
    for n, (law, rel, _find, _replace, title) in enumerate(MUTATIONS, start=1):
        lines.append(f"{n}. {law} — planted in `{rel}`, caught by *{title}*")
    lines += ["", LAWS_END]
    return "\n".join(lines)


def check_doc(path: pathlib.Path) -> int:
    have = path.read_text()
    if LAWS_BEGIN not in have or LAWS_END not in have:
        print(f"FAIL: {path} carries no generated law block", file=sys.stderr)
        return 1
    block = have[have.index(LAWS_BEGIN) : have.index(LAWS_END) + len(LAWS_END)]
    if block.strip() != law_block().strip():
        print(f"FAIL: the law list in {path.name} has drifted from the mutation table")
        return 1
    print(f"ok   the law list in {path.name} matches the {len(MUTATIONS)} mutations in the table")
    return 0


def main() -> int:
    if "--list" in sys.argv:
        print(law_block())
        return 0
    if "--check-doc" in sys.argv:
        return check_doc(pathlib.Path(sys.argv[sys.argv.index("--check-doc") + 1]))
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
