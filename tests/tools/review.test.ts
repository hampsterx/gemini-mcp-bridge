import { describe, it, expect } from "vitest";
import { loadPrompt, buildLengthLimit } from "../../src/utils/prompts.js";
import {
  buildAgenticPrompt,
  buildQuickPrompt,
  buildFocusedPrompt,
  resolveDepth,
  scaleTimeoutForDepth,
  defaultTimeoutForDepth,
  SCAN_TIMEOUT,
  FOCUSED_FALLBACK_TIMEOUT,
  AGENTIC_TIMEOUT,
} from "../../src/tools/review.js";
import { HARD_TIMEOUT_CAP } from "../../src/utils/retry.js";

describe("loadPrompt", () => {
  it("loads a template and replaces placeholders", () => {
    const result = loadPrompt("review-quick.md", {
      DIFF: "some diff content",
      FOCUS_SECTION: "",
    });
    expect(result).toContain("some diff content");
    expect(result).not.toContain("{{DIFF}}");
  });

  it("leaves unreferenced placeholders intact", () => {
    // Only replace keys present in vars — unknown {{PLACEHOLDERS}} in the
    // template stay as-is (they're part of the template, not user content).
    const result = loadPrompt("review-agentic.md", {
      DIFF_SPEC: "git diff HEAD~1",
      // Deliberately omit FOCUS_SECTION
    });
    expect(result).toContain("git diff HEAD~1");
    expect(result).toContain("{{FOCUS_SECTION}}");
  });

  it("does not corrupt diff content containing {{word}} patterns", () => {
    const diffWithHandlebars = `
+<div>{{userName}}</div>
+<span>{{#if active}}Yes{{/if}}</span>
`;
    const result = loadPrompt("review-quick.md", {
      DIFF: diffWithHandlebars,
      FOCUS_SECTION: "",
    });
    expect(result).toContain("{{userName}}");
    expect(result).toContain("{{#if active}}");
  });
});

describe("buildAgenticPrompt", () => {
  it("includes the diff spec command", () => {
    const result = buildAgenticPrompt("git diff HEAD~3");
    expect(result).toContain("git diff HEAD~3");
  });

  it("includes focus section when provided", () => {
    const result = buildAgenticPrompt("git diff", "security");
    expect(result).toContain("Pay special attention to: security");
  });

  it("omits focus section when not provided", () => {
    const result = buildAgenticPrompt("git diff");
    expect(result).not.toContain("Focus Area");
    expect(result).not.toContain("Pay special attention to");
  });

  it("includes length limit when set", () => {
    const result = buildAgenticPrompt("git diff HEAD", undefined, 1000);
    expect(result).toContain("Keep your response under 1000 words");
  });

  it("omits length limit when not set", () => {
    const result = buildAgenticPrompt("git diff HEAD");
    expect(result).not.toContain("Keep your response under");
  });
});

describe("buildQuickPrompt", () => {
  it("includes the diff content", () => {
    const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new";
    const result = buildQuickPrompt(diff);
    expect(result).toContain(diff);
  });

  it("includes focus when provided", () => {
    const result = buildQuickPrompt("some diff", "performance");
    expect(result).toContain("Pay special attention to: performance");
  });

  it("omits focus when not provided", () => {
    const result = buildQuickPrompt("some diff");
    expect(result).not.toContain("Pay special attention to");
  });

  it("includes length limit when maxResponseLength is set", () => {
    const result = buildQuickPrompt("some diff", undefined, 500);
    expect(result).toContain("Keep your response under 500 words");
  });

  it("omits length limit when maxResponseLength is not set", () => {
    const result = buildQuickPrompt("some diff");
    expect(result).not.toContain("Keep your response under");
  });
});

describe("buildFocusedPrompt", () => {
  it("includes the diff content", () => {
    const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new";
    const result = buildFocusedPrompt(diff);
    expect(result).toContain(diff);
  });

  it("instructs the CLI to read changed files only", () => {
    const result = buildFocusedPrompt("diff");
    expect(result).toContain("Do NOT explore beyond the changed files");
  });

  it("acknowledges unreadable changed files (deleted / binary / gitignored)", () => {
    const result = buildFocusedPrompt("diff");
    expect(result).toMatch(/unreadable|read_file returns an error/);
  });

  it("includes focus when provided", () => {
    const result = buildFocusedPrompt("some diff", "security");
    expect(result).toContain("Pay special attention to: security");
  });

  it("omits focus when not provided", () => {
    const result = buildFocusedPrompt("some diff");
    expect(result).not.toContain("Pay special attention to");
  });

  it("includes length limit when maxResponseLength is set", () => {
    const result = buildFocusedPrompt("some diff", undefined, 800);
    expect(result).toContain("Keep your response under 800 words");
  });

  it("omits length limit when maxResponseLength is not set", () => {
    const result = buildFocusedPrompt("some diff");
    expect(result).not.toContain("Keep your response under");
  });
});

