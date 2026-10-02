/**
 * THE PHASE 3 MERCHANT ROUTES AND COMMAND FLOWS, driven the way a merchant
 * drives them: through the menu, the buttons and the keyboard.
 *
 * The twelve P3-S7 routes and the header are all visited:
 *   /stock  /stock/move  /stock/count  /stock/count/[id]  /stock/adjust
 *   /purchases  /purchases/receive  /purchases/[id]  /purchases/[id]/return
 *   /suppliers  /suppliers/[id]  /suppliers/[id]/pay
 * and every critical command runs to its success state: receive, receive and
 * pay, supplier return, supplier payment, damage adjustment, transfer,
 * stocktake (with its confirmation), undo receipt (with its confirmation) and
 * starting stock. Loading, error and empty states are shown and used.
 */
import type { Locator } from 'playwright-core';
import { tabUntil } from './invariants';
import type { Run } from './run-context';

/**
 * PHASE OWNERSHIP OF THE BROWSER STEPS (P4-AL-63).
 *
 * `scripts/phase3-corrective-gate.ts` ran the browser matrix with no
 * `--steps`, so it walked every step that existed. That is harmless while
 * every step is Phase 3's and wrong the moment one is not: a defect on a
 * Phase 4 screen would turn an already-ACCEPTED Phase 3 gate red — a
 * predecessor's gate failing on its successor's work. The fix is ownership,
 * not a looser assertion. Each phase's gate walks the steps that phase owns;
 * the Phase 3 matrix still performs all nine ar/en/tr x 360/768/1280 runs and
 * its equality across them is untouched (OD-P4-11 OPTION A). What changed is
 * WHICH steps it walks, not how many runs it makes.
 *
 * The two lists below are a PARTITION of the steps `runFlows` declares, not
 * two loose lists: every declared step belongs to exactly one of them, and a
 * step added to this file and left out of both is a problem
 * `stepOwnershipProblems` names, so a new step is never silently unwalked.
 * `scripts/phase4-s1-gate.ts` checks the same partition over the source, and
 * `tests/guards/phase4-browser-step-ownership.test.ts` plants each way of
 * breaking it and asserts the refusal.
 */
export const PHASE3_STEPS: readonly string[] = [
  'login',
  'header',
  'stock',
  'move',
  'count',
  'adjust',
  'purchases',
  'receive',
  'receive-pay',
  'return',
  'undo-receipt',
  'suppliers',
  'pay',
  'states',
  'starting-stock',
];

/**
 * The Phase 4 steps. P4-S3 opened this list with the POS screens; every entry
 * is `p4-`-prefixed and absent from PHASE3_STEPS, so the accepted Phase 3
 * gate — pinned to PHASE3_STEPS — never walks a Phase 4 screen and a defect on
 * one can never turn it red. A `run.step` name this list does not hold turns
 * the ownership test and the P4-S1 gate red.
 */
export const PHASE4_STEPS: readonly string[] = ['p4-pos-till', 'p4-pos-sale', 'p4-pos-discount', 'p4-pos-close'];

/**
 * The prefix every Phase 4 step name carries, so a Phase 4 step can never
 * collide with a Phase 3 one (P4-AL-68 — this file already has a step named
 * `return`). `scripts/phase4-s1-gate.ts` holds the same literal and the
 * ownership test pins the two together.
 */
export const PHASE4_STEP_PREFIX = 'p4-';

/** Every step that exists, Phase 3's then Phase 4's. */
export const ALL_BROWSER_STEPS: readonly string[] = [...PHASE3_STEPS, ...PHASE4_STEPS];

/**
 * What is wrong with the partition, empty when nothing is. `declared` is the
 * step names this file declares, in declaration order; pass
 * `ALL_BROWSER_STEPS` to check only the lists against each other.
 */
