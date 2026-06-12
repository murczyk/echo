import DeleteIcon from '@mui/icons-material/Delete';
import ExpandLessOutlinedIcon from '@mui/icons-material/ExpandLessOutlined';
import ExpandMoreOutlinedIcon from '@mui/icons-material/ExpandMoreOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import FileCopyOutlinedIcon from '@mui/icons-material/FileCopyOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import {
  Box,
  Button,
  CircularProgress,
  MenuItem,
  Paper,
  Popper,
  Stack,
  Tooltip,
  useMediaQuery,
} from '@mui/material';
import type { MRT_ColumnDef } from 'material-react-table';
import { MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent, ReactNode } from 'react';

import type { NetworkFreq } from '../../../../Bindings';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { MrtRowActionButton, MrtRowActions, mrtRowActionsColumnSize } from '../../components/MrtRowActionButton';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerChip } from '../../components/PowerChip';
import { SectionLoadingOverlay } from '../../components/SectionLoadingOverlay';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { CompactPowerChip } from '../../components/CompactPowerChip';
import { InternalTableActions } from '../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { TableStateProvider, useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { GlobalFilterTextField } from '../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import {
  buildDefaultColumnOrder,
  getDefaultMRTOptions,
  getSharedFilterTextFieldProps,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  CUSTOM_STYLES,
  FULL_HEIGHT_LOADING_ROW_COUNT,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../components/mui-customized/table/custom-styles';
import { NetworkEditDrawer } from '../rer-network-details-neo/components/NetworkEditDrawer';
import { NetworkEtalonkaReportDialog } from '../rer-network-details-neo/components/NetworkEtalonkaReportDialog';
import { buildRerNetworkDetailsHref } from '../rer-network-details-neo/network-details-preference';
import { UnitStatsSidebar } from '../rer-callsigns-neo/components/UnitStatsSidebar';
import {
  NO_AOR_FILTER_VALUE,
  buildNetworkFrequencyDisplayGroups,
  buildNetworkLabel,
  buildNetworkFrequencyPopupGroups,
  getActivityBarHeight,
  resolveAorFilterSelectOptions,
  sanitizeNetworkColumnFilters,
  NETWORK_STATUS_ACTIVE_COLOR,
  NETWORK_STATUS_ARCHIVED_COLOR,
  NETWORK_STATUS_INACTIVE_COLOR,
  type NetworkRowView,
} from './helpers';
import { useRerNetworksNeoPage } from './use-rer-networks-neo-page';

const defaultMrtOptions = getDefaultMRTOptions<NetworkRowView>();
const columnOrder = buildDefaultColumnOrder({
  dataColumnIds: ['network', 'aors', 'freqs', 'location', 'activity', 'lastActivity'],
  withRowNumbers: true,
  withRowActions: true,
});
const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};
export const FREQUENCY_HOVER_POPPER_PLACEMENT = 'top-start';
export const FREQUENCY_HOVER_POPPER_MODIFIERS: Array<{ name: string; options?: Record<string, unknown> }> = [
  { name: 'offset', options: { offset: [0, 8] } },
  { name: 'flip', options: { fallbackPlacements: ['bottom-start', 'top-end', 'bottom-end'] } },
  { name: 'preventOverflow', options: { boundary: 'viewport', padding: 8 } },
];

const MAX_FREQUENCY_METADATA_LABEL_LENGTH = 16;

function buildDirectionFindingHref(networkId: number): string {
  const href = buildRerNetworkDetailsHref(networkId);
  return href.includes('?') ? `${href}&tab=direction-finding` : `${href}?tab=direction-finding`;
}

function ActivityBars({ bars }: { bars: Array<{ value: number; title: string }> }) {
  const maxValue = bars.reduce((max, bar) => Math.max(max, bar.value), 0);
  return (
    <Stack direction="row" spacing={0.35} alignItems="flex-end" sx={{ height: 36, overflow: 'hidden' }}>
      {bars.map((bar) => (
        <Tooltip key={bar.title} title={`${bar.title} - ${bar.value}`}>
          <Box
            sx={{
              width: 4,
              height: getActivityBarHeight(bar.value, maxValue),
              maxHeight: 34,
              borderRadius: 999,
              bgcolor: 'text.secondary',
              opacity: bar.value > 0 ? 1 : 0.3,
            }}
          />
        </Tooltip>
      ))}
    </Stack>
  );
}

function formatAorActiveFilterValue(value: unknown, aorOptions: Array<{ id: number; name: string }>): string {
  if (!Array.isArray(value)) {
    return 'Порожньо';
  }

  const labels = value
    .map((item) => {
      const raw = String(item).trim();
      if (raw === '') {
        return '';
      }

      if (raw === NO_AOR_FILTER_VALUE) {
        return '—';
      }

      const aorId = Number.parseInt(raw, 10);
      if (!Number.isFinite(aorId)) {
        return raw;
      }

      return aorOptions.find((aor) => aor.id === aorId)?.name ?? `#${aorId}`;
    })
    .filter((label) => label !== '');

  return labels.length === 0 ? 'Порожньо' : labels.join(', ');
}

function NetworkPageHeaderActions({
  reportsMenuAnchorEl,
  canExport,
  onCreate,
  onOpenReportsMenu,
  loading,
}: {
  reportsMenuAnchorEl: HTMLElement | null;
  canExport: boolean;
  onCreate: () => void;
  onOpenReportsMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  loading: boolean;
}) {
  return (
    <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Button variant="contained" disabled onClick={onCreate}>
        Створити мережу
      </Button>
      <Button
        startIcon={<FileCopyOutlinedIcon />}
        endIcon={reportsMenuAnchorEl ? <ExpandLessOutlinedIcon /> : <ExpandMoreOutlinedIcon />}
        variant="contained"
        onClick={onOpenReportsMenu}
        data-reports-menu-button="true"
        disabled={loading || !canExport}
      >
        Звіти
      </Button>
    </Stack>
  );
}

