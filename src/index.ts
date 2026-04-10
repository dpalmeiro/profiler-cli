#!/usr/bin/env node
import { hideBin } from "yargs/helpers";
import { chromium, firefox } from "playwright";
import { getCallTreeData, getMarkerSummary, getLogMarkers, getFlamegraphData, getPageLoadSummary, getNetworkResources, annotateFunction } from "./profiler.js";
import { FlameNode } from "./types.js";
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { buildParser, validateArgs, ParsedArgs } from "./options.js";

const argv = (await buildParser(hideBin(process.argv)).argv) as ParsedArgs;

if (argv.ai) {
  console.log(`
# profiler-cli: AI Usage Guide

## Purpose
Extract performance data from Firefox Profiler profiles to analyze browser performance bottlenecks.
Both Firefox Profiler share URLs and local .json.gz profile files are supported.

## Options Reference

### --calltree N
Returns the top N functions sorted by self time (time spent in the function itself, excluding callees).
This uses an inverted call tree internally, so each root node is a leaf function with high self time.

\`\`\`bash
profiler-cli <profile> --calltree 10
\`\`\`

Output:
  Collected 2197 total nodes
  Top 10 functions by self time:
  1. __psynch_cvwait - 12641 samples (12641 total)
  2. free - 195 samples (195 total)
  ...

### --detailed
Adds full call stack paths to each function in --calltree output. Each path shows the complete
call chain from the function up to the root, with sample counts and percentages. Use --max-paths
to control how many paths are shown per function (default: 5).

\`\`\`bash
profiler-cli <profile> --calltree 5 --detailed
profiler-cli <profile> --calltree 5 --detailed --max-paths 10
\`\`\`

Output (per function):
  1. free - 195 samples (195 total)

     Call path #1 - 9 samples (4.6% of this function):
       free
       nsPurpleBuffer::VisitEntries<SnowWhiteKiller>(SnowWhiteKiller&)
       nsCycleCollector::FreeSnowWhiteWithBudget(JS::SliceBudget&)
       ...
       start

     [167 more call paths, accounting for 173 samples]

### --callers-of NAME
Shows callers of a specific function using a focused inverted call tree. The named function becomes
the root and its callers appear as its children, recursively showing the full call graph that leads
to this function. Use this to answer "what calls X?" and "how much of X's time comes from each caller?".

Function name matching strips C++ generic type parameters, so "servo_arc::Arc::drop_slow" will match
"servo_arc::Arc<T>::drop_slow". Also strips parameter lists when the query has none.

\`\`\`bash
profiler-cli <profile> --calltree 10 --callers-of "malloc"
profiler-cli <profile> --calltree 5 --callers-of "style::properties::cascade::cascade_rules"
profiler-cli <profile> --calltree 5 --callers-of "malloc" --focus-marker="-async,-sync"
\`\`\`

Output:
  Collected 130 total nodes
  Top 5 functions by self time (callers-of: "style::properties::cascade::cascade_rules"):
  1. style::properties::cascade::cascade_rules - 105 samples (105 total)
  2. style::properties::generated::StyleBuilder::build - 59 samples (59 total)
  ...

### --collapse-function NAME
Collapses a function and its entire subtree into a single leaf node. All time spent inside
that function and anything it calls becomes self time on that one node. Useful for suppressing
noise from well-understood or irrelevant functions so they don't dominate the call tree.

\`\`\`bash
profiler-cli <profile> --calltree 10 --collapse-function "servo_arc::Arc::drop_slow"
profiler-cli <profile> --calltree 5 --focus-marker="-async,-sync" --collapse-function "servo_arc::Arc::drop_slow"
\`\`\`

Output shows the collapsed function with all its subtree's samples merged into its self time:
  1. servo_arc::Arc<T>::drop_slow - 127 samples (127 total)   <- was previously spread across many children

### --focus-function NAME
Combines --collapse-function with an exclusive focus on that single node. The function's subtree
is collapsed, and then only that function appears in the output (1 total node). With --detailed,
shows the full caller chains leading up to that function, revealing all the code paths that call it
and how many samples each contributes.

Use this to deeply inspect a specific function: first understand how much total time it takes
(with the subtree collapsed), then understand who calls it and from what context (with --detailed).

\`\`\`bash
# Show the function as a single collapsed node with total self time
profiler-cli <profile> --calltree 5 --focus-function "servo_arc::Arc::drop_slow"

# Add a marker filter to restrict to a time period
profiler-cli <profile> --calltree 5 --focus-marker="-async,-sync" --focus-function "servo_arc::Arc::drop_slow"

# Show full caller chains with sample counts per path
profiler-cli <profile> --calltree 5 --focus-function "servo_arc::Arc::drop_slow" --detailed

# Combine all three
profiler-cli <profile> --calltree 5 --focus-marker="-async,-sync" --focus-function "servo_arc::Arc::drop_slow" --detailed --max-paths 10
\`\`\`

Output (without --detailed):
  Collected 1 total nodes
  Top 5 functions by self time (focus: "servo_arc::Arc::drop_slow", marker: "-async,-sync"):
  1. servo_arc::Arc<T>::drop_slow - 127 samples (127 total)

Output (with --detailed):
  1. servo_arc::Arc<T>::drop_slow - 127 samples (127 total)

     Call path #1 - 14 samples (11.0% of this function):
       servo_arc::Arc<T>::drop_slow
       style::style_resolver::StyleResolverForElement<E>::resolve_style
       style::parallel::style_trees
       geckoservo::glue::traverse_subtree
       ...
       start

### --focus-marker FILTER
Filters samples to only those recorded within markers whose name contains the filter string.
Multiple comma-separated patterns can be specified. Applies before all other analysis.

When the filter value starts with '-', use equals sign syntax to prevent it being parsed as a flag:
  --focus-marker="-async,-sync"   (correct)
  --focus-marker "-async,-sync"   (wrong: -async will be parsed as a flag)

\`\`\`bash
profiler-cli <profile> --calltree 10 --focus-marker "Jank"
profiler-cli <profile> --calltree 10 --focus-marker="-async,-sync"
profiler-cli <profile> --calltree 5 --focus-marker="-async,-sync" --callers-of "malloc"
\`\`\`

For Speedometer profiles, always use --focus-marker="-async,-sync" to exclude the async idle time
between benchmark iterations and focus only on the synchronous benchmark work.

### --flamegraph [N]
Shows a top-down flamegraph-style tree view of call stacks. Each node shows its function name,
percentage of total samples, and sample count. Children are sorted by sample count descending.
Optionally limit output to N levels deep to reduce noise for large profiles.

\`\`\`bash
profiler-cli <profile> --flamegraph
profiler-cli <profile> --flamegraph 5
profiler-cli <profile> --flamegraph 8 --focus-marker="-async,-sync"
\`\`\`

Output:
  Flamegraph (max depth: 5):
  start (100.0%, 22215 samples)
  └─ main (100.0%, 22215 samples)
     └─ XRE_InitChildProcess(...) (100.0%, 22215 samples)
        ├─ MessageLoop::Run() (99.8%, 22168 samples)
        │  └─ XRE_RunAppShell() (99.8%, 22168 samples)
        └─ mozilla::dom::ContentProcess::Init(...) (0.2%, 45 samples)

### --top-markers [N]
Shows markers sorted by total duration and by max single-instance duration. Default shows top 5
in each category. Specify N to show top N markers. Useful for identifying which operations take
the most time overall and which individual instances are the slowest.

\`\`\`bash
profiler-cli <profile> --top-markers
profiler-cli <profile> --top-markers 20
\`\`\`

Output:
  Total unique markers: 110

  Top 5 markers by total duration:
  1. suite-NewsSite-Nuxt-prepare - 5209.82 ms total (count: 100, avg: 52.10 ms)
  ...

  Top 5 markers by max single instance duration:
  1. iteration-0 - 148.45 ms max (total: 148.45 ms, count: 1)
  ...

### --page-load
Comprehensive page load performance summary. Extracts navigation timing events (FCP, Load),
resource loading statistics with a breakdown by type, CPU time by category, and jank periods
(long tasks that block the main thread) with the top functions responsible for each jank.

\`\`\`bash
profiler-cli <profile> --page-load
\`\`\`

Output includes:
- URL being loaded
- Visual ASCII timeline showing FCP and Load relative to each other
- Navigation timing: FCP and Load event times in ms
- Resource summary: total count, average/max duration, breakdown by type (JS/CSS/Image/Font/Other)
- Top 10 slowest resources by duration
- CPU category breakdown: % time in JavaScript, Layout, DOM, GC, Graphics, etc.
- Jank periods: start time, duration, top functions by sample count, category breakdown

### --network
Detailed network resource timing. Shows every network request with its full phase breakdown
matching the Firefox Profiler network waterfall view. Also shows aggregated timing totals
across all resources and cache hit/miss statistics.

\`\`\`bash
profiler-cli <profile> --network
\`\`\`

Output includes:
- Total resource count and cache statistics (Hit/Miss/Unknown percentages)
- Timing totals: sum of each phase across all resources
- Per-resource entries sorted by start time relative to Navigation::Start:
  - URL, HTTP version, cache status, content type, size
  - Start time and total duration
  - Per-phase timing breakdown:
    - Waiting for socket thread
    - DNS request
    - After DNS request
    - TCP connection
    - After TCP connection
    - Establishing TLS session
    - Waiting for HTTP request
    - HTTP request and waiting for response
    - HTTP response (download time)
    - Waiting for main thread

### --annotate <asm|src|all> FUNCTION
Annotates a specific function with per-line sample counts. Requires a local .json.gz profile file
(not a URL). Shows assembly (asm), source code (src), or both interleaved (all). Lines with high
sample counts indicate hot code paths within the function. Use --color to highlight source lines
and hotspots.

\`\`\`bash
profiler-cli profile.json.gz --annotate asm "FunctionName"
profiler-cli profile.json.gz --annotate src "FunctionName"
profiler-cli profile.json.gz --annotate all "FunctionName" --color
\`\`\`

## Understanding the Output

### Self Time vs Total Time
- **Self time**: Samples where this function was the top of the stack (actively executing)
- **Total time**: All samples where this function appeared anywhere on the stack (including callees)
- Self time is usually more actionable for optimization

### Samples
- Profiles are sampled at regular intervals (typically 1ms)
- Each sample is one snapshot of the call stack
- Higher sample counts = more CPU time spent

### Call Paths in --detailed mode
Each call path shows the complete call chain from the function up to the root, ordered
from the function at the top down to the root at the bottom. The path sample count is the
number of samples where this exact sequence of callers was on the stack.

## Common Analysis Patterns

### Pattern 1: Find the biggest CPU consumers
\`\`\`bash
# Top functions overall
profiler-cli <profile> --calltree 20

# Top functions during a specific operation
profiler-cli <profile> --calltree 20 --focus-marker "Jank"

# Top functions during Speedometer benchmark (excluding async idle)
profiler-cli <profile> --calltree 20 --focus-marker="-async,-sync"
\`\`\`

### Pattern 2: Understand who calls a hot function
\`\`\`bash
# See all callers of malloc
profiler-cli <profile> --calltree 10 --callers-of "malloc"

# See callers during a specific marker
profiler-cli <profile> --calltree 10 --callers-of "malloc" --focus-marker="-async,-sync"

# Get detailed caller chains
profiler-cli <profile> --calltree 10 --callers-of "malloc" --detailed
\`\`\`

### Pattern 3: Deep dive on a specific function
\`\`\`bash
# See total time with subtree collapsed
profiler-cli <profile> --calltree 5 --focus-function "MyFunction"

# See all caller chains leading to it
profiler-cli <profile> --calltree 5 --focus-function "MyFunction" --detailed --max-paths 10
\`\`\`

### Pattern 4: Remove noise and focus on what matters
\`\`\`bash
# Collapse a noisy function and see what else is expensive
profiler-cli <profile> --calltree 10 --collapse-function "servo_arc::Arc::drop_slow"

# Combine collapse + marker filter
profiler-cli <profile> --calltree 10 --focus-marker="-async,-sync" --collapse-function "servo_arc::Arc::drop_slow"
\`\`\`

### Pattern 5: Analyze page load performance
\`\`\`bash
# Overview: timing, resources, jank
profiler-cli <profile> --page-load

# Drill into slow network resources
profiler-cli <profile> --network

# See what CPU work happened during load
profiler-cli <profile> --calltree 20
\`\`\`

### Pattern 6: Explore call tree structure
\`\`\`bash
# Top-down view of what the program is doing
profiler-cli <profile> --flamegraph 8

# Restricted to a marker period
profiler-cli <profile> --flamegraph 8 --focus-marker="-async,-sync"
\`\`\`

## Tips
1. **Self time is more actionable**: Functions with high self time are directly consuming CPU
2. **Use --focus-marker for benchmarks**: Always filter Speedometer profiles with --focus-marker="-async,-sync"
3. **Generic type parameters are stripped**: You can omit <T>, <U, V>, etc. in function names
4. **Parameter lists are optional**: "MyFunction" matches "MyFunction(int, char*)" when no '(' in query
5. **Browser internals are expected**: __psynch_cvwait and similar are normal idle/wait functions
6. **Jank >50ms blocks interaction**: Any jank period that long will cause a noticeable freeze
7. **Start broad, then narrow**: Begin with --calltree 20 to find hotspots, then drill in with --callers-of or --focus-function

## Error Handling
- Function not found: The function may not appear in this profile, or check the name spelling
- Profile fails to load: Ensure the URL is a valid Firefox Profiler share URL or local .json.gz
- Large profiles may take 30+ seconds to process
- When using --focus-marker with values starting with '-', always use equals syntax: --focus-marker="-async,-sync"
`);
  process.exit(0);
}

