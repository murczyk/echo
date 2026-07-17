import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { Box, Stack, Tooltip, Typography } from '@mui/material';
import { MRT_ColumnDef } from 'material-react-table';

import type { Palitra } from '../../../../../Bindings';
import { PowerChip } from '../../../components/PowerChip';
import { FULL_HEIGHT_LOADING_ROW_COUNT } from '../../../components/mui-customized/table/custom-styles';
import { formatDateTime24 } from '../../../utils/misc';
import type { FolderTableRowView, TableRowView } from '../types';

function formatText(value: string | null | undefined): string {
  if (!value || value.trim() === '') return '—';
  return value;
}

function renderEmptyFolderCell() {
  return <Box component="span" sx={{ display: 'block', minHeight: 20 }} />;
}

function renderFolderNameCell(
  row: FolderTableRowView,
  onToggleFolderExpanded: (path: string) => void,
) {
  const leftPadding = row.depth * 3 + 1;

  return (
    <Box
      component="button"
      type="button"
      onClick={() => onToggleFolderExpanded(row.folderPath)}
      sx={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        pl: leftPadding,
        pr: 0,
        py: 0.25,
        border: 0,
        background: 'transparent',
        textAlign: 'left',
        cursor: 'pointer',
        color: 'inherit',
        font: 'inherit',
      }}
    >
      <FolderOutlinedIcon fontSize="small" color="action" />
      <Typography variant="body2" fontWeight={700} noWrap>
        {formatText(row.name)}
      </Typography>
      <PowerChip
        label={'Палітр: ' + String(row.totalCount)}
        size="small"
        interactive={false}
        unselectedOpacity={1}
        unselectedBackgroundColor="action.selected"
        unselectedTextColor="text.primary"
        unselectedBorderColor="transparent"
      />
    </Box>
  );
}

function renderConversionStatusChip(palitra: Palitra) {
  if (palitra.conversionStatus === 'processing') {
    return (
      <PowerChip
        label="Обробка"
        size="small"
        interactive={false}
        selected
        backgroundColor="info.light"
        selectedBorderColor="info.main"
        selectedTextColor="info.contrastText"
        sx={{ '& .MuiChip-label': { px: 1 } }}
      />
    );
  }
  if (palitra.conversionStatus === 'error') {
    return (
      <PowerChip
        label="Помилка конвертації"
        size="small"
        interactive={false}
        selected
        backgroundColor="error.light"
        selectedBorderColor="error.main"
        selectedTextColor="error.contrastText"
        sx={{ '& .MuiChip-label': { px: 1 } }}
      />
    );
  }
  return null;
}

function latestChangelogWarningDescription(palitra: Palitra): string {
  if (!palitra.latestChangelogWarning || palitra.changelog.length === 0) {
    return '';
  }
  const latest = palitra.changelog[palitra.changelog.length - 1];
  return latest.description || latest.text || 'Остання подія синхронізації містить попередження';
}

function renderNameCell(row: TableRowView, onToggleFolderExpanded: (path: string) => void) {
  const leftPadding = row.depth * 3;

  if (row.kind === 'folder') {
    return renderFolderNameCell(row, onToggleFolderExpanded);
  }

  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      flexWrap="wrap"
      useFlexGap
      sx={{ pl: leftPadding }}
    >
      <Typography variant="body2" fontWeight={600}>
        {formatText(row.name)}
      </Typography>
      {row.palitra.missingInGoi ? (
        <Tooltip title="Палітра відсутня на сервері ГОІ">
          <WarningAmberIcon color="error" fontSize="small" />
        </Tooltip>
      ) : null}
      {row.palitra.latestChangelogWarning ? (
        <Tooltip title={latestChangelogWarningDescription(row.palitra)}>
          <WarningAmberIcon color="warning" fontSize="small" />
        </Tooltip>
      ) : null}
      {renderConversionStatusChip(row.palitra)}
      {row.palitra.isArchived ? (
        <PowerChip
          label="Архів"
          size="small"
          interactive={false}
          selected
          backgroundColor="warning.light"
          selectedBorderColor="warning.main"
          selectedTextColor="warning.contrastText"
          sx={{ '& .MuiChip-label': { px: 1 } }}
        />
      ) : null}
    </Stack>
  );
}

