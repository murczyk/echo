import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import DriveFileRenameOutlineOutlinedIcon from '@mui/icons-material/DriveFileRenameOutlineOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { isNullOrUndefined, isPresent } from '../utils/misc';
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
  const hasLoadedFilter = isPresent(selectedSavedFilter);
  const canUpdateExisting = !saveInFlight && hasLoadedFilter && isDirty;
  const canSaveAsNewNow = !saveInFlight && canSaveAsNew;
  const canRenameExisting = !saveInFlight && hasLoadedFilter;
  const canDeleteExisting = !saveInFlight && hasLoadedFilter;
  const canOpenMenu = canSaveAsNewNow || canUpdateExisting || canRenameExisting || canDeleteExisting;

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
    setActionDialog((current) => (isNullOrUndefined(current) ? current : { ...current, name: value }));
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
        ? await onRenameExisting(nextName)
        : await onSaveAsNew(nextName);
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

  return (
    <Paper
      sx={{
        p: 1.25,
        borderRadius: 2,
        border: 'none',
        boxShadow: 'none',
        background: 'transparent',
      }}
    >
      <Stack spacing={1}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, minWidth: 0 }}>
          <TypographyLike>{title}</TypographyLike>
          <Tooltip title="Дії">
            <span>
              <IconButton
                size="small"
                onClick={(event) => setMenuAnchorEl(event.currentTarget)}
                disabled={!canOpenMenu}
                aria-label="Дії зі збереженими фільтрами"
              >
                <MoreVertIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
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

        <Menu
          anchorEl={menuAnchorEl}
          open={isPresent(menuAnchorEl)}
          onClose={closeMenu}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        >
          <MenuItem
            onClick={() => {
              closeMenu();
              openActionDialog('save-as-new');
            }}
            disabled={!canSaveAsNewNow}
          >
            <AddOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
            Зберегти як новий
          </MenuItem>
          <MenuItem
            onClick={() => {
              closeMenu();
              void onUpdateExisting();
            }}
            disabled={!canUpdateExisting}
          >
            <RefreshOutlinedIcon fontSize="small" sx={{ mr: 1 }} />
            Оновити вибраний фільтр
          </MenuItem>
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

        <Dialog open={isPresent(actionDialog)} onClose={saveInFlight ? undefined : closeActionDialog} fullWidth maxWidth="xs">
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
        color: 'text.primary',
        whiteSpace: 'nowrap',
        mb: 0,
      }}
    >
      {children}
    </Box>
  );
}
