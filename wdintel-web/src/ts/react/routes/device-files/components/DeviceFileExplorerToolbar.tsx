import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import { Badge, Tooltip } from '@mui/material';

import { PowerIconButton } from '../../../components/PowerIconButton';
import type { DeviceFilesState } from '../use-device-files';
import { DeviceFileSortMenu } from './DeviceFileSortMenu';
import { DeviceFileSearchInput } from './DeviceFileSearchInput';

export function DeviceFileExplorerToolbar({ files }: { files: DeviceFilesState }) {
  if (files.selectedFile) return null;
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-echo-xs">
      <DeviceFileSearchInput files={files} />
      <Tooltip title="Фільтри файлів">
        <PowerIconButton
          size="small"
          aria-label="Фільтри файлів"
          aria-expanded={files.filtersOpen}
          aria-controls="device-file-explorer-filters"
          color={files.filtersOpen ? 'primary' : 'inherit'}
          onClick={() => files.setFiltersOpen(!files.filtersOpen)}
        >
          <Badge
            color="error"
            variant="dot"
            overlap="circular"
            invisible={
              !(
                files.listingFilters.fileTypes.length > 0 ||
                files.listingFilters.extensions.length > 0 ||
                files.listingFilters.modifiedFrom !== null ||
                files.listingFilters.modifiedTo !== null ||
                files.favoritesOnly ||
                files.unviewedOnly ||
                files.archiveFailed ||
                files.archiveEncrypted ||
                files.contentFilter !== true ||
                files.tagFilter.tagIds.length > 0 ||
                files.tagFilter.untagged
              )
            }
          >
            <FilterAltOutlinedIcon />
          </Badge>
        </PowerIconButton>
      </Tooltip>
      {!files.searchResultsVisible && <DeviceFileSortMenu files={files} />}
      {!files.searchResultsVisible && (
        <span aria-hidden className="mx-echo-xs h-echo-lg w-px shrink-0 bg-echo-border" />
      )}
      {!files.searchResultsVisible && (
        <DeviceFileViewMode viewMode={files.viewMode} onChange={files.setViewMode} />
      )}
    </div>
  );
}

export function DeviceFileViewMode({
  viewMode,
  onChange,
}: {
  viewMode: 'grid' | 'list';
  onChange: (mode: 'grid' | 'list') => void;
}) {
  return (
    <div role="group" aria-label="Вигляд файлів" className="flex shrink-0 items-center gap-echo-xs">
      <Tooltip title="Плитка">
        <PowerIconButton
          size="small"
          aria-label="Плитка"
          aria-pressed={viewMode === 'grid'}
          color={viewMode === 'grid' ? 'primary' : 'inherit'}
          onClick={() => onChange('grid')}
        >
          <GridViewOutlinedIcon fontSize="medium" />
        </PowerIconButton>
      </Tooltip>
      <Tooltip title="Список">
        <PowerIconButton
          size="small"
          aria-label="Список"
          aria-pressed={viewMode === 'list'}
          color={viewMode === 'list' ? 'primary' : 'inherit'}
          onClick={() => onChange('list')}
        >
          <ListAltOutlinedIcon fontSize="medium" />
        </PowerIconButton>
      </Tooltip>
    </div>
  );
}
