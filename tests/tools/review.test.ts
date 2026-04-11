import { describe, it, expect } from "vitest";
import { loadPrompt, buildLengthLimit } from "../../src/utils/prompts.js";
import {
  buildAgenticPrompt,
  buildQuickPrompt,
  scaleAgenticTimeout,
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

describe("scaleAgenticTimeout", () => {
  const stat = (files: number) => ({ files, insertions: 0, deletions: 0 });

  it("returns the 180s baseline for an empty diff", () => {
    expect(scaleAgenticTimeout(stat(0))).toBe(180_000);
  });

  it("adds 30s per file to the baseline", () => {
    expect(scaleAgenticTimeout(stat(1))).toBe(210_000);
    expect(scaleAgenticTimeout(stat(5))).toBe(330_000);
    expect(scaleAgenticTimeout(stat(15))).toBe(630_000);
    expect(scaleAgenticTimeout(stat(30))).toBe(1_080_000);
  });

  it("caps at HARD_TIMEOUT_CAP (30 min)", () => {
    // 180_000 + 30_000 * 54 = 1_800_000 — exactly at the cap
    expect(scaleAgenticTimeout(stat(54))).toBe(HARD_TIMEOUT_CAP);
    expect(scaleAgenticTimeout(stat(60))).toBe(HARD_TIMEOUT_CAP);
    expect(scaleAgenticTimeout(stat(1000))).toBe(HARD_TIMEOUT_CAP);
  });

  it("is monotonically non-decreasing", () => {
    let prev = 0;
    for (let n = 0; n <= 120; n++) {
      const t = scaleAgenticTimeout(stat(n));
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
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
