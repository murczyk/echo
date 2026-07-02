import { useCallback, useEffect, useState } from 'react';

import { ParsedRelease, parseRelease } from './markdown-helpers';
import { fetchReleaseMarkdown, fetchReleasesIndex, ReleaseMeta } from './releases.service';

export interface UseUpdatesPageState {
  releases: ReleaseMeta[];
  releasesLoadInProgress: boolean;
  releasesLoadError: string | null;
  selectedReleaseId: string | null;
  release: ParsedRelease | null;
  releaseLoadInProgress: boolean;
  releaseLoadError: string | null;
  selectRelease: (releaseId: string) => void;
  jumpToSection: (id: string) => void;
}

const SCROLL_OFFSET = 120;

export function useUpdatesPage(): UseUpdatesPageState {
  const [releases, setReleases] = useState<ReleaseMeta[]>([]);
  const [releasesLoadInProgress, setReleasesLoadInProgress] = useState(true);
  const [releasesLoadError, setReleasesLoadError] = useState<string | null>(null);
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
  const [release, setRelease] = useState<ParsedRelease | null>(null);
  const [releaseLoadInProgress, setReleaseLoadInProgress] = useState(false);
  const [releaseLoadError, setReleaseLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReleasesLoadInProgress(true);
    setReleasesLoadError(null);
    fetchReleasesIndex()
      .then((list) => {
        if (cancelled) return;
        setReleases(list);
        setReleasesLoadInProgress(false);
        const first = list[0];
        if (first) setSelectedReleaseId(first.releaseId);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setReleasesLoadError(err.message);
        setReleasesLoadInProgress(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedReleaseId) {
      setRelease(null);
      setReleaseLoadInProgress(false);
      setReleaseLoadError(null);
      return;
    }
    let cancelled = false;
    setReleaseLoadInProgress(true);
    setReleaseLoadError(null);
    setRelease(null);
    fetchReleaseMarkdown(selectedReleaseId)
      .then((markdown) => {
        if (cancelled) return;
        setRelease(parseRelease(markdown, selectedReleaseId));
        setReleaseLoadInProgress(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setReleaseLoadError(err.message);
        setReleaseLoadInProgress(false);
        setRelease(null);
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

  return {
    releases,
    releasesLoadInProgress,
    releasesLoadError,
    selectedReleaseId,
    release,
    releaseLoadInProgress,
    releaseLoadError,
    selectRelease,
    jumpToSection,
  };
}
