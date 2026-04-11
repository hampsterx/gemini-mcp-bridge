/**
 * Shared resource limits used across spawn.ts, retry.ts, and tool modules.
 *
 * Kept in a dedicated file so tests that wholesale-mock spawn.js (via
 * `vi.mock("../../src/utils/spawn.js", ...)`) don't accidentally hide the
 * constants, and so there's exactly one source of truth for the hard cap.
 */

/** Hard maximum timeout — no request can exceed this. */
export const HARD_TIMEOUT_CAP = 1_800_000; // 30 minutes
