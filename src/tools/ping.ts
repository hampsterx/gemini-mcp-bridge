import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { findGeminiBinary } from "../utils/spawn.js";
import { buildSubprocessEnv } from "../utils/env.js";
import { getDefaultModel, getFallbackModel } from "../utils/model.js";

const require = createRequire(import.meta.url);
const PKG_VERSION: string = (require("../../package.json") as { version: string }).version;

export interface PingResult {
  cliFound: boolean;
  version: string | null;
  authStatus: "ok" | "expired" | "missing" | "unknown";
  defaultModel: string | null;
  fallbackModel: string | null;
  serverVersion: string;
  nodeVersion: string;
  maxConcurrent: number;
}

/**
 * Detect auth status without spawning the CLI (which is agentic and thrashes).
 * Checks for API key env vars or OAuth credential files on disk.
 */
function detectAuthStatus(): PingResult["authStatus"] {
  const env = buildSubprocessEnv();

  // API key auth: if either key env var is set, auth is available
  if (env["GOOGLE_API_KEY"] || env["GEMINI_API_KEY"]) {
    return "ok";
  }

  // OAuth auth: check ~/.gemini/oauth_creds.json
  try {
    const credsPath = join(homedir(), ".gemini", "oauth_creds.json");
    const raw = readFileSync(credsPath, "utf8");
    const creds = JSON.parse(raw) as Record<string, unknown>;

    const hasRefreshToken =
      typeof creds.refresh_token === "string" && creds.refresh_token.length > 0;
    const hasExpiryDate =
      typeof creds.expiry_date === "number" && creds.expiry_date > 0;

    if (hasRefreshToken) {
      // Has refresh token, CLI can renew automatically
      return "ok";
    }

    if (hasExpiryDate) {
      // No refresh token; access token validity depends on expiry
      return (creds.expiry_date as number) < Date.now() ? "expired" : "ok";
    }

    // Neither valid refresh_token nor valid expiry_date - can't determine status
    return "unknown";
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return "missing";
    }
    // Malformed JSON, permission errors, etc.
    return "unknown";
  }
}

/**
 * Health check and capability detection.
 * Checks if gemini CLI is installed and reports versions.
 * Auth detection is file/env-based (no subprocess spawn).
 */
export async function executePing(): Promise<PingResult> {
  const binary = findGeminiBinary();
  const maxConcurrent = parseInt(
    process.env["GEMINI_MAX_CONCURRENT"] ?? "3",
    10,
  );

  // Try to get CLI version (--version is safe to run synchronously, not agentic)
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
        defaultModel: getDefaultModel() ?? null,
        fallbackModel: getFallbackModel() ?? null,
        serverVersion: PKG_VERSION,
        nodeVersion: process.version,
        maxConcurrent,
      };
    }
    // CLI found but --version failed? Unusual but possible
    cliFound = true;
  }

  const authStatus = detectAuthStatus();
  const defaultModel = getDefaultModel() ?? null;
  const fallbackModel = getFallbackModel() ?? null;

  return {
    cliFound,
    version,
    authStatus,
    defaultModel,
    fallbackModel,
    serverVersion: PKG_VERSION,
    nodeVersion: process.version,
    maxConcurrent,
  };
}
