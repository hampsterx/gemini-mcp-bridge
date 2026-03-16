import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { findGeminiBinary } from "../utils/spawn.js";
import { buildSubprocessEnv } from "../utils/env.js";

const require = createRequire(import.meta.url);
const PKG_VERSION: string = (require("../../package.json") as { version: string }).version;

export interface PingResult {
  cliFound: boolean;
  version: string | null;
  authStatus: "ok" | "expired" | "missing" | "unknown";
  serverVersion: string;
  nodeVersion: string;
  maxConcurrent: number;
}

/**
 * Health check and capability detection.
 * Checks if gemini CLI is installed, authenticated, and reports versions.
 */
export async function executePing(): Promise<PingResult> {
  const binary = findGeminiBinary();
  const maxConcurrent = parseInt(
    process.env["GEMINI_MAX_CONCURRENT"] ?? "3",
    10,
  );

  // Try to get CLI version
  let cliFound = false;
  let version: string | null = null;

  try {
    const output = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    cliFound = true;
    version = output;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        cliFound: false,
        version: null,
        authStatus: "missing",
        serverVersion: PKG_VERSION,
        nodeVersion: process.version,
        maxConcurrent,
      };
    }
    // CLI found but --version failed? Unusual but possible
    cliFound = true;
  }

  // Check auth status by running a minimal prompt
  let authStatus: PingResult["authStatus"] = "unknown";
  try {
    const result = execFileSync(
      binary,
      ["--output-format", "json", "Reply with exactly: OK"],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: buildSubprocessEnv(),
      },
    );
    // If we got a response, auth is working
    if (result && result.length > 0) {
      authStatus = "ok";
    }
  } catch {
    // Auth check failed — could be expired or missing credentials
    authStatus = "expired";
  }

  return {
    cliFound,
    version,
    authStatus,
    serverVersion: PKG_VERSION,
    nodeVersion: process.version,
    maxConcurrent,
  };
}