export function buildLoadingRows(): TableRowView[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    id: -(index + 1),
    kind: 'palitra',
    palitra: {
      id: -(index + 1),
      name: '',
      colorHex: '',
      sourceFileName: null,
      author: null,
      lastUploadedAtTs: null,
      conversionStatus: 'ready',
      sourceFormat: null,
      conversionError: null,
      missingInGoi: false,
      importedFromGoi: false,
      goiOwned: false,
      goiSourceRefreshRetryAvailable: false,
      latestChangelogWarning: false,
      changelog: [],
      accessLogins: [],
      accessOrganismIds: [],
      accessAorId: [],
      folder: null,
    } as unknown as Palitra,
    hiddenByCollapsedFolder: false,
    name: '',
    depth: 0,
    colorHex: '',
    sourceFileName: null,
    lastUploadedAtTs: null,
    author: null,
    accessSummary: '',
    canModify: false,
    canRetryGoiSourceConversion: false,
    canSelect: false,
    archiveInFlight: false,
    deleteInFlight: false,
    downloadInFlight: false,
    uploadInFlight: false,
    retryInFlight: false,
  }));
}

export function buildPalitraTableColumns(
  onToggleFolderExpanded: (path: string) => void,
): MRT_ColumnDef<TableRowView>[] {
  return [
    {
      header: 'Назва',
      accessorKey: 'name',
      id: 'name',
      size: 360,
      Cell: ({ row }) => renderNameCell(row.original, onToggleFolderExpanded),
    },
    {
      header: 'Колір',
      accessorKey: 'colorHex',
      id: 'colorHex',
      size: 140,
      enableSorting: false,
      Cell: ({ row }) =>
        row.original.kind === 'folder' ? (
          renderEmptyFolderCell()
        ) : (
          <PowerChip
            label={formatText(row.original.colorHex)}
            size="small"
            interactive={false}
            selected
            backgroundColor={row.original.colorHex || 'transparent'}
            selectedBorderColor={row.original.colorHex || 'divider'}
            autoTextContrast
          />
        ),
    },
    {
      header: 'Файл',
      accessorKey: 'sourceFileName',
      id: 'sourceFileName',
      size: 240,
      enableSorting: false,
      Cell: ({ row }) =>
        row.original.kind === 'folder' ? (
          renderEmptyFolderCell()
        ) : (
          <Typography
            variant="body2"
            sx={{ maxWidth: 280 }}
            noWrap
            title={formatText(row.original.sourceFileName)}
          >
            {formatText(row.original.sourceFileName)}
          </Typography>
        ),
    },
    {
      header: 'Додано',
      accessorKey: 'lastUploadedAtTs',
      id: 'lastUploadedAtTs',
      size: 170,
      enableColumnFilter: false,
      enableSorting: false,
      Cell: ({ row }) =>
        row.original.kind === 'folder'
          ? renderEmptyFolderCell()
          : formatDateTime24(row.original.lastUploadedAtTs),
    },
    {
      header: 'Автор',
      accessorKey: 'author',
      id: 'author',
      size: 180,
      enableSorting: false,
      Cell: ({ row }) =>
        row.original.kind === 'folder' ? renderEmptyFolderCell() : formatText(row.original.author),
    },
    {
      header: 'Доступ',
      accessorKey: 'accessSummary',
      id: 'accessSummary',
      enableSorting: false,
      size: 320,
      Cell: ({ row }) =>
        row.original.kind === 'folder' ? (
          renderEmptyFolderCell()
        ) : (
          <Typography variant="body2" sx={{ maxWidth: 360 }} title={row.original.accessSummary}>
            {row.original.accessSummary}
          </Typography>
        ),
    },
  ];
}
