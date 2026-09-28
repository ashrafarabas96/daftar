/**
 * Staying under the API's per-address auth allowances.
 *
 * The API counts logins and session refreshes per client address in fixed
 * five-minute windows (auth.service.ts). Every browser the gate drives
 * connects from the same loopback address, so without pacing a fast run
 * would meet a limit that a real merchant, on their own address, never does.
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
