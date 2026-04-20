import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  parseChangeModeOutput,
  ChangeModeParseError,
} from "../../src/utils/changeMode.js";

describe("parseChangeModeOutput", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = realpathSync(await mkdtemp(path.join(os.tmpdir(), "gmb-cm-test-")));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function abs(rel: string): string {
    return path.join(tmpDir, rel);
  }

  it("parses a single edit block with absolute path", async () => {
    await writeFile(abs("sample.ts"), "line1\nline2\nline3\n");
    const text = `**FILE: ${abs("sample.ts")}:2-2**\n===OLD===\nline2\n===NEW===\nNEW_LINE\n`;

    const { edits } = parseChangeModeOutput(text, { workingDirectory: tmpDir });

    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({
      filename: "sample.ts",
      startLine: 2,
      endLine: 2,
      oldCode: "line2",
      newCode: "NEW_LINE",
    });
  });

  it("tolerates prose preamble before the first FILE marker", async () => {
    await writeFile(abs("a.ts"), "foo\nbar\n");
    const text = [
      "I will read the contents of sample.ts and produce edits.",
      "Here are the edit blocks:",
      "",
      `**FILE: ${abs("a.ts")}:1-1**`,
      "OLD:",
      "foo",
      "NEW:",
      "FOO",
    ].join("\n");

    const { edits } = parseChangeModeOutput(text, { workingDirectory: tmpDir });

    expect(edits).toHaveLength(1);
    expect(edits[0].oldCode).toBe("foo");
  });

  it("parses multiple edit blocks across multiple files", async () => {
    await writeFile(abs("a.ts"), "a1\na2\n");
    await writeFile(abs("b.ts"), "b1\nb2\n");
    const text = [
      `**FILE: ${abs("a.ts")}:1-1**`,
      "OLD:",
      "a1",
      "NEW:",
      "A1",
      "",
      `**FILE: ${abs("b.ts")}:2-2**`,
      "OLD:",
      "b2",
      "NEW:",
      "B2",
    ].join("\n");

    const { edits } = parseChangeModeOutput(text, { workingDirectory: tmpDir });

    expect(edits).toHaveLength(2);
    expect(edits.map((e) => e.filename).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("preserves internal blank lines in OLD and NEW sections", async () => {
    await writeFile(abs("c.ts"), "line1\n\nline3\n");
    const text = [
      `**FILE: ${abs("c.ts")}:1-3**`,
      "OLD:",
      "line1",
      "",
      "line3",
      "NEW:",
      "NEW1",
      "",
      "NEW3",
    ].join("\n");

    const { edits } = parseChangeModeOutput(text, { workingDirectory: tmpDir });

    expect(edits[0].oldCode).toBe("line1\n\nline3");
    expect(edits[0].newCode).toBe("NEW1\n\nNEW3");
  });

  it("accepts bare **FILE: <path>** and infers line range from content", async () => {
    await writeFile(abs("d.ts"), "one\ntwo\nthree\nfour\n");
    const text = [
      `**FILE: ${abs("d.ts")}**`,
      "OLD:",
      "two",
      "three",
      "NEW:",
      "TWO",
      "THREE",
    ].join("\n");

    const { edits } = parseChangeModeOutput(text, { workingDirectory: tmpDir });

    expect(edits).toHaveLength(1);
    expect(edits[0].startLine).toBe(2);
    expect(edits[0].endLine).toBe(3);
    expect(edits[0].oldCode).toBe("two\nthree");
  });

  it("rejects bare header when OLD code is not found in the file", async () => {
    await writeFile(abs("e.ts"), "only\nthese\nlines\n");
    const text = [
      `**FILE: ${abs("e.ts")}**`,
      "OLD:",
      "nonexistent",
      "NEW:",
      "replacement",
    ].join("\n");

    expect(() => parseChangeModeOutput(text, { workingDirectory: tmpDir }))
      .toThrow(ChangeModeParseError);
  });

  it("rejects path outside working directory", async () => {
    const outsideDir = realpathSync(await mkdtemp(path.join(os.tmpdir(), "gmb-cm-outside-")));
    try {
      await writeFile(path.join(outsideDir, "bad.ts"), "x\n");
      const text = [
        `**FILE: ${path.join(outsideDir, "bad.ts")}:1-1**`,
        "OLD:",
        "x",
        "NEW:",
        "X",
      ].join("\n");

      expect(() => parseChangeModeOutput(text, { workingDirectory: tmpDir }))
        .toThrow(/traversal/);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects nonexistent file path", async () => {
    const text = [
      `**FILE: ${abs("does-not-exist.ts")}:1-1**`,
      "OLD:",
      "x",
      "NEW:",
      "X",
    ].join("\n");

    expect(() => parseChangeModeOutput(text, { workingDirectory: tmpDir }))
      .toThrow(/not found/);
  });

  it("throws when no edit blocks are found", () => {
    expect(() => parseChangeModeOutput("just prose, no edit blocks here.", {
      workingDirectory: tmpDir,
    })).toThrow(/No edit blocks found/);
  });

  it("throws on missing OLD marker", async () => {
    await writeFile(abs("f.ts"), "x\n");
    const text = [
      `**FILE: ${abs("f.ts")}:1-1**`,
      "NEW:",
      "X",
    ].join("\n");

    expect(() => parseChangeModeOutput(text, { workingDirectory: tmpDir }))
      .toThrow(/Missing OLD/);
  });

  it("throws on missing NEW marker", async () => {
    await writeFile(abs("g.ts"), "x\n");
    const text = [
      `**FILE: ${abs("g.ts")}:1-1**`,
      "OLD:",
      "x",
    ].join("\n");

    expect(() => parseChangeModeOutput(text, { workingDirectory: tmpDir }))
      .toThrow(/Missing NEW/);
  });

  it("throws when both OLD and NEW sections are empty", async () => {
    await writeFile(abs("h.ts"), "x\n");
    const text = [
      `**FILE: ${abs("h.ts")}:1-1**`,
      "OLD:",
      "",
      "NEW:",
      "",
    ].join("\n");

    expect(() => parseChangeModeOutput(text, { workingDirectory: tmpDir }))
      .toThrow(/Empty OLD.*NEW/);
  });

  it("throws on invalid line range (endLine < startLine)", async () => {
    await writeFile(abs("i.ts"), "a\nb\nc\n");
    const text = [
      `**FILE: ${abs("i.ts")}:5-2**`,
      "OLD:",
      "a",
      "NEW:",
      "A",
    ].join("\n");

    expect(() => parseChangeModeOutput(text, { workingDirectory: tmpDir }))
      .toThrow(/Invalid line range/);
  });

  it("rejects overlapping edits within the same file", async () => {
    await writeFile(abs("j.ts"), "l1\nl2\nl3\nl4\nl5\n");
    const text = [
      `**FILE: ${abs("j.ts")}:1-3**`,
      "OLD:",
      "l1\nl2\nl3",
      "NEW:",
      "X",
      "",
      `**FILE: ${abs("j.ts")}:3-4**`,
      "OLD:",
      "l3\nl4",
      "NEW:",
      "Y",
    ].join("\n");

    expect(() => parseChangeModeOutput(text, { workingDirectory: tmpDir }))
      .toThrow(/Overlapping edits/);
  });

  it("allows non-overlapping edits in the same file", async () => {
    await writeFile(abs("k.ts"), "l1\nl2\nl3\nl4\nl5\n");
    const text = [
      `**FILE: ${abs("k.ts")}:1-1**`,
      "OLD:",
      "l1",
      "NEW:",
      "X",
      "",
      `**FILE: ${abs("k.ts")}:3-3**`,
      "OLD:",
      "l3",
      "NEW:",
      "Y",
    ].join("\n");

    const { edits } = parseChangeModeOutput(text, { workingDirectory: tmpDir });
    expect(edits).toHaveLength(2);
  });

  it("returns paths relative to working directory", async () => {
    await mkdir(abs("nested"), { recursive: true });
    await writeFile(abs("nested/file.ts"), "x\n");
    const text = [
      `**FILE: ${abs("nested/file.ts")}:1-1**`,
      "OLD:",
      "x",
      "NEW:",
      "X",
    ].join("\n");

    const { edits } = parseChangeModeOutput(text, { workingDirectory: tmpDir });
    expect(edits[0].filename).toBe(path.join("nested", "file.ts"));
  });

  it("accepts allowed-one-empty sections (OLD empty, NEW populated)", async () => {
    // Anchor pattern for insertions: OLD can be empty IF NEW is not, though
    // the prompt tells Gemini to use an anchor line. Parser just needs to
    // allow the case where exactly one side is empty.
    await writeFile(abs("m.ts"), "existing\n");
    const text = [
      `**FILE: ${abs("m.ts")}:1-1**`,
      "OLD:",
      "",
      "NEW:",
      "added",
    ].join("\n");

    const { edits } = parseChangeModeOutput(text, { workingDirectory: tmpDir });
    expect(edits[0].oldCode).toBe("");
    expect(edits[0].newCode).toBe("added");
  });

  it("fenced markers tolerate 'NEW:' inside OLD content (marker-collision fix)", async () => {
    // YAML/config file where the literal line 'NEW:' appears inside the code
    // being edited. The legacy 'OLD:' / 'NEW:' markers would truncate the
    // OLD section at that line; the fenced '===OLD===' / '===NEW===' markers
    // tell the parser to ignore stray legacy markers inside the block.
    await writeFile(abs("cfg.yaml"), "OLD:\n  val: 1\nNEW:\n  val: 2\n");
    const text = [
      `**FILE: ${abs("cfg.yaml")}:1-4**`,
      "===OLD===",
      "OLD:",
      "  val: 1",
      "NEW:",
      "  val: 2",
      "===NEW===",
      "OLD:",
      "  val: 10",
      "NEW:",
      "  val: 20",
    ].join("\n");

    const { edits } = parseChangeModeOutput(text, { workingDirectory: tmpDir });
    expect(edits).toHaveLength(1);
    expect(edits[0].oldCode).toBe("OLD:\n  val: 1\nNEW:\n  val: 2");
    expect(edits[0].newCode).toBe("OLD:\n  val: 10\nNEW:\n  val: 20");
  });

  it("legacy OLD:/NEW: markers still parse for backwards compatibility", async () => {
    await writeFile(abs("legacy.ts"), "one\n");
    const text = [
      `**FILE: ${abs("legacy.ts")}:1-1**`,
      "OLD:",
      "one",
      "NEW:",
      "ONE",
    ].join("\n");

    const { edits } = parseChangeModeOutput(text, { workingDirectory: tmpDir });
    expect(edits).toHaveLength(1);
    expect(edits[0].oldCode).toBe("one");
    expect(edits[0].newCode).toBe("ONE");
  });

  it("rejects explicit range where OLD block does not match file contents", async () => {
    // Hallucinated line numbers: Gemini claims lines 2-3 but the file at
    // 2-3 is 'bravo\ncharlie'. If we accepted this, downstream applicators
    // would replace the wrong lines.
    await writeFile(abs("mismatch.ts"), "alpha\nbravo\ncharlie\n");
    const text = [
      `**FILE: ${abs("mismatch.ts")}:2-3**`,
      "===OLD===",
      "hallucinated content",
      "with wrong text",
      "===NEW===",
      "replacement",
    ].join("\n");

    expect(() => parseChangeModeOutput(text, { workingDirectory: tmpDir }))
      .toThrow(/does not match file contents/);
  });

  it("rejects explicit range extending past EOF", async () => {
    await writeFile(abs("short.ts"), "only\ntwo\nlines\n");
    const text = [
      `**FILE: ${abs("short.ts")}:1-99**`,
      "===OLD===",
      "only",
      "===NEW===",
      "ONLY",
    ].join("\n");

    expect(() => parseChangeModeOutput(text, { workingDirectory: tmpDir }))
      .toThrow(/cannot read file to verify OLD block/);
  });

  it("rejects bare header with empty OLD section (don't silently anchor to line 1)", async () => {
    // Regression: `indexOf("")` returns 0 and would pin the edit to line 1.
    // With NEW populated this is otherwise "insert" semantics but without an
    // explicit line range we can't tell where to insert, so reject.
    await writeFile(abs("empty-old.ts"), "one\ntwo\n");
    const text = [
      `**FILE: ${abs("empty-old.ts")}**`,
      "===OLD===",
      "",
      "===NEW===",
      "inserted",
    ].join("\n");

    expect(() => parseChangeModeOutput(text, { workingDirectory: tmpDir }))
      .toThrow(/could not locate OLD block/);
  });

  it("bare header matches a CRLF-encoded file via file-side normalisation", async () => {
    // Regression: inferRangeFromContent used to read the file raw. A CRLF
    // file + LF-normalised oldCode = indexOf miss + bogus "could not locate".
    await writeFile(abs("crlf-file.ts"), "alpha\r\nbravo\r\ncharlie\r\n");
    const text = [
      `**FILE: ${abs("crlf-file.ts")}**`,
      "===OLD===",
      "alpha",
      "bravo",
      "===NEW===",
      "ALPHA",
      "BRAVO",
    ].join("\n");

    const { edits } = parseChangeModeOutput(text, { workingDirectory: tmpDir });
    expect(edits).toHaveLength(1);
    expect(edits[0].startLine).toBe(1);
    expect(edits[0].endLine).toBe(2);
  });

  it("normalises CRLF line endings in Gemini output", async () => {
    // Regression: text.split("\n") leaves trailing \r characters in oldCode,
    // which would break downstream exact-match applicators on any file read
    // with LF endings.
    await writeFile(abs("crlf.ts"), "alpha\nbravo\n");
    const text = [
      `**FILE: ${abs("crlf.ts")}:1-1**`,
      "===OLD===",
      "alpha",
      "===NEW===",
      "ALPHA",
    ].join("\r\n");

    const { edits } = parseChangeModeOutput(text, { workingDirectory: tmpDir });
    expect(edits).toHaveLength(1);
    expect(edits[0].oldCode).toBe("alpha");
    expect(edits[0].newCode).toBe("ALPHA");
    expect(edits[0].oldCode).not.toContain("\r");
    expect(edits[0].newCode).not.toContain("\r");
  });

  it("throws on unparseable FILE header line range", async () => {
    await writeFile(abs("n.ts"), "x\n");
    const text = [
      `**FILE: ${abs("n.ts")}:abc-def**`,
      "OLD:",
      "x",
      "NEW:",
      "X",
    ].join("\n");

    // The header has text where digits should be, so neither range nor bare
    // pattern matches. The parser currently treats it as a malformed range.
    expect(() => parseChangeModeOutput(text, { workingDirectory: tmpDir }))
      .toThrow();
  });
});
