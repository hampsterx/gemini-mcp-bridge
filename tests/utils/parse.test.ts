import { describe, it, expect } from "vitest";
import { parseGeminiOutput, extractJson, parseStreamJson, tryParsePartial } from "../../src/utils/parse.js";

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

describe("extractJson", () => {
  it("parses direct JSON string", () => {
    const result = extractJson('{"name": "John", "age": 30}');
    expect(result).not.toBeNull();
    expect(result!.json).toEqual({ name: "John", age: 30 });
  });

  it("parses JSON array", () => {
    const result = extractJson('[1, 2, 3]');
    expect(result).not.toBeNull();
    expect(result!.json).toEqual([1, 2, 3]);
  });

  it("extracts JSON from markdown code fences", () => {
    const text = '```json\n{"name": "John"}\n```';
    const result = extractJson(text);
    expect(result).not.toBeNull();
    expect(result!.json).toEqual({ name: "John" });
  });

  it("extracts JSON from untyped code fences", () => {
    const text = '```\n{"name": "John"}\n```';
    const result = extractJson(text);
    expect(result).not.toBeNull();
    expect(result!.json).toEqual({ name: "John" });
  });

  it("extracts JSON with preamble and postamble text", () => {
    const text = 'Here is the result:\n{"name": "John", "age": 30}\nHope that helps!';
    const result = extractJson(text);
    expect(result).not.toBeNull();
    expect(result!.json).toEqual({ name: "John", age: 30 });
  });

  it("handles nested braces in string values", () => {
    const json = '{"template": "Hello {name}", "count": 1}';
    const result = extractJson(json);
    expect(result).not.toBeNull();
    expect(result!.json).toEqual({ template: "Hello {name}", count: 1 });
  });

  it("returns null for non-JSON text", () => {
    const result = extractJson("This is just plain text with no JSON");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    const result = extractJson("");
    expect(result).toBeNull();
  });

  it("returns null for text exceeding 1MB", () => {
    const text = "x".repeat(1_000_001);
    const result = extractJson(text);
    expect(result).toBeNull();
  });

  it("extracts array from surrounding text", () => {
    const text = 'The results are: [{"id": 1}, {"id": 2}] as requested.';
    const result = extractJson(text);
    expect(result).not.toBeNull();
    expect(result!.json).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("returns raw string matching the extracted JSON", () => {
    const text = 'Preamble\n```json\n{"key": "value"}\n```\nPostamble';
    const result = extractJson(text);
    expect(result).not.toBeNull();
    expect(result!.raw).toBe('{"key": "value"}');
  });
});

describe("parseStreamJson", () => {
  it("returns eventCount from stream-json lines", () => {
    const stdout = [
      '{"type":"init","session_id":"abc"}',
      '{"type":"message","role":"user","content":"hi"}',
      '{"type":"message","role":"assistant","content":"Hello "}',
      '{"type":"message","role":"assistant","content":"world"}',
      '{"type":"result","response":"Hello world","stats":{}}',
    ].join("\n");

    const result = parseStreamJson(stdout, "");
    expect(result.response).toBe("Hello world");
    expect(result.eventCount).toBe(5);
  });

  it("returns eventCount when result line is missing (partial)", () => {
    const stdout = [
      '{"type":"init","session_id":"abc"}',
      '{"type":"message","role":"assistant","content":"partial "}',
      '{"type":"message","role":"assistant","content":"response"}',
    ].join("\n");

    const result = parseStreamJson(stdout, "");
    expect(result.response).toBe("partial response");
    expect(result.eventCount).toBe(3);
  });

  it("returns undefined eventCount for legacy JSON fallback", () => {
    const stderr = JSON.stringify({ response: "legacy output" });
    const result = parseStreamJson("", stderr);
    expect(result.response).toBe("legacy output");
    expect(result.eventCount).toBeUndefined();
  });
});

describe("tryParsePartial", () => {
  it("returns structured result with eventCount", () => {
    const stdout = [
      '{"type":"init","session_id":"abc"}',
      '{"type":"message","role":"assistant","content":"partial content"}',
    ].join("\n");

    const result = tryParsePartial(stdout, "", 30_000);
    expect(result.text).toContain("[Partial response, timed out after 30s]");
    expect(result.text).toContain("partial content");
    expect(result.eventCount).toBe(2);
  });

  it("returns zero eventCount when no content captured", () => {
    const result = tryParsePartial("", "", 25_000);
    expect(result.text).toContain("Timed out after 25s with no response");
    expect(result.eventCount).toBe(0);
  });
});
