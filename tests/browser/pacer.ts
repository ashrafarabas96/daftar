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
