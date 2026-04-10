import { describe, it, expect } from "vitest";
import { buildParser, validateArgs, ParsedArgs } from "../src/options.js";

const URL = "https://profiler.firefox.com/public/abc123";

async function parse(args: string[]): Promise<ParsedArgs> {
  return (await buildParser(args).argv) as ParsedArgs;
}

describe("buildParser", () => {
  describe("defaults", () => {
    it("sets detailed to false", async () => {
      const argv = await parse([URL, "--calltree", "10"]);
      expect(argv.detailed).toBe(false);
    });

    it("sets max-paths to 5", async () => {
      const argv = await parse([URL, "--calltree", "10"]);
      expect(argv.maxPaths).toBe(5);
    });

    it("sets color to false", async () => {
      const argv = await parse([URL, "--calltree", "10"]);
      expect(argv.color).toBe(false);
    });

    it("sets page-load to false", async () => {
      const argv = await parse([URL, "--calltree", "10"]);
      expect(argv.pageLoad).toBe(false);
    });

    it("sets network to false", async () => {
      const argv = await parse([URL, "--calltree", "10"]);
      expect(argv.network).toBe(false);
    });
  });

  describe("positional argument", () => {
    it("captures profile URL as first positional", async () => {
      const argv = await parse([URL, "--calltree", "5"]);
      expect(argv._[0]).toBe(URL);
    });
  });

  describe("--calltree", () => {
    it("parses as number", async () => {
      const argv = await parse([URL, "--calltree", "10"]);
      expect(argv.calltree).toBe(10);
    });

    it("is undefined when not provided", async () => {
      const argv = await parse([URL, "--flamegraph"]);
      expect(argv.calltree).toBeUndefined();
    });
  });

  describe("--focus-function", () => {
    it("parses as string with camelCase key", async () => {
      const argv = await parse([URL, "--calltree", "5", "--focus-function", "myFunc"]);
      expect(argv.focusFunction).toBe("myFunc");
    });

    it("preserves spaces in function names", async () => {
      const argv = await parse([URL, "--calltree", "5", "--focus-function", "Ion: myFunc"]);
      expect(argv.focusFunction).toBe("Ion: myFunc");
    });
  });

  describe("--callers-of", () => {
    it("parses as string with camelCase key", async () => {
      const argv = await parse([URL, "--calltree", "5", "--callers-of", "myFunc"]);
      expect(argv.callersOf).toBe("myFunc");
    });
  });

  describe("--focus-marker", () => {
    it("parses as string with camelCase key", async () => {
      const argv = await parse([URL, "--calltree", "5", "--focus-marker=Jank"]);
      expect(argv.focusMarker).toBe("Jank");
    });

    it("parses comma-separated values with equals syntax", async () => {
      const argv = await parse([URL, "--calltree", "5", "--focus-marker=-async,-sync"]);
      expect(argv.focusMarker).toBe("-async,-sync");
    });
  });

  describe("--flamegraph", () => {
    it("parses depth as number", async () => {
      const argv = await parse([URL, "--flamegraph", "5"]);
      expect(argv.flamegraph).toBe(5);
    });

    it("is undefined when flag is absent", async () => {
      const argv = await parse([URL, "--calltree", "5"]);
      expect(argv.flamegraph).toBeUndefined();
    });
  });

  describe("--detailed", () => {
    it("sets to true when flag is present", async () => {
      const argv = await parse([URL, "--calltree", "5", "--detailed"]);
      expect(argv.detailed).toBe(true);
    });
  });

  describe("--max-paths", () => {
    it("overrides default", async () => {
      const argv = await parse([URL, "--calltree", "5", "--detailed", "--max-paths", "10"]);
      expect(argv.maxPaths).toBe(10);
    });
  });

  describe("--annotate", () => {
    it("accepts 'asm'", async () => {
      const argv = await parse([URL, "--annotate", "asm", "MyFunction"]);
      expect(argv.annotate).toBe("asm");
    });

    it("accepts 'src'", async () => {
      const argv = await parse([URL, "--annotate", "src", "MyFunction"]);
      expect(argv.annotate).toBe("src");
    });

    it("accepts 'all'", async () => {
      const argv = await parse([URL, "--annotate", "all", "MyFunction"]);
      expect(argv.annotate).toBe("all");
    });
  });

  describe("--color", () => {
    it("sets to true when flag is present", async () => {
      const argv = await parse([URL, "--calltree", "5", "--color"]);
      expect(argv.color).toBe(true);
    });
  });

  describe("--samply-path", () => {
    it("parses as string with camelCase key", async () => {
      const argv = await parse([URL, "--calltree", "5", "--samply-path", "/usr/local/bin/samply"]);
      expect(argv.samplyPath).toBe("/usr/local/bin/samply");
    });
  });

  describe("--page-load", () => {
    it("sets to true when flag is present", async () => {
      const argv = await parse([URL, "--page-load"]);
      expect(argv.pageLoad).toBe(true);
    });
  });

  describe("--network", () => {
    it("sets to true when flag is present", async () => {
      const argv = await parse([URL, "--network"]);
      expect(argv.network).toBe(true);
    });
  });

  describe("--top-markers", () => {
    it("parses N as number", async () => {
      const argv = await parse([URL, "--top-markers", "10"]);
      expect(argv.topMarkers).toBe(10);
    });
  });

  describe("--log-markers", () => {
    it("parses filter string with camelCase key", async () => {
      const argv = await parse([URL, "--log-markers", "MDSM"]);
      expect(argv.logMarkers).toBe("MDSM");
    });

    it("is undefined when not provided", async () => {
      const argv = await parse([URL, "--calltree", "5"]);
      expect(argv.logMarkers).toBeUndefined();
    });
  });
});

