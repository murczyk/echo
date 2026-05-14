import { useCallback, useEffect, useMemo, useState } from 'react';

import { ParsedRelease, parseRelease } from './markdown-helpers';
import {
  fetchReleaseMarkdown,
  fetchReleasesIndex,
  ReleaseMeta,
} from './releases-source';

export type LoadStatus<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; data: T }
  | { kind: 'error'; error: string };

interface UseUpdatesPageState {
  releases: LoadStatus<ReleaseMeta[]>;
  selectedReleaseId: string | null;
  release: LoadStatus<ParsedRelease>;
  selectRelease: (releaseId: string) => void;
  jumpToSection: (id: string) => void;
}

const SCROLL_OFFSET = 120;

export function useUpdatesPage(): UseUpdatesPageState {
  const [releases, setReleases] = useState<LoadStatus<ReleaseMeta[]>>({ kind: 'idle' });
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
  const [release, setRelease] = useState<LoadStatus<ParsedRelease>>({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    setReleases({ kind: 'loading' });
    fetchReleasesIndex()
      .then((list) => {
        if (cancelled) return;
        setReleases({ kind: 'success', data: list });
        const first = list[0];
        if (first) setSelectedReleaseId(first.releaseId);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setReleases({ kind: 'error', error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedReleaseId) return;
    let cancelled = false;
    setRelease({ kind: 'loading' });
    fetchReleaseMarkdown(selectedReleaseId)
      .then((markdown) => {
        if (cancelled) return;
        const parsed = parseRelease(markdown, selectedReleaseId);
        setRelease({ kind: 'success', data: parsed });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setRelease({ kind: 'error', error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedReleaseId]);

  const selectRelease = useCallback((releaseId: string) => {
    setSelectedReleaseId((prev) => (prev === releaseId ? prev : releaseId));
  }, []);

  const jumpToSection = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - SCROLL_OFFSET;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  }, []);

  return useMemo(
    () => ({
      releases,
      selectedReleaseId,
      release,
      selectRelease,
      jumpToSection,
    }),
    [releases, selectedReleaseId, release, selectRelease, jumpToSection],
  );
}
