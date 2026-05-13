import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ParsedRelease, parseRelease } from './markdown-helpers';
import { getReleasesSource, ReleaseMeta, ReleasesSource } from './releases-source';

export type LoadStatus<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; data: T }
  | { kind: 'error'; error: string };

interface UseUpdatesPageState {
  releases: LoadStatus<ReleaseMeta[]>;
  selectedReleaseId: string | null;
  release: LoadStatus<ParsedRelease>;
  activeSectionId: string | null;
  selectRelease: (releaseId: string) => void;
  setActiveSectionId: (id: string | null) => void;
  jumpToSection: (id: string) => void;
}

const SCROLL_OFFSET = 120;

export function useUpdatesPage(
  source: ReleasesSource = getReleasesSource(),
): UseUpdatesPageState {
  const [releases, setReleases] = useState<LoadStatus<ReleaseMeta[]>>({ kind: 'idle' });
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
  const [release, setRelease] = useState<LoadStatus<ParsedRelease>>({ kind: 'idle' });
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const activeReleaseRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReleases({ kind: 'loading' });
    source
      .listReleases()
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
  }, [source]);

  useEffect(() => {
    if (!selectedReleaseId) return;
    let cancelled = false;
    activeReleaseRef.current = selectedReleaseId;
    setRelease({ kind: 'loading' });
    setActiveSectionId(null);
    source
      .fetchReleaseMarkdown(selectedReleaseId)
      .then((markdown) => {
        if (cancelled || activeReleaseRef.current !== selectedReleaseId) return;
        const parsed = parseRelease(markdown, selectedReleaseId);
        setRelease({ kind: 'success', data: parsed });
        setActiveSectionId(parsed.sections[0]?.domId ?? null);
      })
      .catch((err: Error) => {
        if (cancelled || activeReleaseRef.current !== selectedReleaseId) return;
        setRelease({ kind: 'error', error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedReleaseId, source]);

  const selectRelease = useCallback((releaseId: string) => {
    setSelectedReleaseId((prev) => (prev === releaseId ? prev : releaseId));
  }, []);

  const jumpToSection = useCallback((id: string) => {
    setActiveSectionId(id);
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
      activeSectionId,
      selectRelease,
      setActiveSectionId,
      jumpToSection,
    }),
    [releases, selectedReleaseId, release, activeSectionId, selectRelease, jumpToSection],
  );
}
