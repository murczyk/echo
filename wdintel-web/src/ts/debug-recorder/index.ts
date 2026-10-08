import { AUTH_UNAUTHORIZED_EVENT } from '../react/auth-redirect';
import { DEBUG_ACTIVATOR_PRESSES, DEBUG_ACTIVATOR_WINDOW_MS } from './config';
import { attachGlobalCollectors } from './collectors';
import { mountDebugRecorderPanel, unmountDebugRecorderPanel } from './debug-recorder-root';
import { createBrowserDebugRecorder, type BrowserDebugRecorder } from './store';
import type {
  DebugBuildMetadata,
  DebugEventInput,
  DebugEventSink,
  DebugRecorderSnapshot,
} from './types';
import type { DebugRecorderPanelController } from './DebugRecorderPanel';

type CollectorAttachment = ReturnType<typeof attachGlobalCollectors>;

export type BrowserDebugRecorderRuntimeDependencies = {
  recorder: BrowserDebugRecorder;
  attachCollectors?: (sink: DebugEventSink) => CollectorAttachment;
  mountPanel?: (controller: DebugRecorderPanelController) => void;
  unmountPanel?: () => void;
  eventTarget?: EventTarget;
};

export type BrowserDebugRecorderRuntime = {
  initialize: () => void;
  configure: (metadata: DebugBuildMetadata) => void;
  registerPress: (nowMs?: number) => boolean;
  record: (input: DebugEventInput) => void;
  aliasIdentifier: (scope: string, value: string | number) => string | null;
  isRecording: () => boolean;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => DebugRecorderSnapshot;
  finish: () => void;
  download: () => boolean;
  clear: () => void;
  mountPanelIfNeeded: () => void;
  destroy: () => void;
};

