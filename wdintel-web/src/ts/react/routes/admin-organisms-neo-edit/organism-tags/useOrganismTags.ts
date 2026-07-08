import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TagAdmin, TagUpsertReq } from '../../../../../Bindings';
import { createOrganismTag, listOrganismTags, updateOrganismTag } from '../../../services/api/tags';
import { type LoadStatus, type TagsView, formatErrorMessage } from './types';

export function useOrganismTags(organismId: number | null) {
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [tags, setTags] = useState<TagAdmin[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [view, setView] = useState<TagsView>('active');

  useEffect(() => {
    if (organismId == null) {
      setStatus('idle');
      setTags([]);
      return;
    }

    const abortController = new AbortController();

    async function loadTags(id: number) {
      setStatus('loading');
      setError(null);
      try {
        const data = await listOrganismTags(id);
        if (abortController.signal.aborted) return;
        setTags(data);
        setStatus('success');
      } catch (loadError) {
        if (abortController.signal.aborted) return;
        setError(`Помилка завантаження тегів: ${formatErrorMessage(loadError)}`);
        setStatus('error');
      }
    }

    void loadTags(organismId);

    return () => {
      abortController.abort();
    };
  }, [organismId]);

  const handleSave = useCallback(
    async (req: Omit<TagUpsertReq, 'ownerOrganismId'>, editingTagId: number | null) => {
      if (organismId == null) return false;

      const fullReq: TagUpsertReq = {
        ...req,
        ownerOrganismId: organismId,
      };

      setSaveInFlight(true);
      setError(null);
      try {
        if (editingTagId == null) {
          const created = await createOrganismTag(organismId, fullReq);
          setTags((current) => [...current, created]);
        } else {
          const updated = await updateOrganismTag(organismId, editingTagId, fullReq);
          setTags((current) => current.map((tag) => (tag.tagId === updated.tagId ? updated : tag)));
        }
        return true;
      } catch (saveError) {
        setError(`Помилка збереження тегу: ${formatErrorMessage(saveError)}`);
        return false;
      } finally {
        setSaveInFlight(false);
      }
    },
    [organismId],
  );

  const handleToggleEnabled = useCallback(
    async (tag: TagAdmin) => {
      if (organismId == null) return;

      setError(null);
      try {
        const req: TagUpsertReq = {
          label: tag.label,
          extra: tag.extra,
          ord: tag.ord,
          enabled: !tag.enabled,
          isPalitra: tag.isPalitra,
          ownerOrganismId: organismId,
        };
        const updated = await updateOrganismTag(organismId, tag.tagId, req);
        setTags((current) =>
          current.map((item) => (item.tagId === updated.tagId ? updated : item)),
        );
      } catch (toggleError) {
        const action = tag.enabled ? 'вимкнення' : 'увімкнення';
        setError(`Помилка ${action} тегу: ${formatErrorMessage(toggleError)}`);
      }
    },
    [organismId],
  );

  const visibleTags = useMemo(
    () => tags.filter((tag) => (view === 'active' ? tag.enabled : !tag.enabled)),
    [tags, view],
  );

  return {
    status,
    tags,
    error,
    saveInFlight,
    view,
    setView,
    visibleTags,
    handleSave,
    handleToggleEnabled,
  };
}
