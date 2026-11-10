import { useLayoutEffect, useRef, type UIEvent } from 'react';
import { ECHO_NAVIGATION_EVENT } from '../../../browser/navigation-guard';
import type { DeviceFileScrollPositions } from './types';

export function useDeviceFileScroll({
  positions,
  viewMode,
  loading,
  active,
  tableVisible,
}: {
  positions?: DeviceFileScrollPositions;
  viewMode: 'grid' | 'list';
  loading: boolean;
  active: boolean;
  tableVisible: boolean;
}) {
  const viewportRef = useRef<HTMLElement>(null);
  const restored = useRef<DeviceFileScrollPositions | null>(null);
  useLayoutEffect(() => {
    restored.current = null;
    if (!positions || loading || !active) return;
    const viewport = tableVisible
      ? viewportRef.current?.querySelector<HTMLElement>('[data-device-file-scroll-viewport]')
      : viewportRef.current;
    if (!viewport) return;
    const position = positions.get(viewMode);
    viewport.scrollTop = position?.top ?? 0;
    viewport.scrollLeft = position?.left ?? 0;
    restored.current = positions;
    const save = () => {
      positions.set(viewMode, { top: viewport.scrollTop, left: viewport.scrollLeft });
    };
    window.addEventListener('popstate', save, true);
    window.addEventListener(ECHO_NAVIGATION_EVENT, save, true);
    return () => {
      window.removeEventListener('popstate', save, true);
      window.removeEventListener(ECHO_NAVIGATION_EVENT, save, true);
    };
  }, [positions, viewMode, loading, active, tableVisible]);

  const onScrollCapture = (event: UIEvent<HTMLElement>) => {
    if (!positions || restored.current !== positions || loading || !active) return;
    const viewport = event.target as HTMLElement;
    if (!viewport.hasAttribute('data-device-file-scroll-viewport')) return;
    if (tableVisible ? viewport === viewportRef.current : viewport !== viewportRef.current) return;
    positions.set(viewMode, { top: viewport.scrollTop, left: viewport.scrollLeft });
  };
  return { viewportRef, onScrollCapture };
}
