/**
 * The demo clock. Game time is nanoseconds like block timestamps, but it can
 * run faster than real time so a three-minute round fits in thirty seconds.
 */
export interface Clock {
  /** Current game time in ns. */
  now(): bigint;
  /** Game seconds per real second. */
  rate(): number;
  setRate(rate: number): void;
}

function realMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class ScaledClock implements Clock {
  private anchorGame: bigint;
  private anchorReal: number;
  private scale: number;

  constructor(startNs: bigint, rate: number) {
    this.anchorGame = startNs;
    this.anchorReal = realMs();
    this.scale = rate;
  }

  now(): bigint {
    const elapsedMs = realMs() - this.anchorReal;
    return this.anchorGame + BigInt(Math.round(elapsedMs * this.scale * 1e6));
  }

  rate(): number {
    return this.scale;
  }

  setRate(rate: number): void {
    this.anchorGame = this.now();
    this.anchorReal = realMs();
    this.scale = rate;
  }
}

/** A clock that only moves when told to. Used by tests. */
export class ManualClock implements Clock {
  private t: bigint;
  private scale = 1;

  constructor(startNs: bigint) {
    this.t = startNs;
  }

  now(): bigint {
    return this.t;
  }

  rate(): number {
    return this.scale;
  }

  setRate(rate: number): void {
    this.scale = rate;
  }

  advanceNs(ns: bigint): void {
    this.t += ns;
  }

  set(ns: bigint): void {
    this.t = ns;
  }
}
