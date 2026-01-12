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

async function fetchAssemblyFromSamply(page: any, nativeSym: any): Promise<any> {
  const libInfo = await page.evaluate(({ nativeSym }: any) => {
    const state = window.getState();
    const profile = window.selectors.profile.getProfile(state);
    const lib = profile.libs[nativeSym.libIndex];

    const currentUrl = window.location.href;
    const symbolServerMatch = currentUrl.match(/symbolServer=([^&]+)/);

    return {
      debugName: lib.debugName,
      breakpadId: lib.breakpadId,
      codeId: lib.codeId || null,
      name: nativeSym.name,
      address: nativeSym.address,
      functionSize: nativeSym.functionSize,
      functionSizeIsKnown: nativeSym.functionSizeIsKnown,
      symbolServerUrl: symbolServerMatch ? decodeURIComponent(symbolServerMatch[1]) : null
    };
  }, { nativeSym });

  const { debugName, breakpadId, codeId, name, address, functionSize, functionSizeIsKnown, symbolServerUrl } = libInfo as any;

  if (!symbolServerUrl) {
    return null;
  }

  const asmUrl = `${symbolServerUrl}/asm/v1`;
  const asmBody = JSON.stringify({
    debugName,
    debugId: breakpadId,
    name,
    codeId,
    startAddress: `0x${address.toString(16)}`,
    size: `0x${functionSize.toString(16)}`,
    continueUntilFunctionEnd: !functionSizeIsKnown
  });

  try {
    const response = await fetch(asmUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: asmBody
    });

    console.log(`Samply /asm/v1 response status: ${response.status}`);

    if (response.ok) {
      const responseText = await response.text();
      let asmData: any;

      try {
        asmData = JSON.parse(responseText);
      } catch (e) {
        console.log("Response is not JSON");
        return null;
      }

      console.log(`Response type: ${typeof asmData}, constructor: ${asmData?.constructor?.name}`);
      console.log(`First char of response: ${responseText.substring(0, 1)}`);
      console.log(`First 100 chars: ${responseText.substring(0, 100)}`);

      // The response should be an object with {startAddress, instructions, ...}
      if (asmData && typeof asmData === 'object' && asmData.startAddress && asmData.instructions) {
        console.log(`Got ${asmData.instructions.length} instructions`);
        const startAddress = parseInt(asmData.startAddress, 16);
        const instructions = asmData.instructions.map((inst: any) => ({
          address: startAddress + inst[0],
          instruction: inst[1]
        }));

        return { instructions };
      } else {
        console.log("Response doesn't have expected structure");
      }
    } else {
      console.log(`Response not OK: ${response.status}`);
    }
  } catch (error) {
    console.log(`Error fetching from samply: ${error}`);
  }

  return null;
}

