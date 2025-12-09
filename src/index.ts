#!/usr/bin/env node
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import { chromium } from "playwright";
import { getCallTreeData, getMarkerSummary, getFlamegraphData, getPageLoadSummary, getNetworkResources } from "./profiler.js";
import { FlameNode } from "./types.js";

const yargsInstance = yargs(hideBin(process.argv));
const argv = (await yargsInstance
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
    describe: "Search for a specific function by name",
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
  .help().argv) as any;

if (argv.ai) {
  console.log(`
# profiler-cli: AI Usage Guide

## Purpose
Extract performance data from Firefox Profiler URLs to analyze browser performance bottlenecks.

## Core Commands

### 1. Get Top Functions by Self Time
\`\`\`bash
profiler-cli <profile-url> --calltree N
\`\`\`
Returns the top N functions sorted by self time (time spent in the function itself, excluding callees).

**Example:**
\`\`\`bash
profiler-cli <profile-url> --calltree 10
\`\`\`

### 2. Flamegraph Tree View
\`\`\`bash
profiler-cli <profile-url> --flamegraph [N]
\`\`\`
Shows a top-down tree view of call stacks with visual hierarchy. Optionally limit depth to N levels.

**Use when:** You want to see the call tree structure and understand caller-callee relationships.

**Example:**
\`\`\`bash
profiler-cli <profile-url> --flamegraph 5
\`\`\`

### 3. Focus on Specific Function or Marker
\`\`\`bash
profiler-cli <profile-url> --calltree 10 --focus-function "FunctionName"
profiler-cli <profile-url> --flamegraph --focus-marker "Jank"
\`\`\`
Applies profiler transforms to focus analysis on specific functions or time periods.

**Use when:** You want to analyze what happens during specific operations or within specific functions.

**Examples:**
\`\`\`bash
# Focus on malloc and see what calls it
profiler-cli <profile-url> --calltree 10 --focus-function "malloc"

# See what happens during Jank markers
profiler-cli <profile-url> --flamegraph --focus-marker "Jank"

# Combine both
profiler-cli <profile-url> --calltree 10 --focus-function "malloc" --focus-marker "Rasterize"
\`\`\`

### 4. Top Markers Analysis
\`\`\`bash
profiler-cli <profile-url> --top-markers [N]
\`\`\`
Shows top 5 markers by total duration and max duration (default), or top N by frequency.

**Use when:** You want to understand which operations are taking the most time.

**Examples:**
\`\`\`bash
# Default: top 5 by total and max duration
profiler-cli <profile-url> --top-markers

# Top 20 by frequency
profiler-cli <profile-url> --top-markers 20
\`\`\`

### 5. Page Load Analysis
\`\`\`bash
profiler-cli <profile-url> --page-load
\`\`\`
Comprehensive page load performance analysis including:
- Navigation timing (FCP, LCP, Load)
- Visual timeline
- Resource loading statistics (164 resources, breakdown by type)
- Sample category breakdown (CPU time by category)
- Jank period analysis (identifies blocking tasks with top functions)

**Use when:** Analyzing page load performance and identifying bottlenecks.

**Output includes:**
- URL being loaded
- FCP, LCP, Load timings with visual timeline
- Resource count and types (JS: 117, Image: 27, etc.)
- Top 10 slowest resource loads
- CPU time breakdown by category (JavaScript: 10.5%, Layout: 9.9%, etc.)
- Jank periods with top functions causing blocking

**Example:**
\`\`\`bash
profiler-cli <profile-url> --page-load
\`\`\`

### 6. Detailed Network Analysis
\`\`\`bash
profiler-cli <profile-url> --network
\`\`\`
Shows detailed network resource timing with phase breakdown:
- Cache statistics (Hit/Miss/Unknown)
- Accumulated timing totals (DNS, Connect, TLS, Wait, Download)
- Per-resource timing phases matching the profiler UI

**Use when:** You need to understand network waterfall and identify slow resources.

**Output includes:**
- Total resources and cache statistics
- Accumulated time for each network phase
- Resources sorted by start time (relative to Navigation::Start)
- Full timing breakdown per resource:
  - Waiting for socket thread
  - DNS request
  - TCP connection
  - TLS handshake
  - HTTP request and waiting for response
  - HTTP response (download)
  - Waiting for main thread

**Example:**
\`\`\`bash
profiler-cli <profile-url> --network
\`\`\`

### 7. Show Detailed Call Paths
\`\`\`bash
profiler-cli <profile-url> --calltree N --detailed --max-paths M
\`\`\`
Shows the call stacks that lead to each function.

**Example:**
\`\`\`bash
profiler-cli <profile-url> --calltree 5 --detailed --max-paths 3
\`\`\`

## Understanding the Output

### Self Time vs Total Time
- **Self time**: Samples where the function itself was executing (excluding functions it calls)
- **Total time**: All samples where the function was on the stack (including its callees)

### Samples
- Profiles are sampled at regular intervals (typically 1ms)
- Each "sample" represents one snapshot of the call stack
- Higher sample counts = more time spent

### Call Paths
When using \`--detailed\`, you see stacks in bottom-up order (root at bottom).
When using \`--flamegraph\`, you see stacks in top-down order (traditional flamegraph).

## Common Analysis Patterns

### Pattern 1: Find Page Load Bottlenecks
\`\`\`bash
# Get comprehensive page load analysis
profiler-cli <url> --page-load

# Then drill into network issues
profiler-cli <url> --network
\`\`\`

### Pattern 2: Analyze Jank/Blocking
\`\`\`bash
# See what's happening during jank
profiler-cli <url> --calltree 20 --focus-marker "Jank"

# Or use page-load to see jank analysis
profiler-cli <url> --page-load
\`\`\`

### Pattern 3: Deep Dive on Hot Function
\`\`\`bash
# Find hot functions
profiler-cli <url> --calltree 20

# Focus on specific function
profiler-cli <url> --flamegraph 5 --focus-function "malloc"
\`\`\`

### Pattern 4: Understand Call Context
\`\`\`bash
# See call tree structure
profiler-cli <url> --flamegraph 10

# Or get detailed call paths
profiler-cli <url> --calltree 5 --detailed --max-paths 5
\`\`\`

## Profile URL Sources
- Firefox Profiler: profiler.firefox.com
- Shared profiles: share.firefox.dev/<profile-id>
- Local profiles: Use the profiler.firefox.com URL from your browser

## Tips for AI Analysis
1. **Start with --page-load** for page load profiles to get comprehensive overview
2. **Use --network** to identify slow resources and connection issues
3. **Self time is more actionable**: Focus on functions with high self time for optimization
4. **Look for patterns in call paths**: Repeated patterns indicate systematic issues
5. **Browser internals are normal**: Don't worry about functions like \`__psynch_cvwait\` (system calls)
6. **JS vs Native**: JavaScript functions show source locations, native functions show C++/Rust names
7. **Samples are relative**: Compare functions within the same profile, not across profiles
8. **Jank indicates blocking**: Any jank >50ms will block user interaction

## Error Handling
- If function not found: The function may not appear in the profile at all
- If profile fails to load: Ensure the URL is a valid Firefox Profiler share URL
- Timeouts: Large profiles may take 30+ seconds to process
- When using --focus-marker with values starting with '-', use equals syntax: --focus-marker="-async,-sync"
`);
  process.exit(0);
}

