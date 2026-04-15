import { spawn, type ChildProcess } from "node:child_process";
import { buildSubprocessEnv } from "./env.js";
import { HARD_TIMEOUT_CAP } from "./limits.js";

/** Default max concurrent subprocess spawns. */
const DEFAULT_MAX_CONCURRENT = 3;

/** Queue timeout — how long a request waits for a slot. */
const QUEUE_TIMEOUT = 30_000;

/** Minimum delay between a completed invocation and the next spawn. */
const MIN_INVOCATION_GAP_MS = parseInt(
  process.env["GEMINI_MIN_INVOCATION_GAP_MS"] ?? "5000",
  10,
);

/** Small random delay added before each spawn to avoid perfectly deterministic timing. */
const SPAWN_JITTER_MAX_MS = parseInt(
  process.env["GEMINI_SPAWN_JITTER_MAX_MS"] ?? "200",
  10,
);

export interface SpawnOptions {
  args: string[];
  cwd: string;
  stdin?: string;
  timeout?: number;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

// Concurrency management
let activeCount = 0;
const maxConcurrent = parseInt(
  process.env["GEMINI_MAX_CONCURRENT"] ?? String(DEFAULT_MAX_CONCURRENT),
  10,
);
const waitQueue: Array<{
  resolve: () => void;
  reject: (err: Error) => void;
}> = [];
let lastInvocationFinishedAt = 0;

function acquireSlot(): Promise<void> {
  if (activeCount < maxConcurrent) {
    activeCount++;
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waitQueue.findIndex((w) => w.resolve === resolve);
      if (idx !== -1) waitQueue.splice(idx, 1);
      reject(new Error(`Concurrency queue timeout after ${QUEUE_TIMEOUT}ms — ${activeCount} processes active`));
    }, QUEUE_TIMEOUT);

    waitQueue.push({
      resolve: () => {
        clearTimeout(timer);
        activeCount++;
        resolve();
      },
      reject,
    });
  });
}

function releaseSlot(): void {
  activeCount--;
  const next = waitQueue.shift();
  if (next) {
    next.resolve();
  }
}

/**
 * Find the gemini CLI binary path.
 */
export function findGeminiBinary(): string {
  return process.env["GEMINI_CLI_PATH"] ?? "gemini";
}

/**
 * Spawn a gemini CLI subprocess with hardened environment,
 * timeout management, and concurrency limiting.
 */
export async function spawnGemini(options: SpawnOptions): Promise<SpawnResult> {
  const timeout = Math.min(options.timeout ?? 60_000, HARD_TIMEOUT_CAP);

  await acquireSlot();

  try {
    await enforceInvocationGap();
    return await doSpawn(options, timeout);
  } finally {
    lastInvocationFinishedAt = Date.now();
    releaseSlot();
  }
}

async function enforceInvocationGap(): Promise<void> {
  const sinceLastFinish = Date.now() - lastInvocationFinishedAt;
  const gapDelay = Math.max(0, MIN_INVOCATION_GAP_MS - sinceLastFinish);
  if (gapDelay > 0) {
    await sleep(gapDelay);
  }

  const jitter = randomJitter(SPAWN_JITTER_MAX_MS);
  if (jitter > 0) {
    await sleep(jitter);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomJitter(maxMs: number): number {
  if (maxMs <= 0) return 0;
  return Math.floor(Math.random() * (maxMs + 1));
}

async function doSpawn(options: SpawnOptions, timeout: number): Promise<SpawnResult> {
  const binary = findGeminiBinary();
  const env = buildSubprocessEnv();

  return new Promise<SpawnResult>((resolve, reject) => {
    let child: ChildProcess;
    const detached = process.platform !== "win32";
    try {
      child = spawn(binary, options.args, {
        cwd: options.cwd,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached,
      });
    } catch (e) {
      reject(new Error(`Failed to spawn gemini CLI: ${e}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      killTimer = killProcessGroup(child);
    }, timeout);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new Error(
              "gemini CLI not found. Install with: npm i -g @google/gemini-cli",
            ),
          );
        } else {
          reject(new Error(`Failed to run gemini CLI: ${err.message}`));
        }
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, exitCode: code, timedOut });
      }
    });

    // Write stdin if provided, then close
    if (options.stdin) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();
  });
}

/**
 * Kill a process and its children. SIGTERM first, SIGKILL after grace period.
 * Only uses process group kill (-pid) when the child was spawned with detached: true,
 * which gives it its own process group. Without detached, -pid would target the
 * parent's process group and kill the MCP server itself.
 */
function killProcessGroup(child: ChildProcess): NodeJS.Timeout | undefined {
  const pid = child.pid;
  if (!pid) return undefined;

  const useGroupKill = process.platform !== "win32";

  const kill = (signal: NodeJS.Signals) => {
    try {
      if (useGroupKill) {
        process.kill(-pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already dead
      }
    }
  };

  kill("SIGTERM");

  // Force kill after 5s grace
  return setTimeout(() => kill("SIGKILL"), 5000);
}

/**
 * Reset concurrency state (for testing).
 */
export function resetConcurrency(): void {
  activeCount = 0;
  waitQueue.length = 0;
  lastInvocationFinishedAt = 0;
}
