import { Browser } from "playwright";
import { CallTreeNode, MarkerSummary, FlameNode, PageLoadSummary, NetworkResourceSummary } from "./types.js";

declare const window: any;
declare const selectors: any;
declare const getState: any;
declare const callTree: any;
declare const filteredThread: any;
declare const dispatch: any;
declare const actions: any;

export async function getCallTreeData(
  browser: Browser,
  url: string,
  topN: number,
  detailed: boolean = false,
  functionName: string | null = null,
  markerTransform: string | null = null
): Promise<CallTreeNode[]> {
  const page = await browser.newPage({
    bypassCSP: true,
  });

  page.setDefaultTimeout(0);

  await page.goto(url);

  await page.waitForFunction(() => {
    return (
      window.selectors &&
      selectors.app.getView(getState()).phase == "DATA_LOADED"
    );
  });

  await page.waitForFunction(() => {
    return selectors.profile.getSymbolicationStatus(getState()) == "DONE";
  });

  await page.evaluate(() => {
    const dispatch = window.dispatch;
    const actions = window.actions;
    dispatch(actions.changeInvertCallstack(true));
    dispatch(actions.changeSelectedTab("calltree"));
  });

  await new Promise((resolve) => setTimeout(resolve, 500));

  if (functionName !== null) {
    const debugInfo = await page.evaluate(({ functionName }: { functionName: string }) => {
      const dispatch = window.dispatch;
      const actions = window.actions;
      const threadsKey = selectors.urlState.getSelectedThreadsKey(getState());
      const state = getState();

      const thread = selectors.selectedThread.getFilteredThread(state);
      const { funcTable, stringTable } = thread;

      let funcIndex = null;
      for (let i = 0; i < funcTable.length; i++) {
        const nameStringIndex = funcTable.name[i];
        const funcName = stringTable.getString(nameStringIndex);
        if (funcName === functionName) {
          funcIndex = i;
          break;
        }
      }

      if (funcIndex === null) {
        return {
          threadsKey,
          error: `Function "${functionName}" not found in function table`,
          rootNodeCountAfterTransform: 0
        };
      }

      dispatch(
        actions.addTransformToStack(threadsKey, {
          type: "focus-function",
          funcIndex: funcIndex,
        })
      );

      const newState = getState();
      const transforms = selectors.urlState.getTransformStack(newState, threadsKey);
      const rootNodes = window.callTree.getRoots();

      return {
        threadsKey,
        transforms: transforms,
        functionName,
        funcIndex,
        rootNodeCountAfterTransform: rootNodes ? rootNodes.length : 0
      };
    }, { functionName });

    if (debugInfo.error) {
      console.log(`Warning: ${debugInfo.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  if (markerTransform !== null) {
    await page.evaluate(({ markerTransform }: { markerTransform: string }) => {
      const dispatch = window.dispatch;
      const actions = window.actions;
      const threadsKey = selectors.urlState.getSelectedThreadsKey(getState());

      dispatch(
        actions.addTransformToStack(threadsKey, {
          type: "filter-samples",
          filterType: "marker-search",
          filter: markerTransform,
        })
      );

      return true;
    }, { markerTransform });

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  if (functionName === null && markerTransform === null) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const jsonString = await page.evaluate(
    async ({ topN, detailed }: { topN: number; detailed: boolean }) => {
      const rootNodes = callTree.getRoots();

      if (!rootNodes || rootNodes.length === 0) {
        return JSON.stringify({ totalNodes: 0, topNodes: [] });
      }

      function collectCallPaths(nodeIndex: number, currentPath: string[]): any[] {
        const nodeData = callTree.getNodeData(nodeIndex);
        if (!nodeData || !nodeData.funcName) {
          return [];
        }

        const funcName = nodeData.funcName;
        const newPath = [...currentPath, funcName];

        const children = callTree.getChildren(nodeIndex);
        if (!children || children.length === 0) {
          return [{
            stack: newPath,
            samples: nodeData.total || nodeData.self || 0
          }];
        }

        const results: any[] = [];
        for (const child of children) {
          const childPaths = collectCallPaths(child, newPath);
          results.push(...childPaths);
        }
        return results;
      }

      const allNodes: any[] = [];

      for (const rootNode of rootNodes) {
        try {
          const nodeData = callTree.getNodeData(rootNode);
          if (!nodeData || !nodeData.funcName) {
            continue;
          }

          const node: any = {
            name: nodeData.funcName,
            selfTime: nodeData.self || 0,
            totalTime: nodeData.total || 0,
            stack: [nodeData.funcName],
          };

          if (detailed) {
            const callPaths = collectCallPaths(rootNode, []);
            node.callPaths = callPaths;
          }

          allNodes.push(node);
        } catch (err) {
          // Skip nodes that cause errors
        }
      }

      allNodes.sort((a, b) => b.selfTime - a.selfTime);

      const topNodes = allNodes.slice(0, topN);

      return JSON.stringify({ totalNodes: allNodes.length, topNodes });
    },
    { topN, detailed }
  );

  await page.close();

  if (typeof jsonString !== "string") {
    throw new Error("Did not get back a string");
  }

  const result = JSON.parse(jsonString);
  if (result.debug) {
    console.log("Debug info:", JSON.stringify(result.debug, null, 2));
  }
  if (result.totalNodes > 0) {
    console.log(`Collected ${result.totalNodes} total nodes`);
  }
  return result.topNodes;
}

export async function getMarkerSummary(
  browser: Browser,
  url: string
): Promise<MarkerSummary[]> {
  const page = await browser.newPage({
    bypassCSP: true,
  });

  page.setDefaultTimeout(0);

  await page.goto(url);

  await page.waitForFunction(() => {
    return (
      window.selectors &&
      selectors.app.getView(getState()).phase == "DATA_LOADED"
    );
  });

  await page.waitForFunction(() => {
    return selectors.profile.getSymbolicationStatus(getState()) == "DONE";
  });

  const jsonString = await page.evaluate(() => {
    const filteredMarkers = window.filteredMarkers;
    const stringTable = window.filteredThread.stringTable;
    const markerStats = new Map<string, { durations: number[] }>();

    let totalMarkers = filteredMarkers.length;

    for (let i = 0; i < filteredMarkers.length; i++) {
      const marker = filteredMarkers[i];

      if (!marker.start || !marker.end || marker.end === null) {
        continue;
      }

      const duration = marker.end - marker.start;
      if (duration <= 0) {
        continue;
      }

      let markerName = marker.name;

      if (marker.data && marker.data.name !== undefined) {
        const dataName = marker.data.name;
        if (typeof dataName === "number") {
          markerName = stringTable.getString(dataName);
        } else {
          markerName = dataName;
        }
      }

      if (!markerStats.has(markerName)) {
        markerStats.set(markerName, { durations: [] });
      }

      const stats = markerStats.get(markerName)!;
      stats.durations.push(duration);
    }

    const summaries: any[] = [];
    for (const [name, stats] of markerStats.entries()) {
      const count = stats.durations.length;
      const totalDuration = stats.durations.reduce((sum, d) => sum + d, 0);
      const avgDuration = totalDuration / count;
      const minDuration = Math.min(...stats.durations);
      const maxDuration = Math.max(...stats.durations);

      summaries.push({
        name,
        count,
        totalDuration,
        avgDuration,
        minDuration,
        maxDuration,
      });
    }

    summaries.sort((a, b) => b.count - a.count);

    return JSON.stringify({ summaries });
  });

  await page.close();

  if (typeof jsonString !== "string") {
    throw new Error("Did not get back a string");
  }

  const result = JSON.parse(jsonString);
  return result.summaries;
}

export async function getFlamegraphData(
  browser: Browser,
  url: string,
  maxDepth: number | null = null,
  functionName: string | null = null,
  markerTransform: string | null = null
): Promise<FlameNode[]> {
  const page = await browser.newPage({
    bypassCSP: true,
  });

  page.setDefaultTimeout(0);

  await page.goto(url);

  await page.waitForFunction(() => {
    return (
      window.selectors &&
      selectors.app.getView(getState()).phase == "DATA_LOADED"
    );
  });

  await page.waitForFunction(() => {
    return selectors.profile.getSymbolicationStatus(getState()) == "DONE";
  });

  await page.evaluate(() => {
    const dispatch = window.dispatch;
    const actions = window.actions;
    dispatch(actions.changeInvertCallstack(false));
    dispatch(actions.changeSelectedTab("calltree"));
  });

  await new Promise((resolve) => setTimeout(resolve, 500));

  if (functionName !== null) {
    const debugInfo = await page.evaluate(({ functionName }: { functionName: string }) => {
      const dispatch = window.dispatch;
      const actions = window.actions;
      const threadsKey = selectors.urlState.getSelectedThreadsKey(getState());
      const state = getState();

      const thread = selectors.selectedThread.getFilteredThread(state);
      const { funcTable, stringTable } = thread;

      let funcIndex = null;
      for (let i = 0; i < funcTable.length; i++) {
        const nameStringIndex = funcTable.name[i];
        const funcName = stringTable.getString(nameStringIndex);
        if (funcName === functionName) {
          funcIndex = i;
          break;
        }
      }

      if (funcIndex === null) {
        return {
          threadsKey,
          error: `Function "${functionName}" not found in function table`,
          rootNodeCount: 0
        };
      }

      dispatch(
        actions.addTransformToStack(threadsKey, {
          type: "focus-function",
          funcIndex: funcIndex,
        })
      );

      const newState = getState();
      const transforms = selectors.urlState.getTransformStack(newState, threadsKey);
      const rootNodes = window.callTree.getRoots();

      return {
        threadsKey,
        transforms: transforms,
        functionName,
        funcIndex,
        rootNodeCount: rootNodes ? rootNodes.length : 0
      };
    }, { functionName });

    if (debugInfo.error) {
      console.log(`Warning: ${debugInfo.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  if (markerTransform !== null) {
    await page.evaluate(({ markerTransform }: { markerTransform: string }) => {
      const dispatch = window.dispatch;
      const actions = window.actions;
      const threadsKey = selectors.urlState.getSelectedThreadsKey(getState());

      dispatch(
        actions.addTransformToStack(threadsKey, {
          type: "filter-samples",
          filterType: "marker-search",
          filter: markerTransform,
        })
      );

      return true;
    }, { markerTransform });

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  if (functionName === null && markerTransform === null) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const jsonString = await page.evaluate(
    async ({ maxDepth }: { maxDepth: number | null }) => {
      const rootNodes = callTree.getRoots();

      if (!rootNodes || rootNodes.length === 0) {
        return JSON.stringify({ roots: [] });
      }

      function buildFlameTree(nodeIndex: number, currentDepth: number): any {
        const nodeData = callTree.getNodeData(nodeIndex);
        if (!nodeData || !nodeData.funcName) {
          return null;
        }

        if (maxDepth !== null && currentDepth >= maxDepth) {
          return null;
        }

        const node: any = {
          name: nodeData.funcName,
          selfTime: nodeData.self || 0,
          totalTime: nodeData.total || 0,
          children: []
        };

        const children = callTree.getChildren(nodeIndex);
        if (children && children.length > 0) {
          for (const childIndex of children) {
            const childNode = buildFlameTree(childIndex, currentDepth + 1);
            if (childNode) {
              node.children.push(childNode);
            }
          }
          node.children.sort((a: any, b: any) => b.totalTime - a.totalTime);
        }

        return node;
      }

      const roots: any[] = [];

      for (const rootNode of rootNodes) {
        const tree = buildFlameTree(rootNode, 0);
        if (tree) {
          roots.push(tree);
        }
      }
      roots.sort((a, b) => b.totalTime - a.totalTime);

      return JSON.stringify({ roots });
    },
    { maxDepth }
  );

  await page.close();

  if (typeof jsonString !== "string") {
    throw new Error("Did not get back a string");
  }

  const result = JSON.parse(jsonString);
  return result.roots;
}

export async function getPageLoadSummary(
  browser: Browser,
  url: string
): Promise<PageLoadSummary> {
  const page = await browser.newPage({
    bypassCSP: true,
  });

  page.setDefaultTimeout(0);

  await page.goto(url);

  await page.waitForFunction(() => {
    return (
      window.selectors &&
      selectors.app.getView(getState()).phase == "DATA_LOADED"
    );
  });

  await page.waitForFunction(() => {
    return selectors.profile.getSymbolicationStatus(getState()) == "DONE";
  });

  const jsonString = await page.evaluate(() => {
    const filteredMarkers = window.filteredMarkers;
    const stringTable = window.filteredThread.stringTable;

    let navigationStart: number | null = null;
    let load: number | null = null;
    let loadUrl: string | null = null;
    let firstContentfulPaint: number | null = null;
    let largestContentfulPaint: number | null = null;
    const resources: Array<{ url: string; duration: number; type: string }> = [];

    for (let i = 0; i < filteredMarkers.length; i++) {
      const marker = filteredMarkers[i];

      let markerName = marker.name;
      if (marker.data && marker.data.name !== undefined) {
        const dataName = marker.data.name;
        if (typeof dataName === "number") {
          markerName = stringTable.getString(dataName);
        } else {
          markerName = dataName;
        }
      }

      if (markerName === "Navigation::Start" && navigationStart === null) {
        navigationStart = marker.start || marker.startTime || 0;
      } else if (markerName.startsWith("Load ") && marker.data && marker.data.URI) {
        const uri = marker.data.URI;
        const startTime = marker.start || marker.startTime || 0;
        const duration = marker.end ? (marker.end - startTime) : 0;

        if (navigationStart !== null) {
          let resourceType = "Other";
          if (uri.endsWith(".js") || uri.includes(".js?")) {
            resourceType = "JS";
          } else if (uri.endsWith(".css") || uri.includes(".css?")) {
            resourceType = "CSS";
          } else if (uri.match(/\.(png|jpg|jpeg|gif|webp|svg|ico)/i)) {
            resourceType = "Image";
          } else if (uri.match(/\.(woff|woff2|ttf|eot)/i)) {
            resourceType = "Font";
          } else if (uri.startsWith("http") && !uri.includes(".")) {
            resourceType = "Document";
          }

          if (uri.startsWith("http") && !uri.includes(".js") && !uri.includes(".css") && !loadUrl) {
            loadUrl = uri;
          }

          resources.push({ url: uri, duration, type: resourceType });
        }
      } else if (markerName === "Load" && load === null) {
        load = marker.start || marker.startTime || 0;
      } else if (markerName.startsWith("Contentful paint after") && firstContentfulPaint === null) {
        const match = markerName.match(/after (\d+)ms/);
        if (match) {
          firstContentfulPaint = parseFloat(match[1]);
          if (markerName.includes("for URL") && !loadUrl) {
            const urlMatch = markerName.match(/for URL (https?:\/\/[^,]+)/);
            if (urlMatch) {
              loadUrl = urlMatch[1];
            }
          }
        }
      } else if (markerName.startsWith("Largest contentful paint after") && largestContentfulPaint === null) {
        const match = markerName.match(/after (\d+)ms/);
        if (match) {
          largestContentfulPaint = parseFloat(match[1]);
        }
      }
    }

    const resourcesBeforeLoad = navigationStart !== null && load !== null
      ? resources.filter((r: any) => {
          const markerIndex = filteredMarkers.findIndex((m: any) => {
            if (m.data && m.data.URI === r.url) {
              return true;
            }
            return false;
          });
          if (markerIndex === -1) return false;
          const marker = filteredMarkers[markerIndex];
          const startTime = marker.start || marker.startTime || 0;
          return startTime >= navigationStart && startTime <= load;
        })
      : [];

    let resourceStats: any = null;
    if (resourcesBeforeLoad.length > 0) {
      const byType: { [type: string]: number } = {};
      let totalDuration = 0;
      let maxDuration = 0;

      for (const res of resourcesBeforeLoad) {
        byType[res.type] = (byType[res.type] || 0) + 1;
        totalDuration += res.duration;
        maxDuration = Math.max(maxDuration, res.duration);
      }

      const topResources = [...resourcesBeforeLoad]
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 10);

      resourceStats = {
        totalResources: resourcesBeforeLoad.length,
        byType,
        avgDuration: totalDuration / resourcesBeforeLoad.length,
        maxDuration,
        topResources,
      };
    }

    let sampleCategoryStats: any = null;
    if (navigationStart !== null && load !== null) {
      try {
        const state = getState();
        const thread = selectors.selectedThread.getFilteredThread(state);
        const samples = thread.samples;
        const stackTable = thread.stackTable;
        const frameTable = thread.frameTable;
        const funcTable = thread.funcTable;
        const categoryList = selectors.profile.getCategories(state);

        const byCategory: { [category: string]: number } = {};
        let totalSamples = 0;

        if (samples && samples.time && samples.stack && stackTable && categoryList) {
          for (let i = 0; i < samples.length; i++) {
            const sampleTime = samples.time[i];
            if (sampleTime >= navigationStart && sampleTime <= load) {
              const stackIndex = samples.stack[i];
              if (stackIndex !== null && stackIndex !== undefined) {
                const categoryIndex = stackTable.category[stackIndex];

                if (categoryIndex !== null && categoryIndex !== undefined) {
                  const categoryName = categoryList[categoryIndex].name;
                  if (categoryName) {
                    byCategory[categoryName] = (byCategory[categoryName] || 0) + 1;
                    totalSamples++;
                  }
                }
              }
            }
          }
        }

        if (totalSamples > 0) {
          sampleCategoryStats = {
            totalSamples,
            byCategory,
          };
        }
      } catch (e) {
        console.log("Error collecting sample categories:", e);
      }
    }

    let jankPeriods: any[] = [];
    if (navigationStart !== null && load !== null) {
      const state = getState();
      const thread = selectors.selectedThread.getFilteredThread(state);
      const samples = thread.samples;
      const stackTable = thread.stackTable;
      const frameTable = thread.frameTable;
      const funcTable = thread.funcTable;
      const categoryList = selectors.profile.getCategories(state);

      for (let i = 0; i < filteredMarkers.length; i++) {
        const marker = filteredMarkers[i];
        let markerName = marker.name;
        if (marker.data && marker.data.name !== undefined) {
          const dataName = marker.data.name;
          if (typeof dataName === "number") {
            markerName = stringTable.getString(dataName);
          } else {
            markerName = dataName;
          }
        }

        if (markerName === "Jank" && marker.start && marker.end) {
          const startTime = marker.start;
          const endTime = marker.end;
          const duration = endTime - startTime;

          if (startTime >= navigationStart) {
            const functionCounts: { [funcName: string]: number } = {};
            const categoryCounts: { [category: string]: number } = {};

            if (samples && samples.time && samples.stack && stackTable && categoryList) {
              for (let j = 0; j < samples.length; j++) {
                const sampleTime = samples.time[j];
                if (sampleTime >= startTime && sampleTime <= endTime) {
                  const stackIndex = samples.stack[j];
                  if (stackIndex !== null && stackIndex !== undefined) {
                    const categoryIndex = stackTable.category[stackIndex];
                    if (categoryIndex !== null && categoryIndex !== undefined && categoryList[categoryIndex]) {
                      const categoryName = categoryList[categoryIndex].name;
                      categoryCounts[categoryName] = (categoryCounts[categoryName] || 0) + 1;
                    }

                    const frameIndex = stackTable.frame[stackIndex];
                    if (frameIndex !== null && frameIndex !== undefined) {
                      const funcIndex = frameTable.func[frameIndex];
                      if (funcIndex !== null && funcIndex !== undefined) {
                        const funcNameIndex = funcTable.name[funcIndex];
                        const funcName = stringTable.getString(funcNameIndex);
                        functionCounts[funcName] = (functionCounts[funcName] || 0) + 1;
                      }
                    }
                  }
                }
              }
            }

            const topFunctions = Object.entries(functionCounts)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([name, samples]) => ({ name, samples }));

            jankPeriods.push({
              startTime: startTime - navigationStart,
              duration,
              topFunctions,
              categories: categoryCounts,
            });
          }
        }
      }

    }

    const result: any = {
      url: loadUrl,
      navigationStart: navigationStart,
      load: load !== null && navigationStart !== null ? load - navigationStart : null,
      firstContentfulPaint: firstContentfulPaint,
      largestContentfulPaint: largestContentfulPaint,
      resources: resourceStats,
      sampleCategories: sampleCategoryStats,
      jankPeriods: jankPeriods.length > 0 ? jankPeriods : null,
    };

    return JSON.stringify(result);
  });

  await page.close();

  if (typeof jsonString !== "string") {
    throw new Error("Did not get back a string");
  }

  const result = JSON.parse(jsonString);
  return result;
}

export async function getNetworkResources(
  browser: Browser,
  url: string
): Promise<NetworkResourceSummary> {
  const page = await browser.newPage({
    bypassCSP: true,
  });

  page.setDefaultTimeout(0);

  await page.goto(url);

  await page.waitForFunction(() => {
    return (
      window.selectors &&
      selectors.app.getView(getState()).phase == "DATA_LOADED"
    );
  });

  await page.waitForFunction(() => {
    return selectors.profile.getSymbolicationStatus(getState()) == "DONE";
  });

  const jsonString = await page.evaluate(() => {
    const filteredMarkers = window.filteredMarkers;
    const stringTable = window.filteredThread.stringTable;

    let navigationStart: number | null = null;

    for (let i = 0; i < filteredMarkers.length; i++) {
      const marker = filteredMarkers[i];
      let markerName = marker.name;
      if (marker.data && marker.data.name !== undefined) {
        const dataName = marker.data.name;
        if (typeof dataName === "number") {
          markerName = stringTable.getString(dataName);
        } else {
          markerName = dataName;
        }
      }

      if (markerName === "Navigation::Start" && navigationStart === null) {
        navigationStart = marker.start || marker.startTime || 0;
        break;
      }
    }

    const resources: any[] = [];
    const phaseTotals: { [phase: string]: number } = {};
    const cacheStats: { [cacheType: string]: number } = {};

    for (let i = 0; i < filteredMarkers.length; i++) {
      const marker = filteredMarkers[i];

      if (marker.data && marker.data.type === "Network" && marker.data.status === "STATUS_STOP") {
        const data = marker.data;
        const startTime = marker.start || 0;
        const endTime = marker.end || startTime;
        const duration = endTime - startTime;

        const ALL_NETWORK_PHASES_IN_ORDER = [
          'startTime',
          'domainLookupStart',
          'domainLookupEnd',
          'connectStart',
          'tcpConnectEnd',
          'secureConnectionStart',
          'connectEnd',
          'requestStart',
          'responseStart',
          'responseEnd',
          'endTime',
        ];

        const HUMAN_LABEL_FOR_PHASE: any = {
          startTime: 'Waiting for socket thread',
          domainLookupStart: 'DNS request',
          domainLookupEnd: 'After DNS request',
          connectStart: 'TCP connection',
          tcpConnectEnd: 'After TCP connection',
          secureConnectionStart: 'Establishing TLS session',
          connectEnd: 'Waiting for HTTP request',
          requestStart: 'HTTP request and waiting for response',
          responseStart: 'HTTP response',
          responseEnd: 'Waiting for main thread',
          endTime: 'End',
        };

        const availablePhases: Array<{ phase: string; value: number }> = [];
        for (const phase of ALL_NETWORK_PHASES_IN_ORDER) {
          if (typeof data[phase] === 'number') {
            availablePhases.push({ phase, value: data[phase] });
          }
        }

        const phases: Array<{ label: string; duration: number }> = [];
        for (let j = 1; j < availablePhases.length; j++) {
          const prevPhase = availablePhases[j - 1];
          const currPhase = availablePhases[j];
          const phaseDuration = currPhase.value - prevPhase.value;
          const label = HUMAN_LABEL_FOR_PHASE[prevPhase.phase];
          phases.push({ label, duration: phaseDuration });

          phaseTotals[label] = (phaseTotals[label] || 0) + phaseDuration;
        }

        const cache = data.cache || "Unknown";
        cacheStats[cache] = (cacheStats[cache] || 0) + 1;

        const resource: any = {
          url: data.URI || "",
          startTime: navigationStart !== null ? startTime - navigationStart : startTime,
          duration,
          status: data.status || "",
          contentType: data.contentType,
          size: data.count,
          httpVersion: data.httpVersion,
          cache,
          phases,
        };

        resources.push(resource);
      }
    }

    return JSON.stringify({
      resources: resources.sort((a, b) => a.startTime - b.startTime),
      totalResources: resources.length,
      phaseTotals,
      cacheStats,
    });
  });

  await page.close();

  if (typeof jsonString !== "string") {
    throw new Error("Did not get back a string");
  }

  const result = JSON.parse(jsonString);
  return result;
}