if (!argv._[0]) {
  console.error("Please provide a profile URL");
  process.exit(1);
}

const profileUrl = argv._[0] as string;

// Handle the case where --focus-marker is followed by a value starting with -
// In this case, yargs may not capture it properly
if (argv.focusMarker === '' || (argv.focusMarker === undefined && argv._.length > 1 && typeof argv._[1] === 'string' && argv._[1].startsWith('-'))) {
  console.error("Error: When using --focus-marker with a value starting with '-', use the equals sign syntax:");
  console.error("  --focus-marker=\"-async,-sync\"");
  console.error("\nInstead of:");
  console.error("  --focus-marker \"-async,-sync\"");
  process.exit(1);
}

const hasTopMarkersFlag = process.argv.includes('--top-markers');
const hasFlamegraphFlag = process.argv.includes('--flamegraph');

if (!argv.calltree && !hasTopMarkersFlag && !hasFlamegraphFlag && !argv.pageLoad && !argv.network) {
  console.error("Please specify one of: --calltree <N>, --flamegraph, --top-markers [N], --page-load, or --network");
  console.error("Note: --focus-function can be used with --calltree or --flamegraph to filter results");
  process.exit(1);
}

const optionCount = [argv.calltree, hasTopMarkersFlag, hasFlamegraphFlag, argv.pageLoad, argv.network].filter(x => x !== undefined && x !== false).length;
if (optionCount > 1) {
  console.error("Please specify only one of: --calltree, --flamegraph, --top-markers, --page-load, or --network");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });

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
    const allMarkerSummaries = await getMarkerSummary(browser, profileUrl);

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
  } else if (hasFlamegraphFlag) {
    const maxDepth = argv.flamegraph || null;
    const flamegraphData = await getFlamegraphData(
      browser,
      profileUrl,
      maxDepth,
      argv.focusFunction || null,
      argv.focusMarker || null
    );

    const filters = [];
    if (argv.focusFunction) filters.push(`focus: "${argv.focusFunction}"`);
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
    const callTreeData = await getCallTreeData(
      browser,
      profileUrl,
      argv.calltree || 1,
      argv.detailed,
      argv.focusFunction || null,
      argv.focusMarker || null
    );

    const filters = [];
    if (argv.focusFunction) filters.push(`focus: "${argv.focusFunction}"`);
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

          // Reverse stack so root is at bottom (traditional view)
          const reversedStack = [...path.stack].reverse();
          for (const frame of reversedStack) {
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
    const pageLoadSummary = await getPageLoadSummary(browser, profileUrl);

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
    const networkSummary = await getNetworkResources(browser, profileUrl);

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
  }
} finally {
  await browser.close();
}
