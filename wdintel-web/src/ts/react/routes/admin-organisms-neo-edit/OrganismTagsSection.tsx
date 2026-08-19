import BlockIcon from '@mui/icons-material/Block';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import EditIcon from '@mui/icons-material/Edit';
import { Box, Stack, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { useCallback, useMemo, useState } from 'react';

import type { TagAdmin, TagUpsertReq } from '../../../../Bindings';
import { MrtRowActionButton } from '../../components/MrtRowActionButton';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { SectionEmptyState } from '../../components/SectionEmptyState';
import { GlobalFilterTextField } from '../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import { CUSTOM_STYLES } from '../../components/mui-customized/table/custom-styles';
import type { AppMrtColumnDef } from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import { SettingsNeoTable } from '../settings-neo/SettingsNeoTable';
import { OrganismTagDialog } from './organism-tags/OrganismTagDialog';
import { formatYesNo, type TagsView } from './organism-tags/types';
import { useOrganismTags } from './organism-tags/useOrganismTags';

// Wide enough for the inline "Редагувати" button plus the "Вимкнути"/"Увімкнути" toggle
// so neither is clipped.
const ORGANISM_TAGS_ACTIONS_COLUMN_SIZE = 81;

const ORGANISM_TAGS_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'tagId',
  'label',
  'extra',
  'ord',
  'isPalitra',
];

const ORGANISM_TAGS_COLUMN_VISIBILITY = {
  tagId: true,
  label: true,
  extra: true,
  ord: true,
  isPalitra: true,
};

function TagsSearchField() {
  const tableStateContext = useTableStateContext();
  return (
    <GlobalFilterTextField
      globalFilter={tableStateContext.globalFilter}
      setGlobalFilter={tableStateContext.onChangeGlobalFilter}
    />
  );
}