function StatusChipLabel({
  color,
  label,
  counter,
}: {
  color: string;
  label: string;
  counter: ReactNode;
}) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" useFlexGap sx={{ minWidth: 0 }}>
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, flexShrink: 0 }} />
      <Stack direction="row" spacing={0.5} alignItems="center" useFlexGap sx={{ minWidth: 0, whiteSpace: 'nowrap' }}>
        <Box component="span" sx={{ minWidth: 0 }}>
          {label}
        </Box>
        <Box component="span" sx={{ minWidth: 0, color: 'text.primary', fontWeight: 700 }}>
          {counter}
        </Box>
      </Stack>
    </Stack>
  );
}

function isShortFrequencyMetadataLabel(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_FREQUENCY_METADATA_LABEL_LENGTH &&
    !/[\r\n]/.test(trimmed) &&
    !/(?:^|[\s/._-])(key|hash|keyid|rx|tx)(?:$|[\s/._-])/i.test(trimmed)
  );
}

export function buildFrequencyMetadataLabels(freq: NetworkFreq): string[] {
  const labels: string[] = [];
  const pushLabel = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed || !isShortFrequencyMetadataLabel(trimmed) || labels.includes(trimmed)) {
      return;
    }
    labels.push(trimmed);
  };

  pushLabel(freq.kind);
  for (const encryptionKey of freq.encryptionKeys) {
    pushLabel(encryptionKey.description);
  }

  return labels;
}