export function stepOwnershipProblems(declared: readonly string[]): string[] {
  const problems: string[] = [];
  const tally = (names: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    return counts;
  };
  for (const [list, names] of [
    ['PHASE3_STEPS', PHASE3_STEPS],
    ['PHASE4_STEPS', PHASE4_STEPS],
  ] as const)
    for (const [name, n] of tally(names)) if (n > 1) problems.push(`${list} names the step "${name}" ${n} times`);
  for (const name of PHASE3_STEPS)
    if (PHASE4_STEPS.includes(name)) problems.push(`the step "${name}" is owned by both PHASE3_STEPS and PHASE4_STEPS — a step is owned by exactly one phase`);
  for (const name of PHASE4_STEPS)
    if (!name.startsWith(PHASE4_STEP_PREFIX))
      problems.push(`the Phase 4 step "${name}" is not ${PHASE4_STEP_PREFIX}-prefixed, so it can collide with a Phase 3 step name (P4-AL-68)`);
  const owned = new Set(ALL_BROWSER_STEPS);
  for (const [name, n] of tally(declared)) {
    if (!owned.has(name))
      problems.push(
        `the step "${name}" is declared in tests/browser/flows.ts but is owned by neither PHASE3_STEPS nor PHASE4_STEPS — an unowned step is walked by no phase gate`,
      );
    if (n > 1) problems.push(`the step "${name}" is declared ${n} times — a step name is run once and names its own evidence (P4-AL-68)`);
  }
  const seen = new Set(declared);
  if (declared.length > 0)
    for (const name of owned)
      if (!seen.has(name)) problems.push(`the step "${name}" is owned by a phase list but tests/browser/flows.ts declares no such step`);
  return problems;
}

// The lists themselves, checked as this module loads: a malformed partition is
// never a browser run that quietly walks the wrong set. The declared half of
// the partition is checked over the source by the ownership test and the
// P4-S1 gate, which can see the declarations this module cannot.
{
  const broken = stepOwnershipProblems(ALL_BROWSER_STEPS);
  if (broken.length > 0) throw new Error(`tests/browser/flows.ts step ownership: ${broken.join('; ')}`);
}

const UUID_PATH = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** True when the element is fully inside the viewport, its own text not cut. */
async function fullyVisible(run: Run, target: Locator, what: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  const vp = run.page.viewportSize();
  if (box === null || vp === null) throw new Error(`${what} has no box`);
  if (box.x < -1 || box.y < -1 || box.x + box.width > vp.width + 1 || box.y + box.height > vp.height + 1)
    run.fail(
      'confirmation',
      `${what} is not fully on screen: [${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}] in ${vp.width}x${vp.height}`,
    );
}

/** Keyboard: Tab from the top of the page reaches `label` (a button), and Enter presses it. */
async function tabToButton(run: Run, label: string): Promise<void> {
  const presses = await tabUntil(run.page, `(a) => a.tagName === 'BUTTON' && (a.textContent || '').trim() === ${JSON.stringify(label)}`);
  if (presses === null) {
    run.fail('keyboard', `Tab never reached the "${label}" button`);
    throw new Error(`keyboard: "${label}" unreachable`);
  }
  await run.page.keyboard.press('Enter');
}

/** Keyboard: Tab reaches a list row containing `text`, and Enter opens it. */
async function tabToRow(run: Run, text: string): Promise<void> {
  const presses = await tabUntil(
    run.page,
    `(a) => a.getAttribute('role') === 'button' && !!a.closest('main li') && (a.textContent || '').includes(${JSON.stringify(text)})`,
  );
  if (presses === null) {
    run.fail('keyboard', `Tab never reached a row with "${text}"`);
    throw new Error(`keyboard: row "${text}" unreachable`);
  }
  await run.page.keyboard.press('Enter');
}

