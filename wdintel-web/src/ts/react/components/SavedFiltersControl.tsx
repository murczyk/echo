import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import DriveFileRenameOutlineOutlinedIcon from '@mui/icons-material/DriveFileRenameOutlineOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import {
  Autocomplete,
  Box,
  Button,
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
import type { FormEvent, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { PowerChip } from './PowerChip';
import { CompactText } from './CompactTypography';
import { STANDARD_DIALOG_ACTIONS_SX } from './dialogStyles';

type SavedFilterIdentity = {
  id: number;
  name: string;
};

type SavedFilterActionKind = 'save-as-new' | 'rename';

type SavedFilterActionDialogState = {
  kind: SavedFilterActionKind;
  name: string;
};

export type SavedFiltersControlProps<TSavedFilter extends SavedFilterIdentity> = {
  savedFilters: TSavedFilter[];
  selectedSavedFilter: TSavedFilter | null;
  savedFilterName: string;
  isDirty: boolean;
  saveInFlight: boolean;
  canSaveAsNew?: boolean;
  onApplySavedFilter: (savedFilter: TSavedFilter | null) => void;
  onSavedFilterNameChange: (name: string) => void;
  onUpdateExisting: () => Promise<void> | void;
  onSaveAsNew: (name: string) => boolean | Promise<boolean> | void;
  onRenameExisting: (name: string) => boolean | Promise<boolean> | void;
  onDeleteExisting: () => Promise<void> | void;
  title?: ReactNode;
};

function getActionConfig(kind: SavedFilterActionKind) {
  return kind === 'rename'
    ? {
        title: 'Перейменувати фільтр',
        confirmLabel: 'Перейменувати',
      }
    : {
        title: 'Зберегти як новий',
        confirmLabel: 'Зберегти',
      };
}

export function SavedFiltersControl<TSavedFilter extends SavedFilterIdentity>({
  savedFilters,
  selectedSavedFilter,
  savedFilterName,
  isDirty,
  saveInFlight,
  canSaveAsNew = true,
  onApplySavedFilter,
  onSavedFilterNameChange,
  onUpdateExisting,
  onSaveAsNew,
  onRenameExisting,
  onDeleteExisting,
  title = 'Збережені фільтри',
}: SavedFiltersControlProps<TSavedFilter>) {
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);
  const [actionDialog, setActionDialog] = useState<SavedFilterActionDialogState | null>(null);

  const sortedSavedFilters = useMemo(
    () => [...savedFilters].sort((a, b) => a.name.localeCompare(b.name)),
    [savedFilters],
  );

  const trimmedSavedFilterName = savedFilterName.trim();
  const selectedSavedFilterName = selectedSavedFilter?.name ?? '';
  const hasLoadedFilter = selectedSavedFilter != null;
  const canUpdateExisting = !saveInFlight && hasLoadedFilter && isDirty;
  const canSaveAsNewNow = !saveInFlight && canSaveAsNew;
  const canRenameExisting = !saveInFlight && hasLoadedFilter;
  const canDeleteExisting = !saveInFlight && hasLoadedFilter;

  const closeMenu = () => setMenuAnchorEl(null);

  const openActionDialog = (kind: SavedFilterActionKind) => {
    setActionDialog({
      kind,
      name: trimmedSavedFilterName || selectedSavedFilterName,
    });
    closeMenu();
  };

  const closeActionDialog = () => setActionDialog(null);

  const updateActionName = (value: string) => {
    setActionDialog((current) => (current == null ? current : { ...current, name: value }));
  };

  const handleActionSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const current = actionDialog;
    if (!current || saveInFlight) return;
    const nextName = current.name.trim();
    if (!nextName) return;
    if (current.kind === 'rename' && nextName === selectedSavedFilterName) return;

    try {
      const result = current.kind === 'rename'
        ? await Promise.resolve(onRenameExisting(nextName))
        : await Promise.resolve(onSaveAsNew(nextName));
      if (result === false) return;
      onSavedFilterNameChange(nextName);
      closeActionDialog();
    } catch {
      // Parents already surface errors; keep the dialog open if they throw.
    }
  };

  const actionConfig = actionDialog ? getActionConfig(actionDialog.kind) : null;
  const draftSavedFilterName = actionDialog?.name ?? savedFilterName;
  const trimmedDraftSavedFilterName = draftSavedFilterName.trim();
  const hasDraftRenamedValue =
    hasLoadedFilter && trimmedDraftSavedFilterName !== '' && trimmedDraftSavedFilterName !== selectedSavedFilterName;
  const statusLabel = hasDraftRenamedValue ? 'Нова назва' : isDirty ? 'Змінено' : 'Вибрано';
  const statusColor = hasDraftRenamedValue || isDirty ? 'warning' : 'success';

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        borderRadius: 2,
        borderColor: 'rgba(148, 163, 184, 0.24)',
        background: 'rgba(255, 255, 255, 0.02)',
      }}
    >
      <Stack spacing={1.25}>
        <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
          <TypographyLike>{title}</TypographyLike>
        </Box>

        <Box sx={{ minWidth: 0 }}>
          {sortedSavedFilters.length > 0 ? (
            <Autocomplete<TSavedFilter, false, false, false>
              size="small"
              options={sortedSavedFilters}
              value={selectedSavedFilter}
              getOptionLabel={(option) => option.name}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              onChange={(_event, next) => onApplySavedFilter(next)}
              openText="Відкрити"
              closeText="Закрити"
              clearText="Очистити"
              noOptionsText="Немає варіантів"
              renderOption={(props, option) => {
                const { key: _unusedKey, ...optionProps } = props;
                return (
                  <li {...optionProps} key={option.id}>
                    {option.name}
                  </li>
                );
              }}
              renderInput={(params) => <TextField {...params} label="Фільтр" />}
              sx={{ minWidth: 0, width: '100%' }}
            />
          ) : (
            <CompactText
              component="span"
              color="text.secondary"
              sx={{
                display: 'inline-block',
                pl: 0.5,
                fontSize: 12,
                fontWeight: 400,
                lineHeight: 1.1,
              }}
            >
              Збережені фільтри відсутні
            </CompactText>
          )}
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, flexWrap: 'wrap' }}>
          <Tooltip title="Зберегти як новий">
            <span>
              <IconButton
                size="small"
                onClick={() => openActionDialog('save-as-new')}
                disabled={!canSaveAsNewNow}
                aria-label="Зберегти як новий"
              >
                <AddOutlinedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Оновити вибраний фільтр">
            <span>
              <IconButton
                size="small"
                onClick={() => {
                  void onUpdateExisting();
                }}
                disabled={!canUpdateExisting}
                aria-label="Оновити вибраний фільтр"
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
                disabled={!canDeleteExisting && !canRenameExisting}
                aria-label="Дії зі збереженим фільтром"
              >
                <MoreVertIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          {hasLoadedFilter ? (
            <Box sx={{ flexGrow: 1, display: 'flex', justifyContent: 'flex-end' }}>
              <PowerChip label={statusLabel} selected color={statusColor} />
            </Box>
          ) : null}
        </Box>

        <Menu
          anchorEl={menuAnchorEl}
          open={menuAnchorEl != null}
          onClose={closeMenu}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        >
          <MenuItem
            onClick={() => openActionDialog('rename')}
            disabled={!canRenameExisting}
          >
            <DriveFileRenameOutlineOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
            Перейменувати
          </MenuItem>
          <MenuItem
            onClick={() => {
              closeMenu();
              void onDeleteExisting();
            }}
            disabled={!canDeleteExisting}
            sx={{ color: 'error.main' }}
          >
            <DeleteOutlineOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
            Видалити
          </MenuItem>
        </Menu>

        <Dialog open={actionDialog != null} onClose={saveInFlight ? undefined : closeActionDialog} fullWidth maxWidth="xs">
          <Box component="form" onSubmit={handleActionSubmit}>
            <DialogTitle>{actionConfig?.title}</DialogTitle>
            <DialogContent sx={{ pt: 2.5, overflow: 'visible' }}>
              <TextField
                autoFocus
                fullWidth
                size="small"
                label="Назва"
                value={draftSavedFilterName}
                onChange={(event) => updateActionName(event.target.value)}
                disabled={saveInFlight}
              />
            </DialogContent>
            <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
              <Button onClick={closeActionDialog} disabled={saveInFlight}>
                Скасувати
              </Button>
              <Button
                type="submit"
                variant="contained"
                disabled={
                  saveInFlight ||
                  trimmedDraftSavedFilterName === '' ||
                  (actionDialog?.kind === 'rename' && trimmedDraftSavedFilterName === selectedSavedFilterName)
                }
              >
                {actionConfig?.confirmLabel}
              </Button>
            </DialogActions>
          </Box>
        </Dialog>
      </Stack>
    </Paper>
  );
}

function TypographyLike({ children }: { children: ReactNode }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-block',
        flexShrink: 0,
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.2,
        color: 'text.secondary',
        whiteSpace: 'nowrap',
        mb: '8px',
      }}
    >
      {children}
    </Box>
  );
}
