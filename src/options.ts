import yargs from "yargs/yargs";

export function buildParser(args: string[]) {
  return yargs(args)
    .parserConfiguration({
      "greedy-arrays": false,
      "short-option-groups": false,
    })
    .usage("Extract information from Firefox Profiler profiles.\n\nUsage: $0 <profile-url>\n       $0 --ai (for AI documentation)")
    .option("calltree", {
      describe: "Get top N functions by self time",
      type: "number",
    })
    .option("focus-function", {
      describe: "Focus on a function's subtree (show what it calls), equivalent to 'Focus on subtree only' in the Firefox Profiler UI",
      type: "string",
    })
    .option("callers-of", {
      describe: "Show callers of a function (inverted call tree focused on this function)",
      type: "string",
    })
    .option("focus-marker", {
      describe: "Filter samples to only include those within markers matching this string (use = syntax for values starting with -)",
      type: "string",
    })
    .option("top-markers", {
      describe: "Show top 5 markers by total duration and by max duration (default), or top N markers by frequency if N is specified",
      type: "number",
    })
    .option("detailed", {
      describe: "Show detailed call paths for each function",
      type: "boolean",
      default: false,
    })
    .option("max-paths", {
      describe: "Maximum number of call paths to show in detailed mode",
      type: "number",
      default: 5,
    })
    .option("flamegraph", {
      describe: "Show flamegraph-style tree view of call stacks (optional: max depth)",
      type: "number",
    })
    .option("page-load", {
      describe: "Show page load performance summary with key metrics",
      type: "boolean",
      default: false,
    })
    .option("network", {
      describe: "Show detailed network resource timing information",
      type: "boolean",
      default: false,
    })
    .option("ai", {
      describe: "Show AI-focused documentation",
      type: "boolean",
    })
    .option("annotate", {
      describe: "Annotate function with assembly (asm), source (src), or both (all). Requires function name as positional argument.",
      type: "string",
      choices: ["asm", "src", "all"],
    })
    .option("color", {
      describe: "Enable color coding: source lines in cyan, hotspots (high sample counts) in yellow/red",
      type: "boolean",
      default: false,
    })
    .option("collapse-function", {
      describe: "Collapse a function and its subtree into a single node",
      type: "string",
    })
    .option("log-markers", {
      describe: "Show Log-type markers (from about:logging captures) with their text payload. Optionally filter by keyword",
      type: "string",
    })
    .option("samply-path", {
      describe: "Path to samply binary (default: use samply from PATH)",
      type: "string",
    })
    .help();
}

export type ParsedArgs = {
  _: (string | number)[];
  calltree?: number;
  focusFunction?: string;
  callersOf?: string;
  focusMarker?: string;
  topMarkers?: number;
  detailed: boolean;
  maxPaths: number;
  flamegraph?: number;
  pageLoad: boolean;
  network: boolean;
  ai?: boolean;
  annotate?: string;
  color: boolean;
  collapseFunction?: string;
  logMarkers?: string;
  samplyPath?: string;
};

export function validateArgs(argv: ParsedArgs, rawArgs: string[]): string | null {
  if (!argv._[0]) {
    return "Please provide a profile URL";
  }

  if (argv.focusMarker === '' || (argv.focusMarker === undefined && argv._.length > 1 && typeof argv._[1] === 'string' && (argv._[1] as string).startsWith('-'))) {
    return "Error: When using --focus-marker with a value starting with '-', use the equals sign syntax:\n  --focus-marker=\"-async,-sync\"\n\nInstead of:\n  --focus-marker \"-async,-sync\"";
  }

  const hasTopMarkersFlag = rawArgs.includes('--top-markers');
  const hasFlamegraphFlag = rawArgs.includes('--flamegraph');
  const hasLogMarkersFlag = rawArgs.includes('--log-markers');

  if (!argv.calltree && !hasTopMarkersFlag && !hasFlamegraphFlag && !argv.pageLoad && !argv.network && !argv.annotate && !hasLogMarkersFlag) {
    return "Please specify one of: --calltree <N>, --flamegraph, --top-markers [N], --page-load, --network, --log-markers [filter], or --annotate <asm|src|all> <function-name>";
  }

  const optionCount = [argv.calltree, hasTopMarkersFlag, hasFlamegraphFlag, argv.pageLoad, argv.network, argv.annotate, hasLogMarkersFlag].filter(x => x !== undefined && x !== false).length;
  if (optionCount > 1) {
    return "Please specify only one of: --calltree, --flamegraph, --top-markers, --page-load, --network, --log-markers, or --annotate";
  }

  if (argv.annotate && !argv._[1]) {
    return "--annotate requires a function name as argument";
  }

  return null;
}
