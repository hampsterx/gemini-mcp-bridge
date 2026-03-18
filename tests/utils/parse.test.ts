import { describe, it, expect } from "vitest";
import { parseGeminiOutput } from "../../src/utils/parse.js";

describe("parseGeminiOutput", () => {
  it("parses JSON with response field from stdout", () => {
    const json = JSON.stringify({ response: "Hello from Gemini" });
    const result = parseGeminiOutput(json, "");
    expect(result.response).toBe("Hello from Gemini");
  });

  it("parses JSON with text field", () => {
    const json = JSON.stringify({ text: "Some text" });
    const result = parseGeminiOutput(json, "");
    expect(result.response).toBe("Some text");
  });

  it("parses nested result.response", () => {
    const json = JSON.stringify({ result: { response: "Nested response" } });
    const result = parseGeminiOutput(json, "");
    expect(result.response).toBe("Nested response");
  });

  it("handles plain text output", () => {
    const result = parseGeminiOutput("Plain text response", "");
    expect(result.response).toBe("Plain text response");
  });

  it("strips ANSI codes before parsing", () => {
    const result = parseGeminiOutput("\x1B[32mColored text\x1B[0m", "");
    expect(result.response).toBe("Colored text");
  });

  it("handles JSON with ANSI wrapping", () => {
    const json = JSON.stringify({ response: "Clean data" });
    const result = parseGeminiOutput(`\x1B[0m${json}\x1B[0m`, "");
    expect(result.response).toBe("Clean data");
  });

  it("throws on empty output with non-JSON stderr", () => {
    expect(() => parseGeminiOutput("", "Some error")).toThrow(
      "stderr: Some error",
    );
  });

  it("throws on completely empty output", () => {
    expect(() => parseGeminiOutput("", "")).toThrow("no output");
  });

  it("handles JSON array (stream-json collected)", () => {
    const json = JSON.stringify([
      { text: "Part 1" },
      { text: " Part 2" },
    ]);
    const result = parseGeminiOutput(json, "");
    expect(result.response).toBe("Part 1 Part 2");
  });

  it("stringifies unknown JSON structure as fallback", () => {
    const json = JSON.stringify({ unknown_field: 42, another: "val" });
    const result = parseGeminiOutput(json, "");
    expect(result.response).toContain("unknown_field");
    expect(result.response).toContain("42");
  });

  // --output-format json writes to stderr, not stdout
  describe("stderr JSON parsing (--output-format json)", () => {
    it("parses JSON response from stderr when stdout is empty", () => {
      const json = JSON.stringify({
        session_id: "abc-123",
        response: "Review looks good",
        stats: { models: {} },
      });
      const result = parseGeminiOutput("", json);
      expect(result.response).toBe("Review looks good");
    });

    it("parses JSON response from stderr with session_id and stats", () => {
      const json = JSON.stringify({
        session_id: "xyz-789",
        response: "Found 2 issues",
        stats: {
          tools: { totalCalls: 3, totalSuccess: 3 },
        },
      });
      const result = parseGeminiOutput("", json);
      expect(result.response).toBe("Found 2 issues");
    });

    it("prefers stdout JSON over stderr JSON", () => {
      const stdoutJson = JSON.stringify({ response: "from stdout" });
      const stderrJson = JSON.stringify({ response: "from stderr" });
      const result = parseGeminiOutput(stdoutJson, stderrJson);
      expect(result.response).toBe("from stdout");
    });

    it("uses stderr JSON when stdout is non-JSON text", () => {
      const stderrJson = JSON.stringify({ response: "from stderr json" });
      // stdout has info lines that aren't JSON, but stderr has valid JSON
      const result = parseGeminiOutput("Loaded cached credentials.", stderrJson);
      // stderr JSON is preferred over plain-text stdout
      expect(result.response).toBe("from stderr json");
    });

    it("handles stderr JSON with empty response field", () => {
      const json = JSON.stringify({ session_id: "abc", response: "" });
      // Empty string is falsy but valid
      const result = parseGeminiOutput("", json);
      // extractFromJson checks typeof === "string", empty string matches
      expect(result.response).toBe("");
    });
  });
});
