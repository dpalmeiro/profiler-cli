# profiler-cli

A command-line tool to extract information from Firefox Profiler profiles.

## Installation

```bash
npm install
npm run build
npm link
```

## Usage

```bash
profiler-cli <profile-url-or-file> [options]
```

Both Firefox Profiler share URLs and local `.json.gz` profile files are supported.

## Options

### `--calltree N`
Get the top N functions by self time (time spent in the function itself, excluding callees).

```bash
profiler-cli <profile> --calltree 10
```

### `--detailed`
Show detailed call paths for each function in `--calltree` output. Each path shows the full call stack leading to the function, sorted by sample count.

```bash
profiler-cli <profile> --calltree 5 --detailed
profiler-cli <profile> --calltree 5 --detailed --max-paths 10
```

### `--max-paths N`
Maximum number of call paths to show per function in `--detailed` mode (default: 5).

### `--callers-of NAME`
Show callers of a specific function using an inverted call tree. The function becomes the root and its callers appear as children, letting you see what code paths lead to it.

Matches with C++ generic type parameters stripped, so `servo_arc::Arc::drop_slow` matches `servo_arc::Arc<T>::drop_slow`.

```bash
profiler-cli <profile> --calltree 10 --callers-of "malloc"
profiler-cli <profile> --calltree 5 --callers-of "style::properties::cascade::cascade_rules"
```

### `--collapse-function NAME`
Collapse a function and its entire subtree into a single node. All time spent in the function and everything it calls is attributed to that node as self time. Useful for removing noise from well-understood functions.

```bash
profiler-cli <profile> --calltree 10 --focus-marker="-async,-sync" --collapse-function "servo_arc::Arc::drop_slow"
```

### `--focus-function NAME`
Collapse the function's subtree (like `--collapse-function`) and then focus exclusively on that single node. With `--detailed`, shows the full caller chains leading up to the function.

Useful for understanding all the code paths that call into a particular function and how much time each contributes.

```bash
# Show the function as a single collapsed node
profiler-cli <profile> --calltree 5 --focus-function "servo_arc::Arc::drop_slow"

# Show full caller chains (what calls this function and from where)
profiler-cli <profile> --calltree 5 --focus-function "servo_arc::Arc::drop_slow" --detailed
```

### `--focus-marker FILTER`
Filter samples to only include those within markers whose name matches the filter string. Multiple comma-separated patterns are supported.

**Note:** When the filter value starts with `-`, use the equals sign syntax to avoid it being interpreted as a flag.

```bash
profiler-cli <profile> --calltree 10 --focus-marker "Jank"
profiler-cli <profile> --calltree 10 --focus-marker="-async,-sync"
```

For Speedometer profiles, always use `--focus-marker="-async,-sync"` to exclude async idle time between iterations.

### `--flamegraph [N]`
Show a top-down flamegraph-style tree view of call stacks. Optionally limit the output to N levels deep.

```bash
profiler-cli <profile> --flamegraph
profiler-cli <profile> --flamegraph 5
```

### `--top-markers [N]`
Show the top 5 markers by total duration and by max single-instance duration. If N is specified, shows the top N markers by frequency.

Only counts markers that have a non-zero duration. Zero-duration log markers are not included — use `--log-markers` for those.

```bash
profiler-cli <profile> --top-markers
profiler-cli <profile> --top-markers 20
```

### `--log-markers [FILTER]`
Extract the text content of `Log`-type markers emitted by Firefox's `about:logging` media preset. These are instant, zero-duration markers that carry a module name and a log message as their payload — invisible to `--top-markers` and `--focus-marker`.

Output is grouped by thread and sorted chronologically. An optional filter string restricts results to entries where the message, module name, or thread name contains the filter (case-insensitive).

```bash
# Show all log markers across all threads
profiler-cli <profile> --log-markers

# Filter by thread name
profiler-cli <profile> --log-markers "MediaDecoderStateMachine"

# Filter by message content
profiler-cli <profile> --log-markers "blank media"

# Filter by module name
profiler-cli <profile> --log-markers "D/MediaDecoder"
```

Example output:
```
Log markers (filter: "MediaDecoder"): 14089 total

[MediaDecoderStateMachine #3]
  t=100.00ms  [D/MediaDecoder] StateChange DECODING
  t=200.00ms  [D/MediaDecoder] StartBuffering reason=NotEnoughData
```

**When to use `--log-markers` vs `--focus-marker`:**
- `--focus-marker` is a *sample filter* — it restricts which CPU samples appear in a `--calltree` or `--flamegraph`, using named markers as time windows. Use it to answer "what code was running during X?"
- `--log-markers` is a *log reader* — it extracts the text payload of `about:logging` entries. Use it to answer "what did the media pipeline log?" No call tree involved.

### `--page-load`
Show a page load performance summary including navigation timing (FCP, Load), resource loading statistics, CPU category breakdown, and jank period analysis.

```bash
profiler-cli <profile> --page-load
```

### `--network`
Show detailed network resource timing with per-resource phase breakdown (DNS, TCP, TLS, request, response, main thread wait).

```bash
profiler-cli <profile> --network
```

### `--annotate <asm|src|all> FUNCTION`
Annotate a function with assembly, source code, or both, with per-line sample counts. Requires a local profile file.

```bash
profiler-cli profile.json.gz --annotate asm "FunctionName"
profiler-cli profile.json.gz --annotate src "FunctionName"
profiler-cli profile.json.gz --annotate all "FunctionName"
```

### `--color`
Enable color coding in `--annotate` output: source lines in cyan, hotspot lines in yellow/magenta.

### `--samply-path PATH`
Path to the `samply` binary (default: use `samply` from PATH). Used when serving local profile files.

### `--ai`
Show comprehensive AI-focused documentation for all options and common analysis patterns.
