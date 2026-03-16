/**
 * Hardened subprocess environment builder.
 * Never spreads process.env — uses an explicit allowlist.
 */

const ALLOWED_ENV_PREFIXES = ["GOOGLE_", "GEMINI_", "CLOUDSDK_"];
const ALLOWED_ENV_KEYS = [
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
];

/** Build a minimal, safe environment for gemini CLI subprocesses. */
export function buildSubprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    NODE_OPTIONS: "--max-old-space-size=8192",
  };

  for (const [key, val] of Object.entries(process.env)) {
    if (!val) continue;
    if (ALLOWED_ENV_KEYS.includes(key)) {
      env[key] = val;
    } else if (ALLOWED_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      env[key] = val;
    }
  }

  return env;
}
