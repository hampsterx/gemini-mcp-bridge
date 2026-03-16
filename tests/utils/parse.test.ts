import { describe, it, expect } from "vitest";
import { parseGeminiOutput } from "../../src/utils/parse.js";

describe("parseGeminiOutput", () => {
  it("parses JSON with response field", () => {
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

  it("throws on empty output with stderr", () => {
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
});
