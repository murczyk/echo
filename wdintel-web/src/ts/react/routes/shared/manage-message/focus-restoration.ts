const MAX_FOCUS_RESTORE_FRAMES = 120;

export function focusAfterEditorSurfacesClose(resolveTarget: () => HTMLElement | null): () => void {
  let cancelled = false;
  let cancelScheduled = () => {};
  let attempts = 0;

  const schedule = (callback: () => void) => {
    if (typeof window.requestAnimationFrame === 'function') {
      const frameId = window.requestAnimationFrame(callback);
      cancelScheduled = () => window.cancelAnimationFrame(frameId);
      return;
    }
    const timeoutId = window.setTimeout(callback, 0);
    cancelScheduled = () => window.clearTimeout(timeoutId);
  };

  const restore = () => {
    if (cancelled) return;
    const surfaceOpen =
      document.querySelector('[data-manage-message-presentation]') != null ||
      document.querySelector('[role="dialog"]') != null;
    if (surfaceOpen && attempts < MAX_FOCUS_RESTORE_FRAMES) {
      attempts += 1;
      schedule(restore);
      return;
    }
    resolveTarget()?.focus();
  };

  schedule(restore);
  return () => {
    cancelled = true;
    cancelScheduled();
  };
}
