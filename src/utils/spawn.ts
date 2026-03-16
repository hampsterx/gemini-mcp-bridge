import { spawn, type ChildProcess } from "node:child_process";
import { buildSubprocessEnv } from "./env.js";

/** Hard maximum timeout — no request can exceed this. */
const HARD_TIMEOUT_CAP = 600_000; // 10 minutes

/** Default max concurrent subprocess spawns. */
const DEFAULT_MAX_CONCURRENT = 3;

/** Queue timeout — how long a request waits for a slot. */
const QUEUE_TIMEOUT = 30_000;

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
    return await doSpawn(options, timeout);
  } finally {
    releaseSlot();
  }
}

async function doSpawn(options: SpawnOptions, timeout: number): Promise<SpawnResult> {
  const binary = findGeminiBinary();
  const env = buildSubprocessEnv();

  return new Promise<SpawnResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, options.args, {
        cwd: options.cwd,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      reject(new Error(`Failed to spawn gemini CLI: ${e}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, timeout);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
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
 */
function killProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;

  try {
    // Kill process group
    process.kill(-pid, "SIGTERM");
  } catch {
    // Process group kill failed, try direct
    try {
      child.kill("SIGTERM");
    } catch {
      // Already dead
    }
  }

  // Force kill after 5s grace
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already dead
      }
    }
  }, 5000);
}

/**
 * Reset concurrency state (for testing).
 */
export function resetConcurrency(): void {
  activeCount = 0;
  waitQueue.length = 0;
}
