export interface CallTreeNode {
  name: string;
  selfTime: number;
  totalTime: number;
  stack: string[];
  callPaths?: CallPath[];
}

export interface CallPath {
  stack: string[];
  samples: number;
}

export interface MarkerSummary {
  name: string;
  count: number;
  totalDuration: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
}

export interface FlameNode {
  name: string;
  selfTime: number;
  totalTime: number;
  children: FlameNode[];
}

export interface Resource {
  url: string;
  duration: number;
  type: string;
}

export interface ResourceStats {
  totalResources: number;
  byType: { [type: string]: number };
  avgDuration: number;
  maxDuration: number;
  topResources: Resource[];
}

export interface SampleCategoryStats {
  totalSamples: number;
  byCategory: { [category: string]: number };
}

export interface JankPeriod {
  startTime: number;
  duration: number;
  topFunctions: Array<{ name: string; samples: number }>;
  categories: { [category: string]: number };
}

export interface NetworkPhase {
  label: string;
  duration: number;
}

export interface NetworkResourceTiming {
  url: string;
  startTime: number;
  duration: number;
  status: string;
  contentType?: string;
  size?: number;
  httpVersion?: string;
  cache?: string;
  phases: NetworkPhase[];
}

export interface NetworkResourceSummary {
  resources: NetworkResourceTiming[];
  totalResources: number;
  phaseTotals: { [phase: string]: number };
  cacheStats: { [cacheType: string]: number };
}

export interface PageLoadSummary {
  url: string | null;
  navigationStart: number | null;
  load: number | null;
  firstContentfulPaint: number | null;
  largestContentfulPaint: number | null;
  resources: ResourceStats | null;
  sampleCategories: SampleCategoryStats | null;
  jankPeriods: JankPeriod[] | null;
}