function FrequencyMetadataChips({ labels }: { labels: string[] }) {
  if (labels.length === 0) {
    return null;
  }

  return (
    <Stack
      direction="row"
      spacing={0.5}
      useFlexGap
      sx={{
        flexWrap: 'nowrap',
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        justifyContent: 'flex-end',
      }}
    >
      {labels.map((label) => (
        <CompactPowerChip
          key={label}
          label={label}
          interactive={false}
          title={label}
          sx={{
            maxWidth: '100%',
            minWidth: 0,
            '& .MuiChip-label': {
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }}
        />
      ))}
    </Stack>
  );
}

function RowLabel({ text }: { text: string }) {
  return (
    <Box
      sx={{
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        fontWeight: 700,
        whiteSpace: 'nowrap',
        width: '100%',
      }}
      title={text}
    >
      {text}
    </Box>
  );
}

function FrequencyGroupDetails({
  group,
}: {
  group: ReturnType<typeof buildNetworkFrequencyPopupGroups>[number];
}) {
  if (group.frequencies.length === 0) {
    return null;
  }

  return (
    <Stack spacing={0.75}>
      <Box sx={{ fontSize: 12, fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {group.title} ({group.frequencies.length})
      </Box>
      <Stack spacing={0.75}>
        {group.frequencies.map((freq) => (
          <Stack key={freq.id} direction="row" spacing={1} alignItems="center" useFlexGap sx={{ minWidth: 0, flexWrap: 'nowrap' }}>
            <Box
              title={freq.freq}
              sx={{
                fontWeight: 700,
                color: group.isInactive ? 'text.secondary' : 'text.primary',
                minWidth: 0,
                flexShrink: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {freq.freq}
            </Box>
            <Box sx={{ ml: 'auto', minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}>
              <FrequencyMetadataChips labels={buildFrequencyMetadataLabels(freq)} />
            </Box>
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}

export function getLocationParts(location: string): string[] {
  return location.split(/[,\n]/).map((item) => item.trim()).filter((item) => item !== '');
}

function NetworkCell({ network }: { network: NetworkRowView }) {
  const href = `/rer-networks-neo/${network.id}`;
  const label = buildNetworkLabel(network.network, network.unitLabels, network.developing);

  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, flexWrap: 'nowrap' }}>
      <Tooltip title={network.statusLabel}>
        <Box
          sx={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            bgcolor: network.statusColor,
            flexShrink: 0,
          }}
        />
      </Tooltip>
      <Box
        component="a"
        href={href}
        title={label}
        aria-label={label}
        sx={{
          minWidth: 0,
          display: 'inline-flex',
          alignItems: 'center',
          color: 'primary.main',
          textDecoration: 'none',
          '&:hover': {
            textDecoration: 'none',
          },
        }}
      >
        <RowLabel text={label} />
      </Box>
    </Stack>
  );
}

function FrequencyCell({
  row,
  onPointerEnterAnchor,
  onPointerLeaveAnchor,
}: {
  row: NetworkRowView;
  onPointerEnterAnchor: (anchorEl: HTMLElement, row: NetworkRowView) => void;
  onPointerLeaveAnchor: () => void;
}) {
  const groups = buildNetworkFrequencyDisplayGroups(row);
  const totalFrequencies = row.activeFrequencies.length + row.inactiveFrequencies.length;

  return (
    <Stack
      direction="column"
      spacing={0.5}
      sx={{ minWidth: 0, cursor: 'default' }}
      data-network-hover-anchor={totalFrequencies > 0 ? 'true' : undefined}
      onPointerEnter={(event) => {
        if (totalFrequencies === 0) return;
        onPointerEnterAnchor(event.currentTarget, row);
      }}
      onPointerLeave={onPointerLeaveAnchor}
    >
      {groups.map((group) => {
        const visibleFrequencies = group.frequencies.slice(0, 2);

        return visibleFrequencies.length > 0 ? (
          <Stack key={group.title} direction="row" spacing={0.5} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', minWidth: 0 }}>
            {visibleFrequencies.map((freq) => (
              <Box
                key={freq.id}
                sx={{
                  fontWeight: 700,
                  color: group.isInactive ? 'text.secondary' : 'text.primary',
                }}
              >
                {freq.freq}
              </Box>
            ))}
            {group.hiddenCount > 0 ? <Box sx={{ color: 'text.secondary' }}>{`+${group.hiddenCount}`}</Box> : null}
          </Stack>
        ) : null;
      })}
    </Stack>
  );
}

function LocationCell({
  row,
  onPointerEnterAnchor,
  onPointerLeaveAnchor,
}: {
  row: NetworkRowView;
  onPointerEnterAnchor: (anchorEl: HTMLElement, row: NetworkRowView) => void;
  onPointerLeaveAnchor: () => void;
}) {
  const parts = getLocationParts(row.network.location);
  const hoverable = parts.length > 2;

  return (
    <Stack
      spacing={0.25}
      sx={{ cursor: 'default', minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}
      data-network-hover-anchor={hoverable ? 'true' : undefined}
      {...(hoverable
        ? {
            onPointerEnter: (event: PointerEvent<HTMLElement>) => onPointerEnterAnchor(event.currentTarget, row),
            onPointerLeave: onPointerLeaveAnchor,
          }
        : {})}
    >
      {parts.slice(0, 2).map((item, index) => (
        <Stack key={item} direction="row" spacing={0.75} alignItems="center" useFlexGap sx={{ minWidth: 0, maxWidth: '100%' }}>
          <Box
            title={item}
            sx={{
              display: 'block',
              minWidth: 0,
              maxWidth: '100%',
              fontWeight: 400,
              lineHeight: 1.2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item}
          </Box>
          {hoverable && index === 0 ? (
            <Box sx={{ color: 'text.secondary', flexShrink: 0, lineHeight: 1.2 }}>{`+${parts.length - 2}`}</Box>
          ) : null}
        </Stack>
      ))}
    </Stack>
  );
}

function NetworkRowActions({
  network,
  canEdit,
  canExport,
  canDelete,
  onOpenReportDialog,
  onOpenEditDialog,
  onOpenDeleteDialog,
}: {
  network: NetworkRowView;
  canEdit: boolean;
  canExport: boolean;
  canDelete: boolean;
  onOpenReportDialog: (network: NetworkRowView['network']) => void;
  onOpenEditDialog: (network: NetworkRowView['network']) => void;
  onOpenDeleteDialog: (network: NetworkRowView['network']) => void;
}) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center' }}>
      <MrtRowActions>
        <MrtRowActionButton
          label="Зведений звіт"
          onClick={() => onOpenReportDialog(network.network)}
          disabled={!canExport}
          icon={<DescriptionOutlinedIcon fontSize="small" />}
        />
        <MrtRowActionButton
          label="Пеленгація"
          onClick={() => window.open(buildDirectionFindingHref(network.id), '_blank', 'noreferrer')}
          icon={<MapOutlinedIcon fontSize="small" />}
        />
        <MrtRowActionButton
          label="Редагувати"
          onClick={() => onOpenEditDialog(network.network)}
          disabled={!canEdit}
          icon={<EditOutlinedIcon fontSize="small" />}
        />
        <MrtRowActionButton
          label="Видалити"
          onClick={() => onOpenDeleteDialog(network.network)}
          disabled={!canDelete}
          icon={<DeleteIcon fontSize="small" />}
          tone="danger"
        />
      </MrtRowActions>
    </Box>
  );
}

function HoverDetailsMenu({
  anchorEl,
  open,
  onClose,
  children,
  minWidth = 320,
  placement = 'bottom-start',
  modifiers,
  paperSx,
  onPointerEnter,
  onPointerLeave,
}: {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  minWidth?: number;
  placement?: 'bottom-start' | 'top-start' | 'bottom-end' | 'top-end';
  modifiers?: Array<{ name: string; options?: Record<string, unknown> }>;
  paperSx?: Record<string, unknown>;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  return (
    <Popper
      open={open}
      anchorEl={anchorEl}
      placement={placement}
      modifiers={modifiers ?? [{ name: 'offset', options: { offset: [0, 8] } }]}
      sx={{ zIndex: (theme) => theme.zIndex.modal + 1 }}
    >
      <Paper
        data-network-hover-popper="true"
        tabIndex={-1}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave ?? onClose}
        sx={{
          minWidth,
          p: 0,
          boxShadow: 8,
          maxWidth: 320,
          maxHeight: 'min(420px, calc(100vh - 32px))',
          overflowX: 'hidden',
          overflowY: 'auto',
          ...paperSx,
        }}
      >
        <Box sx={{ p: 1.5, maxWidth: '100%' }}>{children}</Box>
      </Paper>
    </Popper>
  );
}

type HoverPopoverState =
  | {
      kind: 'freq' | 'location';
      anchorEl: HTMLElement;
      row: NetworkRowView;
    }
  | null;

export function useHoverPopoverState() {
  const [hoverPopover, setHoverPopover] = useState<HoverPopoverState>(null);
  const hoverPopoverCloseTimeoutRef = useRef<number | null>(null);
  const hoverAnchorInsideRef = useRef(false);
  const hoverPopperInsideRef = useRef(false);

  const cancelHoverPopoverClose = useCallback(() => {
    if (hoverPopoverCloseTimeoutRef.current !== null) {
      window.clearTimeout(hoverPopoverCloseTimeoutRef.current);
      hoverPopoverCloseTimeoutRef.current = null;
    }
  }, []);

  const closeIfOutsideHoverZone = useCallback(() => {
    if (hoverAnchorInsideRef.current || hoverPopperInsideRef.current) {
      return;
    }
    setHoverPopover(null);
  }, []);

  const scheduleCloseHoverPopover = useCallback(() => {
    cancelHoverPopoverClose();
    hoverPopoverCloseTimeoutRef.current = window.setTimeout(() => {
      closeIfOutsideHoverZone();
      hoverPopoverCloseTimeoutRef.current = null;
    }, 80);
  }, [cancelHoverPopoverClose, closeIfOutsideHoverZone]);

  const openFreqPopover = useCallback((anchorEl: HTMLElement, row: NetworkRowView) => {
    cancelHoverPopoverClose();
    hoverAnchorInsideRef.current = true;
    setHoverPopover({ kind: 'freq', anchorEl, row });
  }, [cancelHoverPopoverClose]);

  const openLocationPopover = useCallback((anchorEl: HTMLElement, row: NetworkRowView) => {
    cancelHoverPopoverClose();
    hoverAnchorInsideRef.current = true;
    setHoverPopover({ kind: 'location', anchorEl, row });
  }, [cancelHoverPopoverClose]);

  const closeHoverPopover = useCallback(() => {
    cancelHoverPopoverClose();
    hoverAnchorInsideRef.current = false;
    hoverPopperInsideRef.current = false;
    setHoverPopover(null);
  }, [cancelHoverPopoverClose]);

  const onHoverAnchorPointerLeave = useCallback(() => {
    hoverAnchorInsideRef.current = false;
    scheduleCloseHoverPopover();
  }, [scheduleCloseHoverPopover]);

  const onHoverAnchorPointerEnter = useCallback(
    (anchorEl: HTMLElement, row: NetworkRowView) => {
      hoverAnchorInsideRef.current = true;
      openFreqPopover(anchorEl, row);
    },
    [openFreqPopover],
  );

  const onHoverLocationPointerEnter = useCallback(
    (anchorEl: HTMLElement, row: NetworkRowView) => {
      hoverAnchorInsideRef.current = true;
      openLocationPopover(anchorEl, row);
    },
    [openLocationPopover],
  );

  const onHoverPopperPointerEnter = useCallback(() => {
    hoverPopperInsideRef.current = true;
    cancelHoverPopoverClose();
  }, [cancelHoverPopoverClose]);

  const onHoverPopperPointerLeave = useCallback(() => {
    hoverPopperInsideRef.current = false;
    scheduleCloseHoverPopover();
  }, [scheduleCloseHoverPopover]);

  useEffect(() => {
    if (hoverPopover === null) return;

    const closeOnScroll = () => closeHoverPopover();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeHoverPopover();
      }
    };

    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('keydown', closeOnEscape);
    document.addEventListener('scroll', closeOnScroll, true);

    return () => {
      window.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [hoverPopover]);

  return {
    hoverPopover,
    cancelHoverPopoverClose,
    scheduleCloseHoverPopover,
    onHoverAnchorPointerEnter,
    onHoverLocationPointerEnter,
    onHoverAnchorPointerLeave,
    onHoverPopperPointerEnter,
    onHoverPopperPointerLeave,
    closeHoverPopover,
  };
}

function RerNetworksNeoPageBody({ authUserRoles = [] }: { authUserRoles?: string[] }) {
  const page = useRerNetworksNeoPage({ authUserRoles });
  const tableStateContext = useTableStateContext();
  const isDesktopLayout = useMediaQuery((theme) => theme.breakpoints.up('lg'));
  const aorFilterOptions = useMemo(() => resolveAorFilterSelectOptions(page.aorOptions), [page.aorOptions]);
  const aorOptions = page.aorOptions;
  const safeColumnFilters = useMemo(
    () => sanitizeNetworkColumnFilters(tableStateContext.columnFilters),
    [tableStateContext.columnFilters],
  );
  const {
    hoverPopover,
    onHoverAnchorPointerEnter,
    onHoverLocationPointerEnter,
    onHoverAnchorPointerLeave,
    onHoverPopperPointerEnter,
    onHoverPopperPointerLeave,
    closeHoverPopover,
  } = useHoverPopoverState();
  const onToggleReportsMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      page.setReportsMenuAnchorEl((current) => (current === event.currentTarget ? null : event.currentTarget));
    },
    [page.setReportsMenuAnchorEl],
  );

  useEffect(() => {
    closeHoverPopover();
  }, [closeHoverPopover, page.loading, page.loadingMore, page.refreshing, tableStateContext.columnFilters, tableStateContext.globalFilter, tableStateContext.sorting]);

  useEffect(() => {
    if (page.reportsMenuAnchorEl === null) return;

    const closeReportsMenu = (event: globalThis.MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest('[data-reports-menu="true"]') !== null ||
        target?.closest('[data-reports-menu-button="true"]') !== null
      ) {
        return;
      }

      page.setReportsMenuAnchorEl(null);
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        page.setReportsMenuAnchorEl(null);
      }
    };

    document.addEventListener('click', closeReportsMenu, true);
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      document.removeEventListener('click', closeReportsMenu, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [page.reportsMenuAnchorEl, page.setReportsMenuAnchorEl]);

  const columns = useMemo<Array<MRT_ColumnDef<NetworkRowView>>>(
    () => [
      {
        id: 'network',
        header: 'Мережа',
        accessorFn: (row) => row.network.name,
        enableColumnFilter: true,
        enableSorting: true,
        Cell: ({ row }) => <NetworkCell network={row.original} />,
      },
      {
        id: 'aors',
        header: 'Смуги',
        accessorFn: (row) => (row.network.aorIds.length === 0 ? [NO_AOR_FILTER_VALUE] : row.network.aorIds.map(String)),
        enableColumnFilter: true,
        enableSorting: true,
        meta: {
          activeFilterValueFormatter: (value: unknown) => formatAorActiveFilterValue(value, aorOptions),
        },
        Cell: ({ row }) => (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {row.original.aorLabels.length > 0 ? row.original.aorLabels.slice(0, 3).map((label) => <PowerChip key={label} label={label} interactive={false} />) : '—'}
            {row.original.aorLabels.length > 3 ? <Box sx={{ color: 'text.secondary' }}>{`+${row.original.aorLabels.length - 3}`}</Box> : null}
          </Stack>
        ),
        filterVariant: 'multi-select',
        filterSelectOptions: aorFilterOptions,
        filterFn: 'arrIncludesSome',
        muiFilterTextFieldProps: () => {
          const shared = getSharedFilterTextFieldProps('multi-select');
          const selectSlotProps = (shared.slotProps?.select ?? {}) as any;
          return {
            ...shared,
            slotProps: {
              ...shared.slotProps,
              select: {
                ...selectSlotProps,
                MenuProps: {
                  ...(selectSlotProps.MenuProps ?? {}),
                  PaperProps: {
                    ...(selectSlotProps.MenuProps?.PaperProps ?? {}),
                    sx: {
                      maxHeight: 320,
                      '& .MuiMenuItem-root': {
                        minHeight: 32,
                        py: 0.25,
                      },
                      '& .MuiCheckbox-root': {
                        p: 0.25,
                        mr: 0.5,
                        transform: 'scale(0.85)',
                      },
                    },
                  },
                },
              },
            },
          };
        },
      },
      {
        id: 'freqs',
        header: 'Частоти',
        accessorFn: (row) => row.activeFrequencies.map((freq) => freq.freq).join(' ') + row.inactiveFrequencies.map((freq) => freq.freq).join(' '),
        enableColumnFilter: true,
        enableSorting: true,
        Cell: ({ row }) => (
          <FrequencyCell
            row={row.original}
            onPointerEnterAnchor={onHoverAnchorPointerEnter}
            onPointerLeaveAnchor={onHoverAnchorPointerLeave}
          />
        ),
      },
      {
        id: 'location',
        header: 'Район',
        accessorFn: (row) => row.network.location,
        enableColumnFilter: true,
        enableSorting: true,
        Cell: ({ row }) => (
          <LocationCell
            row={row.original}
            onPointerEnterAnchor={onHoverLocationPointerEnter}
            onPointerLeaveAnchor={onHoverAnchorPointerLeave}
          />
        ),
      },
      {
        id: 'activity',
        header: 'Активність',
        accessorFn: (row) => row.activityBars.reduce((sum, item) => sum + item.value, 0),
        enableColumnFilter: false,
        enableSorting: true,
        Cell: ({ row }) => (
          <Box>
            {row.original.activityBars.some((bar) => bar.value > 0) ? <ActivityBars bars={row.original.activityBars} /> : <Box sx={{ color: 'text.secondary' }}>Не активна останні 10 днів</Box>}
          </Box>
        ),
      },
      {
        id: 'lastActivity',
        header: 'Остання активність',
        accessorFn: (row) => row.lastActivityLabel,
        enableColumnFilter: false,
        enableSorting: true,
        Cell: ({ row }) => (
          <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{row.original.lastActivityTooltip}</span>}>
            <Stack spacing={0.25} sx={{ cursor: 'default' }}>
              <Box sx={{ color: 'text.primary' }}>{row.original.lastActivityLabel}</Box>
              <Box sx={{ color: 'text.secondary' }}>{row.original.lastActivityDetail}</Box>
            </Stack>
          </Tooltip>
        ),
      },
    ],
    [aorFilterOptions, aorOptions, onHoverAnchorPointerEnter, onHoverAnchorPointerLeave, onHoverLocationPointerEnter],
  );
  const isInitialLoading = page.loading && page.rows.length === 0;
  const isEmptyResult = !isInitialLoading && page.rows.length === 0;
  const showLoadMore = !isInitialLoading && !page.noMoreToLoad;
  const showTableOverlay = !isInitialLoading && (page.loadingMore || page.refreshing);

  const table = useMaterialReactTable({
    ...defaultMrtOptions,
    data: page.rows,
    columns,
    enableColumnActions: true,
    enableGlobalFilter: true,
    enableColumnFilters: true,
    enableColumnFilterModes: false,
    columnFilterDisplayMode: 'popover',
    enableFacetedValues: false,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    enableSorting: true,
    manualFiltering: true,
    manualSorting: true,
    enableHiding: true,
    enableRowActions: true,
    positionActionsColumn: 'first',
    enableRowNumbers: true,
    initialState: {
      columnOrder,
      pagination: {
        pageIndex: 0,
        pageSize: FULL_HEIGHT_LOADING_ROW_COUNT,
      },
    },
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onSortingChange: tableStateContext.onSortingChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    renderRowActions: ({ row }) => (
      <NetworkRowActions
        network={row.original}
        canEdit={page.permissions.canEdit}
        canExport={page.permissions.canExport}
        canDelete={page.permissions.canDelete}
        onOpenReportDialog={page.openReportDialog}
        onOpenEditDialog={page.openEditDialog}
        onOpenDeleteDialog={page.openDeleteDialog}
      />
    ),
    defaultColumn: {
      size: 180,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-numbers': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-numbers'],
        enableResizing: false,
      },
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: mrtRowActionsColumnSize(4),
        enableResizing: false,
      },
    },
    muiTablePaperProps: ({ table }) => ({
      ...resolvedPaperProps({ table }),
      sx: {
        ...(resolvedPaperProps({ table }) as { sx?: object }).sx,
        ...FULL_WIDTH_TABLE_PAPER_SX,
        width: '100%',
        maxWidth: '100%',
        height: isInitialLoading || isEmptyResult ? '100%' : 'auto',
        minHeight: isInitialLoading || isEmptyResult ? '100%' : 0,
        minWidth: 0,
        overflow: table.getState().isFullScreen
          ? 'auto'
          : showTableOverlay || isEmptyResult
            ? 'hidden'
            : 'auto',
        border: 0,
        borderRadius: 0,
        boxShadow: 'none',
      },
      style: {
        ...((resolvedPaperProps({ table }) as { style?: object }).style ?? {}),
        padding: 0,
      },
    }),
    muiTableContainerProps: {
      sx: getPageScrollTableContainerSx({
        loading: showTableOverlay,
        height: '100%',
        minHeight: isInitialLoading || isEmptyResult ? '100%' : 0,
        maxHeight: 'none',
        idleOverflowX: 'auto',
        idleOverflowY: isEmptyResult ? 'hidden' : 'auto',
        idleOverflow: isEmptyResult ? 'hidden' : 'auto',
      }),
    },
    muiTableHeadCellProps: {
      sx: {
        ...CUSTOM_STYLES.muiTableHeadCellProps.sx,
        '& .Mui-TableHeadCell-ResizeHandle-Wrapper': {
          mr: '-8px',
        },
      },
    },
    muiTableBodyCellProps: {
      sx: {
        ...CUSTOM_STYLES.muiTableBodyCellProps.sx,
        verticalAlign: 'top',
      },
    },
    muiTableBodyProps: {
      sx: {
        ...CUSTOM_STYLES.muiTableBodyProps.sx,
        minHeight: isInitialLoading || isEmptyResult ? '100%' : 0,
      },
    },
    muiTableProps: {
      'aria-label': 'Мережі',
    },
    state: {
      isLoading: page.loading,
      showLoadingOverlay: false,
      showSkeletons: isInitialLoading,
      showProgressBars: false,
      globalFilter: tableStateContext.globalFilter,
      columnFilters: safeColumnFilters,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder ?? columnOrder,
      columnSizing: tableStateContext.columnSizing ?? {},
      columnVisibility: tableStateContext.columnVisibility ?? {},
    },
  });
  const onTableInitializedRef = useRef(tableStateContext.onTableInitialized);

  useEffect(() => {
    onTableInitializedRef.current = tableStateContext.onTableInitialized;
  }, [tableStateContext.onTableInitialized]);

  useEffect(() => {
    onTableInitializedRef.current(table);
  }, [table]);

  const additionalActiveFilters = useMemo(
    () => [
      ...(page.selectedSidebarUnitFilter
        ? [
            {
              id: 'page-unit',
              label: 'Підрозділ',
              value:
                page.selectedSidebarUnitFilter.kind === 'leaf'
                  ? page.selectedSidebarUnitFilter.unitName
                  : page.selectedSidebarUnitFilter.label,
              valuePreview:
                page.selectedSidebarUnitFilter.kind === 'leaf'
                  ? page.selectedSidebarUnitFilter.unitName
                  : page.selectedSidebarUnitFilter.label,
              isGlobalFilter: false,
            },
          ]
        : page.filters.unitText.trim()
          ? [
              {
                id: 'page-unit',
                label: 'Підрозділ',
                value: page.filters.unitText.trim(),
                valuePreview: page.filters.unitText.trim(),
                isGlobalFilter: false,
              },
            ]
          : []),
      ...(page.filters.status !== 'all'
        ? [
            {
              id: 'page-status',
              label: 'Статус',
              value: page.filters.status,
              valuePreview:
                page.filters.status === 'active'
                  ? 'Активні'
                  : page.filters.status === 'inactive'
                    ? 'Неактивні'
                    : 'Архівні',
              isGlobalFilter: false,
            },
          ]
        : []),
    ],
    [
      page.filters.status,
      page.filters.unitText,
      page.selectedSidebarUnitFilter,
    ],
  );

  return (
    <Box sx={{ minHeight: 0, height: '100%', overflow: isDesktopLayout ? 'hidden' : 'visible' }}>
      <Stack spacing={3} useFlexGap sx={{ minHeight: 0, height: '100%', overflow: isDesktopLayout ? 'hidden' : 'visible' }}>
        <TablePageToolbar
          title="Мережі"
          titleLeadingActions={
            !isDesktopLayout ? null : (
              <SidePanelToggleButton
                side="left"
                active={page.sidebarOpen}
                label={page.sidebarOpen ? 'Згорнути ліву панель' : 'Розгорнути ліву панель'}
                onClick={() => page.setSidebarOpen((prev: boolean) => !prev)}
              />
            )
          }
          titleLeadingGap={2}
          internalActionsHidden
          actions={
            <NetworkPageHeaderActions
              canExport={page.permissions.canExport}
              reportsMenuAnchorEl={page.reportsMenuAnchorEl}
              loading={page.downloadInFlight !== null}
              onCreate={() => {}}
              onOpenReportsMenu={onToggleReportsMenu}
            />
          }
        />

        {page.status ? <PowerAlert severity={page.status.kind}>{page.status.text}</PowerAlert> : null}

        <Stack
          direction={isDesktopLayout ? 'row' : 'column'}
          spacing={2}
          useFlexGap
          sx={{
            flex: 1,
            minHeight: 0,
            alignItems: 'stretch',
          }}
        >
          {isDesktopLayout ? (
            page.sidebarOpen ? (
              <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 0, flexShrink: 0, minHeight: 0 }}>
                <UnitStatsSidebar
                  stats={page.unitStatsView}
                  open={page.sidebarOpen}
                  isDesktopLayout={isDesktopLayout}
                  loading={page.refreshing || (page.loading && page.unitStatsView.length === 0)}
                  onPickUnitFilter={page.onPickUnitFilter}
                  onToggleInvestigating={page.onToggleInvestigating}
                  showInvestigatingFilter
                  isInvestigating={page.filters.showOnlyInvestigating}
                  selectedUnitFilter={page.selectedSidebarUnitFilter ?? undefined}
                />
              </Box>
            ) : null
          ) : (
            <UnitStatsSidebar
              stats={page.unitStatsView}
              open={page.sidebarOpen}
              isDesktopLayout={isDesktopLayout}
              loading={page.refreshing || (page.loading && page.unitStatsView.length === 0)}
              onPickUnitFilter={page.onPickUnitFilter}
              onToggleInvestigating={page.onToggleInvestigating}
              showInvestigatingFilter
              isInvestigating={page.filters.showOnlyInvestigating}
              onToggleOpen={() => page.setSidebarOpen((prev: boolean) => !prev)}
              selectedUnitFilter={page.selectedSidebarUnitFilter ?? undefined}
            />
          )}

          <Stack
            spacing={2}
            useFlexGap
            sx={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                minWidth: 0,
                flexWrap: 'wrap',
              }}
            >
              <GlobalFilterTextField
                globalFilter={tableStateContext.globalFilter}
                setGlobalFilter={tableStateContext.onChangeGlobalFilter}
                disabled={page.loading}
              />
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', minWidth: 0 }}>
                <PowerChip
                  selected={page.filters.status === 'all'}
                  onClick={() => page.setFilters((current) => ({ ...current, status: 'all' }))}
                  label="Всі"
                  interactive
                  fontWeight={700}
                />
                <PowerChip
                  selected={page.filters.status === 'active'}
                  onClick={() => page.setFilters((current) => ({ ...current, status: 'active' }))}
                  label={
                    <StatusChipLabel
                      color={NETWORK_STATUS_ACTIVE_COLOR}
                      label="Активні"
                      counter={page.statusCounts?.active ?? '—'}
                    />
                  }
                  interactive
                  fontWeight={700}
                />
                <PowerChip
                  selected={page.filters.status === 'inactive'}
                  onClick={() => page.setFilters((current) => ({ ...current, status: 'inactive' }))}
                  label={
                    <StatusChipLabel
                      color={NETWORK_STATUS_INACTIVE_COLOR}
                      label="Неактивні"
                      counter={page.statusCounts?.inactive ?? '—'}
                    />
                  }
                  interactive
                  fontWeight={700}
                />
                <PowerChip
                  selected={page.filters.status === 'deleted'}
                  onClick={() => page.setFilters((current) => ({ ...current, status: 'deleted' }))}
                  label={
                    <StatusChipLabel
                      color={NETWORK_STATUS_ARCHIVED_COLOR}
                      label="Архівні"
                      counter={page.statusCounts?.archived ?? '—'}
                    />
                  }
                  interactive
                  fontWeight={700}
                />
              </Stack>
              <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center' }}>
                <InternalTableActions
                  table={tableStateContext.tableInstance}
                  densityDisabled={page.loading}
                  columnsVisibilityDisabled={page.loading}
                  filtersDisabled={page.loading}
                  additionalActiveFilters={additionalActiveFilters}
                  onClearAdditionalActiveFilter={(filterId) => {
                    if (filterId === 'page-unit') {
                      page.onClearUnitFilter();
                    }
                    if (filterId === 'page-status') {
                      page.setFilters((current) => ({ ...current, status: 'all' }));
                    }
                  }}
                  onClearAdditionalActiveFilters={() => {
                    page.onClearUnitFilter();
                    page.setFilters((current) => ({ ...current, status: 'all' }));
                  }}
                  fullScreenEnabled={false}
                  fullScreenDisabled={page.loading}
                />
              </Box>
            </Box>

            <Box
              sx={{
                position: 'relative',
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                border: '1px solid',
                borderColor: 'var(--bs-border-color)',
                backgroundColor: 'var(--bs-body-bg)',
                overflow: 'hidden',
                '& .Mui-TableHeadCell-ResizeHandle-Wrapper': {
                  mr: '-8px',
                },
              }}
              onPointerMoveCapture={(event) => {
                const target = event.target as HTMLElement | null;
                if (!target) return;
                if (target.closest('[data-network-hover-anchor="true"], [data-network-hover-popper="true"]')) return;
                if (hoverPopover !== null) {
                  closeHoverPopover();
                }
              }}
            >
              <SectionLoadingOverlay
                open={showTableOverlay}
                ariaLabel={isInitialLoading ? 'Завантаження мереж' : 'Оновлення мереж'}
                showSpinner={!isInitialLoading}
              />
              <Box sx={{ position: 'relative', minHeight: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
                <MaterialReactTable table={table} />
                {showLoadMore ? (
                  <Box sx={{ borderTop: '1px solid', borderColor: 'var(--bs-border-color)', display: 'flex', justifyContent: 'center', p: '10px' }}>
                    <Button
                      variant="outlined"
                      onClick={() => void page.loadMoreNetworks()}
                      disabled={page.loadingMore || page.loading || page.refreshing}
                      startIcon={page.loadingMore ? <CircularProgress size={16} color="inherit" /> : null}
                    >
                      {page.loadingMore ? 'Завантаження...' : 'Завантажити ще'}
                    </Button>
                  </Box>
                ) : null}
              </Box>
            </Box>
          </Stack>
        </Stack>
      </Stack>

      <Popper
        open={page.reportsMenuAnchorEl !== null}
        anchorEl={page.reportsMenuAnchorEl}
        placement="bottom-end"
        modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]}
        sx={{ zIndex: (theme) => theme.zIndex.modal + 1 }}
      >
        <Paper data-reports-menu="true" sx={{ minWidth: 240, py: 1, boxShadow: 8 }}>
          <Stack spacing={0.5}>
            <MenuItem onClick={() => { page.setReportsMenuAnchorEl(null); page.openTopReportDialog(); }} disabled={page.downloadInFlight !== null || !page.permissions.canExport}>
              Зведений звіт
            </MenuItem>
            <MenuItem onClick={() => { page.setReportsMenuAnchorEl(null); void page.runDownload('goi'); }} disabled={page.downloadInFlight !== null || !page.permissions.canExport}>
              ГОІ
            </MenuItem>
            <MenuItem onClick={() => { page.setReportsMenuAnchorEl(null); page.setStatus({ kind: 'info', text: 'Експорт PDF ще не реалізовано.' }); }} disabled={page.downloadInFlight !== null || !page.permissions.canExport}>
              Експорт PDF
            </MenuItem>
            <MenuItem onClick={() => { page.setReportsMenuAnchorEl(null); page.setStatus({ kind: 'info', text: 'Експорт CSV ще не реалізовано.' }); }} disabled={page.downloadInFlight !== null || !page.permissions.canExport}>
              Експорт CSV
            </MenuItem>
          </Stack>
        </Paper>
      </Popper>

      {hoverPopover?.kind === 'freq' ? (
        <HoverDetailsMenu
          anchorEl={hoverPopover.anchorEl}
          open
          onClose={closeHoverPopover}
          minWidth={220}
          placement={FREQUENCY_HOVER_POPPER_PLACEMENT}
          modifiers={FREQUENCY_HOVER_POPPER_MODIFIERS}
          paperSx={{
            maxWidth: 320,
            maxHeight: 'min(420px, calc(100vh - 32px))',
            overflowX: 'hidden',
            overflowY: 'auto',
          }}
          onPointerEnter={onHoverPopperPointerEnter}
          onPointerLeave={onHoverPopperPointerLeave}
        >
          <Stack spacing={1.25}>
            {buildNetworkFrequencyPopupGroups(hoverPopover.row).map((group) => (
              <FrequencyGroupDetails key={group.title} group={group} />
            ))}
          </Stack>
        </HoverDetailsMenu>
      ) : null}

      {hoverPopover?.kind === 'location' ? (
        <HoverDetailsMenu
          anchorEl={hoverPopover.anchorEl}
          open
          onClose={closeHoverPopover}
          minWidth={260}
          placement={FREQUENCY_HOVER_POPPER_PLACEMENT}
          modifiers={FREQUENCY_HOVER_POPPER_MODIFIERS}
          paperSx={{
            maxWidth: 320,
            maxHeight: 'min(420px, calc(100vh - 32px))',
            overflowX: 'hidden',
            overflowY: 'auto',
          }}
          onPointerEnter={onHoverPopperPointerEnter}
          onPointerLeave={onHoverPopperPointerLeave}
        >
          <Stack spacing={0.75}>
            {getLocationParts(hoverPopover.row.network.location).map((item) => (
              <Box key={item} title={item} sx={{ lineHeight: 1.25 }}>
                {item}
              </Box>
            ))}
          </Stack>
        </HoverDetailsMenu>
      ) : null}

      <NetworkEtalonkaReportDialog
        report={page.etalonkaReport}
        onClose={page.closeReportDialog}
        onDownload={() => void page.downloadEtalonkaReport()}
        onTypeChange={(reportType) => page.setEtalonkaReport((current) => ({ ...current, reportType }))}
        onActiveFreqsOnlyChange={(activeFreqsOnly) => page.setEtalonkaReport((current) => ({ ...current, activeFreqsOnly }))}
        onIncludeSigintSignsChange={(includeSigintSigns) => page.setEtalonkaReport((current) => ({ ...current, includeSigintSigns }))}
        onIncludeConfirmationChange={(includeConfirmation) => page.setEtalonkaReport((current) => ({ ...current, includeConfirmation }))}
        onIncludeUnitCallsignsChange={(includeUnitCallsigns) => page.setEtalonkaReport((current) => ({ ...current, includeUnitCallsigns }))}
        onIncludePelengsMapChange={(includePelengsMap) => page.setEtalonkaReport((current) => ({ ...current, includePelengsMap }))}
        onFromDateTimeStrChange={(fromDateTimeStr) => page.setEtalonkaReport((current) => ({ ...current, fromDateTimeStr }))}
        onToDateTimeStrChange={(toDateTimeStr) => page.setEtalonkaReport((current) => ({ ...current, toDateTimeStr }))}
      />

      <NetworkEditDrawer
        open={page.editDialog !== null}
        form={page.editDialog}
        saving={page.editSubmitting}
        error={page.editError}
        referenceLoading={page.loading && page.unitOptions.length === 0 && page.postOptions.length === 0}
        aorOptions={page.aorOptions.map((aor) => ({ id: aor.id, label: aor.name }))}
        unitOptions={page.unitOptions}
        postOptions={page.postOptions}
        onClose={page.closeEditDialog}
        onChange={page.setEditDialog}
        onSave={() => void page.saveNetworkEdit()}
      />

      <ConfirmDangerDialog
        open={page.deleteDialogNetwork !== null}
        onClose={page.closeDeleteDialog}
        onConfirm={() => void page.confirmDeleteNetwork()}
        title="Видалити мережу"
        description={`Ви дійсно хочете видалити мережу «${page.deleteDialogNetwork?.name ?? ''}»?`}
        submitting={page.deleteSubmitting}
        disabled={page.deleteDialogNetwork === null}
      />
    </Box>
  );
}

export function RerNetworksNeoPage({ authUserRoles = [] }: { authUserRoles?: string[] } = {}) {
  return (
    <TableStateProvider
      tableId="rer-networks-neo"
      defaultColumnOrder={columnOrder}
      defaultColumnVisibility={{}}
      defaultEnableColumnOrdering={false}
      sanitizeColumnFilters={sanitizeNetworkColumnFilters}
    >
      <RerNetworksNeoPageBody authUserRoles={authUserRoles} />
    </TableStateProvider>
  );
}
