import { useCallback, useRef, useState } from 'react';

import type { Palitra, PalitraHighlightBlacklistEntry, PalitraReadV2 } from '../../../../Bindings';
import {
  addPalitraHighlightBlacklistEntry,
  deletePalitraHighlightBlacklistEntry,
  getPalitraHighlightBlacklist,
  highlightBlacklistLabelKey,
  readPalitraV2,
} from '../../services/api/palitra';
import { formatErrorMessage } from './helpers';

export function useRerPalitraNeoPageHighlightBlacklist() {
  const [palitra, setPalitra] = useState<Palitra | null>(null);
  const [data, setData] = useState<PalitraReadV2 | null>(null);
  const [entries, setEntries] = useState<PalitraHighlightBlacklistEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationBlocked, setMutationBlocked] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [pendingLabels, setPendingLabels] = useState<Set<string>>(new Set());
  const requestIdRef = useRef(0);
  const openPalitraIdRef = useRef<number | null>(null);

  const load = useCallback(async (nextPalitra: Palitra) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    setMutationError(null);
    setMutationBlocked(false);
    setData(null);
    setEntries([]);
    setPendingIds(new Set());
    setPendingLabels(new Set());

    try {
      const [nextEntries, nextData] = await Promise.all([
        getPalitraHighlightBlacklist(nextPalitra.id),
        readPalitraV2(nextPalitra.id),
      ]);
      if (requestIdRef.current !== requestId) return;
      setEntries(nextEntries);
      setData(nextData);
    } catch (loadError) {
      if (requestIdRef.current !== requestId) return;
      setError(formatErrorMessage(loadError));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, []);

  const open = useCallback(
    (nextPalitra: Palitra) => {
      if (nextPalitra.id <= 0) return;
      openPalitraIdRef.current = nextPalitra.id;
      setPalitra(nextPalitra);
      void load(nextPalitra);
    },
    [load],
  );

  const close = useCallback(() => {
    requestIdRef.current += 1;
    openPalitraIdRef.current = null;
    setPalitra(null);
    setLoading(false);
    setError(null);
    setMutationError(null);
    setPendingIds(new Set());
    setPendingLabels(new Set());
  }, []);

  const toggle = useCallback(
    async (label: string, entry: PalitraHighlightBlacklistEntry | null) => {
      const currentPalitra = palitra;
      if (!currentPalitra || mutationBlocked) return;
      const requestId = requestIdRef.current;
      const palitraId = currentPalitra.id;
      const isCurrent = () =>
        requestIdRef.current === requestId && openPalitraIdRef.current === palitraId;
      const labelKey = highlightBlacklistLabelKey(label);

      if (entry) {
        if (pendingIds.has(entry.id)) return;
        setPendingIds((previous) => new Set(previous).add(entry.id));
        setMutationError(null);
        try {
          await deletePalitraHighlightBlacklistEntry(palitraId, entry.id);
          if (isCurrent())
            setEntries((previous) => previous.filter((item) => item.id !== entry.id));
        } catch (mutationFailure) {
          if (isCurrent()) {
            setMutationError(formatErrorMessage(mutationFailure));
            if (mutationFailure instanceof Error && 'status' in mutationFailure) {
              const status = (mutationFailure as Error & { status?: number }).status;
              if (status === 403 || status === 404) setMutationBlocked(true);
            }
          }
        } finally {
          if (isCurrent()) {
            setPendingIds((previous) => {
              const next = new Set(previous);
              next.delete(entry.id);
              return next;
            });
          }
        }
        return;
      }

      if (pendingLabels.has(labelKey)) return;
      setPendingLabels((previous) => new Set(previous).add(labelKey));
      setMutationError(null);
      try {
        const addedEntry = await addPalitraHighlightBlacklistEntry(palitraId, label.trim());
        if (isCurrent()) {
          setEntries((previous) =>
            previous.some((item) => highlightBlacklistLabelKey(item.label) === labelKey)
              ? previous
              : [...previous, addedEntry],
          );
        }
      } catch (mutationFailure) {
        if (isCurrent()) {
          setMutationError(formatErrorMessage(mutationFailure));
          if (mutationFailure instanceof Error && 'status' in mutationFailure) {
            const status = (mutationFailure as Error & { status?: number }).status;
            if (status === 403 || status === 404) setMutationBlocked(true);
          }
        }
      } finally {
        if (isCurrent()) {
          setPendingLabels((previous) => {
            const next = new Set(previous);
            next.delete(labelKey);
            return next;
          });
        }
      }
    },
    [mutationBlocked, palitra, pendingIds, pendingLabels],
  );

  return {
    highlightBlacklistPalitra: palitra,
    highlightBlacklistData: data,
    highlightBlacklistEntries: entries,
    highlightBlacklistLoading: loading,
    highlightBlacklistError: error,
    highlightBlacklistMutationError: mutationError,
    highlightBlacklistMutationBlocked: mutationBlocked,
    highlightBlacklistPendingIds: pendingIds,
    highlightBlacklistPendingLabels: pendingLabels,
    openHighlightBlacklist: open,
    loadHighlightBlacklist: () => (palitra ? load(palitra) : Promise.resolve()),
    toggleHighlightBlacklist: toggle,
    closeHighlightBlacklist: close,
  };
}