describe("validateArgs", () => {
  function makeArgv(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
    return {
      _: [URL],
      detailed: false,
      maxPaths: 5,
      pageLoad: false,
      network: false,
      color: false,
      ...overrides,
    };
  }

  it("returns null for valid --calltree args", () => {
    const argv = makeArgv({ calltree: 10 });
    expect(validateArgs(argv, ["--calltree", "10"])).toBeNull();
  });

  it("returns null for valid --flamegraph args", () => {
    const argv = makeArgv();
    expect(validateArgs(argv, ["--flamegraph"])).toBeNull();
  });

  it("returns null for valid --page-load args", () => {
    const argv = makeArgv({ pageLoad: true });
    expect(validateArgs(argv, ["--page-load"])).toBeNull();
  });

  it("returns null for valid --network args", () => {
    const argv = makeArgv({ network: true });
    expect(validateArgs(argv, ["--network"])).toBeNull();
  });

  it("returns null for valid --top-markers args", () => {
    const argv = makeArgv();
    expect(validateArgs(argv, ["--top-markers"])).toBeNull();
  });

  it("returns null for valid --log-markers args", () => {
    const argv = makeArgv({ logMarkers: "" });
    expect(validateArgs(argv, ["--log-markers"])).toBeNull();
  });

  it("returns null for --log-markers with a filter", () => {
    const argv = makeArgv({ logMarkers: "MDSM" });
    expect(validateArgs(argv, ["--log-markers", "MDSM"])).toBeNull();
  });

  it("rejects --log-markers combined with --calltree", () => {
    const argv = makeArgv({ calltree: 10, logMarkers: "" });
    const error = validateArgs(argv, ["--calltree", "10", "--log-markers"]);
    expect(error).toMatch("only one");
  });

  it("requires a profile URL", () => {
    const argv = makeArgv({ _: [] });
    expect(validateArgs(argv, ["--calltree", "10"])).toMatch("profile URL");
  });

  it("requires at least one action flag", () => {
    const argv = makeArgv();
    const error = validateArgs(argv, []);
    expect(error).toMatch("--calltree");
    expect(error).toMatch("--flamegraph");
  });

  it("rejects multiple action flags", () => {
    const argv = makeArgv({ calltree: 10, pageLoad: true });
    const error = validateArgs(argv, ["--calltree", "10", "--page-load"]);
    expect(error).toMatch("only one");
  });

  it("rejects --calltree combined with --flamegraph", () => {
    const argv = makeArgv({ calltree: 10 });
    const error = validateArgs(argv, ["--calltree", "10", "--flamegraph"]);
    expect(error).toMatch("only one");
  });

  it("requires function name with --annotate", () => {
    const argv = makeArgv({ annotate: "asm" });
    const error = validateArgs(argv, ["--annotate", "asm"]);
    expect(error).toMatch("function name");
  });

  it("accepts --annotate with a function name", () => {
    const argv = makeArgv({ annotate: "asm", _: [URL, "MyFunction"] });
    expect(validateArgs(argv, ["--annotate", "asm", "MyFunction"])).toBeNull();
  });

  it("rejects empty --focus-marker value", () => {
    const argv = makeArgv({ calltree: 10, focusMarker: "" });
    const error = validateArgs(argv, ["--calltree", "10", "--focus-marker"]);
    expect(error).toMatch("equals sign syntax");
  });

  it("rejects --focus-marker when value starting with - ends up as positional", () => {
    const argv = makeArgv({ calltree: 10, focusMarker: undefined, _: [URL, "-async,-sync"] });
    const error = validateArgs(argv, ["--calltree", "10", "--focus-marker", "-async,-sync"]);
    expect(error).toMatch("equals sign syntax");
  });
});