const validationError = validateArgs(argv, process.argv);
if (validationError) {
  console.error(validationError);
  process.exit(1);
}

const profileUrl = argv._[0] as string;
const hasTopMarkersFlag = process.argv.includes('--top-markers');
const hasFlamegraphFlag = process.argv.includes('--flamegraph');
const hasLogMarkersFlag = process.argv.includes('--log-markers');

// Check if this is a local profile file (.json.gz), and if so start samply
let samplyProcess: any = null;
let actualProfileUrl = profileUrl;

if (existsSync(profileUrl) && profileUrl.endsWith('.json.gz')) {
  console.log("Local profile detected, starting samply server...\n");

  const PORT = 3000 + Math.floor(Math.random() * 1000);
  console.log(`Starting samply server on port ${PORT}...`);

  // Start samply from the directory containing the profile
  // This is important for jitdump files referenced with relative paths (./jit-*.dump)
  const path = await import('path');
  const profileDir = path.dirname(path.resolve(profileUrl));
  const profileBasename = path.basename(profileUrl);

  console.log(`Starting samply from directory: ${profileDir}`);
  console.log(`Loading profile: ${profileBasename}`);

  const samplyBinary = argv.samplyPath || "samply";
  if (argv.samplyPath) {
    console.log(`Using samply: ${argv.samplyPath}`);
  }

  samplyProcess = spawn(samplyBinary, ["load", profileBasename, "--no-open", "--port", String(PORT)], {
    cwd: profileDir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait for samply to be ready and capture the profiler URL
  await new Promise<void>((resolve, reject) => {
    let samplyOutput = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Samply did not start within 30 seconds`));
    }, 30000);

    samplyProcess.stdout?.on("data", (data: Buffer) => {
      const output = data.toString();
      samplyOutput += output;

      // Try to extract the profiler URL from samply's output
      const urlMatch = output.match(/https:\/\/profiler\.firefox\.com\/[^\s]+/);
      if (urlMatch) {
        actualProfileUrl = urlMatch[0];
      }
    });

    samplyProcess.stderr?.on("data", (data: Buffer) => {
      const output = data.toString();
      samplyOutput += output;

      // samply prints the URL to stderr
      const urlMatch = output.match(/https:\/\/profiler\.firefox\.com\/[^\s]+/);
      if (urlMatch) {
        actualProfileUrl = urlMatch[0];
      }

      if (output.includes("Local server listening")) {
        // Wait a bit more to make sure we capture the URL
        setTimeout(() => {
          clearTimeout(timeout);
          resolve();
        }, 500);
      }
    });

    samplyProcess.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  console.log("Samply server ready");

  // If we didn't capture the URL from samply's output, construct it
  if (actualProfileUrl === profileUrl) {
    console.log("Profiler URL not captured from samply output, fetching from server...");
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/`);
      const html = await response.text();
      const urlMatch = html.match(/https:\/\/profiler\.firefox\.com\/[^"]+/);
      if (urlMatch) {
        actualProfileUrl = urlMatch[0];
        console.log("Got profiler URL from HTTP response");
      } else {
        console.error("Could not find profiler URL in samply server response");
      }
    } catch (error) {
      console.error(`Error fetching profiler URL: ${error}`);
    }
  }

  console.log(`Profiler URL: ${actualProfileUrl}\n`);
}

// Use Firefox for better profiler compatibility
const browser = await firefox.launch({ headless: true });

function printFlameTree(node: FlameNode, totalSamples: number, indent: string = "", isLast: boolean = true, isRoot: boolean = true): void {
  const prefix = isRoot ? "" : (isLast ? "└─ " : "├─ ");
  const percentage = ((node.totalTime / totalSamples) * 100).toFixed(1);
  const selfTimeStr = node.selfTime > 0 ? ` [self: ${node.selfTime}]` : "";
  console.log(`${indent}${prefix}${node.name} (${percentage}%, ${node.totalTime} samples)${selfTimeStr}`);

  const childIndent = isRoot ? "" : indent + (isLast ? "   " : "│  ");

  for (let i = 0; i < node.children.length; i++) {
    const isLastChild = i === node.children.length - 1;
    printFlameTree(node.children[i], totalSamples, childIndent, isLastChild, false);
  }
}

try {
  if (hasTopMarkersFlag) {
    const allMarkerSummaries = await getMarkerSummary(browser, actualProfileUrl);

    console.log(`\nTotal unique markers: ${allMarkerSummaries.length}\n`);

    if (argv.topMarkers === undefined) {
      const limit = 5;
      const byTotalDuration = [...allMarkerSummaries].sort((a, b) => b.totalDuration - a.totalDuration).slice(0, Math.min(limit, allMarkerSummaries.length));
      const byMaxDuration = [...allMarkerSummaries].sort((a, b) => b.maxDuration - a.maxDuration).slice(0, Math.min(limit, allMarkerSummaries.length));

      console.log(`Top ${byTotalDuration.length} markers by total duration:\n`);
      for (let i = 0; i < byTotalDuration.length; i++) {
        const marker = byTotalDuration[i];
        console.log(`${i + 1}. ${marker.name} - ${marker.totalDuration.toFixed(2)} ms total (count: ${marker.count}, avg: ${marker.avgDuration.toFixed(2)} ms)`);
      }

      console.log(`\nTop ${byMaxDuration.length} markers by max single instance duration:\n`);
      for (let i = 0; i < byMaxDuration.length; i++) {
        const marker = byMaxDuration[i];
        console.log(`${i + 1}. ${marker.name} - ${marker.maxDuration.toFixed(2)} ms max (total: ${marker.totalDuration.toFixed(2)} ms, count: ${marker.count})`);
      }
    } else {
      const limit = argv.topMarkers;
      const markerSummaries = allMarkerSummaries.slice(0, limit);

      console.log(`Marker Summary (sorted by frequency):\n`);

      if (limit < allMarkerSummaries.length) {
        console.log(`Showing top ${limit} markers:\n`);
      }

      for (let i = 0; i < markerSummaries.length; i++) {
        const marker = markerSummaries[i];
        console.log(`${i + 1}. ${marker.name}`);
        console.log(`   Count: ${marker.count}`);
        console.log(`   Total duration: ${marker.totalDuration.toFixed(2)} ms`);
        console.log(`   Avg duration: ${marker.avgDuration.toFixed(2)} ms`);
        console.log(`   Min duration: ${marker.minDuration.toFixed(2)} ms`);
        console.log(`   Max duration: ${marker.maxDuration.toFixed(2)} ms`);
        console.log();
      }
    }
  } else if (hasLogMarkersFlag) {
    const filter = (argv.logMarkers && argv.logMarkers !== "") ? argv.logMarkers : null;
    const entries = await getLogMarkers(browser, actualProfileUrl, filter);

    if (entries.length === 0) {
      console.log(filter
        ? `No Log markers found matching "${filter}".`
        : "No Log markers found in this profile.");
    } else {
      const filterLabel = filter ? ` (filter: "${filter}")` : "";
      console.log(`\nLog markers${filterLabel}: ${entries.length} total\n`);

      let currentThread = "";
      for (const entry of entries) {
        if (entry.thread !== currentThread) {
          currentThread = entry.thread;
          console.log(`\n[${currentThread}]`);
        }
        const moduleLabel = entry.module ? `[${entry.module}] ` : "";
        console.log(`  t=${entry.time.toFixed(2)}ms  ${moduleLabel}${entry.message}`);
      }
    }
  } else if (hasFlamegraphFlag) {
    const maxDepth = argv.flamegraph || null;
    const flamegraphData = await getFlamegraphData(
      browser,
      actualProfileUrl,
      maxDepth,
      argv.callersOf || null,
      argv.focusMarker || null,
      argv.collapseFunction || null,
      argv.focusFunction || null
    );

    const filters = [];
    if (argv.collapseFunction) filters.push(`collapse: "${argv.collapseFunction}"`);
    if (argv.focusFunction) filters.push(`focus: "${argv.focusFunction}"`);
    if (argv.callersOf) filters.push(`callers-of: "${argv.callersOf}"`);
    if (argv.focusMarker) filters.push(`marker: "${argv.focusMarker}"`);
    if (maxDepth) filters.push(`max depth: ${maxDepth}`);
    const filterText = filters.length > 0 ? ` (${filters.join(", ")})` : "";

    console.log(`\nFlamegraph${filterText}:\n`);

    if (flamegraphData.length === 0) {
      console.log("No data found in profile.\n");
    } else {
      const totalSamples = flamegraphData.reduce((sum, root) => sum + root.totalTime, 0);
      for (const root of flamegraphData) {
        printFlameTree(root, totalSamples);
        console.log();
      }
    }
  } else if (argv.calltree) {
    const localPath = (existsSync(profileUrl) && profileUrl.endsWith('.json.gz')) ? profileUrl : null;
    const callTreeData = await getCallTreeData(
      browser,
      actualProfileUrl,
      argv.calltree || 1,
      argv.detailed,
      argv.callersOf || null,
      argv.focusMarker || null,
      localPath,
      argv.collapseFunction || null,
      argv.focusFunction || null
    );

    const filters = [];
    if (argv.collapseFunction) filters.push(`collapse: "${argv.collapseFunction}"`);
    if (argv.focusFunction) filters.push(`focus: "${argv.focusFunction}"`);
    if (argv.callersOf) filters.push(`callers-of: "${argv.callersOf}"`);
    if (argv.focusMarker) filters.push(`marker: "${argv.focusMarker}"`);
    const filterText = filters.length > 0 ? ` (${filters.join(", ")})` : "";

    console.log(`\nTop ${argv.calltree} functions by self time${filterText}:\n`);

    if (callTreeData.length === 0) {
      console.log("No data found in profile.\n");
    }

    for (let i = 0; i < callTreeData.length; i++) {
      const node = callTreeData[i];
      console.log(`${i + 1}. ${node.name} - ${node.selfTime} samples (${node.totalTime} total)`);


      if (argv.detailed && node.callPaths) {
        console.log();

        // Sort call paths by samples (descending)
        const sortedPaths = [...node.callPaths].sort((a, b) => b.samples - a.samples);

        const pathsToShow = sortedPaths.slice(0, argv.maxPaths);

        for (let j = 0; j < pathsToShow.length; j++) {
          const path = pathsToShow[j];
          const percentage = ((path.samples / node.selfTime) * 100).toFixed(1);
          console.log(`   Call path #${j + 1} - ${path.samples} samples (${percentage}% of this function):`);

          for (const frame of path.stack) {
            console.log(`     ${frame}`);
          }
          console.log();
        }

        // Show summary of remaining paths
        const remainingPaths = sortedPaths.length - pathsToShow.length;
        if (remainingPaths > 0) {
          const samplesRemaining = sortedPaths.slice(pathsToShow.length).reduce((sum, p) => sum + p.samples, 0);
          console.log(`   [${remainingPaths} more call path${remainingPaths > 1 ? 's' : ''}, accounting for ${samplesRemaining} samples]\n`);
        }
      }
    }
  } else if (argv.pageLoad) {
    const pageLoadSummary = await getPageLoadSummary(browser, actualProfileUrl);

    console.log("\n═══════════════════════════════════════════════════════════════════════════════");
    console.log("  Page Load Summary");
    console.log("═══════════════════════════════════════════════════════════════════════════════\n");

    if (pageLoadSummary.url) {
      console.log(`URL: ${pageLoadSummary.url}\n`);
    } else {
      console.log("URL: Not found\n");
    }

    const metrics = [
      { name: "Load", value: pageLoadSummary.load, label: "Load" },
      { name: "FCP", value: pageLoadSummary.firstContentfulPaint, label: "FCP" },
      { name: "LCP", value: pageLoadSummary.largestContentfulPaint, label: "LCP" },
    ].filter(m => m.value !== null);

    if (metrics.length > 0) {
      const maxTime = Math.max(...metrics.map(m => m.value!));
      const timelineWidth = 80;

      const maxTimeStr = `${maxTime.toFixed(0)}ms`;
      const padding = timelineWidth - 3 - maxTimeStr.length;
      console.log(`0ms${" ".repeat(padding)}${maxTimeStr}`);

      const positions = metrics
        .sort((a, b) => a.value! - b.value!)
        .map(m => ({
          label: m.label,
          pos: Math.floor((m.value! / maxTime) * (timelineWidth - 1))
        }));

      let mainTimeline = "-".repeat(timelineWidth);
      for (const pos of positions) {
        mainTimeline = mainTimeline.substring(0, pos.pos) + "|" + mainTimeline.substring(pos.pos + 1);
      }
      console.log(mainTimeline);

      for (let i = 0; i < positions.length; i++) {
        const currentPos = positions[i];
        let line = " ".repeat(timelineWidth);

        for (let j = i; j < positions.length; j++) {
          line = line.substring(0, positions[j].pos) + "|" + line.substring(positions[j].pos + 1);
        }

        let labelStart = currentPos.pos;
        if (i === positions.length - 1) {
          labelStart = currentPos.pos + 2;
          if (labelStart + currentPos.label.length > timelineWidth) {
            labelStart = Math.max(0, currentPos.pos - currentPos.label.length - 1);
          }
        }

        if (labelStart >= 0 && labelStart + currentPos.label.length <= timelineWidth) {
          line = line.substring(0, labelStart) + currentPos.label + line.substring(labelStart + currentPos.label.length);
        }

        console.log(line);
      }

      console.log("\n───── Navigation Timing ─────\n");

      for (const metric of metrics) {
        console.log(`  ${metric.name.padEnd(4)}: ${metric.value!.toFixed(2)} ms`);
      }
    } else {
      console.log("\nNo page load metrics found.");
    }

    if (pageLoadSummary.resources) {
      const res = pageLoadSummary.resources;
      console.log("\n───── Resources ─────\n");
      console.log(`  Total resources: ${res.totalResources}`);
      console.log(`  Average duration: ${res.avgDuration.toFixed(2)} ms`);
      console.log(`  Max duration: ${res.maxDuration.toFixed(2)} ms`);
      console.log("\n  By type:");

      const sortedTypes = Object.entries(res.byType).sort((a, b) => b[1] - a[1]);
      for (const [type, count] of sortedTypes) {
        console.log(`    ${type}: ${count}`);
      }

      console.log("\n  Top 10 longest loads:");
      for (let i = 0; i < res.topResources.length; i++) {
        const resource = res.topResources[i];
        const filename = resource.url.split('/').pop() || resource.url;
        const displayName = filename.length > 60 ? filename.substring(0, 57) + "..." : filename;
        console.log(`    ${i + 1}. ${displayName} - ${resource.duration.toFixed(2)} ms (${resource.type})`);
      }
    }

    if (pageLoadSummary.sampleCategories) {
      const samples = pageLoadSummary.sampleCategories;
      console.log("\n───── Categories ─────\n");
      console.log(`  Total samples: ${samples.totalSamples}\n`);
      console.log("  By category:");

      const sortedCategories = Object.entries(samples.byCategory).sort((a, b) => b[1] - a[1]);
      for (const [category, count] of sortedCategories) {
        const percentage = ((count / samples.totalSamples) * 100).toFixed(1);
        console.log(`    ${category}: ${count} (${percentage}%)`);
      }
    }

    if (pageLoadSummary.jankPeriods && pageLoadSummary.jankPeriods.length > 0) {
      console.log("\n───── Jank ─────\n");
      console.log(`  Total jank periods: ${pageLoadSummary.jankPeriods.length}\n`);

      for (let i = 0; i < pageLoadSummary.jankPeriods.length; i++) {
        const jank = pageLoadSummary.jankPeriods[i];
        console.log(`  Jank ${i + 1}: ${jank.startTime.toFixed(2)} ms - ${jank.duration.toFixed(2)} ms duration`);

        if (jank.topFunctions.length > 0) {
          console.log("    Top functions:");
          for (const func of jank.topFunctions) {
            console.log(`      ${func.name} - ${func.samples} samples`);
          }
        }

        const sortedCategories = Object.entries(jank.categories).sort((a: any, b: any) => b[1] - a[1]);
        if (sortedCategories.length > 0) {
          console.log("    Categories:");
          for (const [category, count] of sortedCategories) {
            console.log(`      ${category}: ${count}`);
          }
        }
        console.log();
      }
    }
  } else if (argv.network) {
    const networkSummary = await getNetworkResources(browser, actualProfileUrl);

    console.log("\n═══════════════════════════════════════════════════════════════════════════════");
    console.log("  Network Resources");
    console.log("═══════════════════════════════════════════════════════════════════════════════\n");

    console.log(`Total resources: ${networkSummary.totalResources}\n`);

    console.log("───── Cache Statistics ─────\n");
    const sortedCacheStats = Object.entries(networkSummary.cacheStats).sort((a, b) => b[1] - a[1]);
    for (const [cacheType, count] of sortedCacheStats) {
      const percentage = ((count / networkSummary.totalResources) * 100).toFixed(1);
      console.log(`  ${cacheType}: ${count} (${percentage}%)`);
    }

    console.log("\n───── Timing Totals ─────\n");
    const sortedPhaseTotals = Object.entries(networkSummary.phaseTotals).sort((a, b) => b[1] - a[1]);
    for (const [phase, total] of sortedPhaseTotals) {
      console.log(`  ${phase}: ${total.toFixed(2)} ms`);
    }

    console.log("\n───── Resources (sorted by start time relative to Navigation::Start) ─────\n");

    for (let i = 0; i < networkSummary.resources.length; i++) {
      const res = networkSummary.resources[i];
      const displayUrl = res.url.length > 100 ? res.url.substring(0, 97) + "..." : res.url;

      console.log(`${i + 1}. ${displayUrl}`);
      console.log(`   Start: ${res.startTime.toFixed(2)} ms | Duration: ${res.duration.toFixed(2)} ms`);

      if (res.httpVersion) {
        console.log(`   HTTP: ${res.httpVersion}`);
      }

      if (res.cache) {
        console.log(`   Cache: ${res.cache}`);
      }

      if (res.contentType) {
        console.log(`   Content-Type: ${res.contentType}`);
      }

      if (res.size !== undefined) {
        const sizeKB = (res.size / 1024).toFixed(2);
        console.log(`   Size: ${sizeKB} KB`);
      }

      if (res.phases && res.phases.length > 0) {
        console.log("   Phases:");
        for (const phase of res.phases) {
          console.log(`     ${phase.label}: ${phase.duration.toFixed(2)} ms`);
        }
      }

      console.log();
    }
  } else if (argv.annotate) {
    const functionName = argv._[1] as string;
    await annotateFunction(browser, actualProfileUrl, functionName, argv.annotate as 'asm' | 'src' | 'all', argv.color);
  }
} finally {
  await browser.close();
  if (samplyProcess) {
    samplyProcess.kill();
  }
}
