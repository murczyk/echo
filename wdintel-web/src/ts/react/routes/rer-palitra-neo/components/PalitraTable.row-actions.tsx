import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteIcon from '@mui/icons-material/Delete';
import DownloadIcon from '@mui/icons-material/Download';
import DriveFileMoveOutlinedIcon from '@mui/icons-material/DriveFileMoveOutlined';
import EditIcon from '@mui/icons-material/Edit';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HistoryIcon from '@mui/icons-material/History';
import ReplayIcon from '@mui/icons-material/Replay';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import UnarchiveOutlinedIcon from '@mui/icons-material/UnarchiveOutlined';
import { Box, CircularProgress, Tooltip } from '@mui/material';

import type { Palitra } from '../../../../../Bindings';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { MrtRowActionButton, MrtRowActions } from '../../../components/MrtRowActionButton';
import type { FolderTableRowView, PalitraRowView, TableRowView } from '../types';

type Props = {
  row: TableRowView;
  loading: boolean;
  bulkDeleteInFlight: boolean;
  externalBusy: boolean;
  onOpenEdit: (palitra: Palitra) => void;
  onRequestArchive: (palitra: Palitra) => void;
  onRequestAssignFolder: (palitra: Palitra) => void;
  onRequestUnarchive: (palitra: Palitra) => void;
  onDownload: (palitra: Palitra) => void;
  onRequestPreview: (palitra: Palitra) => void;
  onRequestUploadPoints: (palitraId: number) => void;
  onRetryConversion: (palitra: Palitra) => void;
  onRetryGoiSourceConversion: (palitra: Palitra) => void;
  onOpenHistory: (palitra: Palitra) => void;
  onDelete: (palitra: Palitra) => void;
  onToggleFolderExpanded: (path: string) => void;
  onRequestRenameFolder: (path: string) => void;
  onRequestArchiveFolder: (path: string) => void;
  onRequestDeleteFolder: (path: string) => void;
};

function renderFolderRowActions(row: FolderTableRowView, props: Props) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center' }}>
      <MrtRowActions>
        <MrtRowActionButton
          label={row.isExpanded ? 'Згорнути папку' : 'Розгорнути папку'}
          onClick={() => props.onToggleFolderExpanded(row.folderPath)}
          disabled={props.loading || props.externalBusy}
          icon={
            row.isExpanded ? (
              <ExpandMoreIcon fontSize="small" />
            ) : (
              <ChevronRightIcon fontSize="small" />
            )
          }
        />
        <MrtRowActionButton
          label="Перейменувати папку"
          onClick={() => props.onRequestRenameFolder(row.folderPath)}
          disabled={!row.canModify || props.loading || props.externalBusy}
          icon={<EditIcon fontSize="small" />}
          opensModal
        />
        <MrtRowActionButton
          label="Архівувати всі палітри в папці"
          onClick={() => props.onRequestArchiveFolder(row.folderPath)}
          disabled={!row.canModify || props.loading || props.externalBusy}
          icon={<ArchiveOutlinedIcon fontSize="small" />}
          opensModal
        />
        <MrtRowActionButton
          label="Видалити всі палітри в папці"
          onClick={() => props.onRequestDeleteFolder(row.folderPath)}
          disabled={!row.canModify || props.loading || props.externalBusy}
          icon={<DeleteIcon fontSize="small" />}
          tone="danger"
          opensModal
        />
      </MrtRowActions>
    </Box>
  );
}

function isPalitraRowMutationDisabled(row: PalitraRowView, props: Props): boolean {
  return (
    !row.canModify ||
    row.archiveInFlight ||
    row.deleteInFlight ||
    row.downloadInFlight ||
    row.uploadInFlight ||
    row.retryInFlight ||
    props.loading ||
    props.bulkDeleteInFlight ||
    props.externalBusy
  );
}

function isPalitraRowPreviewDisabled(row: PalitraRowView, props: Props): boolean {
  return (
    !row.canSelect ||
    row.archiveInFlight ||
    row.deleteInFlight ||
    row.downloadInFlight ||
    row.uploadInFlight ||
    props.loading ||
    row.retryInFlight ||
    props.bulkDeleteInFlight ||
    props.externalBusy
  );
}

function isGoiSourceRetryDisabled(row: PalitraRowView, props: Props): boolean {
  return (
    !row.canRetryGoiSourceConversion ||
    row.retryInFlight ||
    props.loading ||
    props.bulkDeleteInFlight ||
    props.externalBusy
  );
}

