import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceFileSelection } from './device-file-archive';
import {
  markDeviceFileViewed,
  markDeviceFileUnviewed,
  setDeviceFileFavorite,
} from '../../services/api/devices';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { redirectToLogin } from '../../auth-redirect';
import { toDeviceFileLoadError } from './helpers';

export function useDeviceFileMarkers(deviceId: string, selectedFile: DeviceFileSelection | null) {
  const [favorites, setFavorites] = useState<Record<string, boolean>>({});
  const [viewed, setViewed] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [viewedPending, setViewedPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const requests = useRef(new Map<string, AbortController>());
  useEffect(() => {
    setFavorites({});
    setViewed({});
    setPending(new Set());
    setViewedPending(new Set());
    setError(null);
    return () => {
      for (const controller of requests.current.values()) controller.abort();
      requests.current.clear();
    };
  }, [deviceId]);
  const reportError = useCallback((cause: unknown) => {
    if (isAbortError(cause)) return;
    if (isUnauthorizedError(cause)) redirectToLogin();
    setError(toDeviceFileLoadError(cause, 'Не вдалося зберегти мітку файлу').message);
  }, []);
  const saveViewed = useCallback(
    async (entry: Pick<DeviceFileSelection, 'fileId' | 'revision'>, value: boolean) => {
      const { fileId, revision } = entry;
      if (!fileId || revision == null) return;
      const revisionKey = `${fileId}/${revision}`;
      const key = `viewed:${revisionKey}`;
      if (requests.current.has(key)) return;
      const controller = new AbortController();
      requests.current.set(key, controller);
      setViewedPending((current) => new Set(current).add(revisionKey));
      setError(null);
      try {
        const save = value ? markDeviceFileViewed : markDeviceFileUnviewed;
        const response = await save({ deviceId, fileId, revision }, { signal: controller.signal });
        if (!controller.signal.aborted)
          setViewed((current) => ({ ...current, [revisionKey]: response.isViewed }));
      } catch (cause) {
        if (!controller.signal.aborted) reportError(cause);
      } finally {
        if (requests.current.get(key) === controller) {
          requests.current.delete(key);
          setViewedPending((current) => {
            const next = new Set(current);
            next.delete(revisionKey);
            return next;
          });
        }
      }
    },
    [deviceId, reportError],
  );
  const fileId = selectedFile?.fileId;
  const revision = selectedFile?.revision;
  const hasContent = selectedFile?.hasContent;
  const isViewed = viewed[`${fileId}/${revision}`] ?? selectedFile?.isViewed;
  useEffect(() => {
    if (!fileId || revision == null || !hasContent || isViewed) return;
    void saveViewed({ fileId, revision }, true);
  }, [fileId, revision, hasContent, isViewed, saveViewed]);
  const toggleViewed = useCallback(
    (entry: Pick<DeviceFileSelection, 'fileId' | 'revision' | 'isViewed'>) =>
      saveViewed(entry, !(viewed[`${entry.fileId}/${entry.revision}`] ?? entry.isViewed)),
    [saveViewed, viewed],
  );
  const withMarkers = useCallback(
    <
      T extends {
        entryId: string;
        isFavorite?: boolean;
        fileId?: string | null;
        revision?: number | null;
        isViewed?: boolean;
      },
    >(
      entry: T,
    ): T => ({
      ...entry,
      isFavorite: favorites[entry.entryId] ?? entry.isFavorite ?? false,
      isViewed: viewed[`${entry.fileId}/${entry.revision}`] ?? entry.isViewed ?? false,
    }),
    [favorites, viewed],
  );
  const toggleFavorite = useCallback(
    async (entry: { entryId: string; isFavorite?: boolean }) => {
      if (requests.current.has(entry.entryId)) return;
      const controller = new AbortController();
      requests.current.set(entry.entryId, controller);
      setPending((current) => new Set(current).add(entry.entryId));
      setError(null);
      try {
        const response = await setDeviceFileFavorite(
          {
            deviceId,
            entryId: entry.entryId,
            favorite: !(favorites[entry.entryId] ?? entry.isFavorite ?? false),
          },
          { signal: controller.signal },
        );
        if (!controller.signal.aborted)
          setFavorites((current) => ({ ...current, [entry.entryId]: response.isFavorite }));
      } catch (cause) {
        if (!controller.signal.aborted) reportError(cause);
      } finally {
        if (requests.current.get(entry.entryId) === controller) {
          requests.current.delete(entry.entryId);
          setPending((current) => {
            const next = new Set(current);
            next.delete(entry.entryId);
            return next;
          });
        }
      }
    },
    [deviceId, favorites, reportError],
  );
  const reset = useCallback(() => {
    setFavorites({});
    setViewed((current) => {
      const key = `${fileId}/${revision}`;
      return current[key] === undefined ? {} : { [key]: current[key] };
    });
  }, [fileId, revision]);
  return { withMarkers, toggleFavorite, toggleViewed, pending, viewedPending, error, reset };
}