export function createBrowserDebugRecorderRuntime(
  dependencies: BrowserDebugRecorderRuntimeDependencies,
): BrowserDebugRecorderRuntime {
  const recorder = dependencies.recorder;
  const collectorAttacher = dependencies.attachCollectors ?? attachGlobalCollectors;
  const panelMounter = dependencies.mountPanel ?? mountDebugRecorderPanel;
  const panelUnmounter = dependencies.unmountPanel ?? unmountDebugRecorderPanel;
  const eventTarget =
    dependencies.eventTarget ?? (typeof window === 'undefined' ? new EventTarget() : window);
  let initialized = false;
  let unsubscribe: (() => void) | null = null;
  let collectorCleanup: (() => void) | null = null;
  let collectorsAttached = false;
  let authListenerAttached = false;
  let pagehideListenerAttached = false;
  let panelMounted = false;
  let pressTimes: number[] = [];

  const clear = () => {
    pressTimes = [];
    try {
      recorder.clear();
    } catch {
      // Public diagnostics APIs must remain exception-free.
    }
  };

  const onUnauthorized = () => clear();
  const onPagehide = () => {
    try {
      recorder.flush();
    } catch {
      // Best-effort persistence during document teardown.
    }
  };

  const collectorSink: DebugEventSink = (input) => {
    const status = input.details?.status;
    const sameOrigin = input.details?.sameOrigin;
    if (input.kind === 'http.completed' && status === 401 && sameOrigin === true) {
      clear();
      return;
    }
    try {
      recorder.record(input);
    } catch {
      // Collector failures cannot affect the application.
    }
  };

  const detachCollectors = () => {
    if (!collectorsAttached) return;
    collectorsAttached = false;
    const cleanup = collectorCleanup;
    collectorCleanup = null;
    try {
      cleanup?.();
    } catch {
      // Collector cleanup is isolated.
    }
  };

  const attachCollectors = () => {
    if (collectorsAttached) return;
    collectorsAttached = true;
    try {
      const attachment = collectorAttacher(collectorSink);
      if (!collectorsAttached) {
        attachment.cleanup();
        return;
      }
      collectorCleanup = attachment.cleanup;
      recorder.setCollectorSupport(attachment.support);
    } catch {
      collectorsAttached = false;
      collectorCleanup = null;
    }
  };

  const attachAuthListener = () => {
    if (authListenerAttached) return;
    authListenerAttached = true;
    eventTarget.addEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
  };
  const detachAuthListener = () => {
    if (!authListenerAttached) return;
    authListenerAttached = false;
    eventTarget.removeEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
  };
  const attachPagehideListener = () => {
    if (pagehideListenerAttached) return;
    pagehideListenerAttached = true;
    eventTarget.addEventListener('pagehide', onPagehide);
  };
  const detachPagehideListener = () => {
    if (!pagehideListenerAttached) return;
    pagehideListenerAttached = false;
    eventTarget.removeEventListener('pagehide', onPagehide);
  };

  const controller: DebugRecorderPanelController = {
    subscribe: recorder.subscribe,
    getSnapshot: recorder.getSnapshot,
    finish: () => recorder.finish(),
    download: () => recorder.download(),
  };

  const syncLifecycle = () => {
    const state = recorder.getSnapshot().state;
    if (state === 'recording') {
      attachCollectors();
      attachPagehideListener();
    } else {
      detachCollectors();
      detachPagehideListener();
    }
    if (state === 'idle') {
      detachAuthListener();
      if (panelMounted) {
        panelMounted = false;
        try {
          panelUnmounter();
        } catch {
          // Panel failures cannot affect the application.
        }
      }
    } else {
      attachAuthListener();
      if (!panelMounted) {
        panelMounted = true;
        try {
          panelMounter(controller);
        } catch {
          panelMounted = false;
        }
      }
    }
  };

  const initialize = () => {
    if (initialized) return;
    initialized = true;
    unsubscribe = recorder.subscribe(syncLifecycle);
    syncLifecycle();
  };

  const mountPanelIfNeeded = () => {
    const alreadyMounted = panelMounted;
    syncLifecycle();
    if (!alreadyMounted || recorder.getSnapshot().state === 'idle') return;
    try {
      panelMounter(controller);
    } catch {
      panelMounted = false;
    }
  };

  return {
    initialize,
    configure: (metadata) => {
      try {
        recorder.configure(metadata);
      } catch {
        // Public diagnostics APIs must remain exception-free.
      }
    },
    registerPress: (nowMs = Date.now()) => {
      try {
        if (recorder.getSnapshot().state !== 'idle') {
          pressTimes = [];
          return false;
        }
        pressTimes = pressTimes.filter(
          (pressedAt) => nowMs >= pressedAt && nowMs - pressedAt <= DEBUG_ACTIVATOR_WINDOW_MS,
        );
        pressTimes.push(nowMs);
        if (pressTimes.length < DEBUG_ACTIVATOR_PRESSES) return false;
        pressTimes = [];
        recorder.start();
        return recorder.getSnapshot().state === 'recording';
      } catch {
        pressTimes = [];
        return false;
      }
    },
    record: (input) => {
      if (recorder.getSnapshot().state !== 'recording') return;
      collectorSink(input);
    },
    aliasIdentifier: (scope, value) => {
      if (recorder.getSnapshot().state !== 'recording') return null;
      try {
        return recorder.aliasIdentifier(scope, value);
      } catch {
        return null;
      }
    },
    isRecording: () => recorder.getSnapshot().state === 'recording',
    subscribe: recorder.subscribe,
    getSnapshot: recorder.getSnapshot,
    finish: () => {
      try {
        recorder.finish();
      } catch {
        // Public diagnostics APIs must remain exception-free.
      }
    },
    download: () => {
      try {
        return recorder.download();
      } catch {
        return false;
      }
    },
    clear,
    mountPanelIfNeeded,
    destroy: () => {
      unsubscribe?.();
      unsubscribe = null;
      initialized = false;
      detachCollectors();
      detachPagehideListener();
      detachAuthListener();
      if (panelMounted) {
        panelMounted = false;
        try {
          panelUnmounter();
        } catch {
          // Panel failures cannot affect the application.
        }
      }
      pressTimes = [];
    },
  };
}

const runtime = createBrowserDebugRecorderRuntime({ recorder: createBrowserDebugRecorder() });

export const initializeBrowserDebugRecorder = runtime.initialize;
export const mountDebugRecorderPanelIfNeeded = runtime.mountPanelIfNeeded;
export const configureBrowserDebugRecorder = runtime.configure;
export const registerBrowserDebugRecorderPress = runtime.registerPress;
export const recordDebugEvent = runtime.record;
export const aliasDebugIdentifier = runtime.aliasIdentifier;
export const isBrowserDebugRecording = runtime.isRecording;
export const subscribeBrowserDebugRecorder = runtime.subscribe;
export const getBrowserDebugRecorderSnapshot = runtime.getSnapshot;
export const finishBrowserDebugRecording = runtime.finish;
export const downloadBrowserDebugRecording = runtime.download;
export const clearBrowserDebugRecording = runtime.clear;
