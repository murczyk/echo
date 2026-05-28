import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import DriveFileRenameOutlineOutlinedIcon from '@mui/icons-material/DriveFileRenameOutlineOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import HighlightOffOutlinedIcon from '@mui/icons-material/HighlightOffOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
} from '@mui/material';
import type { FormEvent } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { OrganismKeywordSetDto, RerDutyQueryStateWf as RerDutyFeedFilterState } from '../../../../Bindings';
import { CompactText } from '../../components/CompactTypography';
import { KeywordFormsEditor } from '../../components/KeywordFormsEditor';
import { PowerAlert } from '../../components/PowerAlert';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../components/dialogStyles';
import { keywordSetDisplayName, resolveKeywordSetId } from '../../services/api/organism-keyword-sets';
import { isPresent } from '../../utils/misc';
import { DeleteConfirmDialog } from './dialogs';
import { useOrganismKeywordSetsEditor } from './useOrganismKeywordSetsEditor';

const KEYWORD_WORDS_MAX_HEIGHT = '50vh';

const panelCancelButtonProps = { size: 'small' as const, variant: 'outlined' as const };
const panelPrimaryButtonProps = { size: 'small' as const, variant: 'contained' as const };

const keywordWordsScrollSx = {
  display: 'flex',
  flexWrap: 'wrap',
  alignContent: 'flex-start',
  alignSelf: 'flex-start',
  width: '100%',
  gap: 0.75,
  maxHeight: KEYWORD_WORDS_MAX_HEIGHT,
  overflowY: 'auto',
  pr: 0.5,
  py: 0.25,
} as const;

type HighlightOption = OrganismKeywordSetDto | null;

type RenameDialogState = {
  name: string;
};

export type FeedKeywordsPanelProps = {
  feedId: string;
  filter: RerDutyFeedFilterState;
  keywordSets: OrganismKeywordSetDto[];
  onFilterChange: (feedId: string, nextFilter: RerDutyFeedFilterState) => void;
  onKeywordSetsReload: () => Promise<void>;
};

