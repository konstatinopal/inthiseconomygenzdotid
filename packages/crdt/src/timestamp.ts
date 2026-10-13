// Hybrid Logical Clock timestamps.
// Format (46 chars, lexically sortable): <ISO 8601 millis>-<counter hex4>-<node hex16>
// e.g. 2026-10-13T09:15:00.000Z-0000-a1b2c3d4e5f60718

const MAX_DRIFT = 5 * 60 * 1000;
const MAX_COUNTER = 0xffff;

export class ClockDriftError extends Error {}
export class OverflowError extends Error {}
export class DuplicateNodeError extends Error {}

export class Timestamp {
  constructor(
    readonly millis: number,
    readonly counter: number,
    readonly node: string,
  ) {}

  toString(): string {
    return [
      new Date(this.millis).toISOString(),
      this.counter.toString(16).toUpperCase().padStart(4, '0'),
      this.node.padStart(16, '0'),
    ].join('-');
  }

  static parse(str: string): Timestamp | null {
    if (typeof str !== 'string') return null;
    const parts = str.split('-');
    if (parts.length !== 5) return null;
    const millis = Date.parse(parts.slice(0, 3).join('-'));
    const counter = parseInt(parts[3], 16);
    const node = parts[4];
    if (isNaN(millis) || isNaN(counter) || node.length !== 16) return null;
    return new Timestamp(millis, counter, node);
  }

  static since(isoString: string): string {
    return isoString + '-0000-0000000000000000';
  }

  static zero(): string {
    return Timestamp.since(new Date(0).toISOString());
  }
}

export function makeNodeId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export interface ClockState {
  millis: number;
  counter: number;
  node: string;
}

/** A per-device HLC. Not thread-safe; one per open budget file. */
export class Clock {
  state: ClockState;
  now: () => number;

  constructor(state: ClockState, now: () => number = Date.now) {
    this.state = { ...state };
    this.now = now;
  }

  /** Generate a timestamp for a local event. */
  send(): Timestamp {
    const phys = this.now();
    const lOld = this.state.millis;
    const cOld = this.state.counter;
    const lNew = Math.max(lOld, phys);
    const cNew = lOld === lNew ? cOld + 1 : 0;
    if (lNew - phys > MAX_DRIFT) throw new ClockDriftError('Clock drift too large');
    if (cNew > MAX_COUNTER) throw new OverflowError('HLC counter overflow');
    this.state = { millis: lNew, counter: cNew, node: this.state.node };
    return new Timestamp(lNew, cNew, this.state.node);
  }

  /** Merge a remote timestamp into the local clock. */
  recv(msg: Timestamp): void {
    const phys = this.now();
    if (msg.millis - phys > MAX_DRIFT) throw new ClockDriftError('Remote clock drift too large');
    if (msg.node === this.state.node) {
      // Our own message coming back from the server is fine; only a different
      // device sharing our id would be a problem, which we can't detect here.
    }
    const lOld = this.state.millis;
    const cOld = this.state.counter;
    const lNew = Math.max(lOld, phys, msg.millis);
    let cNew: number;
    if (lNew === lOld && lNew === msg.millis) cNew = Math.max(cOld, msg.counter) + 1;
    else if (lNew === lOld) cNew = cOld + 1;
    else if (lNew === msg.millis) cNew = msg.counter + 1;
    else cNew = 0;
    if (lNew - phys > MAX_DRIFT) throw new ClockDriftError('Clock drift too large');
    if (cNew > MAX_COUNTER) throw new OverflowError('HLC counter overflow');
    this.state = { millis: lNew, counter: cNew, node: this.state.node };
  }
}