function renderPalitraRowActions(row: PalitraRowView, props: Props) {
  const mutationDisabled = isPalitraRowMutationDisabled(row, props);
  const previewDisabled = isPalitraRowPreviewDisabled(row, props);

  return (
    <Box
      sx={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
    >
      <Tooltip title="Попередній перегляд">
        <span style={{ display: 'inline-flex' }}>
          <PowerIconButton
            size="small"
            aria-label="Попередній перегляд"
            title="Попередній перегляд"
            onClick={(event) => {
              event.stopPropagation();
              props.onRequestPreview(row.palitra);
            }}
            disabled={previewDisabled}
            sx={(theme) => ({
              width: 28,
              height: 28,
              borderRadius: '50%',
              color: theme.palette.text.primary,
              '&:hover': {
                backgroundColor: theme.palette.action.hover,
                color: theme.palette.text.primary,
              },
              '&:focus-visible': {
                outline: `2px solid ${theme.palette.primary.main}`,
                outlineOffset: 1,
              },
              '&.Mui-disabled': {
                color: theme.palette.action.disabled,
              },
            })}
          >
            <VisibilityOutlinedIcon fontSize="small" />
          </PowerIconButton>
        </span>
      </Tooltip>
      <MrtRowActions forceMenu>
        <MrtRowActionButton
          label="Редагувати"
          onClick={() => props.onOpenEdit(row.palitra)}
          disabled={mutationDisabled}
          icon={<EditIcon fontSize="small" />}
          opensModal
        />
        <MrtRowActionButton
          label="Історія"
          onClick={() => props.onOpenHistory(row.palitra)}
          disabled={props.loading || props.externalBusy}
          icon={<HistoryIcon fontSize="small" />}
          opensModal
        />
        <MrtRowActionButton
          label="Перемістити в папку"
          onClick={() => props.onRequestAssignFolder(row.palitra)}
          disabled={mutationDisabled}
          icon={<DriveFileMoveOutlinedIcon fontSize="small" />}
          opensModal
        />
        {row.palitra.isArchived ? (
          <MrtRowActionButton
            label="Повернути з архіву"
            onClick={() => props.onRequestUnarchive(row.palitra)}
            disabled={mutationDisabled}
            icon={
              row.archiveInFlight ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <UnarchiveOutlinedIcon fontSize="small" />
              )
            }
            opensModal
          />
        ) : (
          <MrtRowActionButton
            label="Перенести в архів"
            onClick={() => props.onRequestArchive(row.palitra)}
            disabled={mutationDisabled}
            icon={
              row.archiveInFlight ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <ArchiveOutlinedIcon fontSize="small" />
              )
            }
            opensModal
          />
        )}
        <MrtRowActionButton
          label="Завантажити"
          onClick={() => props.onDownload(row.palitra)}
          disabled={
            row.id < 0 ||
            row.archiveInFlight ||
            row.deleteInFlight ||
            row.downloadInFlight ||
            row.uploadInFlight ||
            props.loading ||
            row.retryInFlight ||
            props.bulkDeleteInFlight ||
            props.externalBusy
          }
          icon={
            row.downloadInFlight ? (
              <CircularProgress size={16} color="inherit" />
            ) : (
              <DownloadIcon fontSize="small" />
            )
          }
        />
        <MrtRowActionButton
          label="Додати точки"
          onClick={() => props.onRequestUploadPoints(row.id)}
          disabled={mutationDisabled}
          icon={
            row.uploadInFlight ? (
              <CircularProgress size={16} color="inherit" />
            ) : (
              <CloudUploadIcon fontSize="small" />
            )
          }
        />
        {row.palitra.goiSourceRefreshRetryAvailable ? (
          <MrtRowActionButton
            label="Повторити оновлення з ГОІ"
            onClick={() => props.onRetryGoiSourceConversion(row.palitra)}
            disabled={isGoiSourceRetryDisabled(row, props)}
            icon={
              row.retryInFlight ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <ReplayIcon fontSize="small" />
              )
            }
          />
        ) : null}
        {row.palitra.conversionStatus === 'error' &&
        !row.palitra.goiSourceRefreshRetryAvailable &&
        !row.palitra.importedFromGoi &&
        !row.palitra.goiOwned ? (
          <MrtRowActionButton
            label="Повторити конвертацію"
            onClick={() => props.onRetryConversion(row.palitra)}
            disabled={mutationDisabled}
            icon={
              row.retryInFlight ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <ReplayIcon fontSize="small" />
              )
            }
          />
        ) : null}
        <MrtRowActionButton
          label="Видалити"
          onClick={() => props.onDelete(row.palitra)}
          disabled={mutationDisabled}
          icon={
            row.deleteInFlight ? (
              <CircularProgress size={16} color="inherit" />
            ) : (
              <DeleteIcon fontSize="small" />
            )
          }
          tone="danger"
          opensModal
        />
      </MrtRowActions>
    </Box>
  );
}

export function renderPalitraTableRowActions(props: Props) {
  if (props.row.kind === 'folder') {
    return renderFolderRowActions(props.row, props);
  }

  return renderPalitraRowActions(props.row, props);
}
