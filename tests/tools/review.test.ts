import { describe, it, expect } from "vitest";
import { loadPrompt, buildLengthLimit } from "../../src/utils/prompts.js";
import {
  buildAgenticPrompt,
  buildQuickPrompt,
  buildFocusedPrompt,
  stripReviewPreamble,
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

  it("forbids narration and repo-wide drift in final output", () => {
    const result = buildAgenticPrompt("git diff HEAD");
    expect(result).toContain("Do not narrate tool usage");
    expect(result).toContain('prefer "No significant findings." over speculative suggestions');
    expect(result).toContain("Start immediately with the first finding");
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

  it("forbids planning narration and requires changed-file anchoring", () => {
    const result = buildFocusedPrompt("diff");
    expect(result).toContain("Return findings only");
    expect(result).toContain("Every finding must be tied to a changed file");
    expect(result).toContain("Start immediately with the first finding");
  });
});

describe("stripReviewPreamble", () => {
  it("strips a leading narration preamble before the first finding", () => {
    const response = [
      "## Summary",
      "I will inspect the changed files first.",
      "Then I'll look for regressions.",
      "",
      "**Severity**: warning",
      "**File**: src/tools/review.ts",
      "**Line**: 120",
      "**Issue**: The parser drops timeout context.",
      "**Suggestion**: Preserve the prefix.",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe([
      "**Severity**: warning",
      "**File**: src/tools/review.ts",
      "**Line**: 120",
      "**Issue**: The parser drops timeout context.",
      "**Suggestion**: Preserve the prefix.",
    ].join("\n"));
  });

  it("preserves timeout prefixes while stripping narration", () => {
    const response = [
      "[Partial response, timed out after 120s on 4-file diff (+10 / -2); consider depth: \"scan\" or narrow the base]",
      "",
      "### Plan",
      "I am going to inspect the changed files first.",
      "",
      "No significant findings.",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe([
      "[Partial response, timed out after 120s on 4-file diff (+10 / -2); consider depth: \"scan\" or narrow the base]",
      "No significant findings.",
    ].join("\n"));
  });

  it("leaves substantive review content unchanged when there is no narration preamble", () => {
    const response = [
      "**Severity**: warning",
      "**File**: src/tools/review.ts",
      "**Line**: 88",
      "**Issue**: Diff parsing can return duplicate entries.",
      "**Suggestion**: Deduplicate before formatting.",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe(response);
  });

  it("does not strip ambiguous prose before a finding", () => {
    const response = [
      "The diff mostly looks good, but there is one defect worth fixing.",
      "",
      "**Severity**: warning",
      "**File**: src/tools/review.ts",
      "**Line**: 88",
      "**Issue**: Diff parsing can return duplicate entries.",
      "**Suggestion**: Deduplicate before formatting.",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe(response);
  });

  it("preserves verdict lines that begin with review phrasing", () => {
    const response = [
      "I reviewed the changed files and found no significant issues.",
      "Residual risk: this still depends on runtime config matching production.",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe(response);
  });

  it("preserves a prose finding that starts with 'First,'", () => {
    const response = [
      "First, the null check is backwards and can never guard the dereference.",
      "",
      "This will throw before the fallback path runs.",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe(response);
  });

  it("preserves verdict-style summaries that lead into a finding", () => {
    const response = [
      "I reviewed the diff and found one warning:",
      "",
      "**Severity**: warning",
      "**File**: src/tools/review.ts",
      "**Line**: 88",
      "**Issue**: Diff parsing can return duplicate entries.",
      "**Suggestion**: Deduplicate before formatting.",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe(response);
  });

  it("strips narration before a '### Verdict:' heading", () => {
    const response = [
      "I will begin by gathering context on the changes.",
      "I will read the project's AGENTS.md and the modified files.",
      "",
      "### Verdict: Critical issues found",
      "",
      "#### Severity: critical",
      "The handler swallows the error.",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe([
      "### Verdict: Critical issues found",
      "",
      "#### Severity: critical",
      "The handler swallows the error.",
    ].join("\n"));
  });

  it("strips narration before a '#### Verdict:' heading", () => {
    const response = [
      "I will now read the full contents of src/tools/query.ts.",
      "",
      "#### Verdict: No issues",
      "",
      "The diff looks clean.",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe([
      "#### Verdict: No issues",
      "",
      "The diff looks clean.",
    ].join("\n"));
  });

  it("strips narration before a '## Verdict' heading with no colon", () => {
    const response = [
      "Let me inspect the test file first.",
      "",
      "## Verdict",
      "",
      "Nothing to flag.",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe([
      "## Verdict",
      "",
      "Nothing to flag.",
    ].join("\n"));
  });

  it("leaves a response that starts directly with a Verdict heading unchanged", () => {
    const response = [
      "### Verdict: No issues",
      "",
      "Nothing to flag.",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe(response);
  });

  it("leaves a Verdict heading inside a code fence alone when there is no narration preamble", () => {
    const response = [
      "```",
      "### Verdict: foo",
      "```",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe(response);
  });

  it("does not anchor on a Verdict heading buried inside a fenced code block", () => {
    const response = [
      "I will begin by reading the fixtures.",
      "",
      "```",
      "### Verdict: foo",
      "```",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe(response);
  });

  it("does not anchor on prose that mentions a verdict", () => {
    const response = [
      "I will start with the diff.",
      "",
      "My verdict is that this is broken.",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe(response);
  });

  it("does not anchor on a blockquoted Verdict heading", () => {
    // The trailing Severity marker is a real body-start. If the regex wrongly
    // matched `> ### Verdict`, narration would strip and output would begin at
    // the blockquoted line. Expecting the full original proves the `^\s*#`
    // anchor correctly rejects the `>` prefix.
    const response = [
      "I will start with the diff.",
      "",
      "> ### Verdict: Critical",
      "",
      "**Severity**: critical",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe(response);
  });

  it("preserves a partial-response prefix while stripping narration before a Verdict heading", () => {
    const response = [
      "[Partial response, timed out after 180s]",
      "",
      "I will begin by gathering context.",
      "",
      "### Verdict: Critical issues found",
      "",
      "The handler swallows the error.",
    ].join("\n");

    expect(stripReviewPreamble(response)).toBe([
      "[Partial response, timed out after 180s]",
      "### Verdict: Critical issues found",
      "",
      "The handler swallows the error.",
    ].join("\n"));
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
