import { execFileSync } from "node:child_process";
import { findGeminiBinary } from "../utils/spawn.js";

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

  // Get server version from package.json (injected at build or read at runtime)
  const serverVersion = "0.1.0";

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
        serverVersion,
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
      ["-p", "Reply with exactly: OK", "--output-format", "json"],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([k]) =>
                ["HOME", "PATH", "USER", "SHELL"].includes(k) ||
                k.startsWith("GOOGLE_") ||
                k.startsWith("GEMINI_") ||
                k.startsWith("CLOUDSDK_"),
            ),
          ),
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
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
    serverVersion,
    nodeVersion: process.version,
    maxConcurrent,
  };
}