describe("resolveDepth", () => {
  it("uses explicit depth when set", () => {
    expect(resolveDepth({ depth: "scan" })).toBe("scan");
    expect(resolveDepth({ depth: "focused" })).toBe("focused");
    expect(resolveDepth({ depth: "deep" })).toBe("deep");
  });

  it("depth wins over quick when both are set", () => {
    expect(resolveDepth({ depth: "focused", quick: true })).toBe("focused");
    expect(resolveDepth({ depth: "deep", quick: true })).toBe("deep");
    expect(resolveDepth({ depth: "scan", quick: false })).toBe("scan");
  });

  it("legacy quick: true maps to scan", () => {
    expect(resolveDepth({ quick: true })).toBe("scan");
  });

  it("legacy quick: false maps to deep (preserves current agentic default)", () => {
    expect(resolveDepth({ quick: false })).toBe("deep");
  });

  it("defaults to deep when neither depth nor quick is set", () => {
    expect(resolveDepth({})).toBe("deep");
  });
});

describe("scaleTimeoutForDepth", () => {
  const stat = (files: number) => ({ files, insertions: 0, deletions: 0 });

  describe("scan", () => {
    it("is a constant regardless of diff size", () => {
      expect(scaleTimeoutForDepth("scan", stat(0))).toBe(SCAN_TIMEOUT);
      expect(scaleTimeoutForDepth("scan", stat(100))).toBe(SCAN_TIMEOUT);
      expect(scaleTimeoutForDepth("scan", stat(1000))).toBe(SCAN_TIMEOUT);
    });
  });

  describe("focused", () => {
    it("returns the 120s baseline for an empty diff", () => {
      expect(scaleTimeoutForDepth("focused", stat(0))).toBe(120_000);
    });

    it("adds 15s per file to the baseline", () => {
      expect(scaleTimeoutForDepth("focused", stat(1))).toBe(135_000);
      expect(scaleTimeoutForDepth("focused", stat(5))).toBe(195_000);
      expect(scaleTimeoutForDepth("focused", stat(10))).toBe(270_000);
    });

    it("caps at 300s", () => {
      // 120_000 + 15_000 * 12 = 300_000 exactly
      expect(scaleTimeoutForDepth("focused", stat(12))).toBe(300_000);
      expect(scaleTimeoutForDepth("focused", stat(20))).toBe(300_000);
      expect(scaleTimeoutForDepth("focused", stat(1000))).toBe(300_000);
    });

    it("is monotonically non-decreasing", () => {
      let prev = 0;
      for (let n = 0; n <= 30; n++) {
        const t = scaleTimeoutForDepth("focused", stat(n));
        expect(t).toBeGreaterThanOrEqual(prev);
        prev = t;
      }
    });
  });

  describe("deep", () => {
    it("returns the 240s baseline for an empty diff", () => {
      expect(scaleTimeoutForDepth("deep", stat(0))).toBe(240_000);
    });

    it("adds 45s per file to the baseline", () => {
      expect(scaleTimeoutForDepth("deep", stat(1))).toBe(285_000);
      expect(scaleTimeoutForDepth("deep", stat(5))).toBe(465_000);
      expect(scaleTimeoutForDepth("deep", stat(10))).toBe(690_000);
      expect(scaleTimeoutForDepth("deep", stat(15))).toBe(915_000);
    });

    it("caps at HARD_TIMEOUT_CAP (30 min)", () => {
      // 240_000 + 45_000 * 34 = 1_770_000; 35 files gets capped
      expect(scaleTimeoutForDepth("deep", stat(35))).toBe(HARD_TIMEOUT_CAP);
      expect(scaleTimeoutForDepth("deep", stat(100))).toBe(HARD_TIMEOUT_CAP);
      expect(scaleTimeoutForDepth("deep", stat(1000))).toBe(HARD_TIMEOUT_CAP);
    });

    it("is monotonically non-decreasing", () => {
      let prev = 0;
      for (let n = 0; n <= 120; n++) {
        const t = scaleTimeoutForDepth("deep", stat(n));
        expect(t).toBeGreaterThanOrEqual(prev);
        prev = t;
      }
    });
  });
});

describe("defaultTimeoutForDepth", () => {
  it("scan -> SCAN_TIMEOUT (180s)", () => {
    expect(defaultTimeoutForDepth("scan")).toBe(SCAN_TIMEOUT);
    expect(SCAN_TIMEOUT).toBe(180_000);
  });

  it("focused -> FOCUSED_FALLBACK_TIMEOUT (240s)", () => {
    expect(defaultTimeoutForDepth("focused")).toBe(FOCUSED_FALLBACK_TIMEOUT);
    expect(FOCUSED_FALLBACK_TIMEOUT).toBe(240_000);
  });

  it("deep -> AGENTIC_TIMEOUT (600s)", () => {
    expect(defaultTimeoutForDepth("deep")).toBe(AGENTIC_TIMEOUT);
    expect(AGENTIC_TIMEOUT).toBe(600_000);
  });
});

describe("buildLengthLimit", () => {
  it("returns instruction for positive word count", () => {
    expect(buildLengthLimit(500)).toBe("Keep your response under 500 words.");
  });

  it("returns empty string when undefined", () => {
    expect(buildLengthLimit(undefined)).toBe("");
  });

  it("returns empty string when zero", () => {
    expect(buildLengthLimit(0)).toBe("");
  });

  it("returns empty string when negative", () => {
    expect(buildLengthLimit(-10)).toBe("");
  });
});
