import { DEBUG_DOM_MUTATION_INSPECTION_LIMIT, DEBUG_DOM_SUBSTANTIAL_SUBTREE_SIZE } from '../config';
import type { DebugCollectorCleanup, DebugEventSink } from '../types';

const LOADING_SELECTOR = '[aria-busy="true"], [data-debug-skeleton], .MuiSkeleton-root';

function isRecorderElement(element: Element): boolean {
  return element.closest('[data-debug-recorder-root]') !== null;
}

function subtreeSize(element: Element): number {
  return 1 + element.querySelectorAll('*').length;
}

function customElementCount(element: Element): number {
  let count = element.localName.includes('-') ? 1 : 0;
  for (const child of element.querySelectorAll('*')) {
    if (child.localName.includes('-')) count += 1;
  }
  return count;
}

function loadingCount(): number {
  let count = 0;
  for (const element of document.querySelectorAll(LOADING_SELECTOR)) {
    if (!isRecorderElement(element)) count += 1;
  }
  return count;
}

export function attachDomLoadingCollector(sink: DebugEventSink): DebugCollectorCleanup {
  const root = document.body;
  if (!root || typeof MutationObserver === 'undefined') return () => {};
  let active = true;
  let frame: number | null = null;
  let mutationCount = 0;
  let addedCount = 0;
  let removedCount = 0;
  let replacementCount = 0;
  let replacementItems = 0;
  let connectedCustomElements = 0;
  let disconnectedCustomElements = 0;
  let inspectedNodes = 0;
  let lastLoadingCount = loadingCount();

  const emit: DebugEventSink = (input) => {
    if (!active) return;
    try {
      sink(input);
    } catch {
      // The orchestrator owns collector failure reporting.
    }
  };

  const resetBatch = () => {
    mutationCount = 0;
    addedCount = 0;
    removedCount = 0;
    replacementCount = 0;
    replacementItems = 0;
    connectedCustomElements = 0;
    disconnectedCustomElements = 0;
    inspectedNodes = 0;
  };

  const flush = () => {
    frame = null;
    if (mutationCount > 0) {
      emit({
        kind: 'dom.mutations',
        source: 'collector',
        details: { count: mutationCount, addedCount, removedCount },
      });
    }
    if (replacementCount > 0) {
      emit({
        kind: 'dom.replacement',
        source: 'collector',
        details: { count: replacementCount, itemCount: replacementItems },
      });
    }
    if (connectedCustomElements > 0) {
      emit({
        kind: 'dom.custom-elements',
        source: 'collector',
        details: { outcome: 'connected', count: connectedCustomElements },
      });
    }
    if (disconnectedCustomElements > 0) {
      emit({
        kind: 'dom.custom-elements',
        source: 'collector',
        details: { outcome: 'disconnected', count: disconnectedCustomElements },
      });
    }
    const currentLoadingCount = loadingCount();
    if (currentLoadingCount !== lastLoadingCount) {
      emit({
        kind: 'skeleton.visibility',
        source: 'collector',
        details: { visible: currentLoadingCount > 0, count: currentLoadingCount },
      });
      lastLoadingCount = currentLoadingCount;
    }
    resetBatch();
  };

  const inspectNodes = (nodes: NodeList, connected: boolean) => {
    for (const node of nodes) {
      if (inspectedNodes >= DEBUG_DOM_MUTATION_INSPECTION_LIMIT) return;
      inspectedNodes += 1;
      if (!(node instanceof Element) || isRecorderElement(node)) continue;
      const size = subtreeSize(node);
      if (size >= DEBUG_DOM_SUBSTANTIAL_SUBTREE_SIZE) {
        replacementCount += 1;
        replacementItems += size;
      }
      const customCount = customElementCount(node);
      if (connected) connectedCustomElements += customCount;
      else disconnectedCustomElements += customCount;
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof Element && isRecorderElement(record.target)) continue;
      mutationCount += 1;
      if (record.type === 'childList') {
        addedCount += record.addedNodes.length;
        removedCount += record.removedNodes.length;
        inspectNodes(record.addedNodes, true);
        inspectNodes(record.removedNodes, false);
      }
    }
    if (mutationCount > 0 && frame === null) frame = window.requestAnimationFrame(flush);
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-busy', 'data-debug-skeleton', 'class'],
  });

  return () => {
    if (!active) return;
    active = false;
    observer.disconnect();
    if (frame !== null) window.cancelAnimationFrame(frame);
    resetBatch();
  };
}
