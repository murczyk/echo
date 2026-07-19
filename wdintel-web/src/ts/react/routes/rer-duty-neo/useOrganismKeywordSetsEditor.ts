import { useCallback, useEffect, useMemo, useState } from 'react';

import type { OrganismKeywordSetDto } from '../../../../Bindings';
import {
  deleteOrganismKeywordSet,
  suggestNewKeywordSetName,
  upsertOrganismKeywordSet,
} from '../../services/api/organism-keyword-sets';
import { strArraysEqual } from '../../utils/misc';

export function useOrganismKeywordSetsEditor(
  keywordSets: OrganismKeywordSetDto[],
  reloadKeywordSets: () => Promise<void>,
) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [words, setWords] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const selected = useMemo(
    () => keywordSets.find((s) => s.id === selectedId) ?? null,
    [keywordSets, selectedId],
  );

  const isDirty = useMemo(() => {
    if (!selected?.canEdit) return false;
    const editedName = name.trim();
    return editedName !== selected.name || !strArraysEqual(words, selected.words);
  }, [selected, name, words]);

  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    if (keywordSets.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId != null && keywordSets.some((s) => s.id === selectedId)) return;
    setSelectedId(keywordSets[0]?.id ?? null);
  }, [keywordSets, selectedId]);

  useEffect(() => {
    if (!selected) {
      setName('');
      setWords([]);
      return;
    }
    setName(selected.name);
    setWords(selected.words);
  }, [selected]);

  useEffect(() => {
    setSaveError(null);
  }, [selectedId]);

  const selectSet = useCallback(
    (id: number) => {
      if (id === selectedId) return;
      if (
        isDirty &&
        !window.confirm('Є не збережені зміни. Перейти до іншого набору без збереження?')
      ) {
        return;
      }
      setSelectedId(id);
    },
    [isDirty, selectedId],
  );

  const clearSaveFeedback = useCallback(() => {
    setSaveError(null);
  }, []);

  const discardChanges = useCallback(() => {
    if (!selected) return;
    setName(selected.name);
    setWords(selected.words);
    clearSaveFeedback();
  }, [selected, clearSaveFeedback]);

  const handleSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await upsertOrganismKeywordSet({
        id: selected.id,
        name: name.trim(),
        words,
      });
      await reloadKeywordSets();
      setSelectedId(saved.id);
      return saved.id;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setSaving(false);
    }
  }, [selected, name, words, reloadKeywordSets]);

  const handleCreate = useCallback(async () => {
    if (isDirty && !window.confirm('Є не збережені зміни. Створити новий набір без збереження?')) {
      return null;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const created = await upsertOrganismKeywordSet({
        id: null,
        name: suggestNewKeywordSetName(keywordSets),
        words: [],
      });
      await reloadKeywordSets();
      setSelectedId(created.id);
      return created.id;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setSaving(false);
    }
  }, [isDirty, keywordSets, reloadKeywordSets]);

  const handleRename = useCallback(
    async (nextName: string): Promise<boolean> => {
      if (!selected?.canEdit) return false;
      const trimmed = nextName.trim();
      if (!trimmed || trimmed === selected.name) return false;
      if (isDirty && !window.confirm('Є не збережені зміни. Перейменувати набір без збереження?')) {
        return false;
      }
      setSaving(true);
      setSaveError(null);
      try {
        const saved = await upsertOrganismKeywordSet({
          id: selected.id,
          name: trimmed,
          words: isDirty ? selected.words : words,
        });
        await reloadKeywordSets();
        setSelectedId(saved.id);
        setName(saved.name);
        setWords(saved.words);
        return true;
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [selected, isDirty, words, reloadKeywordSets],
  );

  const handleDelete = useCallback(async (): Promise<{
    deletedId: number;
    nextId: number | null;
  } | null> => {
    if (!selected || !selected.canDelete) return null;
    const deletedId = selected.id;
    const nextId = keywordSets.find((s) => s.id !== deletedId)?.id ?? null;
    setSaving(true);
    setSaveError(null);
    try {
      await deleteOrganismKeywordSet(deletedId);
      await reloadKeywordSets();
      setSelectedId(nextId);
      return { deletedId, nextId };
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setSaving(false);
    }
  }, [selected, keywordSets, reloadKeywordSets]);

  const syncSelectedId = useCallback(
    (id: number | null) => {
      if (id == null) return;
      if (id === selectedId) return;
      if (
        isDirty &&
        !window.confirm('Є не збережені зміни. Перейти до іншого набору без збереження?')
      ) {
        return;
      }
      setSelectedId(id);
    },
    [isDirty, selectedId],
  );

  return {
    selectedId,
    selected,
    name,
    words,
    setName,
    setWords,
    isDirty,
    saving,
    saveError,
    selectSet,
    syncSelectedId,
    clearSaveFeedback,
    discardChanges,
    handleSave,
    handleCreate,
    handleRename,
    handleDelete,
  };
}
