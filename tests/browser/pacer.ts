/**
 * Staying under the API's per-address allowances: the auth limits on login
 * and refresh, and the general per-route throttle (`RouteBudgets` below).
 *
 * The API counts logins and session refreshes per client address in fixed
 * five-minute windows (auth.service.ts). The web server forwards each
 * browser's TCP peer (`server.mts`, TD-19) and the API trusts it, so the
 * address the API counts is the browser's own — and every browser the gate
 * drives connects from loopback. Should Chromium reach the web server over
 * both 127.0.0.1 and ::1, the API counts two addresses; one budget for all of
 * them is the stricter reading, so it can never overspend either. Without
 * pacing a fast run would meet a limit that a real merchant, on their own
 * address, never does.
 * The pacer keeps a sliding window of what the gate has spent: at most N
 * events in ANY window of that length means at most N in each of the API's
 * fixed windows, so waiting here is enough and never guesses the API's clock.
 *
 * Every full page load spends one refresh (the page's access token lives in
 * memory, so a new document asks the BFF for one); a client-side navigation
 * spends none. The flows therefore navigate the way a merchant does, through
 * the menu and the buttons, and reserve a refresh only for a real reload.
 */
export class SlidingBudget {
  private readonly spent: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly name: string,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Spend one unit, waiting first if the window is full. Serialized, so concurrent workers never overspend. */
  take(): Promise<number> {
    const turn = this.queue.then(async () => {
      let waited = 0;
      for (;;) {
        const now = Date.now();
        while (this.spent.length > 0 && (this.spent[0] ?? now) <= now - this.windowMs) this.spent.shift();
        if (this.spent.length < this.limit) break;
        const until = (this.spent[0] ?? now) + this.windowMs - now + 50;
        waited += until;
        await new Promise((resolve) => setTimeout(resolve, until));
      }
      this.spent.push(Date.now());
      return waited;
    });
    this.queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }
}

/**
 * One `SlidingBudget` per API route, for the requests pages send through the
 * BFF proxy (`/api/proxy/...`). The API counts per route HANDLER, and the
 * gate sees only URLs, so a URL is folded to the handler it reaches: a path
 * segment spelled like a route literal (lower-case words joined by `-`) is
 * kept, and any other segment — a UUID, a number, anything holding a digit or
 * an upper-case letter — is a parameter. Folding can only put two handlers
 * under one budget (stricter), never split one handler across two, because
 * every merchant route parameter is an identifier (apps/api: `:id`,
 * `:purchaseId`, `:supplierId`, ...), never a word.
 */
export function routeKey(method: string, pathname: string): string {
  const segments = pathname
    .split('/')
    .filter((s) => s !== '')
    .map((s) => (/^[a-z]+(?:-[a-z]+)*$/.test(s) ? s : ':param'));
  return `${method.toUpperCase()} /${segments.join('/')}`;
}

export class RouteBudgets {
  private readonly budgets = new Map<string, SlidingBudget>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Spend one unit of the budget of the route `method pathname` reaches. */
  take(method: string, pathname: string): Promise<number> {
    const key = routeKey(method, pathname);
    let budget = this.budgets.get(key);
    if (budget === undefined) {
      budget = new SlidingBudget(key, this.limit, this.windowMs);
      this.budgets.set(key, budget);
    }
    return budget.take();
  }
}

/**
 * Proof that the pacer is in front of EVERY proxied request, not merely in
 * front of the ones we happened to think of.
 *
 * A budget only holds if nothing walks past it. The gate paces in a
 * `context.route` handler, so a request that never reaches that handler is
 * spent at the API without being counted here — and the first symptom of that
 * is a 429 on the busiest route, which is indistinguishable from "the budget
 * is set too high" unless the two numbers are kept apart and compared.
 *
 * So each proxied request is counted three ways, per route key:
 *   seen      — the browser issued it (`page.on('request')`, which fires for
 *               every request a page makes, intercepted or not)
 *   paced     — the context handler charged a budget for it
 *   fulfilled — a step answered it locally and it never reached the network
 *
 * `seen === paced + fulfilled` for every key, always. A key where it does not
 * hold names a request that reached the API unpaced, and the gate fails on it
 * rather than reporting a clean run it cannot justify.
 */
/** Where a request was issued from, so an unpaced one can be named instead of merely counted. */
export interface RequestOrigin {
  readonly locale: string;
  readonly viewport: string;
  /** The step that was running, or `(between steps)` — which is itself a useful answer. */
  readonly step: string;
  readonly url: string;
  readonly atMs: number;
}

export class RouteCoverage {
  private readonly rows = new Map<string, { seen: number; paced: number; fulfilled: number }>();
  /**
   * Every request seen, keyed by Playwright's own Request object — the same
   * object the interceptor is handed, so "was this one paced?" is an identity
   * question and not a counting one.
   *
   * Counts alone say a route is short by one; they cannot say WHICH one, and
   * a single unpaced request out of a hundred is exactly the case where the
   * difference between a real leak and a teardown artefact decides whether
   * anything needs fixing.
   */
  private readonly pending = new Map<object, RequestOrigin & { route: string }>();
  private readonly settled = new WeakSet<object>();

  private row(key: string): { seen: number; paced: number; fulfilled: number } {
    let row = this.rows.get(key);
    if (row === undefined) {
      row = { seen: 0, paced: 0, fulfilled: 0 };
      this.rows.set(key, row);
    }
    return row;
  }

  seen(method: string, pathname: string, token?: object, origin?: RequestOrigin): void {
    const route = routeKey(method, pathname);
    this.row(route).seen += 1;
    if (token !== undefined && origin !== undefined) this.pending.set(token, { ...origin, route });
  }

  paced(method: string, pathname: string, token?: object): void {
    this.row(routeKey(method, pathname)).paced += 1;
    this.settle(token);
  }

  fulfilled(method: string, pathname: string, token?: object): void {
    this.row(routeKey(method, pathname)).fulfilled += 1;
    this.settle(token);
  }

  private settle(token: object | undefined): void {
    if (token === undefined) return;
    this.settled.add(token);
    this.pending.delete(token);
  }

  /** The requests that were seen and never accounted for, each with where it came from. */
  unaccounted(): (RequestOrigin & { route: string })[] {
    return [...this.pending.values()].sort((a, b) => a.atMs - b.atMs);
  }

  /** Every route key with its three counts, busiest first — the gate prints this whether it passes or fails. */
  table(): { route: string; seen: number; paced: number; fulfilled: number; unpaced: number }[] {
    return [...this.rows.entries()]
      .map(([route, r]) => ({ route, seen: r.seen, paced: r.paced, fulfilled: r.fulfilled, unpaced: r.seen - r.paced - r.fulfilled }))
      .sort((a, b) => b.seen - a.seen);
  }

  /** The keys where a request reached the API without being charged. Empty is the only acceptable answer. */
  unpaced(): { route: string; unpaced: number }[] {
    return this.table()
      .filter((r) => r.unpaced !== 0)
      .map((r) => ({ route: r.route, unpaced: r.unpaced }));
  }
}
