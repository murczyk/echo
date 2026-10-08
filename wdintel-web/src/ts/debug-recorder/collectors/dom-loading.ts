import { DEBUG_DOM_MUTATION_INSPECTION_LIMIT, DEBUG_DOM_SUBSTANTIAL_SUBTREE_SIZE } from '../config';
import type { DebugCollectorCleanup, DebugEventSink } from '../types';

const LOADING_SELECTOR = '[aria-busy="true"], [data-debug-skeleton], .MuiSkeleton-root';

function isRecorderElement(element: Element): boolean {
  return element.closest('[data-debug-recorder-host], [data-debug-recorder-root]') !== null;
}

function inspectSubtree(element: Element, limit: number): { size: number; customCount: number } {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
  let current: Node | null = walker.currentNode;
  let size = 0;
  let customCount = 0;
  while (current && size < limit) {
    size += 1;
    if (current instanceof Element && current.localName.includes('-')) customCount += 1;
    current = walker.nextNode();
  }
  return { size, customCount };
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

  if (lastLoadingCount > 0) {
    emit({
      kind: 'skeleton.visibility',
      source: 'collector',
      details: { visible: true, count: lastLoadingCount },
    });
  }

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
      if (!(node instanceof Element) || isRecorderElement(node)) continue;
      const inspection = inspectSubtree(node, DEBUG_DOM_MUTATION_INSPECTION_LIMIT - inspectedNodes);
      inspectedNodes += inspection.size;
      const size = inspection.size;
      if (size >= DEBUG_DOM_SUBSTANTIAL_SUBTREE_SIZE) {
        replacementCount += 1;
        replacementItems += size;
      }
      if (connected) connectedCustomElements += inspection.customCount;
      else disconnectedCustomElements += inspection.customCount;
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