export function OrganismTagsSection({ organismId }: { organismId: number | null }) {
  const {
    status,
    tags,
    error,
    saveInFlight,
    view,
    setView,
    visibleTags,
    handleSave,
    handleToggleEnabled,
  } = useOrganismTags(organismId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<TagAdmin | null>(null);

  const openCreateDialog = useCallback(() => {
    setEditingTag(null);
    setDialogOpen(true);
  }, []);

  const openEditDialog = useCallback((tag: TagAdmin) => {
    setEditingTag(tag);
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setEditingTag(null);
  }, []);

  const onSave = useCallback(
    (req: Omit<TagUpsertReq, 'ownerOrganismId'>) => handleSave(req, editingTag?.tagId ?? null),
    [handleSave, editingTag],
  );

  const columns = useMemo<AppMrtColumnDef<TagAdmin>[]>(() => {
    const noWrapHeadCellProps = {
      sx: { ...CUSTOM_STYLES.muiTableHeadCellProps.sx, whiteSpace: 'nowrap' },
    };
    const noWrapBodyCellProps = {
      sx: { ...CUSTOM_STYLES.muiTableBodyCellProps.sx, whiteSpace: 'nowrap' },
    };
    return [
      { header: 'ID', accessorKey: 'tagId', size: 80 },
      { header: 'Назва', accessorKey: 'label', size: 200 },
      {
        header: 'Додатковий',
        id: 'extra',
        accessorFn: (row) => formatYesNo(row.extra),
        size: 150,
        muiTableHeadCellProps: noWrapHeadCellProps,
        muiTableBodyCellProps: noWrapBodyCellProps,
      },
      {
        header: 'Порядок',
        id: 'ord',
        accessorFn: (row) => (row.ord == null ? '—' : row.ord),
        size: 130,
        muiTableHeadCellProps: noWrapHeadCellProps,
        muiTableBodyCellProps: noWrapBodyCellProps,
      },
      {
        header: 'Палітра',
        id: 'isPalitra',
        accessorFn: (row) => formatYesNo(row.isPalitra),
        size: 130,
        muiTableHeadCellProps: noWrapHeadCellProps,
        muiTableBodyCellProps: noWrapBodyCellProps,
      },
    ];
  }, []);

  const renderRowActions = useCallback(
    ({ row }: { row: { original: TagAdmin } }) => {
      const tag = row.original;
      return (
        <Stack direction="row" alignItems="center" gap={0.5}>
          <MrtRowActionButton
            label="Редагувати"
            icon={<EditIcon fontSize="small" />}
            opensModal
            onClick={() => openEditDialog(tag)}
          />
          {tag.enabled ? (
            <MrtRowActionButton
              label="Вимкнути"
              icon={<BlockIcon fontSize="small" />}
              onClick={() => void handleToggleEnabled(tag)}
            />
          ) : (
            <MrtRowActionButton
              label="Увімкнути"
              icon={<CheckCircleIcon fontSize="small" />}
              onClick={() => void handleToggleEnabled(tag)}
            />
          )}
        </Stack>
      );
    },
    [handleToggleEnabled, openEditDialog],
  );

  if (organismId == null) {
    return <SectionEmptyState message="Спочатку збережіть організм, щоб додати теги." />;
  }

  const isLoading = status === 'loading' || status === 'idle';
  const hasAnyTags = status === 'success' && tags.length > 0;
  const isEmpty = status === 'success' && tags.length === 0;
  const isEmptyView = hasAnyTags && visibleTags.length === 0;
  const emptyViewMessage =
    view === 'active'
      ? 'Немає активних тегів. Перемкніться на «Архів», щоб побачити вимкнені.'
      : 'Архів порожній — немає вимкнених тегів.';

  return (
    <Box sx={{ pb: 1 }}>
      <Stack spacing={2}>
        {error != null ? <PowerAlert severity="error">{error}</PowerAlert> : null}

        {isEmpty && !isLoading ? (
          <>
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="flex-end"
              gap={2}
              flexWrap="wrap"
            >
              <PowerButton variant="contained" onClick={openCreateDialog}>
                Додати тег
              </PowerButton>
            </Stack>
            <SectionEmptyState message="У цього організму ще немає тегів." />
          </>
        ) : null}

        {isLoading || hasAnyTags ? (
          <TableStateProvider
            tableId="admin-organism-tags-neo"
            defaultColumnOrder={ORGANISM_TAGS_COLUMN_ORDER}
            defaultColumnVisibility={ORGANISM_TAGS_COLUMN_VISIBILITY}
            defaultEnableColumnOrdering={false}
          >
            <Stack spacing={2}>
              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                gap={2}
                flexWrap="wrap"
              >
                <Stack direction="row" alignItems="center" gap={2} flexWrap="wrap">
                  <Box sx={{ flex: 1, maxWidth: 320 }}>
                    <TagsSearchField />
                  </Box>
                  <ToggleButtonGroup
                    value={view}
                    exclusive
                    size="small"
                    color="primary"
                    onChange={(_event, value: TagsView | null) => {
                      if (value) setView(value);
                    }}
                    sx={{
                      flexShrink: 0,
                      borderRadius: 1,
                      '& .MuiToggleButton-root': {
                        textTransform: 'none',
                        px: 1.75,
                        py: 0.625,
                        fontSize: '0.875rem',
                        fontWeight: 600,
                        lineHeight: 1.25,
                        borderRadius: 0,
                      },
                      '& .MuiToggleButtonGroup-firstButton': {
                        borderTopLeftRadius: 8,
                        borderBottomLeftRadius: 8,
                      },
                      '& .MuiToggleButtonGroup-lastButton': {
                        borderTopRightRadius: 8,
                        borderBottomRightRadius: 8,
                      },
                    }}
                  >
                    <ToggleButton value="active">Активні</ToggleButton>
                    <ToggleButton value="archived">Архів</ToggleButton>
                  </ToggleButtonGroup>
                </Stack>
                <PowerButton variant="contained" onClick={openCreateDialog}>
                  Додати тег
                </PowerButton>
              </Stack>
              {isEmptyView && !isLoading ? (
                <SectionEmptyState message={emptyViewMessage} />
              ) : (
                <SettingsNeoTable
                  columns={columns}
                  data={isLoading ? [] : visibleTags}
                  loading={isLoading}
                  layoutMode="grid"
                  enableRowActions
                  renderRowActions={renderRowActions}
                  rowActionsColumnSize={ORGANISM_TAGS_ACTIONS_COLUMN_SIZE}
                />
              )}
            </Stack>
          </TableStateProvider>
        ) : null}
      </Stack>

      <OrganismTagDialog
        open={dialogOpen}
        editingTag={editingTag}
        saveInFlight={saveInFlight}
        onClose={closeDialog}
        onSave={onSave}
      />
    </Box>
  );
}
