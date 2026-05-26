import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import {
  Box,
  Button,
  Chip,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { OrganismKeywordSetDto } from '../../../../Bindings';
import { KeywordFormsEditor } from '../../components/KeywordFormsEditor';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import {
  deleteOrganismKeywordSet,
  fetchOrganismKeywordSets,
  suggestNewKeywordSetName,
  upsertOrganismKeywordSet,
} from '../../services/api/organism-keyword-sets';
import { strArraysEqual } from '../../utils/misc';
import { readKeywordSetIdFromUrl, writeKeywordSetIdToUrl } from './settings-url';

export function SettingsKeywordSetsSection() {
  const [sets, setSets] = useState<OrganismKeywordSetDto[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(() => readKeywordSetIdFromUrl());
  const [name, setName] = useState('');
  const [words, setWords] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const selected = useMemo(() => sets.find((s) => s.id === selectedId) ?? null, [sets, selectedId]);

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

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await fetchOrganismKeywordSets();
      setSets(list);
      const urlId = readKeywordSetIdFromUrl();
      const nextId = urlId != null && list.some((s) => s.id === urlId) ? urlId : (list[0]?.id ?? null);
      setSelectedId(nextId);
      if (nextId != null) writeKeywordSetIdToUrl(nextId);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!selected) {
      setName('');
      setWords([]);
      return;
    }
    setName(selected.name);
    setWords(selected.words);
    setSaveError(null);
    setSaveSuccess(null);
  }, [selected]);

  const selectSet = (id: number) => {
    if (id === selectedId) return;
    if (isDirty && !window.confirm('Є не збережені зміни. Перейти до іншого набору без збереження?')) {
      return;
    }
    setSelectedId(id);
    writeKeywordSetIdToUrl(id);
  };

  const clearSaveFeedback = () => {
    setSaveSuccess(null);
    setSaveError(null);
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const saved = await upsertOrganismKeywordSet({
        id: selected.id,
        name: name.trim(),
        words,
      });
      setSaveSuccess('Збережено');
      await reload();
      setSelectedId(saved.id);
      writeKeywordSetIdToUrl(saved.id);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    if (isDirty && !window.confirm('Є не збережені зміни. Створити новий набір без збереження?')) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const created = await upsertOrganismKeywordSet({
        id: null,
        name: suggestNewKeywordSetName(sets),
        words: [],
      });
      writeKeywordSetIdToUrl(created.id);
      await reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selected || !selected.canDelete) return;
    if (!window.confirm(`Видалити набір «${selected.name}»?`)) return;
    setSaving(true);
    setSaveError(null);
    try {
      await deleteOrganismKeywordSet(selected.id);
      await reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box
      role="tabpanel"
      id="settings-neo-panel-keywords"
      aria-labelledby="settings-neo-tab-keywords"
      sx={{ p: { xs: 2, sm: 2.5 } }}
    >
      <Stack spacing={2}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
          <KeyOutlinedIcon sx={{ fontSize: 20, color: 'primary.main', flexShrink: 0 }} aria-hidden />
          <Typography component="h2" variant="h6" sx={{ fontWeight: 700, lineHeight: 1.2, flexShrink: 0 }}>
            Набори ключових слів
          </Typography>
          <Divider sx={{ flex: 1, minWidth: 16 }} />
          {isDirty && selected?.canEdit ? (
            <Chip
              size="small"
              label="Не збережений"
              color="warning"
              variant="outlined"
              sx={{ flexShrink: 0, height: 24 }}
            />
          ) : null}
          {isDirty && selected?.canEdit ? (
            <PowerButton
              size="small"
              variant="contained"
              onClick={() => void handleSave()}
              disabled={saving || loading}
              sx={{ flexShrink: 0 }}
            >
              зберегти
            </PowerButton>
          ) : null}
          {selected?.canDelete ? (
            <Button
              size="small"
              color="error"
              variant="text"
              onClick={() => void handleDelete()}
              disabled={saving || loading}
              sx={{ flexShrink: 0, border: 'none', boxShadow: 'none' }}
            >
              Видалити
            </Button>
          ) : null}
        </Stack>
        {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
        {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}
        {saveSuccess ? (
          <PowerAlert severity="success" role="status">
            {saveSuccess}
          </PowerAlert>
        ) : null}
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="flex-start">
          <Box sx={{ width: { xs: '100%', md: 240 }, flexShrink: 0 }}>
            {!isDirty ? (
              <PowerButton
                size="small"
                variant="outlined"
                fullWidth
                startIcon={<AddOutlinedIcon sx={{ fontSize: 16 }} />}
                onClick={() => void handleCreate()}
                disabled={saving || loading}
                sx={{ mb: 1 }}
              >
                Створити набір
              </PowerButton>
            ) : null}
            <List
              dense
              disablePadding
              sx={{ maxHeight: { xs: 160, md: 'none' }, overflowY: { xs: 'auto', md: 'visible' } }}
            >
              {sets.map((set) => (
                <ListItemButton key={set.id} selected={set.id === selectedId} onClick={() => selectSet(set.id)}>
                  <ListItemText
                    primary={set.name}
                    secondary={set.id === selectedId && isDirty ? 'Не збережені зміни' : (set.authorLogin ?? undefined)}
                    secondaryTypographyProps={set.id === selectedId && isDirty ? { color: 'warning.main' } : undefined}
                  />
                </ListItemButton>
              ))}
            </List>
          </Box>
          <Box sx={{ flex: 1, width: '100%', minWidth: 0 }}>
            {loading ? (
              <Typography color="text.secondary">Завантаження…</Typography>
            ) : selected ? (
              <Stack spacing={1.5}>
                <TextField
                  size="small"
                  label="Назва набору"
                  value={name}
                  onChange={(e) => {
                    clearSaveFeedback();
                    setName(e.target.value);
                  }}
                  disabled={!selected.canEdit || saving}
                  sx={{ maxWidth: 420 }}
                />
                <KeywordFormsEditor
                  words={words}
                  onWordsChange={(next) => {
                    clearSaveFeedback();
                    setWords(next);
                  }}
                  disabled={!selected.canEdit || saving}
                />
              </Stack>
            ) : (
              <Typography color="text.secondary">Оберіть набір або створіть новий</Typography>
            )}
          </Box>
        </Stack>
      </Stack>
    </Box>
  );
}
