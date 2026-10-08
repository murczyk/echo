import type { DEBUG_SCHEMA_VERSION } from './config';

export type DebugSafePrimitive = boolean | number | string | null;
export type DebugSafeValue =
  DebugSafePrimitive | DebugSafeValue[] | { [key: string]: DebugSafeValue };

export type DebugTarget = {
  tag: string;
  role?: string;
  inputType?: string;
  testId?: string;
};

export type DebugEventInput = {
  kind: string;
  source?: string;
  target?: DebugTarget | EventTarget | null;
  details?: Record<string, unknown>;
};

export type DebugEventContext = {
  seq: number;
  tMs: number;
  route: string;
};

export type DebugEvent = {
  seq: number;
  tMs: number;
  kind: string;
  source: string;
  route: string;
  target?: DebugTarget;
  details?: Record<string, DebugSafeValue>;
};

export type DebugBuildMetadata = {
  echoVersion: string;
  deploymentMode: string;
};

export type DebugEnvironment = DebugBuildMetadata & {
  browserFamily: 'Chromium' | 'Edge' | 'Firefox' | 'Safari' | 'Unknown';
  browserVersion: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  startRoute: string;
};

export type DebugAnomalySummary = {
  total: number;
  counts: Record<string, number>;
};

export type DebugCollectorSupport = {
  supported: string[];
  unsupported: string[];
  failed: string[];
};

export type DebugAliasTable = Record<string, Record<string, string>>;

export type PersistedDebugSession = {
  schemaVersion: typeof DEBUG_SCHEMA_VERSION;
  state: 'recording' | 'ready';
  recordingId: string;
  aliasSalt: string;
  startedAt: number;
  deadlineAt: number;
  readyAt?: number;
  nextSeq: number;
  events: DebugEvent[];
  serializedBytes: number;
  droppedEvents: number;
  rejectedEvents: number;
  truncatedValues: number;
  persistenceFailed: boolean;
  aliases: DebugAliasTable;
  environment: DebugEnvironment;
  anomalies: DebugAnomalySummary;
  collectorSupport: DebugCollectorSupport;
};

export type DebugRecorderSnapshot = {
  state: 'idle' | 'recording' | 'ready';
  recordingId: string | null;
  startedAt: number | null;
  deadlineAt: number | null;
  elapsedMs: number;
  eventCount: number;
  droppedEvents: number;
  anomalyCount: number;
  persistenceFailed: boolean;
  downloadError: boolean;
};

export type DebugEventSink = (input: DebugEventInput) => void;
export type DebugCollectorCleanup = () => void;

export type DebugAnomalyDetector = {
  observe: (event: DebugEvent) => DebugEventInput[];
  finish: (atMs: number) => DebugEventInput[];
  getSummary: () => DebugAnomalySummary;
  getBufferedEventCount: () => number;
};

export type DebugSanitizer = {
  safeRoute: (value: string | URL) => string;
  safeTarget: (value: DebugTarget | EventTarget | null | undefined) => DebugTarget | undefined;
  safeError: (value: unknown) => Record<string, DebugSafeValue>;
  sanitizeInput: (input: DebugEventInput, context: DebugEventContext) => DebugEvent | null;
  alias: (scope: string, value: string | number) => string;
  sanitizeSessionForExport: (session: PersistedDebugSession) => PersistedDebugSession;
  getAliases: () => DebugAliasTable;
};