export async function annotateFunction(
  browser: Browser,
  url: string,
  functionName: string,
  mode: 'asm' | 'src' | 'all'
): Promise<void> {
  const page = await browser.newPage({
    bypassCSP: true,
  });

  page.setDefaultTimeout(0);

  console.log("Loading profile...");
  await page.goto(url, { timeout: 120000 });

  console.log("Waiting for profile data...");
  await page.waitForFunction(() => {
    return (
      window.selectors &&
      selectors.app.getView(getState()).phase == "DATA_LOADED"
    );
  }, { timeout: 300000 });

  console.log("Waiting for symbolication...");
  await page.waitForFunction(() => {
    return selectors.profile.getSymbolicationStatus(getState()) == "DONE";
  }, { timeout: 120000 });

  // Set up inverted call tree like --calltree does
  await page.evaluate(() => {
    const dispatch = window.dispatch;
    const actions = window.actions;
    dispatch(actions.changeInvertCallstack(true));
    dispatch(actions.changeSelectedTab("calltree"));
  });

  await new Promise((resolve) => setTimeout(resolve, 500));

  console.log(`Searching for function: ${functionName}`);

  // Find the function using call tree (same approach as --calltree)
  const result = await page.evaluate(
    ({ functionName }: { functionName: string }) => {
      const rootNodes = window.callTree.getRoots();

      if (!rootNodes || rootNodes.length === 0) {
        return { error: "No call tree data available" };
      }

      // Search for the function in the call tree
      let foundNode = null;
      for (const rootNode of rootNodes) {
        const nodeData = window.callTree.getNodeData(rootNode);
        if (nodeData && nodeData.funcName === functionName) {
          foundNode = {
            funcName: nodeData.funcName,
            selfTime: nodeData.self || 0,
            totalTime: nodeData.total || 0
          };
          break;
        }
      }

      if (!foundNode) {
        return { error: `Function "${functionName}" not found in call tree` };
      }

      return foundNode;
    },
    { functionName }
  );

  if ((result as any).error) {
    console.error((result as any).error);
    if ((result as any).matchingFunctions) {
      console.log("\nFunctions containing 'findOptimal':");
      for (const fn of (result as any).matchingFunctions) {
        console.log(`  - ${fn}`);
      }
    }
    await page.close();
    return;
  }

  const { funcName, selfTime, totalTime } = result as any;
  console.log(`Found function: ${funcName}`);
  console.log(`Self time: ${selfTime} samples, Total time: ${totalTime} samples`);
  console.log(`Mode: ${mode}\n`);

  // Get native symbols for this function (needed for asm and src modes)
  // Works for any function with native symbols (JIT, C++, Rust, etc.)
  let nativeSymbolInfo: any = null;

  console.log("Extracting native symbol info...");

  nativeSymbolInfo = await page.evaluate(
      ({ functionName }: { functionName: string }) => {
        const rootNodes = window.callTree.getRoots();

        // Find the call tree node for this function
        let targetNode = null;
        for (const rootNode of rootNodes) {
          const nodeData = window.callTree.getNodeData(rootNode);
          if (nodeData && nodeData.funcName === functionName) {
            targetNode = rootNode;
            break;
          }
        }

        if (targetNode === null) {
          return { error: "Function not found in call tree" };
        }

        // Get bottom box info which includes native symbols
        const bottomBoxInfo = window.callTree.getBottomBoxInfoForCallNode(targetNode);

        if (!bottomBoxInfo || !bottomBoxInfo.nativeSymbols || bottomBoxInfo.nativeSymbols.length === 0) {
          return { error: "No native symbols found for this function (not JIT compiled?)" };
        }

        // Group native symbols by function size
        const groups = new Map<number, any>();

        for (const nativeSymbol of bottomBoxInfo.nativeSymbols) {
          const funcSize = nativeSymbol.functionSize;

          if (!groups.has(funcSize)) {
            groups.set(funcSize, {
              functionSize: funcSize,
              nativeSymbols: [],
              representativeSymbol: nativeSymbol
            });
          }

          groups.get(funcSize).nativeSymbols.push(nativeSymbol);
        }

        const groupArray = Array.from(groups.values()).map(g => ({
          functionSize: g.functionSize,
          symbolCount: g.nativeSymbols.length,
          nativeSymbols: g.nativeSymbols,
          representativeSymbol: g.representativeSymbol
        }));

        // Sort by function size (largest first)
        groupArray.sort((a, b) => b.functionSize - a.functionSize);

        return {
          groups: groupArray,
          totalGroups: groupArray.length,
          totalNativeSymbols: bottomBoxInfo.nativeSymbols.length
        };
      },
      { functionName }
    );

  if (mode === 'asm' || mode === 'all') {
    console.log("\nExtracting assembly code...");

    if (!nativeSymbolInfo || (nativeSymbolInfo as any).error) {
      console.error(`Assembly extraction failed: ${(nativeSymbolInfo as any)?.error || 'No native symbols (not JIT compiled?)'}`);
    } else {
      const { groups, totalGroups, totalNativeSymbols } = nativeSymbolInfo as any;
      console.log(`Found ${totalNativeSymbols} native symbol(s) in ${totalGroups} compilation variant(s):\n`);

      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        console.log(`Compilation ${i + 1}:`);
        console.log(`  Function size: ${group.functionSize} bytes`);
        console.log(`  Native symbols: ${group.symbolCount}`);

        // Show the first symbol's info
        if (group.nativeSymbols && group.nativeSymbols.length > 0) {
          const sym = group.nativeSymbols[0];
          console.log(`  Address: 0x${sym.address.toString(16)}`);
          console.log(`  Name: ${sym.name}`);
        }
        console.log();
      }

      // For each compilation variant, get the assembly code
      console.log("Fetching assembly code for each compilation...\n");

      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        console.log(`\n${"═".repeat(80)}`);
        console.log(`Compilation ${i + 1} of ${totalGroups}`);
        console.log(`${"═".repeat(80)}\n`);

        // Use the representative native symbol to fetch assembly
        const nativeSym = group.representativeSymbol;

        // Dispatch UPDATE_BOTTOM_BOX to load this native symbol's assembly
        await page.evaluate(({ nativeSym }: any) => {
          const state = window.getState();
          const threadsKey = window.selectors.urlState.getSelectedThreadsKey(state);
          const currentTab = window.selectors.urlState.getSelectedTab(state);

          window.dispatch(window.actions.updateBottomBoxContentsAndMaybeOpen(currentTab, {
            libIndex: nativeSym.libIndex,
            sourceIndex: null,
            nativeSymbols: [nativeSym]
          }));
        }, { nativeSym });

        // Wait for assembly to load
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Get native symbol index for line mapping
        const nativeSymbolIndex = await page.evaluate(({ nativeSym }: any) => {
          const state = window.getState();
          const thread = window.selectors.selectedThread.getThread(state);
          const { nativeSymbols } = thread;

          // Find the index of this native symbol
          for (let i = 0; i < nativeSymbols.length; i++) {
            if (nativeSymbols.address[i] === nativeSym.address &&
                nativeSymbols.libIndex[i] === nativeSym.libIndex) {
              return i;
            }
          }
          return null;
        }, { nativeSym });

        // Get the assembly code with sample counts
        const assemblyData = await page.evaluate(({ nativeSym, nativeSymbolIndex }: any) => {
          const state = window.getState();
          const assemblyViewCode = window.selectors.code.getAssemblyViewCode(state);
          const nativeSymbolBaseAddress = nativeSym.address;

          if (!assemblyViewCode || assemblyViewCode.type === 'ERROR') {
            return {
              error: 'Assembly not available',
              assemblyViewCode: assemblyViewCode ? JSON.stringify(assemblyViewCode).substring(0, 200) : null
            };
          }

          if (assemblyViewCode.type !== 'AVAILABLE') {
            return { error: `Assembly in state: ${assemblyViewCode.type}` };
          }

          // Get address timings (sample counts per address)
          const addressTimings = window.selectors.selectedThread.getAssemblyViewAddressTimings(state);

          // Map sample counts to instructions
          const totalSamples = addressTimings.totalAddressHits || new Map();
          const selfSamples = addressTimings.selfAddressHits || new Map();

          // Check ALL fields on assembly view code object
          const asmViewKeys = Object.keys(assemblyViewCode);
          const firstInst = assemblyViewCode.instructions[0] || {};
          const instKeys = Object.keys(firstInst);

          // Check if there's source code attached to the assembly view
          const hasSourceCode = assemblyViewCode.sourceCode || assemblyViewCode.source;

          // Get line mappings from frame table for interleaving
          const thread = window.selectors.selectedThread.getThread(state);
          const { samples, stackTable, frameTable } = thread;

          // Build a map of address -> source line number from frames
          const addressToLineMap = new Map<number, number>();

          for (let sampleIdx = 0; sampleIdx < samples.length; sampleIdx++) {
            let stackIdx = samples.stack[sampleIdx];
            while (stackIdx !== null) {
              const frameIdx = stackTable.frame[stackIdx];
              const frameNativeSymbol = frameTable.nativeSymbol ? frameTable.nativeSymbol[frameIdx] : null;

              if (frameNativeSymbol === nativeSymbolIndex) {
                const address = frameTable.address ? frameTable.address[frameIdx] : null;
                const lineNumber = frameTable.line ? frameTable.line[frameIdx] : null;

                if (address !== null && lineNumber !== null) {
                  addressToLineMap.set(address, lineNumber);
                }
              }

              stackIdx = stackTable.prefix[stackIdx];
            }
          }

          const instructions = assemblyViewCode.instructions.map((inst: any) => {
            const totalCount = totalSamples.get(inst.address) || 0;
            const selfCount = selfSamples.get(inst.address) || 0;
            const sourceLineNumber = addressToLineMap.get(inst.address) || null;

            return {
              address: inst.address,
              instruction: inst.decodedString,
              totalSamples: totalCount,
              selfSamples: selfCount,
              sourceLineNumber
            };
          });

          let totalSampleCount = 0;
          for (const count of selfSamples.values()) {
            totalSampleCount += count;
          }

          return {
            instructions,
            totalSampleCount
          };
        }, { nativeSym, nativeSymbolIndex });

        if ((assemblyData as any).error) {
          console.log(`Error: ${(assemblyData as any).error}`);

          // Check if this is a V8/malformed response error - try fetching directly from samply
          const errorStr = JSON.stringify((assemblyData as any).assemblyViewCode || '');
          if (errorStr.includes('SYMBOL_SERVER_API_MALFORMED_RESPONSE') || errorStr.includes('BROWSER_CONNECTION_ERROR')) {
            console.log("Profiler UI failed, fetching assembly directly from samply...\n");

            // Fetch assembly directly from samply
            const samplyAsm = await fetchAssemblyFromSamply(page, nativeSym);

            console.log(`Samply fetch result: ${samplyAsm ? 'success' : 'failed'}`);

            if (samplyAsm && samplyAsm.instructions) {
              console.log(`Got ${samplyAsm.instructions.length} instructions from samply`);

              // Compute sample counts and line mappings manually from frame table
              const sampleCounts = await page.evaluate(({ nativeSymbolIndex, instructions }: any) => {
                const state = window.getState();
                const thread = window.selectors.selectedThread.getThread(state);
                const { samples, stackTable, frameTable } = thread;

                const addressSamples = new Map<number, number>();
                const addressToLineMap = new Map<number, number>();

                for (let sampleIdx = 0; sampleIdx < samples.length; sampleIdx++) {
                  let stackIdx = samples.stack[sampleIdx];
                  while (stackIdx !== null) {
                    const frameIdx = stackTable.frame[stackIdx];
                    const frameNativeSymbol = frameTable.nativeSymbol ? frameTable.nativeSymbol[frameIdx] : null;

                    if (frameNativeSymbol === nativeSymbolIndex) {
                      const address = frameTable.address ? frameTable.address[frameIdx] : null;
                      const lineNumber = frameTable.line ? frameTable.line[frameIdx] : null;

                      if (address !== null) {
                        addressSamples.set(address, (addressSamples.get(address) || 0) + 1);
                        if (lineNumber !== null && !addressToLineMap.has(address)) {
                          addressToLineMap.set(address, lineNumber);
                        }
                      }
                    }

                    stackIdx = stackTable.prefix[stackIdx];
                  }
                }

                // Map sample counts and line numbers to instructions
                return instructions.map((inst: any) => {
                  const samples = addressSamples.get(inst.address) || 0;
                  return {
                    address: inst.address,
                    instruction: inst.instruction,
                    selfSamples: samples,
                    totalSamples: samples,
                    sourceLineNumber: addressToLineMap.get(inst.address) || null
                  };
                });
              }, { nativeSymbolIndex, instructions: samplyAsm.instructions });

              const instructionsWithSamples = sampleCounts as any;
              const totalSampleCount = instructionsWithSamples.reduce((sum: number, inst: any) => sum + inst.selfSamples, 0);

              console.log(`Total samples: ${totalSampleCount}\n`);

              if (mode === 'asm') {
                const headerAddr = "Address".padEnd(10);
                console.log(`${headerAddr}    Self   Total`);
                console.log("─".repeat(80));
                for (const inst of instructionsWithSamples) {
                  const addrStr = `0x${inst.address.toString(16).padStart(8, '0')}`;
                  const selfStr = inst.selfSamples > 0 ? inst.selfSamples.toString().padStart(7) : "       ";
                  const totalStr = inst.totalSamples > 0 ? inst.totalSamples.toString().padStart(7) : "       ";
                  const marker = inst.selfSamples > 0 ? "►" : " ";
                  console.log(`${addrStr}  ${selfStr}  ${totalStr}  ${marker} ${inst.instruction}`);
                }
                console.log();
              } else {
                // For mode=all, store for interleaving
                group.assemblyInstructions = instructionsWithSamples;
                group.assemblyTotalSamples = totalSampleCount;
                console.log(`Stored ${instructionsWithSamples.length} instructions for interleaving`);
                console.log(`${instructionsWithSamples.filter((i: any) => i.sourceLineNumber !== null).length} instructions have source line mappings\n`);
              }
            }
          }
        } else {
          const { instructions, totalSampleCount } = assemblyData as any;
          console.log(`Total samples: ${totalSampleCount}`);
          console.log(`Instructions: ${instructions.length}\n`);

          if (mode === 'asm') {
            // Display all instructions with sample counts
            const headerAddr = "Address".padEnd(10);
            console.log(`${headerAddr}    Self   Total`);
            console.log("─".repeat(80));

            for (const inst of instructions) {
              const addrStr = `0x${inst.address.toString(16).padStart(8, '0')}`;
              const selfStr = inst.selfSamples > 0 ? inst.selfSamples.toString().padStart(7) : "       ";
              const totalStr = inst.totalSamples > 0 ? inst.totalSamples.toString().padStart(7) : "       ";
              const marker = inst.selfSamples > 0 ? "►" : " ";
              console.log(`${addrStr}  ${selfStr}  ${totalStr}  ${marker} ${inst.instruction}`);
            }

            console.log();
          } else {
            // For mode=all, store for interleaving
            group.assemblyInstructions = instructions;
            group.assemblyTotalSamples = totalSampleCount;
          }
        }
      }
    }
  }

  if (mode === 'src' || mode === 'all') {
    console.log("\nExtracting source code...");

    // Get source using function's source index (like the profiler UI does when you double-click)
    const funcSourceInfo = await page.evaluate(
      ({ functionName }: { functionName: string }) => {
        const state = window.getState();
        const thread = window.selectors.selectedThread.getFilteredThread(state);
        const { funcTable, stringTable } = thread;

        // Find function
        let funcIndex = null;
        for (let i = 0; i < funcTable.length; i++) {
          const nameIdx = funcTable.name[i];
          const name = stringTable.getString(nameIdx);
          if (name === functionName) {
            funcIndex = i;
            break;
          }
        }

        if (funcIndex === null) {
          return { error: "Function not found" };
        }

        const sourceIndex = funcTable.source ? funcTable.source[funcIndex] : null;

        return { funcIndex, sourceIndex };
      },
      { functionName }
    );

    console.log(`Function source info: ${JSON.stringify(funcSourceInfo)}`);

    // For functions without source index, try triggering source load via native symbol
    if (((funcSourceInfo as any).error || (funcSourceInfo as any).sourceIndex === null) &&
        nativeSymbolInfo && !(nativeSymbolInfo as any).error) {
      console.log("No source index, trying to load source via native symbol...");

      const groups = (nativeSymbolInfo as any).groups || [];
      if (groups.length > 0) {
        const group = groups[0];
        const nativeSym = group.representativeSymbol;

        // Dispatch UPDATE_BOTTOM_BOX with native symbol
        await page.evaluate(({ nativeSym }: any) => {
          const state = window.getState();
          const currentTab = window.selectors.urlState.getSelectedTab(state);

          window.dispatch(window.actions.updateBottomBoxContentsAndMaybeOpen(currentTab, {
            libIndex: nativeSym.libIndex,
            sourceIndex: null,
            nativeSymbols: [nativeSym]
          }));
        }, { nativeSym });

        // Wait for source to load (try polling like we do for assembly)
        console.log("Waiting for source view to load...");
        let attempts = 0;
        let sourceLoaded = false;

        while (attempts < 30) {
          const sourceCheck = await page.evaluate(() => {
            const state = window.getState();
            const sourceViewCode = window.selectors.code.getSourceViewCode(state);
            return {
              exists: !!sourceViewCode,
              type: sourceViewCode?.type || null,
              available: sourceViewCode?.type === 'AVAILABLE',
              codeLength: sourceViewCode?.type === 'AVAILABLE' ? sourceViewCode.code.length : 0
            };
          });

          if (sourceCheck.available) {
            console.log(`Source view loaded after ${attempts + 1} attempts`);
            sourceLoaded = true;
            break;
          }

          if (attempts % 5 === 0 && attempts > 0) {
            console.log(`Attempt ${attempts + 1}/30: exists=${sourceCheck.exists}, type=${sourceCheck.type}`);
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
          attempts++;
        }

        if (!sourceLoaded) {
          console.log("Source view did not load after 30 seconds");
        }

        if (sourceLoaded) {
          console.log("Source loaded via native symbol!\n");

          // Get source with line timings
          const sourceData = await page.evaluate(() => {
            const state = window.getState();
            const sourceViewCode = window.selectors.code.getSourceViewCode(state);
            const lineTimings = window.selectors.selectedThread.getSourceViewLineTimings(state);
            const selfHits = lineTimings.selfLineHits || new Map();
            const totalHits = lineTimings.totalLineHits || new Map();

            const lines = sourceViewCode.code.split('\n');
            const linesWithSamples = lines.map((text: string, index: number) => {
              const lineNumber = index + 1;
              return {
                lineNumber,
                text,
                selfSamples: selfHits.get(lineNumber) || 0,
                totalSamples: totalHits.get(lineNumber) || 0
              };
            });

            let totalSampleCount = 0;
            for (const count of selfHits.values()) {
              totalSampleCount += count;
            }

            return {
              success: true,
              lines: linesWithSamples,
              totalLines: lines.length,
              totalSamples: totalSampleCount
            };
          });

          // Continue with the normal source processing flow
          if ((sourceData as any).success) {
            const { lines, totalLines, totalSamples } = sourceData as any;

            // Extract function start line and filter
            const lineMatch = functionName.match(/:(\d+):\d+\)?$/);
            const functionStartLine = lineMatch ? parseInt(lineMatch[1]) : null;

            let relevantLines = lines;
            if (functionStartLine !== null) {
              const startLine = lines.find((l: any) => l.lineNumber === functionStartLine);
              if (startLine) {
                const startIndent = startLine.text.search(/\S/);
                let endLineNumber = lines.length;

                for (let i = 0; i < lines.length; i++) {
                  const line = lines[i];
                  if (line.lineNumber > functionStartLine) {
                    const lineIndent = line.text.search(/\S/);
                    if (line.text.trim() === '}' && lineIndent <= startIndent) {
                      endLineNumber = line.lineNumber;
                      break;
                    }
                  }
                }

                relevantLines = lines.filter((l: any) =>
                  l.lineNumber >= functionStartLine && l.lineNumber <= endLineNumber
                );
              }
            }

            if (mode === 'src') {
              console.log(`Source code (${relevantLines.length} lines, ${totalSamples} samples):\n`);
              const headerLine = "Line".padEnd(10);
              console.log(`${headerLine}    Self   Total`);
              console.log("─".repeat(80));

              for (const line of relevantLines) {
                const lineNum = line.lineNumber.toString().padStart(10);
                const selfStr = line.selfSamples > 0 ? line.selfSamples.toString().padStart(7) : "       ";
                const totalStr = line.totalSamples > 0 ? line.totalSamples.toString().padStart(7) : "       ";
                const marker = line.selfSamples > 0 ? "►" : " ";
                console.log(`${lineNum}  ${selfStr}  ${totalStr}  ${marker} ${line.text}`);
              }
              console.log();

              await page.close();
              return;
            }

            // For mode=all, continue to interleaving
            if (mode === 'all' && nativeSymbolInfo && !(nativeSymbolInfo as any).error) {
              const groups = (nativeSymbolInfo as any).groups || [];

              for (const group of groups) {
                if (group.assemblyInstructions) {
                  console.log(`\n${"═".repeat(80)}`);
                  console.log("Interleaved Source and Assembly");
                  console.log(`${"═".repeat(80)}\n`);

                  const sourceLineMap = new Map<number, any>();
                  for (const line of relevantLines) {
                    sourceLineMap.set(line.lineNumber, line);
                  }

                  const headerLine = "Line/Addr".padEnd(10);
                  console.log(`${headerLine}    Self   Total`);
                  console.log("─".repeat(80));

                  let lastSourceLineShown = 0;
                  let justShowedSource = false;

                  for (let i = 0; i < group.assemblyInstructions.length; i++) {
                    const inst = group.assemblyInstructions[i];
                    const nextInst = i + 1 < group.assemblyInstructions.length ? group.assemblyInstructions[i + 1] : null;

                    if (inst.sourceLineNumber !== null) {
                      const hasSourceToShow = relevantLines.some((l: any) =>
                        l.lineNumber > lastSourceLineShown && l.lineNumber <= inst.sourceLineNumber
                      );

                      if (hasSourceToShow) {
                        if (justShowedSource === false && lastSourceLineShown > 0) {
                          console.log();
                        }

                        for (const line of relevantLines) {
                          if (line.lineNumber > lastSourceLineShown && line.lineNumber <= inst.sourceLineNumber) {
                            const lineNum = line.lineNumber.toString().padStart(10);
                            const selfStr = line.selfSamples > 0 ? line.selfSamples.toString().padStart(7) : "       ";
                            const totalStr = line.totalSamples > 0 ? line.totalSamples.toString().padStart(7) : "       ";
                            const marker = line.selfSamples > 0 ? "►" : " ";
                            console.log(`${lineNum}  ${selfStr}  ${totalStr}  ${marker} ${line.text}`);

                            lastSourceLineShown = line.lineNumber;
                          }
                        }

                        justShowedSource = true;

                        const nextWillShowSource = nextInst && nextInst.sourceLineNumber !== null &&
                                                   nextInst.sourceLineNumber > lastSourceLineShown;
                        if (!nextWillShowSource) {
                          console.log();
                        }
                      }
                    } else {
                      justShowedSource = false;
                    }

                    const addrStr = `0x${inst.address.toString(16).padStart(8, '0')}`;
                    const selfStr = inst.selfSamples > 0 ? inst.selfSamples.toString().padStart(7) : "       ";
                    const totalStr = inst.totalSamples > 0 ? inst.totalSamples.toString().padStart(7) : "       ";
                    const marker = inst.selfSamples > 0 ? "►" : " ";
                    console.log(`${addrStr}  ${selfStr}  ${totalStr}  ${marker} ${inst.instruction}`);
                  }

                  const hasRemainingSource = relevantLines.some((l: any) => l.lineNumber > lastSourceLineShown);
                  if (hasRemainingSource) {
                    console.log();
                    for (const line of relevantLines) {
                      if (line.lineNumber > lastSourceLineShown) {
                        const lineNum = line.lineNumber.toString().padStart(10);
                        const selfStr = line.selfSamples > 0 ? line.selfSamples.toString().padStart(7) : "       ";
                        const totalStr = line.totalSamples > 0 ? line.totalSamples.toString().padStart(7) : "       ";
                        const marker = line.selfSamples > 0 ? "►" : " ";
                        console.log(`${lineNum}  ${selfStr}  ${totalStr}  ${marker} ${line.text}`);
                      }
                    }
                  }

                  console.log();
                }
              }

              await page.close();
              return;
            }
          }
        }
      }
    }

    if ((funcSourceInfo as any).error || (funcSourceInfo as any).sourceIndex === null) {
      console.log("No source index for this function, trying alternative method...");

      // For V8/functions without source index, try to load source by file path
      // Extract file path from function name: "JS:o*run /path/file.js:58:13"
      const fileMatch = functionName.match(/\s([^\s]+\.js):\d+:\d+/);
      if (fileMatch) {
        const filePath = fileMatch[1];
        console.log(`Trying to load source from file: ${filePath}\n`);

        // Try to read the file directly if it exists
        const fs = await import('fs');
        if (fs.existsSync(filePath)) {
          const sourceText = fs.readFileSync(filePath, 'utf-8');
          const lines = sourceText.split('\n');

          // Compute sample counts per line from frame table
          const lineSamples = await page.evaluate(
            ({ functionName }: { functionName: string }) => {
              const state = window.getState();
              const thread = window.selectors.selectedThread.getThread(state);
              const { funcTable, stringTable, samples, stackTable, frameTable } = thread;

              // Find function index
              let funcIndex = null;
              for (let i = 0; i < funcTable.length; i++) {
                const nameIdx = funcTable.name[i];
                const name = stringTable.getString(nameIdx);
                if (name === functionName) {
                  funcIndex = i;
                  break;
                }
              }

              if (funcIndex === null) {
                return {};
              }

              // Count samples per line
              const lineCounts: any = {};

              for (let sampleIdx = 0; sampleIdx < samples.length; sampleIdx++) {
                let stackIdx = samples.stack[sampleIdx];
                while (stackIdx !== null) {
                  const frameIdx = stackTable.frame[stackIdx];
                  const frameFuncIdx = frameTable.func[frameIdx];

                  if (frameFuncIdx === funcIndex) {
                    const lineNumber = frameTable.line ? frameTable.line[frameIdx] : null;
                    if (lineNumber !== null) {
                      lineCounts[lineNumber] = (lineCounts[lineNumber] || 0) + 1;
                    }
                    break;
                  }

                  stackIdx = stackTable.prefix[stackIdx];
                }
              }

              return lineCounts;
            },
            { functionName }
          );

          const sampleCounts = lineSamples as any;
          const totalSamplesInSource = Object.values(sampleCounts).reduce((sum: number, val: any) => sum + val, 0);

          if (totalSamplesInSource === 0) {
            console.log(`Note: V8 jitdumps don't include source line debug info (frameTable.line is empty)`);
            console.log(`Showing source structure only, sample counts not available\n`);
          } else {
            console.log(`Got sample counts for ${Object.keys(sampleCounts).length} lines, total ${totalSamplesInSource} samples\n`);
          }

          const linesWithSamples = lines.map((text: string, index: number) => ({
            lineNumber: index + 1,
            text,
            selfSamples: sampleCounts[index + 1] || 0,
            totalSamples: sampleCounts[index + 1] || 0
          }));

          // Process relevantLines for mode=all
          const lineMatch = functionName.match(/:(\d+):\d+\)?$/);
          const functionStartLine = lineMatch ? parseInt(lineMatch[1]) : null;

          let relevantLines = linesWithSamples;
          if (functionStartLine !== null) {
            const startLine = linesWithSamples.find((l: any) => l.lineNumber === functionStartLine);
            if (startLine) {
              const startIndent = startLine.text.search(/\S/);
              let endLineNumber = linesWithSamples.length;

              for (let i = 0; i < linesWithSamples.length; i++) {
                const line = linesWithSamples[i];
                if (line.lineNumber > functionStartLine) {
                  const lineIndent = line.text.search(/\S/);
                  if (line.text.trim() === '}' && lineIndent <= startIndent) {
                    endLineNumber = line.lineNumber;
                    break;
                  }
                }
              }

              relevantLines = linesWithSamples.filter((l: any) =>
                l.lineNumber >= functionStartLine && l.lineNumber <= endLineNumber
              );
            }
          }

          // For mode=src, display source
          if (mode === 'src') {
            console.log(`Source code (${relevantLines.length} lines, read from file):\n`);
            const headerLine = "Line".padEnd(10);
            console.log(`${headerLine}    Self   Total`);
            console.log("─".repeat(80));

            for (const line of relevantLines) {
              const lineNum = line.lineNumber.toString().padStart(10);
              console.log(`${lineNum}                      ${line.text}`);
            }
            console.log();

            await page.close();
            return;
          }

          // For mode=all, continue to interleaving with this source
          const sourceData = { success: true, lines: relevantLines, totalLines: relevantLines.length, totalSamples: 0 };

          // Jump to the mode=all interleaving code below
          if (mode === 'all' && nativeSymbolInfo && !(nativeSymbolInfo as any).error) {
            const groups = (nativeSymbolInfo as any).groups || [];

            for (const group of groups) {
              if (group.assemblyInstructions) {
                console.log(`\n${"═".repeat(80)}`);
                console.log("Interleaved Source and Assembly");
                console.log(`${"═".repeat(80)}\n`);

                // Build map of line number -> source text for quick lookup
                const sourceLineMap = new Map<number, any>();
                for (const line of relevantLines) {
                  sourceLineMap.set(line.lineNumber, line);
                }

                // Header row
                const headerLine = "Line/Addr".padEnd(10);
                console.log(`${headerLine}    Self   Total`);
                console.log("─".repeat(80));

                // Display ALL assembly instructions in address order
                // Show ALL source lines, inserting assembly where it maps
                let lastSourceLineShown = 0;
                let justShowedSource = false;

                for (let i = 0; i < group.assemblyInstructions.length; i++) {
                  const inst = group.assemblyInstructions[i];
                  const nextInst = i + 1 < group.assemblyInstructions.length ? group.assemblyInstructions[i + 1] : null;

                  // If this instruction maps to a source line, check if we need to show source lines first
                  if (inst.sourceLineNumber !== null) {
                    const hasSourceToShow = relevantLines.some((l: any) =>
                      l.lineNumber > lastSourceLineShown && l.lineNumber <= inst.sourceLineNumber
                    );

                    if (hasSourceToShow) {
                      // Blank line before source block (if we just showed assembly)
                      if (justShowedSource === false && lastSourceLineShown > 0) {
                        console.log();
                      }

                      // Show all source lines from lastSourceLineShown+1 up to and including this line
                      for (const line of relevantLines) {
                        if (line.lineNumber > lastSourceLineShown && line.lineNumber <= inst.sourceLineNumber) {
                          // Show source line (no blank lines between consecutive source lines)
                          const lineNum = line.lineNumber.toString().padStart(10);
                          const selfStr = line.selfSamples > 0 ? line.selfSamples.toString().padStart(7) : "       ";
                          const totalStr = line.totalSamples > 0 ? line.totalSamples.toString().padStart(7) : "       ";
                          const marker = line.selfSamples > 0 ? "►" : " ";
                          console.log(`${lineNum}  ${selfStr}  ${totalStr}  ${marker} ${line.text}`);

                          lastSourceLineShown = line.lineNumber;
                        }
                      }

                      justShowedSource = true;

                      // Only add blank line after source if next instruction doesn't also map to a source line
                      const nextWillShowSource = nextInst && nextInst.sourceLineNumber !== null &&
                                                 nextInst.sourceLineNumber > lastSourceLineShown;
                      if (!nextWillShowSource) {
                        console.log();
                      }
                    }
                  } else {
                    justShowedSource = false;
                  }

                  // Show assembly instruction
                  const addrStr = `0x${inst.address.toString(16).padStart(8, '0')}`;
                  const selfStr = inst.selfSamples > 0 ? inst.selfSamples.toString().padStart(7) : "       ";
                  const totalStr = inst.totalSamples > 0 ? inst.totalSamples.toString().padStart(7) : "       ";
                  const marker = inst.selfSamples > 0 ? "►" : " ";
                  console.log(`${addrStr}  ${selfStr}  ${totalStr}  ${marker} ${inst.instruction}`);
                }

                // Show any remaining source lines
                const hasRemainingSource = relevantLines.some((l: any) => l.lineNumber > lastSourceLineShown);
                if (hasRemainingSource) {
                  console.log();
                  for (const line of relevantLines) {
                    if (line.lineNumber > lastSourceLineShown) {
                      const lineNum = line.lineNumber.toString().padStart(10);
                      const selfStr = line.selfSamples > 0 ? line.selfSamples.toString().padStart(7) : "       ";
                      const totalStr = line.totalSamples > 0 ? line.totalSamples.toString().padStart(7) : "       ";
                      const marker = line.selfSamples > 0 ? "►" : " ";
                      console.log(`${lineNum}  ${selfStr}  ${totalStr}  ${marker} ${line.text}`);
                    }
                  }
                }

                console.log();
              }
            }

            await page.close();
            return;
          }
        }
      }
    } else {
      const sourceIndex = (funcSourceInfo as any).sourceIndex;
      console.log(`Function source index: ${sourceIndex}`);

      // Check what this source index points to
      const sourceInfo = await page.evaluate(({ sourceIndex }: any) => {
        const state = window.getState();
        const profile = window.selectors.profile.getProfile(state);

        if (profile.sourceTable && sourceIndex < profile.sourceTable.length) {
          const fileName = profile.sourceTable.fileName ? profile.sourceTable.fileName[sourceIndex] : null;
          const category = profile.sourceTable.category ? profile.sourceTable.category[sourceIndex] : null;

          return {
            sourceIndex,
            fileName: fileName !== null ? profile.stringTable.getString(fileName) : null,
            category
          };
        }

        return { sourceIndex, fileName: null, category: null };
      }, { sourceIndex });

      console.log(`Source info: ${JSON.stringify(sourceInfo)}`);

      // Dispatch to load this source
      await page.evaluate(({ sourceIndex }: any) => {
        const state = window.getState();
        const currentTab = window.selectors.urlState.getSelectedTab(state);

        window.dispatch(window.actions.updateBottomBoxContentsAndMaybeOpen(currentTab, {
          libIndex: null,
          sourceIndex: sourceIndex,
          nativeSymbols: []
        }));
      }, { sourceIndex });

      // Wait and check if source loads
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const sourceData = await page.evaluate(() => {
        const state = window.getState();
        const sourceViewCode = window.selectors.code.getSourceViewCode(state);
        const sourceCodeCache = window.selectors.code.getSourceCodeCache(state);

        if (sourceViewCode && sourceViewCode.type === 'AVAILABLE') {
          // Get line timings
          const lineTimings = window.selectors.selectedThread.getSourceViewLineTimings(state);
          const selfHits = lineTimings.selfLineHits || new Map();
          const totalHits = lineTimings.totalLineHits || new Map();

          // Debug: check what file the source view is showing
          const sourceViewState = state.sourceView;
          const sourceFile = sourceViewState?.file || 'unknown';

          // Debug: sample what's in the maps
          const debugSelfKeys = Array.from(selfHits.keys()).slice(0, 10);
          const debugSelfValues = Array.from(selfHits.values()).slice(0, 10);
          const debugTotalKeys = Array.from(totalHits.keys()).slice(0, 10);

          const lines = sourceViewCode.code.split('\n');
          const linesWithSamples = lines.map((text: string, index: number) => {
            const lineNumber = index + 1;
            return {
              lineNumber,
              text,
              selfSamples: selfHits.get(lineNumber) || 0,
              totalSamples: totalHits.get(lineNumber) || 0
            };
          });

          let totalSampleCount = 0;
          for (const count of selfHits.values()) {
            totalSampleCount += count;
          }

          // Debug: check how many samples actually have line numbers
          const samplesWithLines = linesWithSamples.filter((l: any) => l.selfSamples > 0 || l.totalSamples > 0).length;

          return {
            success: true,
            lines: linesWithSamples,
            totalLines: lines.length,
            totalSamples: totalSampleCount,
            sourceFile,
            debug: {
              selfHitsSize: selfHits.size,
              totalHitsSize: totalHits.size,
              samplesWithLines,
              debugSelfKeys,
              debugSelfValues,
              debugTotalKeys
            }
          };
        }

        return {
          success: false,
          sourceViewExists: !!sourceViewCode,
          sourceViewType: sourceViewCode?.type || null,
          cacheSize: sourceCodeCache.size
        };
      });

      if ((sourceData as any).success) {
        const { lines, totalLines, totalSamples, sourceFile, debug } = sourceData as any;

        console.log(`Source file: ${sourceFile}`);

        if (debug) {
          console.log(`Debug: selfHits has ${debug.selfHitsSize} entries, totalHits has ${debug.totalHitsSize} entries`);
          console.log(`Debug: selfHits keys: ${JSON.stringify(debug.debugSelfKeys)}`);
          console.log(`Debug: selfHits values: ${JSON.stringify(debug.debugSelfValues)}`);
          console.log();
        }

        // Extract function start line from function name
        // SpiderMonkey format: "Ion: funcName (/path/file.js:35:41)"
        // V8 format: "JS:o*run /path/file.js:58:13"
        const lineMatch = functionName.match(/:(\d+):\d+\)?$/);
        const functionStartLine = lineMatch ? parseInt(lineMatch[1]) : null;

        // Find the actual function boundaries first
        let relevantLines = lines;
        let functionEndLine = lines.length;

        if (functionStartLine !== null) {
          const startLine = lines.find((l: any) => l.lineNumber === functionStartLine);
          if (startLine) {
            const startIndent = startLine.text.search(/\S/);

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line.lineNumber > functionStartLine) {
                const lineIndent = line.text.search(/\S/);
                if (line.text.trim() === '}' && lineIndent <= startIndent) {
                  functionEndLine = line.lineNumber;
                  break;
                }
              }
            }

            // Check if all samples are within the function boundaries
            const linesWithSamples = lines.filter((l: any) => l.selfSamples > 0 || l.totalSamples > 0);
            const samplesOutsideFunction = linesWithSamples.some((l: any) =>
              l.lineNumber < functionStartLine || l.lineNumber > functionEndLine
            );

            if (!samplesOutsideFunction) {
              // All samples are within function - filter to just this function
              relevantLines = lines.filter((l: any) =>
                l.lineNumber >= functionStartLine && l.lineNumber <= functionEndLine
              );
            } else {
              // Samples outside function - this means inlined code
              // Try to identify the main function from the file name
              // E.g., "findOptimalSegmentationInternal-benchmark.js" -> show findOptimalSegmentationInternal
              const fileNameMatch = functionName.match(/\/([^/]+)-benchmark\.js/);
              const primaryFunctionName = fileNameMatch ? fileNameMatch[1] : null;

              console.log(`Note: Optimized code has inlined functions. Primary function: ${primaryFunctionName}\n`);

              // If we can identify a primary function, show only that
              if (primaryFunctionName) {
                // Find the function with this name
                const funcRegex = new RegExp(`^\\s*function\\s+${primaryFunctionName}\\s*\\(`);
                for (let i = 0; i < lines.length; i++) {
                  const line = lines[i];
                  if (line && line.text.match(funcRegex)) {
                    const funcStartLine = line.lineNumber;
                    const startIndent = line.text.search(/\S/);
                    let funcEndLine = lines.length;

                    for (let j = i + 1; j < lines.length; j++) {
                      const endLine = lines[j];
                      if (endLine.text.trim() === '}' && endLine.text.search(/\S/) <= startIndent) {
                        funcEndLine = endLine.lineNumber;
                        break;
                      }
                    }

                    console.log(`Found ${primaryFunctionName} at lines ${funcStartLine}-${funcEndLine}\n`);
                    relevantLines = lines.filter((l: any) =>
                      l.lineNumber >= funcStartLine && l.lineNumber <= funcEndLine
                    );
                    break;
                  }
                }
              } else {
                // Fall back to showing all functions with samples
                console.log(`Showing all functions with samples.\n`);

                // Find functions that contain samples by looking for function boundaries
                const functionsWithSamples = new Set<number>(); // Set of function start lines

                for (const sampleLine of linesWithSamples) {
                  // Find which function this sample line belongs to
                  // Look backwards for the nearest "function" declaration
                  for (let i = sampleLine.lineNumber - 1; i >= 0; i--) {
                    const line = lines[i];
                    if (line && line.text.match(/^\s*function\s+\w+|^\s*\w+\.prototype\.\w+\s*=\s*function/)) {
                      functionsWithSamples.add(line.lineNumber);
                      break;
                    }
                  }
                }

              // For each function with samples, find its boundaries and include it
              const ranges: Array<{start: number, end: number}> = [];

              for (const funcStart of functionsWithSamples) {
                const startLine = lines.find((l: any) => l.lineNumber === funcStart);
                if (startLine) {
                  const startIndent = startLine.text.search(/\S/);
                  let funcEnd = lines.length;

                  for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.lineNumber > funcStart) {
                      const lineIndent = line.text.search(/\S/);
                      if (line.text.trim() === '}' && lineIndent <= startIndent) {
                        funcEnd = line.lineNumber;
                        break;
                      }
                    }
                  }

                  ranges.push({start: funcStart, end: funcEnd});
                }
              }

              // Merge overlapping ranges and filter lines
              ranges.sort((a, b) => a.start - b.start);
              const mergedRanges: Array<{start: number, end: number}> = [];
              for (const range of ranges) {
                if (mergedRanges.length === 0 || range.start > mergedRanges[mergedRanges.length - 1].end) {
                  mergedRanges.push(range);
                } else {
                  mergedRanges[mergedRanges.length - 1].end = Math.max(mergedRanges[mergedRanges.length - 1].end, range.end);
                }
              }

                relevantLines = lines.filter((l: any) =>
                  mergedRanges.some(r => l.lineNumber >= r.start && l.lineNumber <= r.end)
                );
              }
            }
          }
        }

        if (mode === 'src') {
          // For src mode, just show source
          const actualSamplesOnLines = relevantLines.reduce((sum: number, l: any) => sum + (l.selfSamples || 0), 0);
          const linesWithSamples = relevantLines.filter((l: any) => l.selfSamples > 0).length;

          console.log(`Source code (${relevantLines.length} lines):`);
          console.log(`  ${actualSamplesOnLines} samples mapped to specific lines`);
          if (totalSamples > actualSamplesOnLines) {
            console.log(`  ${totalSamples - actualSamplesOnLines} samples without line info\n`);
          } else {
            console.log();
          }

          const headerLine = "Line".padEnd(10);
          console.log(`${headerLine}    Self   Total`);
          console.log("─".repeat(80));

          for (const line of relevantLines) {
            const lineNum = line.lineNumber.toString().padStart(10);
            const selfStr = line.selfSamples > 0 ? line.selfSamples.toString().padStart(7) : "       ";
            const totalStr = line.totalSamples > 0 ? line.totalSamples.toString().padStart(7) : "       ";
            const marker = line.selfSamples > 0 ? "►" : " ";
            console.log(`${lineNum}  ${selfStr}  ${totalStr}  ${marker} ${line.text}`);
          }
          console.log();

          await page.close();
          return;
        }

        // For mode=all, implement interleaving
        if (mode === 'all' && nativeSymbolInfo && !(nativeSymbolInfo as any).error) {
          const groups = (nativeSymbolInfo as any).groups || [];

          for (const group of groups) {
            if (group.assemblyInstructions) {
              console.log(`\n${"═".repeat(80)}`);
              console.log("Interleaved Source and Assembly");
              console.log(`${"═".repeat(80)}\n`);

              // Build map of line number -> source text for quick lookup
              const sourceLineMap = new Map<number, any>();
              for (const line of relevantLines) {
                sourceLineMap.set(line.lineNumber, line);
              }

              // Header row
              const headerLine = "Line/Addr".padEnd(10);
              console.log(`${headerLine}    Self   Total`);
              console.log("─".repeat(80));

              // Display ALL assembly instructions in address order
              // Show ALL source lines, inserting assembly where it maps
              let lastSourceLineShown = 0;
              let justShowedSource = false;

              for (let i = 0; i < group.assemblyInstructions.length; i++) {
                const inst = group.assemblyInstructions[i];
                const nextInst = i + 1 < group.assemblyInstructions.length ? group.assemblyInstructions[i + 1] : null;

                // If this instruction maps to a source line, check if we need to show source lines first
                if (inst.sourceLineNumber !== null) {
                  const hasSourceToShow = relevantLines.some((l: any) =>
                    l.lineNumber > lastSourceLineShown && l.lineNumber <= inst.sourceLineNumber
                  );

                  if (hasSourceToShow) {
                    // Blank line before source block (if we just showed assembly)
                    if (justShowedSource === false && lastSourceLineShown > 0) {
                      console.log();
                    }

                    // Show all source lines from lastSourceLineShown+1 up to and including this line
                    for (const line of relevantLines) {
                      if (line.lineNumber > lastSourceLineShown && line.lineNumber <= inst.sourceLineNumber) {
                        // Show source line (no blank lines between consecutive source lines)
                        const lineNum = line.lineNumber.toString().padStart(10);
                        const selfStr = line.selfSamples > 0 ? line.selfSamples.toString().padStart(7) : "       ";
                        const totalStr = line.totalSamples > 0 ? line.totalSamples.toString().padStart(7) : "       ";
                        const marker = line.selfSamples > 0 ? "►" : " ";
                        console.log(`${lineNum}  ${selfStr}  ${totalStr}  ${marker} ${line.text}`);

                        lastSourceLineShown = line.lineNumber;
                      }
                    }

                    justShowedSource = true;

                    // Only add blank line after source if next instruction doesn't also map to a source line
                    // (i.e., we're about to show assembly)
                    const nextWillShowSource = nextInst && nextInst.sourceLineNumber !== null &&
                                               nextInst.sourceLineNumber > lastSourceLineShown;
                    if (!nextWillShowSource) {
                      console.log();
                    }
                  }
                } else {
                  justShowedSource = false;
                }

                // Show assembly instruction
                const addrStr = `0x${inst.address.toString(16).padStart(8, '0')}`;
                const selfStr = inst.selfSamples > 0 ? inst.selfSamples.toString().padStart(7) : "       ";
                const totalStr = inst.totalSamples > 0 ? inst.totalSamples.toString().padStart(7) : "       ";
                const marker = inst.selfSamples > 0 ? "►" : " ";
                console.log(`${addrStr}  ${selfStr}  ${totalStr}  ${marker} ${inst.instruction}`);
              }

              // Show any remaining source lines that weren't encountered
              const hasRemainingSource = relevantLines.some((l: any) => l.lineNumber > lastSourceLineShown);
              if (hasRemainingSource) {
                console.log();
                for (const line of relevantLines) {
                  if (line.lineNumber > lastSourceLineShown) {
                    const lineNum = line.lineNumber.toString().padStart(10);
                    const selfStr = line.selfSamples > 0 ? line.selfSamples.toString().padStart(7) : "       ";
                    const totalStr = line.totalSamples > 0 ? line.totalSamples.toString().padStart(7) : "       ";
                    const marker = line.selfSamples > 0 ? "►" : " ";
                    console.log(`${lineNum}  ${selfStr}  ${totalStr}  ${marker} ${line.text}`);
                  }
                }
              }

              console.log();
            }
          }

          await page.close();
          return;
        }
      } else {
        console.log(`Source did not load: ${JSON.stringify(sourceData)}\n`);
      }
    }
  }

  await page.close();
}
