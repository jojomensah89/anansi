/** Shared by every external hop in a preview pass. Reserve before durable claims. */
export class FetchBudget {
  used = 0;
  readonly deadline: number;
  constructor(readonly limit = 40, milliseconds = 20_000) { this.deadline = Date.now() + milliseconds; }
  get remainingMs() { return Math.max(0, this.deadline - Date.now()); }
  canStart() { return this.limit - this.used >= 12 && this.remainingMs > 0; }
  consume(count = 1) {
    if (this.used + count > this.limit || !this.remainingMs) throw new Error("preview budget exhausted");
    this.used += count;
  }
}
