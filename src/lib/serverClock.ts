import { getSupabase } from "./supabaseClient";

// Server-clock synchronisation for the multiplayer countdown.
//
// The round deadline is a pair of server values (rooms.round_started_at plus
// the tier's round_seconds), so the only remaining client-side ingredient is
// "what time is it now". Reading that from Date.now() directly would make the
// countdown depend on the device clock: a skewed device shows a different
// number of seconds than everyone else in the room, and a player could skew it
// on purpose.
//
// Instead we measure the offset between this device and the server once, then
// tick against serverNow(). A client whose network is slow simply learns about
// the round late and starts its countdown partway through — it still lands on
// the same absolute deadline as everyone else, because the deadline is an
// absolute server timestamp rather than "now + duration".

let offsetMs = 0;
let synced = false;
let inFlight: Promise<void> | null = null;

/**
 * Measure this device's offset from the server clock.
 *
 * Round-trip is halved to approximate one-way latency, which is the standard
 * cheap estimate — good to a few tens of milliseconds on a normal connection,
 * far inside the one-second granularity the countdown is displayed at.
 *
 * Deduped: concurrent callers await the same sync, and a completed sync is
 * reused for the rest of the session.
 */
export async function syncServerClock(force = false): Promise<void> {
  if (synced && !force) return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const t0 = Date.now();
      const { data, error } = await getSupabase().rpc("server_now");
      const t1 = Date.now();
      if (error || !data) return;

      const serverMs = new Date(data as string).getTime();
      if (Number.isNaN(serverMs)) return;

      offsetMs = serverMs - (t0 + (t1 - t0) / 2);
      synced = true;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Current time on the server's clock, in ms. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** Whether a sync has succeeded. Before that serverNow() falls back to device time. */
export function isClockSynced(): boolean {
  return synced;
}

/** Measured device-to-server offset in ms. Exposed for diagnostics/verification. */
export function clockOffsetMs(): number {
  return offsetMs;
}

/**
 * Whole seconds remaining until an absolute server deadline, floored at 0.
 * Ceil so a countdown reads "1" for the final partial second rather than "0".
 *
 * `nowMs` is an explicit parameter so a React caller can pass a ticking state
 * value. Defaulting it to serverNow() would make the result depend on a moving
 * value React cannot see, which silently freezes any memo that derives from it.
 */
export function secondsUntil(deadlineMs: number, nowMs: number = serverNow()): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}
