import CloseIcon from '@mui/icons-material/Close';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import { Badge, Box, Divider, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';
import type { MouseEvent } from 'react';
import { MRT_ColumnFiltersState, MRT_RowData, MRT_TableInstance } from 'material-react-table';
import { isPresent } from '../../../../../../../../utils/misc';


import { PowerButton } from '../../../../../../../PowerButton';
import { PowerIconButton } from '../../../../../../../PowerIconButton';
import { PowerMenu } from '../../../../../../../PowerMenu';
import { getActiveTableFilters, type ActiveFilterDescriptor } from './active-filters-utils';

type ActiveFiltersButtonProps<T extends MRT_RowData> = {
  table?: MRT_TableInstance<T> | null;
  columnFilters: MRT_ColumnFiltersState;
  globalFilter: unknown;
  additionalActiveFilters?: ActiveFilterDescriptor[];
  onClearAdditionalActiveFilter?: (filterId: string) => void;
  onClearAdditionalActiveFilters?: () => void;
  disabled?: boolean;
};

export function ActiveFiltersButton<T extends MRT_RowData>(props: ActiveFiltersButtonProps<T>) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const activeFilters = [
    ...getActiveTableFilters(props.table, props.columnFilters, props.globalFilter),
    ...(props.additionalActiveFilters ?? []),
  ];
  const hasActiveFilters = activeFilters.length > 0;
  const isDisabled = props.disabled || !props.table;

  function onOpen(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (isDisabled) {
      return;
    }

    setAnchorEl(event.currentTarget);
  }

  function onClose() {
    setAnchorEl(null);
  }

  function onClearFilter(filterId: string, isGlobalFilter: boolean) {
    if (!props.table) {
      return;
    }

    const additionalFilter = (props.additionalActiveFilters ?? []).find((filter) => filter.id === filterId);
    if (additionalFilter) {
      props.onClearAdditionalActiveFilter?.(filterId);
      return;
    }

    if (isGlobalFilter) {
      props.table.setGlobalFilter('');
    } else {
      props.table.setColumnFilters((currentFilters) => currentFilters.filter((filter) => filter.id !== filterId));
    }
  }

  function onClearAllFilters() {
    if (!props.table) {
      return;
    }

    props.table.setColumnFilters([]);
    props.table.setGlobalFilter('');
    props.onClearAdditionalActiveFilters?.();
    onClose();
  }

  return (
    <>
      <PowerMenu
        open={isPresent(anchorEl)}
        anchorEl={anchorEl}
        onClose={onClose}
        MenuListProps={{
          'aria-labelledby': 'active-filters-button',
        }}
      >
        <Box sx={{ p: 2, minWidth: 340, maxWidth: 480 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} sx={{ mb: 1.5 }}>
            <Typography variant="subtitle1" fontWeight={600}>
              Активні фільтри
            </Typography>
            <PowerButton
              size="small"
              onClick={onClearAllFilters}
              disabled={!hasActiveFilters || isDisabled}
              style={{ minHeight: 'unset', paddingTop: 0, paddingBottom: 0 }}
            >
              Очистити все
            </PowerButton>
          </Stack>
          <Divider sx={{ mb: 1.5 }} />
          {hasActiveFilters ? (
            <Stack spacing={1}>
              {activeFilters.map((filter) => (
                <Box
                  key={filter.id}
                  sx={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 1,
                    justifyContent: 'space-between',
                  }}
                >
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="body2" fontWeight={600} sx={{ wordBreak: 'break-word' }}>
                      {filter.label}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
                      {filter.valuePreview}
                    </Typography>
                  </Box>
                  <Tooltip title="Очистити фільтр">
                    <span>
                      <IconButton
                        size="small"
                        onClick={(event) => {
                          event.stopPropagation();
                          onClearFilter(filter.id, filter.isGlobalFilter);
                        }}
                        disabled={isDisabled}
                        aria-label={`Очистити фільтр ${filter.label}`}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Box>
              ))}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Немає активних фільтрів
            </Typography>
          )}
        </Box>
      </PowerMenu>
      <Tooltip title="Активні фільтри">
        <span>
          <Badge color="error" variant="dot" invisible={!hasActiveFilters} overlap="circular">
            <PowerIconButton id="active-filters-button" disabled={isDisabled} onClick={onOpen} size="small">
              <FilterAltIcon />
            </PowerIconButton>
          </Badge>
        </span>
      </Tooltip>
    </>
  );
}
