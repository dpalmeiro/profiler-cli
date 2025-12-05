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
# Show AI-focused documentation
profiler-cli --ai

# Get top 10 functions by self time
profiler-cli <profile-url> --calltree 10

# Get detailed call paths for top 5 functions
profiler-cli <profile-url> --calltree 5 --detailed

# Search for a specific function
profiler-cli <profile-url> --calltree 10 --focus-function "FunctionName"

# Search with detailed call paths
profiler-cli <profile-url> --calltree 10 --focus-function "FunctionName" --detailed --max-paths 10

# Show flamegraph tree view
profiler-cli <profile-url> --flamegraph

# Show flamegraph with limited depth
profiler-cli <profile-url> --flamegraph --flamegraph-depth 5

# Show flamegraph for specific function
profiler-cli <profile-url> --flamegraph --focus-function "FunctionName"

# Filter to samples during markers starting with "Jank"
profiler-cli <profile-url> --calltree 10 --focus-marker "Jank"

# List top 5 markers by total duration and by max duration (default)
profiler-cli <profile-url> --top-markers

# List top 20 markers by frequency
profiler-cli <profile-url> --top-markers 20

# Show page load performance summary
profiler-cli <profile-url> --page-load
```

## Options

- `--ai`: Show comprehensive AI-focused documentation
- `--calltree N`: Get top N functions by self time
- `--focus-function NAME`: Search for a specific function by name (works with --calltree, --flamegraph)
- `--focus-marker FILTER`: Filter samples to only those within markers matching the filter string
- `--top-markers [N]`: Show top 5 markers by total duration and by max duration (default), or top N markers by frequency if N is specified
- `--detailed`: Show detailed call paths for each function
- `--max-paths N`: Maximum number of call paths to show in detailed mode (default: 5)
- `--flamegraph`: Show flamegraph-style tree view of call stacks (top-down)
- `--flamegraph-depth N`: Maximum depth for flamegraph tree (default: unlimited)
- `--page-load`: Show page load performance summary with key metrics (Load event, First Contentful Paint, Largest Contentful Paint) and resource loading statistics

**Note:** When using `--focus-marker` with values starting with `-` (like `-async,-sync`), use equals sign syntax: `--focus-marker="-async,-sync"`