/** Open a section from the header, through the menu button where the viewport collapses it. */
async function nav(run: Run, key: 'stock' | 'purchases' | 'suppliers'): Promise<void> {
  const toggle = run.page.getByRole('button', { name: run.T('nav.menu'), exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await run.page.getByRole('link', { name: run.T(`nav.${key}`), exact: true }).click();
  await run.page.waitForURL(new RegExp(`/${run.locale}/${key}$`));
}

/** Open the POS screens from the header, through the menu button where the viewport collapses it. */
async function posNav(run: Run): Promise<void> {
  const toggle = run.page.getByRole('button', { name: run.T('nav.menu'), exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await run.page.getByRole('link', { name: run.T('nav.pos'), exact: true }).click();
  await run.page.waitForURL(new RegExp(`/${run.locale}/pos$`));
}

/** Add a found item to the basket from the search results. */
async function addFound(run: Run, name: string): Promise<void> {
  await run
    .row(name)
    .getByRole('button', { name: run.T('common.add'), exact: true })
    .click();
}

/** Wait until the basket holds exactly `n` lines, by the quantity fields the screen shows. */
async function basketLines(run: Run, n: number): Promise<void> {
  const fields = run.page.getByLabel(run.T('pos.basket.quantity'), { exact: true });
  for (let i = 0; i < 40; i += 1) {
    if ((await fields.count()) === n) return;
    await run.page.waitForTimeout(250);
  }
  run.fail('flow', `the basket shows ${await fields.count()} line(s), expected ${n}`);
  throw new Error(`basket lines: expected ${n}`);
}

/**
 * The text of one amount the screen shows, by the label beside it — read
 * BACK from the page, never computed here. The amounts are the server's, so a
 * step can only compare what it read before with what it reads after.
 */
async function amountShown(run: Run, key: string): Promise<string> {
  const label = run.page.getByText(run.T(key), { exact: true }).first();
  await label.waitFor();
  return (await label.locator('xpath=following-sibling::span[1]').innerText()).trim();
}

async function startingStockOffered(run: Run): Promise<boolean> {
  await run.page.getByRole('radiogroup', { name: run.T('stock.adjust.why') }).waitFor();
  return (await run.page.getByRole('radio', { name: new RegExp(`^${escapeRe(run.T('stock.adjust.reason.starting'))}`) }).count()) > 0;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * TD-20: once the business's single opening is posted, "Starting stock" is
 * not offered, and the screen says plainly why and what to use instead.
 */
async function assertStartingStockClosed(run: Run, where: string): Promise<void> {
  if (await startingStockOffered(run))
    run.fail('flow', `${where}: "Starting stock" is offered although the business's opening is already recorded (the server can only refuse it)`);
  const explained = await run.page.getByText(run.T('stock.adjust.startingRecorded')).count();
  if (explained === 0) run.fail('flow', `${where}: the screen does not explain that starting stock was already recorded`);
}

export async function runFlows(run: Run): Promise<void> {
  const { page, names, seed } = run;
  const T = run.T.bind(run);

  await run.step('login', async () => {
    await run.login();
  });

  // The header at this width: the menu button by keyboard below the lg breakpoint, the business switcher.
  await run.step('header', async () => {
    const toggle = run.button(T('nav.menu'));
    const navEl = page.locator('#daftar-app-nav');
    await run.shot('header');
    const collapsed = run.viewport.width < 1024;
    if (collapsed !== (await toggle.isVisible())) run.fail('menu', `menu button visible=${!collapsed} expected at ${run.viewport.width}px`);
    if (collapsed) {
      if (await navEl.isVisible()) run.fail('menu', 'the collapsed nav is visible before the menu is opened');
      await toggle.focus();
      await page.keyboard.press('Enter');
      if ((await toggle.getAttribute('aria-expanded')) !== 'true' || !(await navEl.isVisible()))
        run.fail('menu', 'Enter on the menu button did not open the nav');
      await page.getByRole('link', { name: T('nav.suppliers'), exact: true }).waitFor();
      await run.shot('header-menu-open');
      await page.keyboard.press('Escape');
      const focusBack: unknown = await page.evaluate(`document.activeElement ? document.activeElement.id : ''`);
      if ((await toggle.getAttribute('aria-expanded')) !== 'false' || (await navEl.isVisible()) || focusBack !== 'daftar-app-nav-toggle')
        run.fail('menu', 'Escape did not close the menu and return focus to its button');
    } else if (!(await navEl.isVisible())) run.fail('menu', 'the nav is not visible on a wide screen');
    // The business switcher: a menu whose items are on screen and usable.
    const switcher = run.button(names.business);
    await switcher.click();
    const item = page.getByRole('menuitem').filter({ hasText: seed.starter[run.viewport.name]?.name ?? '' });
    await item.waitFor();
    await fullyVisible(run, item, 'the business switcher item');
    await run.shot('header-business-menu');
    await page.keyboard.press('Escape');
    if (await item.isVisible()) {
      run.fail('menu', 'Escape did not close the business menu');
      await switcher.click();
    }
  });

  await run.step('stock', async () => {
    await nav(run, 'stock');
    await run.field(T('common.warehouse')).selectOption({ label: seed.mainWarehouse });
    await run.row(names.rice).waitFor();
    await run.shot('stock');
    await run.field(T('common.search')).fill(names.riceSearch);
    await run.field(T('stock.levels.show')).selectOption({ label: T('stock.levels.inStock') });
    await page.waitForTimeout(800);
    await run.row(names.rice).waitFor();
    await run.shot('stock-filtered');
    await tabToButton(run, T('stock.move.title'));
    await page.waitForURL(/\/stock\/move$/);
  });

  await run.step('move', async () => {
    await run.text('stock.move.title');
    await run.field(T('stock.move.from')).selectOption({ label: seed.mainWarehouse });
    await run.field(T('stock.move.to')).selectOption({ label: seed.secondWarehouse });
    await run.field(T('stock.picker.search')).fill(names.riceSearch);
    await run
      .row(names.rice)
      .getByRole('button', { name: T('common.add') })
      .click();
    await run.field(T('stock.move.quantity')).fill('2');
    await run.shot('move');
    await tabToButton(run, T('stock.move.submit'));
    await run.text('stock.move.done', { from: seed.mainWarehouse, to: seed.secondWarehouse });
    await run.shot('move-done');
    await run.button(T('stock.common.backToStock')).click();
    await page.waitForURL(/\/stock$/);
  });

  await run.step('count', async () => {
    await run.button(T('stock.count.title')).click();
    await page.waitForURL(/\/stock\/count$/);
    await run.field(T('common.warehouse')).selectOption({ label: seed.secondWarehouse });
    await page.getByRole('button', { name: new RegExp(`^(${escapeRe(T('stock.count.continue'))}|${escapeRe(T('stock.count.start'))})$`) }).waitFor();
    await page.waitForTimeout(600);
    await run.shot('count-list');
    const cont = run.button(T('stock.count.continue'));
    if ((await cont.count()) > 0) await tabToButton(run, T('stock.count.continue'));
    else await tabToButton(run, T('stock.count.start'));
    await page.waitForURL(new RegExp(`/stock/count/${UUID_PATH}$`));
    await run.text('stock.count.addItems');
    await run.field(T('stock.picker.search')).fill(names.riceSearch);
    await run
      .row(names.rice)
      .getByRole('button', { name: T('common.add') })
      .click();
    await run.field(T('stock.count.counted')).first().fill('7');
    await run.button(T('stock.count.save')).click();
    await run.text('stock.count.saved');
    await run.shot('count-sheet');
    await run.button(T('stock.count.finish')).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const confirm = dialog.getByRole('button', { name: T('stock.count.finish'), exact: true });
    await fullyVisible(run, confirm, 'the "Finish the count" confirmation');
    await fullyVisible(run, dialog.getByText(T('stock.count.finishHint')), 'the finish warning');
    await run.shot('count-finish-confirm');
    await confirm.click();
    await run.text('stock.count.finished');
    await run.shot('count-finished');
  });

  await run.step('adjust', async () => {
    await nav(run, 'stock');
    await run.button(T('stock.adjust.title')).click();
    await page.waitForURL(/\/stock\/adjust$/);
    await assertStartingStockClosed(run, 'a business whose opening is posted');
    await page.getByText(T('stock.adjust.reason.damaged'), { exact: true }).click();
    await run.field(T('common.warehouse')).selectOption({ label: seed.mainWarehouse });
    await run
      .field(T('stock.adjust.noteOptional'))
      .fill(run.locale === 'ar' ? 'زجاجة مكسورة أثناء الترتيب' : run.locale === 'tr' ? 'Rafa dizerken şişe kırıldı' : 'Bottle broke while shelving');
    await run.field(T('stock.picker.search')).fill(names.oilSearch);
    await run
      .row(names.oil)
      .getByRole('button', { name: T('common.add') })
      .click();
    await run.field(T('stock.adjust.quantityLess')).fill('1');
    await run.shot('adjust');
    await tabToButton(run, T('stock.adjust.submit'));
    await run.text('stock.adjust.done');
    await run.shot('adjust-done');
  });

  await run.step('purchases', async () => {
    await nav(run, 'purchases');
    await run.row(names.supplierA).waitFor();
    await run.shot('purchases');
    await run.field(T('stock.levels.show')).selectOption({ label: T('purchasing.list.filter.received') });
    await page.waitForTimeout(800);
    await run.row(names.supplierA).waitFor();
    await run.shot('purchases-received');
    await tabToRow(run, 'INV-2090');
    await page.waitForURL(new RegExp(`/purchases/${UUID_PATH}$`));
    await run.button(T('common.back')).waitFor();
    // TD-16: an ordinary purchase with a payable amount offers Pay, never the leftover close.
    if ((await run.button(T('purchasing.detail.leftoverClose')).count()) > 0)
      run.fail('flow', 'the leftover close is offered on a purchase whose amount can be paid');
    await run.shot('purchase-detail');
  });

  await run.step('receive', async () => {
    await nav(run, 'purchases');
    await tabToButton(run, T('purchasing.receive.title'));
    await page.waitForURL(/\/purchases\/receive$/);
    await run.field(T('purchasing.receive.supplier')).fill(names.supplierASearch);
    await run.row(names.supplierA).waitFor();
    await page.keyboard.press('Tab');
    const focused = await page.evaluate('document.activeElement ? document.activeElement.textContent : ""');
    if (typeof focused !== 'string' || !focused.includes(names.supplierA)) run.fail('keyboard', 'Tab from the supplier search did not reach the supplier row');
    await page.keyboard.press('Enter');
    await run.field(T('common.warehouse')).selectOption({ label: seed.mainWarehouse });
    await run.field(T('common.item')).fill(names.riceSearch);
    await run.row(names.rice).click();
    await run.field(T('common.quantity')).fill('8');
    await run.field(T('purchasing.receive.unitPrice', { currency: seed.currency })).fill('31.50');
    await run.field(`${T('purchasing.receive.supplierReference')} (${T('common.optional')})`).fill(`INV-${run.tag}`);
    await run.shot('receive');
    await tabToButton(run, T('common.review'));
    await run.text('purchasing.receive.reviewTitle');
    await run.shot('receive-review');
    await run.button(T('purchasing.receive.receive')).click();
    await run.text('purchasing.receive.received');
    await run.shot('receive-done');
  });

  await run.step('receive-pay', async () => {
    await run.button(T('purchasing.receive.another')).click();
    await run.field(T('purchasing.receive.supplier')).fill(names.supplierBSearch);
    await run.row(names.supplierB).click();
    await run.field(T('common.warehouse')).selectOption({ label: seed.mainWarehouse });
    await run.field(T('common.item')).fill(names.teaSearch);
    await run.row(names.tea).click();
    await run.field(T('common.quantity')).fill('4');
    await run.field(T('purchasing.receive.unitPrice', { currency: seed.currency })).fill('7.10');
    await run.button(T('common.review')).click();
    await run.text('purchasing.receive.reviewTitle');
    await page.getByRole('switch', { name: T('purchasing.receive.paidNow') }).click();
    await run.field(T('payments.method')).selectOption({ label: names.cash });
    const amount = run.field(T('payments.amountPaid', { currency: seed.currency }));
    if ((await amount.inputValue()) === '') await amount.fill('28.40');
    await run.shot('receive-pay');
    await run.button(T('purchasing.receive.receiveAndPay')).click();
    await run.text('purchasing.receive.received');
    await run.text('purchasing.receive.paid');
    await run.shot('receive-pay-done');
  });

  await run.step('return', async () => {
    await nav(run, 'purchases');
    await run.row(seed.returnReference).click();
    await page.waitForURL(new RegExp(`/purchases/${UUID_PATH}$`));
    await run.button(T('purchasing.return.title')).click();
    await page.waitForURL(new RegExp(`/purchases/${UUID_PATH}/return$`));
    await run.field(T('purchasing.return.quantityToReturn')).first().fill('1');
    await run
      .field(`${T('purchasing.return.reason')} (${T('common.optional')})`)
      .fill(run.locale === 'ar' ? 'كيس ممزق' : run.locale === 'tr' ? 'Yırtık çuval' : 'Torn bag');
    await run.shot('return');
    await tabToButton(run, T('purchasing.return.submit'));
    await run.text('purchasing.return.done');
    await run.shot('return-done');
  });

  // Undo receipt: only where the server says `reversible`, and behind a visible confirmation.
  await run.step('undo-receipt', async () => {
    await nav(run, 'purchases');
    // A draft opens in the receive form to be continued; it is never "undone".
    await run.row('DR-1').click();
    await page.waitForURL(new RegExp(`/purchases/receive\\?draft=${UUID_PATH}$`));
    await run.button(T('common.review')).waitFor();
    if ((await run.button(T('purchasing.detail.undoReceipt')).count()) > 0) run.fail('flow', 'Undo receipt is offered on a draft');
    await run.shot('purchase-draft');
    await nav(run, 'purchases');
    const ref = seed.undoReference[run.viewport.name] ?? '';
    await run.row(ref).click();
    await page.waitForURL(new RegExp(`/purchases/${UUID_PATH}$`));
    const undo = run.button(T('purchasing.detail.undoReceipt'));
    await undo.waitFor();
    await undo.click();
    await run.text('purchasing.detail.undoTitle');
    const confirm = run.button(T('purchasing.detail.undoConfirm'));
    await fullyVisible(run, confirm, 'the "Undo receipt" confirmation');
    await run.shot('purchase-undo-confirm');
    await confirm.click();
    await run.text('purchasing.detail.undone');
    await run.shot('purchase-undone');
    if ((await run.button(T('purchasing.detail.undoReceipt')).count()) > 0) run.fail('flow', 'Undo receipt is still offered after the receipt was undone');
  });

  await run.step('suppliers', async () => {
    await nav(run, 'suppliers');
    await run.row(names.supplierA).waitFor();
    await run.shot('suppliers');
    await run.field(T('common.search')).fill(names.supplierBSearch);
    await run.row(names.supplierB).waitFor();
    await page.waitForTimeout(600);
    await run.shot('suppliers-search');
    await run.field(T('common.search')).fill('');
    await page.getByLabel(T('suppliers.list.owedOnly')).check();
    await page.waitForTimeout(800);
    await run.row(names.supplierA).waitFor();
    await run.shot('suppliers-owed');
    await tabToRow(run, names.supplierA);
    await page.waitForURL(new RegExp(`/suppliers/${UUID_PATH}$`));
    await run.text('suppliers.detail.openPurchases');
    await page.waitForTimeout(600);
    await run.shot('supplier-detail');
  });

  await run.step('pay', async () => {
    await tabToButton(run, T('payments.title'));
    await page.waitForURL(new RegExp(`/suppliers/${UUID_PATH}/pay$`));
    await run.field(T('payments.method')).selectOption({ label: names.cash });
    await run.field(T('payments.amountPaid', { currency: seed.currency })).fill('15');
    const split = run.button(T('payments.showSplit'));
    if ((await split.count()) > 0) await split.click();
    await page.waitForTimeout(500);
    await run.shot('pay');
    await tabToButton(run, T('payments.submit'));
    await run.text('payments.done');
    await run.shot('pay-done');
  });

  // Loading and error states, on the page's real context read, held back and then refused by the network.
  await run.step('states', async () => {
    const read = /\/api\/proxy\/me\/businesses(\?|$)/;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(read, async (route) => {
      await held;
      await route.fallback(); // on to the context's pacer (run-context.ts), then the network
    });
    await nav(run, 'suppliers');
    await page.getByRole('status').first().waitFor();
    await run.shot('state-loading');
    release();
    await run.row(names.supplierA).waitFor();
    await page.unroute(read);
    await run.expecting(read, async () => {
      await page.route(read, (route) =>
        route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'UNAVAILABLE', message: 'refused by the browser gate' }) }),
      );
      await nav(run, 'purchases');
      const retry = run.button(T('common.tryAgain'));
      await retry.waitFor();
      await fullyVisible(run, retry, 'the "Try again" button');
      await run.shot('state-error');
      await page.unroute(read);
      await retry.click();
      await run.row(names.supplierA).waitFor();
    });
  });

  // Starting stock, in a business whose opening is not recorded yet; its empty lists first.
  await run.step('starting-stock', async () => {
    const starter = seed.starter[run.viewport.name];
    if (starter === undefined) throw new Error('no starter business was seeded for this viewport');
    await page.evaluate(`localStorage.setItem('daftar_business_id', ${JSON.stringify(starter.businessId)})`);
    await run.reload();
    await page.locator('header').waitFor();
    await nav(run, 'suppliers');
    await run.text('suppliers.list.empty');
    await run.shot('suppliers-empty');
    await nav(run, 'purchases');
    await run.text('purchasing.list.empty');
    await run.shot('purchases-empty');
    await nav(run, 'stock');
    await run.button(T('stock.adjust.title')).click();
    await page.waitForURL(/\/stock\/adjust$/);
    if (!(await startingStockOffered(run))) throw new Error('"Starting stock" is not offered in a business with no opening');
    await page.getByText(T('stock.adjust.reason.starting'), { exact: true }).click();
    await run.field(T('stock.picker.search')).fill(names.starterItem);
    await run
      .row(names.starterItem)
      .getByRole('button', { name: T('common.add') })
      .click();
    await run.field(T('stock.adjust.quantityMore')).fill('10');
    await run.field(T('stock.line.costPerUnit', { currency: seed.currency })).fill('12.5');
    await run.shot('adjust-starting');
    await run.button(T('stock.adjust.submit')).click();
    await run.text('stock.adjust.doneStarting');
    await run.shot('adjust-starting-done');
    await run.button(T('stock.adjust.another')).click();
    await assertStartingStockClosed(run, 'right after recording starting stock');
    // The server's own answer, on a new document: still closed.
    await run.reload();
    await assertStartingStockClosed(run, 'after a reload');
    await run.shot('adjust-starting-closed');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P4-S3 — THE POS STEPS.
  //
  // Four steps, each `p4-` prefixed and owned by PHASE4_STEPS, so the
  // accepted Phase 3 gate (pinned to PHASE3_STEPS) never walks them and a
  // defect on a POS screen can never turn it red (P4-AL-63, P4-AL-68).
  //
  // Each step takes its FIRST screenshot as soon as the screen is on the
  // page, before it drives anything: `run.shot()` is what checks the
  // invariants, so a planted defect is reported in EVERY locale × viewport
  // run — the nine-combination red proof — and not only where a flow happens
  // to get far enough.
  //
  // Every amount these steps read is the server's: the steps compare the
  // text of "To pay" before and after a discount request and require the
  // SERVER to have changed it. They never compute an expected total; a step
  // that did would be the browser deciding the price.
  // ═══════════════════════════════════════════════════════════════════════

  await run.step('p4-pos-till', async () => {
    // The Phase 3 steps end in the starter business; selling happens in the
    // one that has stock and prices. One document load per run, no more.
    await page.evaluate(`localStorage.setItem('daftar_business_id', ${JSON.stringify(seed.businessId)})`);
    await run.reload();
    await page.locator('header').waitFor();
    await posNav(run);
    await run.shot('p4-pos-no-till');
    await run.text('pos.till.mustOpen');
    await tabToButton(run, T('pos.till.goToTill'));
    await page.waitForURL(new RegExp(`/${run.locale}/pos/till$`));
    await run.text('pos.till.none');
    await run.shot('p4-pos-till');
    await run.field(T('pos.till.where')).selectOption({ label: seed.mainWarehouse });
    await tabToButton(run, T('pos.till.open'));
    await page.waitForURL(new RegExp(`/${run.locale}/pos$`));
    await run.text('pos.basket.empty');
    await run.shot('p4-pos-till-open');
  });

  await run.step('p4-pos-sale', async () => {
    await posNav(run);
    await run.shot('p4-pos-register');
    // The type-ahead is paced by the screen: one read per pause, nothing
    // under two characters. The step waits for the screen's own pause.
    await run.field(T('pos.search.label')).fill(names.riceSearch);
    await run.row(names.rice).waitFor();
    await run.shot('p4-pos-search');
    await addFound(run, names.rice);
    await basketLines(run, 1);
    await run.field(T('pos.search.label')).fill(names.teaSearch);
    await run.row(names.tea).waitFor();
    await addFound(run, names.tea);
    await basketLines(run, 2);
    // How many: the screen sends the quantity and takes the server's basket back.
    const before = await amountShown(run, 'pos.total.due');
    await run.field(T('pos.basket.quantity')).first().fill('3');
    await page.waitForTimeout(1200);
    const after = await amountShown(run, 'pos.total.due');
    if (after === before) run.fail('flow', `"to pay" did not change after the server was sent a new quantity (still ${before})`);
    await run.shot('p4-pos-basket');
    // A quantity that is not a quantity is refused on the line, not sent.
    await run.field(T('pos.basket.quantity')).first().fill('3..5');
    await run.text('pos.basket.quantityInvalid');
    await run.shot('p4-pos-quantity-refused');
    await run.field(T('pos.basket.quantity')).first().fill('3');
    await page.waitForTimeout(1200);
    // One line off again, and the server's basket is what the screen shows.
    await run.button(T('common.remove')).last().click();
    await basketLines(run, 1);
    await run.shot('p4-pos-basket-one');
  });

  await run.step('p4-pos-discount', async () => {
    const due = await amountShown(run, 'pos.total.due');
    await run.field(T('pos.discount.amount', { currency: seed.currency })).fill('1.50');
    await run.shot('p4-pos-discount');
    await tabToButton(run, T('pos.discount.apply'));
    await page.waitForTimeout(800);
    const discounted = await amountShown(run, 'pos.total.due');
    if (discounted === due) run.fail('flow', `the server was asked for a discount and "to pay" is unchanged (${due})`);
    const given = await amountShown(run, 'pos.total.discount');
    if (!/[1-9]/.test(given)) run.fail('flow', `the discount the server allowed reads as nothing ("${given}")`);
    await run.shot('p4-pos-discounted');
    // A discount that is not an amount in this currency never leaves the screen.
    await run.field(T('pos.discount.amount', { currency: seed.currency })).fill('1.5555');
    await run.button(T('pos.discount.apply')).click();
    await run.text('pos.discount.invalid');
    await run.shot('p4-pos-discount-refused');
    await run.button(T('pos.discount.clear')).click();
    await page.waitForTimeout(800);
    // Finish, behind a visible confirmation, and read the sale the server recorded.
    await tabToButton(run, T('pos.finish.action'));
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const confirm = dialog.getByRole('button', { name: T('pos.finish.action'), exact: true });
    await fullyVisible(run, confirm, 'the "Finish the sale" confirmation');
    await fullyVisible(run, dialog.getByText(T('pos.finish.confirmHint')), 'the finish warning');
    await run.shot('p4-pos-finish-confirm');
    await confirm.click();
    await run.text('pos.finish.done');
    await run.text('pos.receipt.title');
    await run.shot('p4-pos-sold');
    await run.button(T('pos.finish.another')).click();
    await run.text('pos.basket.empty');
    await run.shot('p4-pos-next-sale');
  });

  await run.step('p4-pos-close', async () => {
    await run.button(T('pos.till.goToTill')).click();
    await page.waitForURL(new RegExp(`/${run.locale}/pos/till$`));
    await run.text('pos.till.opened');
    await run.shot('p4-pos-till-after-sale');
    await run.button(T('pos.till.close')).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const confirm = dialog.getByRole('button', { name: T('pos.till.close'), exact: true });
    await fullyVisible(run, confirm, 'the "Close the till" confirmation');
    await run.shot('p4-pos-close-confirm');
    await confirm.click();
    await run.text('pos.till.closed');
    await run.shot('p4-pos-closed');
    await posNav(run);
    await run.text('pos.till.mustOpen');
    await run.shot('p4-pos-no-till-again');
  });
}