export function FeedKeywordsPanel({
  feedId,
  filter,
  keywordSets,
  onFilterChange,
  onKeywordSetsReload,
}: FeedKeywordsPanelProps) {
  const resolvedSetId = useMemo(
    () => resolveKeywordSetId(keywordSets, filter.highlightKeywordSetId),
    [keywordSets, filter.highlightKeywordSetId],
  );
  const highlightSet = useMemo(
    () => (resolvedSetId != null ? (keywordSets.find((s) => s.id === resolvedSetId) ?? null) : null),
    [keywordSets, resolvedSetId],
  );

  const {
    selected,
    name,
    words,
    setWords,
    isDirty,
    saving,
    saveError,
    saveSuccess,
    syncSelectedId,
    clearSaveFeedback,
    discardChanges,
    handleSave: saveEditorSet,
    handleCreate: createEditorSet,
    handleRename: renameEditorSet,
    handleDelete: deleteEditorSet,
  } = useOrganismKeywordSetsEditor(keywordSets, onKeywordSetsReload);

  const [editExpanded, setEditExpanded] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);
  const [renameDialog, setRenameDialog] = useState<RenameDialogState | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  useEffect(() => {
    if (resolvedSetId != null) syncSelectedId(resolvedSetId);
  }, [resolvedSetId, syncSelectedId]);

  const setFilter = useCallback(
    (patch: Partial<RerDutyFeedFilterState>) => {
      onFilterChange(feedId, { ...filter, ...patch });
    },
    [feedId, filter, onFilterChange],
  );

  const applySetId = (setId: number | null) => {
    setFilter({ highlightKeywordSetId: setId, highlightKeywordsEnabled: null });
    if (setId != null) syncSelectedId(setId);
  };

  const handleSave = async () => {
    const savedId = await saveEditorSet();
    if (savedId != null) {
      applySetId(savedId);
      setEditExpanded(false);
    }
  };

  const handleCreate = async () => {
    const createdId = await createEditorSet();
    if (createdId != null) {
      applySetId(createdId);
      setEditExpanded(true);
    }
  };

  const closeDeleteDialog = () => {
    if (!saving) setDeleteDialogOpen(false);
  };

  const handleDeleteConfirm = async () => {
    const result = await deleteEditorSet();
    if (result == null) return;
    setDeleteDialogOpen(false);
    setEditExpanded(false);
    if (resolvedSetId === result.deletedId) {
      applySetId(result.nextId);
    }
  };

  const handleRefresh = async () => {
    setReloading(true);
    try {
      await onKeywordSetsReload();
    } finally {
      setReloading(false);
    }
  };

  const sortedSets = useMemo(
    () => [...keywordSets].sort((a, b) => keywordSetDisplayName(a).localeCompare(keywordSetDisplayName(b))),
    [keywordSets],
  );
  const highlightOptions = useMemo<HighlightOption[]>(() => [null, ...sortedSets], [sortedSets]);

  const canEdit = selected?.canEdit ?? false;
  const canManageSet = highlightSet != null && selected != null;
  const canUpdate = !saving && canEdit && isDirty;
  const canDiscard = !saving && isDirty;
  const canRename = !saving && canEdit && canManageSet && !isDirty;
  const canDelete = !saving && (selected?.canDelete ?? false);
  const canCreate = !saving;
  const canEditWords = !saving && canManageSet && canEdit;
  const canOpenMenu = canCreate || canRename || canDelete || canEditWords;

  const handleDiscard = () => {
    discardChanges();
    setEditExpanded(false);
  };

  const closeMenu = () => setMenuAnchorEl(null);

  const openRenameDialog = () => {
    setRenameDialog({ name: name.trim() || selected?.name || '' });
    closeMenu();
  };

  const openDeleteDialog = () => {
    closeMenu();
    setDeleteDialogOpen(true);
  };

  const closeRenameDialog = () => setRenameDialog(null);

  const handleRenameSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renameDialog || saving) return;
    const nextName = renameDialog.name.trim();
    if (!nextName) return;
    const ok = await renameEditorSet(nextName);
    if (ok) closeRenameDialog();
  };

  const trimmedRenameName = renameDialog?.name.trim() ?? '';
  const selectedName = selected?.name ?? '';
  const previewWords = useMemo(() => {
    if (!highlightSet) return [];
    return isDirty ? words : highlightSet.words;
  }, [highlightSet, isDirty, words]);

  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        width: '100%',
        maxWidth: '100%',
        px: { xs: 2, sm: 2.5 },
        py: 2,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        maxHeight: '100%',
        overflowY: 'auto',
      }}
    >
      <Paper
        sx={{
          p: 1.25,
          borderRadius: 2,
          border: 'none',
          boxShadow: 'none',
          background: 'transparent',
        }}
      >
        <Stack spacing={1} sx={{ minHeight: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, minWidth: 0 }}>
            <Box
              component="span"
              sx={{
                display: 'inline-block',
                flexShrink: 0,
                fontSize: 13,
                fontWeight: 600,
                lineHeight: 1.2,
                color: 'text.primary',
                whiteSpace: 'nowrap',
              }}
            >
              Набори
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flexShrink: 0 }}>
              <Tooltip title="Оновити список наборів">
                <span>
                  <IconButton
                    size="small"
                    aria-label="Оновити список наборів"
                    onClick={() => void handleRefresh()}
                    disabled={saving || reloading}
                  >
                    <RefreshOutlinedIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Дії">
                <span>
                  <IconButton
                    size="small"
                    onClick={(event) => setMenuAnchorEl(event.currentTarget)}
                    disabled={!canOpenMenu}
                    aria-label="Дії з наборами ключових слів"
                  >
                    <MoreVertIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
          </Box>

          <Autocomplete<HighlightOption, false, false, false>
            size="small"
            options={highlightOptions}
            value={highlightSet}
            disablePortal
            disabled={saving || reloading}
            getOptionLabel={(option) => (option ? keywordSetDisplayName(option) : 'Без підсвітки')}
            isOptionEqualToValue={(option, value) => option?.id === value?.id}
            onChange={(_event, next) => {
              applySetId(next?.id ?? null);
              setEditExpanded(false);
            }}
            openText="Відкрити"
            closeText="Закрити"
            clearText="Очистити"
            noOptionsText="Немає наборів"
            renderOption={(props, option) => {
              const { key: _unusedKey, ...optionProps } = props;
              if (!option) {
                return (
                  <li {...optionProps} key="no-highlight">
                    <HighlightOffOutlinedIcon sx={{ fontSize: 20, mr: 1, color: 'text.secondary' }} />
                    Без підсвітки
                  </li>
                );
              }
              return (
                <li {...optionProps} key={option.id}>
                  {keywordSetDisplayName(option)}
                </li>
              );
            }}
            renderInput={(params) => <TextField {...params} label="Набір" />}
            sx={{ minWidth: 0, width: '100%' }}
          />

          {highlightSet ? (
            <CompactText
              component="span"
              color="text.secondary"
              sx={{ display: 'inline-block', pl: 0.5, lineHeight: 1.3 }}
            >
              {words.length === 0
                ? 'Набір порожній — додайте слова через редагування'
                : `Слів у наборі: ${words.length}`}
            </CompactText>
          ) : (
            <CompactText
              component="span"
              color="text.secondary"
              sx={{ display: 'inline-block', pl: 0.5, lineHeight: 1.3 }}
            >
              Оберіть набір, щоб підсвічувати ключові слова в стрічці
            </CompactText>
          )}

          {highlightSet && !editExpanded && previewWords.length > 0 ? (
            <Box sx={keywordWordsScrollSx}>
              {previewWords.map((word) => (
                <Chip key={word} label={word} size="small" variant="outlined" />
              ))}
            </Box>
          ) : null}

          <Menu
            anchorEl={menuAnchorEl}
            open={isPresent(menuAnchorEl)}
            onClose={closeMenu}
            disablePortal
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          >
            <MenuItem
              onClick={() => {
                closeMenu();
                void handleCreate();
              }}
              disabled={!canCreate}
            >
              <AddOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
              Створити набір
            </MenuItem>
            <MenuItem
              onClick={() => {
                closeMenu();
                setEditExpanded(true);
              }}
              disabled={!canEditWords}
            >
              <EditOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
              Редагувати слова
            </MenuItem>
            <MenuItem onClick={openRenameDialog} disabled={!canRename}>
              <DriveFileRenameOutlineOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
              Перейменувати
            </MenuItem>
            <MenuItem onClick={openDeleteDialog} disabled={!canDelete} sx={{ color: 'error.main' }}>
              <DeleteOutlineOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
              Видалити набір
            </MenuItem>
          </Menu>

          <Dialog
            open={isPresent(renameDialog)}
            onClose={saving ? undefined : closeRenameDialog}
            fullWidth
            maxWidth="xs"
          >
            <Box component="form" onSubmit={handleRenameSubmit}>
              <DialogTitle>Перейменувати набір</DialogTitle>
              <DialogContent sx={{ pt: 2.5, overflow: 'visible' }}>
                <TextField
                  autoFocus
                  fullWidth
                  size="small"
                  label="Назва"
                  value={renameDialog?.name ?? ''}
                  onChange={(event) => setRenameDialog({ name: event.target.value })}
                  disabled={saving}
                />
              </DialogContent>
              <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
                <Button {...panelCancelButtonProps} onClick={closeRenameDialog} disabled={saving}>
                  Скасувати
                </Button>
                <Button
                  {...panelPrimaryButtonProps}
                  type="submit"
                  disabled={saving || trimmedRenameName === '' || trimmedRenameName === selectedName}
                >
                  Перейменувати
                </Button>
              </DialogActions>
            </Box>
          </Dialog>

          <DeleteConfirmDialog
            open={deleteDialogOpen}
            title="Видалити набір?"
            content={
              selected
                ? `Набір «${keywordSetDisplayName(selected)}». Цю дію не можна скасувати.`
                : 'Цю дію не можна скасувати.'
            }
            onClose={closeDeleteDialog}
            onConfirm={() => void handleDeleteConfirm()}
            confirmDisabled={saving}
            actionSize="small"
            cancelVariant="outlined"
          />

          {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}
          {saveSuccess ? (
            <PowerAlert severity="success" role="status" onClose={() => clearSaveFeedback()}>
              {saveSuccess}
            </PowerAlert>
          ) : null}

          {editExpanded && canManageSet ? (
            <Stack spacing={1.25} sx={{ pt: 0.25 }}>
              {!canEdit ? (
                <CompactText color="text.secondary">Редагування цього набору недоступне</CompactText>
              ) : (
                <>
                  <KeywordFormsEditor
                    words={words}
                    onWordsChange={(next) => {
                      clearSaveFeedback();
                      setWords(next);
                    }}
                    disabled={saving}
                    tagsMaxHeight={KEYWORD_WORDS_MAX_HEIGHT}
                  />
                  <Stack direction="row" spacing={0.75} justifyContent="flex-end" flexWrap="wrap" useFlexGap>
                    <Button {...panelCancelButtonProps} onClick={handleDiscard} disabled={!canDiscard}>
                      Скасувати
                    </Button>
                    <Button {...panelPrimaryButtonProps} onClick={() => void handleSave()} disabled={!canUpdate}>
                      Зберегти
                    </Button>
                  </Stack>
                </>
              )}
            </Stack>
          ) : null}
        </Stack>
      </Paper>
    </Box>
  );
}
