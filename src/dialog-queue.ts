/**
 * One extension dialog at a time.
 *
 * dsh routes every approval through `ctx.approval`, and its client keeps each
 * concurrent request alive, projecting one of them into the session's
 * pending-interaction seat. That second half has no pi counterpart: pi's
 * interactive UI holds one extension-selector slot, and a dialog that a later
 * `ui.select` replaces is never settled — its promise stays pending forever.
 *
 * So pi-dsh-sandbox supplies the spacing itself: concurrent escalations wait
 * here and open one at a time, and each request rides the tool execution's
 * abort signal, so a cancelled run withdraws its question instead of leaving
 * a dialog behind. The queue is a pi host adaptation, not a dsh behavior; see
 * `docs/design.md` chapter 4.3.
 *
 * @module pi-dsh-sandbox/dialog-queue
 */

/** Resolves one queued request when the slot reaches it. */
type Admit = () => void;

/**
 * Serializes access to pi's single extension-dialog slot.
 *
 * Ordering is first-come, first-served. A request whose signal aborts while
 * queued never opens, which the caller reads as a cancelled approval.
 */
export class DialogQueue {
  #busy = false;
  readonly #waiting: Admit[] = [];

  /** Requests queued behind the open dialog; a test seam. */
  get pending(): number {
    return this.#waiting.length;
  }

  /**
   * Run `open` with exclusive access to the dialog slot.
   *
   * @param open Opens the dialog and resolves with the user's answer.
   * @param signal The tool execution's abort signal; aborting withdraws the
   *   request, both while queued and while the dialog is open.
   * @returns The answer, or `undefined` when the request was cancelled before
   *   it could open.
   */
  async run<T>(open: () => Promise<T | undefined>, signal?: AbortSignal): Promise<T | undefined> {
    if (signal?.aborted === true) return undefined;
    if (this.#busy) {
      const admitted = await new Promise<boolean>((resolve) => {
        const admit: Admit = () => resolve(true);
        this.#waiting.push(admit);
        signal?.addEventListener("abort", () => {
          const index = this.#waiting.indexOf(admit);
          // Absent means the slot was handed over first; the open dialog
          // handles that abort through its own signal.
          if (index < 0) return;
          this.#waiting.splice(index, 1);
          resolve(false);
        }, { once: true });
      });
      if (!admitted) return undefined;
    }
    this.#busy = true;
    try {
      return await open();
    } finally {
      this.#busy = false;
      this.#waiting.shift()?.();
    }
  }
}

/** The queue shared by every escalation in this extension. */
export const dialogQueue = new DialogQueue();
