import { useCallback, useState } from 'react';

const DEVICE_FILE_VIEW_MODE_STORAGE_KEY = 'echo.device-files.view-mode.v1';
type ViewMode = 'grid' | 'list';

function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(DEVICE_FILE_VIEW_MODE_STORAGE_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export function useDeviceFileViewMode() {
  const [viewMode, updateViewMode] = useState(readViewMode);
  const setViewMode = useCallback((mode: ViewMode) => {
    updateViewMode(mode);
    try {
      localStorage.setItem(DEVICE_FILE_VIEW_MODE_STORAGE_KEY, mode);
    } catch {}
  }, []);
  return [viewMode, setViewMode] as const;
}
