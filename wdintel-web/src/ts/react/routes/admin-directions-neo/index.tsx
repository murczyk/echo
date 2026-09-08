import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import UnarchiveOutlinedIcon from '@mui/icons-material/UnarchiveOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import {
  Autocomplete,
  Box,
  ButtonBase,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Tab,
  Switch,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  MRT_RowData,
  MRT_SortingState,
  MRT_ShowHideColumnsButton,
  MRT_TableInstance,
  MRT_ToggleDensePaddingButton,
  MaterialReactTable,
} from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  AreaOfResponsibility,
  Datasource,
  InterseptionKind,
  Login,
  Organism,
  OrphanSignalGroupEntry,
  SigintZone,
  SignalGroupLogin,
  SignalGroupEntry,
  SignalGroupStatsTimelinePoint,
  ZoneDatasourceGroup,
  ZoneDatasourceGroupAddReq,
  ZoneDatasourceGroupUpdateReq,
} from '../../../../Bindings';
import {
  MrtRowActionButton,
  MrtRowActions,
  mrtRowActionsColumnSize,
} from '../../components/MrtRowActionButton';
import { PageErrorState } from '../../components/PageErrorState';
import { SectionEmptyState } from '../../components/SectionEmptyState';
import { SectionLoadingOverlay } from '../../components/SectionLoadingOverlay';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { GlobalFilterTextField } from '../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { PowerButton } from '../../components/PowerButton';
import { EchoChip } from '../../components/EchoChip';
import {
  CUSTOM_STYLES,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  getDefaultMRTOptions,
  mrtCustomCell,
  mrtItemsCell,
  mrtTextCell,
  useAppMaterialReactTable,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import { MrtOverflowText } from '../../components/mui-customized/table/mrt-overflow';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import { listAors } from '../../services/api/aor';
import { listLogins } from '../../services/api/logins';
import { editGroup } from '../../services/api/messenger';
import { listOrganisms } from '../../services/api/organisms';
import { currentSystemSettings } from '../../services/api/system-settings';
import { ZoneGroupCell } from './ZoneGroupCell';
import { buildAccessItems, type ZoneGroupAccessItem } from './zone-group-access';
import {
  addZoneDatasourceGroup,
  archiveSignalGroup,
  deleteZoneDatasourceGroup,
  fetchSignalGroupInfoBatch,
  fetchSignalGroupStatsTimeline,
  listArchivedSignalGroups,
  listDatasources,
  listOrphanSignalGroups,
  listSigintZones,
  listZoneDatasourceGroups,
  listZoneDatasources,
  unarchiveSignalGroup,
  updateZoneDatasourceGroup,
} from '../../services/api/zones';
import { NO_DATA_LABEL, formatDate } from '../../utils/misc';
import {
  buildLoginOptions,
  preserveAiManagedLoginIds,
  selectedLoginIds,
} from '../../utils/login-options';
import { PowerAlert } from '../../components/PowerAlert';
import { DatasourceKindIcon } from '../../components/icons';
import { GroupStatsTimelineCell } from './GroupStatsTimelineCell';
import { GroupCardView, type GroupCardData } from './GroupCardView';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

const INTERSEPTION_KIND_TOOLTIP =
  'РЕР перехоплення відобувається шляхом прослуховування радіомере, і ідентифікуються за частотою на якій було здійснено перехоплення. Інше - для перехоплень які було отримані із інших джерел. Такі перехоплення ідентифікуються за маскою підрозділу, перевірте Оперативні Параметри мережі підрозділу для налаштувань маски';

function InfoFieldLabel({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
      {label}
      <Tooltip title={tooltip} arrow>
        <InfoOutlinedIcon color="action" fontSize="small" />
      </Tooltip>
    </Box>
  );
}

function InterseptionKindSelect({
  value,
  onChange,
}: {
  value: InterseptionKind;
  onChange: (value: InterseptionKind) => void;
}) {
  return (
    <TextField
      select
      fullWidth
      size="small"
      label={<InfoFieldLabel label="Категорія групи" tooltip={INTERSEPTION_KIND_TOOLTIP} />}
      value={value}
      onChange={(event) => onChange(event.target.value as InterseptionKind)}
    >
      <MenuItem value="rer">РЕР</MenuItem>
      <MenuItem value="other">Інше</MenuItem>
    </TextField>
  );
}

type DatasourceEntry = [number, Datasource];
type ZoneEntry = [number, SigintZone];
type OrganismById = Map<number, Organism>;
type ZoneGroupRow = {
  id: string;
  zoneId: number;
  datasourceId: number;
  group: ZoneDatasourceGroup;
};

type OrphanAssignState = {
  group: OrphanSignalGroupEntry;
  selectedZones: ZoneEntry[];
  isSecret: boolean;
  interseptionKind: InterseptionKind;
  disableNetworkAssignment: boolean;
  selectedUsers: string[];
  selectedOrganismIds: number[];
  selectedAdmins: string[];
  isSaving: boolean;
  error: string | null;
};

type GroupEditState = {
  zoneId: number;
  datasourceId: number;
  group: ZoneDatasourceGroup;
  groupName: string;
  isSecret: boolean;
  interseptionKind: InterseptionKind;
  disableNetworkAssignment: boolean;
  selectedUsers: string[];
  selectedUserDetails: SignalGroupLogin[];
  selectedOrganismIds: number[];
  selectedAdmins: string[];
  selectedAdminDetails: SignalGroupLogin[];
  shortNote: string;
  longNote: string;
  selectedAorIds: number[];
  isSaving: boolean;
  error: string | null;
};

type OrphanEditState = {
  group: OrphanSignalGroupEntry;
  groupName: string;
  interseptionKind: InterseptionKind;
  disableNetworkAssignment: boolean;
  shortNote: string;
  longNote: string;
  selectedAorIds: number[];
  isSaving: boolean;
  error: string | null;
};

type DeleteState = {
  zoneId: number;
  datasourceId: number;
  group: ZoneDatasourceGroup;
  groupName: string;
  isDeleting: boolean;
  error: string | null;
};

type ArchiveState = {
  masterKey: string;
  groupName: string;
  isSaving: boolean;
  error: string | null;
};

type UnarchiveState = ArchiveState;

function getSelectedGroupMasterKey() {
  return new URLSearchParams(window.location.search).get('group');
}

function updateSelectedGroupUrl(masterKey: string | null, replace = false) {
  const url = new URL(window.location.href);
  if (masterKey) url.searchParams.set('group', masterKey);
  else url.searchParams.delete('group');
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const method = replace ? 'replaceState' : 'pushState';
  window.history[method](window.history.state, '', nextUrl);
}

function buildGroupCardData(props: {
  masterKey: string;
  groupInfos: Map<string, SignalGroupEntry>;
  orphanGroups: OrphanSignalGroupEntry[];
  archivedGroups: OrphanSignalGroupEntry[];
  zoneGroups: Map<string, ZoneDatasourceGroup[]>;
  zones: ZoneEntry[];
  zoneDatasourceIds: Map<number, number[]>;
  datasourceById: Map<number, Datasource>;
}): GroupCardData | null {
  const orphan = [...props.orphanGroups, ...props.archivedGroups].find(
    (group) => group.masterKey === props.masterKey,
  );
  const info = props.groupInfos.get(props.masterKey);
  const matchingZoneGroups: Array<{
    zoneName: string;
    datasourceId: number;
    group: ZoneDatasourceGroup;
  }> = [];

  for (const [zoneId, zone] of props.zones) {
    for (const datasourceId of props.zoneDatasourceIds.get(zoneId) ?? []) {
      const groups = props.zoneGroups.get(buildGroupKey(zoneId, datasourceId)) ?? [];
      for (const group of groups) {
        if (group.groupMasterKey === props.masterKey) {
          matchingZoneGroups.push({ zoneName: zone.name, datasourceId, group });
        }
      }
    }
  }

  const firstZoneGroup = matchingZoneGroups[0]?.group;
  if (!orphan && !info && !firstZoneGroup) return null;
  const stats = orphan?.groupStats ??
    info?.groupStats ?? { activityLastDay: 0, activityLastWeek: 0 };
  const adminData = orphan?.groupAdminData ?? info?.adminData;
  const aors =
    orphan?.areasOfResponsibility ??
    info?.areasOfResponsibility ??
    firstZoneGroup?.areasOfResponsibility;
  const datasourceIds = new Set<number>();
  if (orphan?.datasourceId) datasourceIds.add(orphan.datasourceId);
  matchingZoneGroups.forEach(({ datasourceId }) => datasourceIds.add(datasourceId));

  return {
    masterKey: props.masterKey,
    name: getGroupName(props.masterKey, orphan?.name, props.groupInfos),
    datasourceLabels: Array.from(datasourceIds).map((id) =>
      getDatasourceLabel(id, props.datasourceById),
    ),
    directionLabels: Array.from(new Set(matchingZoneGroups.map(({ zoneName }) => zoneName))),
    activityLastDay: stats.activityLastDay,
    activityLastWeek: stats.activityLastWeek,
    aorLabels: (aors ?? []).map((aor) => aor.name),
    shortNote: adminData?.shortNote ?? firstZoneGroup?.shortNote ?? null,
    longNote: adminData?.longNote ?? firstZoneGroup?.longNote ?? null,
    interseptionKind:
      orphan?.interseptionKind ??
      info?.interseptionKind ??
      firstZoneGroup?.interseptionKind ??
      'rer',
    disableNetworkAssignment:
      orphan?.disableNetworkAssignment ??
      info?.disableNetworkAssignment ??
      firstZoneGroup?.disableNetworkAssignment ??
      false,
    isArchived: orphan?.isArchived ?? false,
  };
}

const DEFAULT_ORPHAN_COLUMNS_VISIBILITY = {
  group: true,
  datasource: true,
  activityDay: true,
  activityWeek: true,
  activityTimeline: false,
  aors: true,
  notes: true,
  createdAt: true,
};

const DEFAULT_ORPHAN_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'group',
  'datasource',
  'activityDay',
  'activityWeek',
  'activityTimeline',
  'aors',
  'notes',
  'createdAt',
];

const DEFAULT_ZONE_COLUMNS_VISIBILITY = {
  group: true,
  datasource: true,
  activityDay: true,
  activityWeek: true,
  activityTimeline: false,
  access: true,
  admins: true,
  aors: true,
  notes: true,
};

const DISABLE_NETWORK_ASSIGNMENT_TOOLTIP =
  'Корисно для глобальних груп що діють на дуже широкій смузі';

function DisableNetworkAssignmentLabel() {
  return (
    <Box
      component="span"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}
    >
      <Box component="span">Вимкнути привʼязку мереж</Box>
      <Tooltip title={DISABLE_NETWORK_ASSIGNMENT_TOOLTIP} placement="top">
        <Box
          component="span"
          sx={{ display: 'inline-flex', color: 'text.secondary', lineHeight: 0, cursor: 'default' }}
          aria-label="Підказка"
        >
          <InfoOutlinedIcon sx={{ fontSize: 16 }} />
        </Box>
      </Tooltip>
    </Box>
  );
}

const DEFAULT_ZONE_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'group',
  'datasource',
  'activityDay',
  'activityWeek',
  'activityTimeline',
  'access',
  'admins',
  'aors',
  'notes',
];

const DEFAULT_ACTIVITY_DAY_SORTING: MRT_SortingState = [{ id: 'activityDay', desc: true }];
const GROUP_ACTIVITY_TIMELINE_COLUMN_ID = 'activityTimeline';
const GROUP_ACTIVITY_PERIOD_HOURS = 24 * 90;
const GROUP_ACTIVITY_DEFAULT_WINDOW_HOURS = 24 * 7;
const EMPTY_AOR_FILTER_VALUE = NO_DATA_LABEL;
const EMPTY_AOR_FILTER_LABEL = NO_DATA_LABEL;

const orphanDefaultMRTOptions = getDefaultMRTOptions<OrphanSignalGroupEntry>();
const zoneDefaultMRTOptions = getDefaultMRTOptions<ZoneGroupRow>();
const ORPHAN_GLOBAL_FILTER_COLUMN_IDS = new Set([
  'group',
  'datasource',
  'aors',
  'notes',
  'createdAt',
]);
const ZONE_GLOBAL_FILTER_COLUMN_IDS = new Set([
  'group',
  'datasource',
  'access',
  'admins',
  'aors',
  'notes',
]);
const LOADING_SKELETON_ROW_COUNT = 16;

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

function formatOptionalText(value: string | null | undefined): string {
  if (!value || !value.trim()) return NO_DATA_LABEL;
  return value;
}

function buildTimelineMasterKeys(keys: (string | null | undefined)[]): string[] {
  return Array.from(new Set(keys.map((key) => key?.trim() ?? '').filter(Boolean))).sort();
}

function sumTimelinePoints(points: SignalGroupStatsTimelinePoint[] | undefined): number | null {
  if (!points || points.length === 0) return null;
  return points.reduce((sum, point) => sum + point.count, 0);
}

function useGroupStatsTimeline(masterKeys: string[], enabled: boolean) {
  const [status, setStatus] = useState<LoadingStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Map<string, SignalGroupStatsTimelinePoint[]>>(new Map());
  const requestKey = masterKeys.join('|');

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      setError(null);
      return;
    }

    if (masterKeys.length === 0) {
      setStatus('success');
      setError(null);
      setData(new Map());
      return;
    }

    const controller = new AbortController();
    setStatus('loading');
    setError(null);

    fetchSignalGroupStatsTimeline(
      { masterKeys, periodHours: GROUP_ACTIVITY_PERIOD_HOURS },
      controller.signal,
    )
      .then((rsp) => {
        setData(new Map(rsp.data.map((entry) => [entry.masterKey, entry.points])));
        setStatus('success');
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setStatus('error');
        setError(formatErrorMessage(err));
      });

    return () => controller.abort();
  }, [enabled, requestKey]);

  return { status, error, data };
}

function buildGroupKey(zoneId: number, datasourceId: number): string {
  return `${zoneId}:${datasourceId}`;
}

function getGroupName(
  groupKey: string,
  fallbackName: string | null | undefined,
  groupInfos: Map<string, SignalGroupEntry>,
) {
  const info = groupInfos.get(groupKey);
  if (info && info.name.trim()) return info.name;
  if (fallbackName && fallbackName.trim()) return fallbackName;
  return groupKey.slice(-5);
}

function getOrphanGroupName(group: OrphanSignalGroupEntry) {
  return group.name && group.name.trim() ? group.name : group.masterKey.slice(-5);
}

function getDatasourceLabel(datasourceId: number | null, datasourceById: Map<number, Datasource>) {
  if (datasourceId === null) return NO_DATA_LABEL;
  const datasource = datasourceById.get(datasourceId);
  return datasource?.displayName || `#${datasourceId}`;
}

function getDatasource(datasourceId: number | null, datasourceById: Map<number, Datasource>) {
  if (datasourceId === null) return null;
  return datasourceById.get(datasourceId) ?? null;
}

function getOrganismLabel(organismId: number, organismById: OrganismById) {
  const organism = organismById.get(organismId);
  return organism?.name || `#${organismId}`;
}

function buildAccessLabel(
  users: string[] | null | undefined,
  userDetails: SignalGroupLogin[] | null | undefined,
  organismIds: number[] | null | undefined,
  organismById: OrganismById,
  loginById: Map<string, Login>,
) {
  const parts: string[] = [];
  if (users && users.length > 0) {
    parts.push(formatZoneGroupLoginIds(users, userDetails ?? [], loginById));
  }

  const organismLabels = (organismIds ?? []).map((id) => getOrganismLabel(id, organismById));
  if (organismLabels.length > 0) parts.push(`Організми: ${organismLabels.join(', ')}`);

  return parts.length > 0 ? parts.join('; ') : 'без обмежень';
}

function formatZoneGroupLoginIds(
  loginIds: string[],
  details: SignalGroupLogin[],
  loginById: Map<string, Login>,
) {
  const detailsById = new Map(details.map((detail) => [detail.loginId, detail]));
  return loginIds
    .map((id) => detailsById.get(id)?.login ?? loginById.get(id)?.login ?? id)
    .join(', ');
}

function selectedOrganisms(selectedIds: number[], options: Organism[]) {
  return selectedIds
    .map((id) => options.find((organism) => organism.id === id))
    .filter(Boolean) as Organism[];
}

function LoginAutocomplete(props: {
  label: string;
  options: Login[];
  selectedIds: string[];
  selectedDetails: SignalGroupLogin[];
  onChange: (loginIds: string[]) => void;
}) {
  const options = props.options.map(({ id, login }) => ({ id, login }));
  const optionsById = new Map(options.map((option) => [option.id, option]));
  const detailsById = new Map(props.selectedDetails.map((detail) => [detail.loginId, detail]));
  const selectedOptions = props.selectedIds.map((id) => {
    const detail = detailsById.get(id);
    if (detail) {
      return {
        id: detail.loginId,
        login: detail.login,
        isAiManaged: detail.isAiManaged,
      };
    }
    return optionsById.get(id) ?? { id, login: id, isAiManaged: false };
  });

  return (
    <Autocomplete<{ id: string; login: string; isAiManaged?: boolean }, true>
      multiple
      options={options}
      value={selectedOptions}
      onChange={(_, value) =>
        props.onChange(
          preserveAiManagedLoginIds(
            props.selectedIds,
            selectedLoginIds(value),
            props.selectedDetails,
          ),
        )
      }
      getOptionLabel={(option) => option.login}
      isOptionEqualToValue={(option, value) => option.id === value.id}
      renderOption={(optionProps, option) => {
        const { key: _unusedKey, ...restOptionProps } = optionProps;
        return (
          <Box component="li" {...restOptionProps} key={option.id}>
            {option.login}
          </Box>
        );
      }}
      renderTags={(value, getTagProps) =>
        value.map((option, index) => {
          const tagProps = getTagProps({ index });
          return (
            <Chip
              {...tagProps}
              key={option.id}
              label={option.login}
              onDelete={option.isAiManaged ? undefined : tagProps.onDelete}
              title={option.isAiManaged ? 'Керується AI control plane' : undefined}
              size="small"
            />
          );
        })
      }
      renderInput={(params) => <TextField {...params} label={props.label} />}
    />
  );
}

function renderDatasourceCell(
  datasourceId: number | null,
  datasourceById: Map<number, Datasource>,
) {
  const datasource = getDatasource(datasourceId, datasourceById);
  if (!datasource)
    return (
      <MrtOverflowText
        displayValue={NO_DATA_LABEL}
        fullValue={NO_DATA_LABEL}
        sx={{ minWidth: 0, width: '100%', maxWidth: '100%' }}
      />
    );

  const label = datasource.displayName || `#${datasourceId}`;
  const hasIcon = ['signal', 'whatsapp', 'echo_operator'].includes(datasource.kind.toLowerCase());

  if (!hasIcon)
    return (
      <MrtOverflowText
        displayValue={label}
        fullValue={label}
        sx={{ minWidth: 0, width: '100%', maxWidth: '100%' }}
      />
    );

  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        minWidth: 0,
        width: '100%',
        maxWidth: '100%',
      }}
    >
      <DatasourceKindIcon kind={datasource.kind} fontSize="small" sx={{ flexShrink: 0 }} />
      <MrtOverflowText
        displayValue={label}
        fullValue={label}
        sx={{ minWidth: 0, flex: '1 1 auto' }}
      />
    </Box>
  );
}

function buildAorLabels(aors: AreaOfResponsibility[] | null | undefined): string {
  if (!aors || aors.length === 0) return NO_DATA_LABEL;
  return aors.map((aor) => aor.name).join(', ');
}

function buildAorNames(aors: AreaOfResponsibility[] | null | undefined): string[] {
  if (!aors || aors.length === 0) return [];
  return aors.map((aor) => aor.name);
}

function buildAorFilterNames(aors: AreaOfResponsibility[] | null | undefined): string[] {
  const names = buildAorNames(aors);
  return names.length > 0 ? names : [EMPTY_AOR_FILTER_VALUE];
}

function buildAorFilterOptions(aors: AreaOfResponsibility[]): { text: string; value: string }[] {
  const uniqueNames = Array.from(new Set(aors.map((aor) => aor.name)));
  return [
    { text: EMPTY_AOR_FILTER_LABEL, value: EMPTY_AOR_FILTER_VALUE },
    ...uniqueNames.map((name) => ({ text: name, value: name })),
  ];
}

function buildOrphanLoadingRows(): OrphanSignalGroupEntry[] {
  return Array.from({ length: LOADING_SKELETON_ROW_COUNT }, (_, index) => ({
    masterKey: `loading-orphan-${index}`,
    name: '',
    datasourceId: null,
    ignoreOperativny: false,
    interseptionKind: 'rer',
    disableNetworkAssignment: false,
    isArchived: false,
    groupStats: {
      activityLastDay: 0,
      activityLastWeek: 0,
    },
    groupAdminData: null,
    areasOfResponsibility: null,
    createdAt: 0,
  }));
}

function buildZoneLoadingRows(): ZoneGroupRow[] {
  return Array.from({ length: LOADING_SKELETON_ROW_COUNT }, (_, index) => ({
    id: `loading-zone-${index}`,
    zoneId: 0,
    datasourceId: 0,
    group: {
      sigintZoneDatasourceId: index,
      groupMasterKey: '',
      isGroupSecret: false,
      interseptionKind: 'rer',
      disableNetworkAssignment: false,
      allowedUsers: [],
      allowedUserDetails: [],
      allowedOrganismIds: [],
      adminLogins: [],
      adminLoginDetails: [],
      areasOfResponsibility: null,
      shortNote: null,
      longNote: null,
    },
  }));
}

function TableTabControls<TData extends MRT_RowData>(props: {
  globalFilter: string;
  onGlobalFilterChange: (value: string) => void;
  table: MRT_TableInstance<TData>;
  disabled?: boolean;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        pb: 2,
        flexShrink: 0,
      }}
    >
      <Box sx={{ width: { xs: '100%', sm: 360 }, maxWidth: '100%' }}>
        <GlobalFilterTextField
          className="!min-w-0 !w-full"
          globalFilter={props.globalFilter}
          setGlobalFilter={props.onGlobalFilterChange}
          disabled={props.disabled}
        />
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          flexShrink: 0,
          pointerEvents: props.disabled ? 'none' : undefined,
          opacity: props.disabled ? 0.5 : undefined,
        }}
        aria-disabled={props.disabled ? 'true' : undefined}
      >
        <MRT_ShowHideColumnsButton table={props.table} />
        <MRT_ToggleDensePaddingButton table={props.table} />
      </Box>
    </Box>
  );
}

function OrphanGroupsTable(props: {
  data: OrphanSignalGroupEntry[];
  loading?: boolean;
  datasourceById: Map<number, Datasource>;
  aorFilterOptions: { text: string; value: string }[];
  onAssign?: (group: OrphanSignalGroupEntry) => void;
  onEdit?: (group: OrphanSignalGroupEntry) => void;
  onArchive?: (group: OrphanSignalGroupEntry) => void;
  onUnarchive?: (group: OrphanSignalGroupEntry) => void;
  onView?: (group: OrphanSignalGroupEntry) => void;
}) {
  const tableStateContext = useTableStateContext();
  const isLoading = Boolean(props.loading);
  const isActivityTimelineVisible =
    tableStateContext.columnVisibility[GROUP_ACTIVITY_TIMELINE_COLUMN_ID] === true;
  const timelineMasterKeys = useMemo(
    () => buildTimelineMasterKeys(props.data.map((group) => group.masterKey)),
    [props.data],
  );
  const timeline = useGroupStatsTimeline(
    timelineMasterKeys,
    isActivityTimelineVisible && !isLoading,
  );

  const columns = useMemo<AppMrtColumnDef<OrphanSignalGroupEntry>[]>(
    () => [
      {
        header: 'Група',
        id: 'group',
        accessorFn: (row) => {
          if (!row?.masterKey) return NO_DATA_LABEL;
          return row.name && row.name.trim() ? row.name : row.masterKey.slice(-5);
        },
        meta: { overflowMode: 'custom', overflowOwner: 'shared-text' },
        Cell: mrtCustomCell(({ row }) => {
          if (isLoading || !row.original?.masterKey) return <span>{NO_DATA_LABEL}</span>;
          const name = getOrphanGroupName(row.original);
          return (
            <MrtOverflowText
              displayValue={name}
              fullValue={name}
              interactive
              component={ButtonBase}
              componentProps={{ onClick: () => props.onView?.(row.original) }}
              sx={{ color: 'inherit', textAlign: 'left', justifyContent: 'flex-start' }}
            />
          );
        }),
        size: 220,
      },
      {
        header: 'Джерело',
        id: 'datasource',
        accessorFn: (row) => getDatasourceLabel(row?.datasourceId ?? null, props.datasourceById),
        meta: { overflowMode: 'custom', overflowOwner: 'shared-text' },
        Cell: mrtCustomCell(({ row }) =>
          renderDatasourceCell(row.original?.datasourceId ?? null, props.datasourceById),
        ),
        size: 180,
      },
      {
        header: 'Активність (день)',
        id: 'activityDay',
        accessorFn: (row) => row?.groupStats?.activityLastDay ?? null,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => row.original?.groupStats?.activityLastDay ?? NO_DATA_LABEL,
          fullValue: ({ row }) =>
            String(row.original?.groupStats?.activityLastDay ?? NO_DATA_LABEL),
        }),
        size: 140,
      },
      {
        header: 'Активність (тиждень)',
        id: 'activityWeek',
        accessorFn: (row) => row?.groupStats?.activityLastWeek ?? null,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => row.original?.groupStats?.activityLastWeek ?? NO_DATA_LABEL,
          fullValue: ({ row }) =>
            String(row.original?.groupStats?.activityLastWeek ?? NO_DATA_LABEL),
        }),
        size: 140,
      },
      {
        header: 'Активність (час)',
        id: GROUP_ACTIVITY_TIMELINE_COLUMN_ID,
        accessorFn: (row) => sumTimelinePoints(timeline.data.get(row?.masterKey ?? '')),
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => {
          if (isLoading || !row.original?.masterKey) {
            return <span>{NO_DATA_LABEL}</span>;
          }
          return (
            <GroupStatsTimelineCell
              points={timeline.data.get(row.original.masterKey) ?? []}
              status={timeline.status}
              error={timeline.error}
              periodHours={GROUP_ACTIVITY_PERIOD_HOURS}
              defaultWindowHours={GROUP_ACTIVITY_DEFAULT_WINDOW_HOURS}
            />
          );
        },
        enableColumnFilter: false,
        size: 260,
      },
      {
        header: 'Смуги',
        id: 'aors',
        accessorFn: (row) => buildAorFilterNames(row?.areasOfResponsibility),
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<OrphanSignalGroupEntry, string>({
          items: ({ row }) => buildAorNames(row.original?.areasOfResponsibility),
          renderItem: (name) => <EchoChip label={name} tone="neutral" />,
          measurementScope: 'admin-directions:orphan-aors',
          getItemKey: (name) => name,
          getItemText: (name) => name,
          emptyValue: NO_DATA_LABEL,
        }),
        filterVariant: 'multi-select',
        filterSelectOptions: props.aorFilterOptions,
        filterFn: 'arrIncludesSome',
        size: 240,
      },
      {
        header: 'Нотатки',
        id: 'notes',
        accessorFn: (row) => {
          const shortNote = row?.groupAdminData?.shortNote ?? '';
          const longNote = row?.groupAdminData?.longNote ?? '';
          return `${shortNote}${longNote ? ` / ${longNote}` : ''}`.trim() || NO_DATA_LABEL;
        },
        meta: { overflowMode: 'wrap' },
        Cell: ({ row }) => {
          const shortNote = formatOptionalText(row.original?.groupAdminData?.shortNote ?? null);
          const longNote = formatOptionalText(row.original?.groupAdminData?.longNote ?? null);
          if (shortNote === NO_DATA_LABEL && longNote === NO_DATA_LABEL)
            return <span>{NO_DATA_LABEL}</span>;
          return (
            <div className="flex flex-col">
              {shortNote !== NO_DATA_LABEL ? <span>{shortNote}</span> : null}
              {longNote !== NO_DATA_LABEL ? (
                <span className="text-muted-foreground text-xs">{longNote}</span>
              ) : null}
            </div>
          );
        },
        size: 260,
      },
      {
        header: 'Створено',
        id: 'createdAt',
        accessorFn: (row) => row?.createdAt ?? null,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) =>
            row.original?.createdAt ? formatDate(row.original.createdAt) : NO_DATA_LABEL,
          fullValue: ({ row }) =>
            row.original?.createdAt ? formatDate(row.original.createdAt) : NO_DATA_LABEL,
        }),
        size: 140,
      },
    ],
    [
      isLoading,
      props.datasourceById,
      props.aorFilterOptions,
      timeline.data,
      timeline.status,
      timeline.error,
    ],
  );

  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps =
    typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

  const state = {
    showAlertBanner: false,
    showLoadingOverlay: false,
    showSkeletons: Boolean(props.loading),
    globalFilter: tableStateContext.globalFilter,
    columnVisibility: tableStateContext.columnVisibility,
    columnFilters: tableStateContext.columnFilters,
    density: tableStateContext.density,
    sorting: tableStateContext.sorting,
    columnOrder: tableStateContext.columnOrder,
    columnSizing: { ...tableStateContext.columnSizing, 'mrt-row-actions': 76 },
  };
  const rowActionCount =
    (props.onAssign ? 1 : 0) +
    (props.onEdit ? 1 : 0) +
    (props.onArchive ? 1 : 0) +
    (props.onUnarchive ? 1 : 0);

  const table = useAppMaterialReactTable({
    columns,
    data: isLoading ? buildOrphanLoadingRows() : props.data,
    enableSorting: true,
    enableColumnActions: true,
    enableGlobalFilter: true,
    enableHiding: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowVirtualization: false,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    columnFilterDisplayMode: 'popover',
    globalFilterFn: 'contains',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onSortingChange: tableStateContext.onSortingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    onDensityChange: tableStateContext.setDensity,
    getColumnCanGlobalFilter: (column) => ORPHAN_GLOBAL_FILTER_COLUMN_IDS.has(column.id),
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) =>
      isLoading || !row.original?.masterKey ? null : (
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          {props.onEdit ? (
            <MrtRowActionButton
              label="Редагувати"
              onClick={() => props.onEdit?.(row.original)}
              icon={<EditIcon fontSize="small" />}
              opensModal
            />
          ) : null}
          <MrtRowActions forceMenu>
            {props.onView ? (
              <MrtRowActionButton
                label="Переглянути"
                onClick={() => props.onView?.(row.original)}
                icon={<VisibilityOutlinedIcon fontSize="small" />}
              />
            ) : null}
            {props.onAssign ? (
              <MrtRowActionButton
                label="Додати до напрямку"
                onClick={() => props.onAssign?.(row.original)}
                icon={<AddCircleOutlineIcon fontSize="small" />}
                opensModal
              />
            ) : null}
            {props.onArchive ? (
              <MrtRowActionButton
                label="Архівувати"
                onClick={() => props.onArchive?.(row.original)}
                icon={<ArchiveOutlinedIcon fontSize="small" />}
                tone="warning"
                opensModal
              />
            ) : null}
            {props.onUnarchive ? (
              <MrtRowActionButton
                label="Розархівувати"
                onClick={() => props.onUnarchive?.(row.original)}
                icon={<UnarchiveOutlinedIcon fontSize="small" />}
                tone="warning"
                opensModal
              />
            ) : null}
          </MrtRowActions>
        </Box>
      ),
    defaultColumn: {
      size: 200,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: 76,
        minSize: 76,
        maxSize: 76,
        enableResizing: false,
      },
    },
    muiTablePaperProps: ({ table }) => {
      const baseProps = resolvedPaperProps({ table });
      return {
        ...baseProps,
        sx: {
          ...(baseProps as any)?.sx,
          ...FULL_WIDTH_TABLE_PAPER_SX,
          height: isLoading ? '100%' : 'auto',
          minHeight: isLoading ? '100%' : undefined,
          maxHeight: '100%',
        },
      };
    },
    muiTableContainerProps: {
      sx: {
        ...(CUSTOM_STYLES.muiTableContainerProps as any)?.sx,
        ...getPageScrollTableContainerSx({
          loading: isLoading,
          height: isLoading ? '100%' : 'auto',
          minHeight: isLoading ? '100%' : undefined,
          maxHeight: '100%',
          idleOverflow: 'auto',
        }),
      },
    },
    state,
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return (
    <Box
      sx={{
        display: 'flex',
        width: '100%',
        flex: isLoading ? 1 : undefined,
        minHeight: 0,
        minWidth: 0,
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <TableTabControls
        globalFilter={tableStateContext.globalFilter}
        onGlobalFilterChange={(value) => tableStateContext.onChangeGlobalFilter(value)}
        table={table}
        disabled={isLoading}
      />
      <Box
        sx={{
          width: '100%',
          minHeight: 0,
          minWidth: 0,
          overflow: 'hidden',
          maxHeight: '100%',
          flex: isLoading ? 1 : undefined,
          position: 'relative',
          cursor: isLoading ? 'progress' : undefined,
        }}
      >
        {isLoading ? (
          <SectionLoadingOverlay
            open
            ariaLabel="Завантаження таблиці напрямків"
            showSpinner={false}
            sx={{ zIndex: 12 }}
          />
        ) : null}
        <MaterialReactTable table={table} />
      </Box>
    </Box>
  );
}

function ZoneGroupsTable(props: {
  rows: ZoneGroupRow[];
  loading?: boolean;
  datasourceById: Map<number, Datasource>;
  organismById: OrganismById;
  loginById: Map<string, Login>;
  groupInfos: Map<string, SignalGroupEntry>;
  aorFilterOptions: { text: string; value: string }[];
  onEdit: (zoneId: number, datasourceId: number, group: ZoneDatasourceGroup) => void;
  onDelete: (zoneId: number, datasourceId: number, group: ZoneDatasourceGroup) => void;
  onArchive: (zoneId: number, datasourceId: number, group: ZoneDatasourceGroup) => void;
  onView: (masterKey: string) => void;
}) {
  const tableStateContext = useTableStateContext();
  const isLoading = Boolean(props.loading);
  const isActivityTimelineVisible =
    tableStateContext.columnVisibility[GROUP_ACTIVITY_TIMELINE_COLUMN_ID] === true;
  const timelineMasterKeys = useMemo(
    () => buildTimelineMasterKeys(props.rows.map((row) => row.group.groupMasterKey)),
    [props.rows],
  );
  const timeline = useGroupStatsTimeline(
    timelineMasterKeys,
    isActivityTimelineVisible && !isLoading,
  );

  const columns = useMemo<AppMrtColumnDef<ZoneGroupRow>[]>(
    () => [
      {
        header: 'Група',
        id: 'group',
        accessorFn: (row) =>
          row?.group?.groupMasterKey
            ? getGroupName(row.group.groupMasterKey, null, props.groupInfos)
            : NO_DATA_LABEL,
        meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
        Cell: mrtCustomCell(({ row }) => {
          if (isLoading || !row.original?.group?.groupMasterKey)
            return <span>{NO_DATA_LABEL}</span>;
          const groupName = getGroupName(row.original.group.groupMasterKey, null, props.groupInfos);
          return (
            <ZoneGroupCell
              name={groupName}
              isSecret={row.original.group.isGroupSecret}
              onView={() => props.onView(row.original.group.groupMasterKey)}
            />
          );
        }),
        size: 240,
      },
      {
        header: 'Джерело',
        id: 'datasource',
        accessorFn: (row) => getDatasourceLabel(row?.datasourceId ?? null, props.datasourceById),
        meta: { overflowMode: 'custom', overflowOwner: 'shared-text' },
        Cell: mrtCustomCell(({ row }) =>
          renderDatasourceCell(row.original?.datasourceId ?? null, props.datasourceById),
        ),
        size: 200,
      },
      {
        header: 'Активність (день)',
        id: 'activityDay',
        accessorFn: (row) => {
          const stats = row?.group?.groupMasterKey
            ? props.groupInfos.get(row.group.groupMasterKey)?.groupStats
            : null;
          return stats ? stats.activityLastDay : null;
        },
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => {
            const stats = row.original?.group?.groupMasterKey
              ? props.groupInfos.get(row.original.group.groupMasterKey)?.groupStats
              : null;
            return stats?.activityLastDay ?? NO_DATA_LABEL;
          },
          fullValue: ({ row }) => {
            const stats = row.original?.group?.groupMasterKey
              ? props.groupInfos.get(row.original.group.groupMasterKey)?.groupStats
              : null;
            return String(stats?.activityLastDay ?? NO_DATA_LABEL);
          },
        }),
        size: 140,
      },
      {
        header: 'Активність (тиждень)',
        id: 'activityWeek',
        accessorFn: (row) => {
          const stats = row?.group?.groupMasterKey
            ? props.groupInfos.get(row.group.groupMasterKey)?.groupStats
            : null;
          return stats ? stats.activityLastWeek : null;
        },
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => {
            const stats = row.original?.group?.groupMasterKey
              ? props.groupInfos.get(row.original.group.groupMasterKey)?.groupStats
              : null;
            return stats?.activityLastWeek ?? NO_DATA_LABEL;
          },
          fullValue: ({ row }) => {
            const stats = row.original?.group?.groupMasterKey
              ? props.groupInfos.get(row.original.group.groupMasterKey)?.groupStats
              : null;
            return String(stats?.activityLastWeek ?? NO_DATA_LABEL);
          },
        }),
        size: 140,
      },
      {
        header: 'Активність (час)',
        id: GROUP_ACTIVITY_TIMELINE_COLUMN_ID,
        accessorFn: (row) => sumTimelinePoints(timeline.data.get(row?.group?.groupMasterKey ?? '')),
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => {
          const masterKey = row.original?.group?.groupMasterKey;
          if (isLoading || !masterKey) {
            return <span>{NO_DATA_LABEL}</span>;
          }
          return (
            <GroupStatsTimelineCell
              points={timeline.data.get(masterKey) ?? []}
              status={timeline.status}
              error={timeline.error}
              periodHours={GROUP_ACTIVITY_PERIOD_HOURS}
              defaultWindowHours={GROUP_ACTIVITY_DEFAULT_WINDOW_HOURS}
            />
          );
        },
        enableColumnFilter: false,
        size: 260,
      },
      {
        header: 'Доступ',
        id: 'access',
        accessorFn: (row) =>
          buildAccessLabel(
            row?.group?.allowedUsers,
            row?.group?.allowedUserDetails,
            row?.group?.allowedOrganismIds,
            props.organismById,
            props.loginById,
          ),
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<ZoneGroupRow, ZoneGroupAccessItem>({
          items: ({ row }) => {
            const items = buildAccessItems(
              row.original?.group?.allowedUsers,
              row.original?.group?.allowedUserDetails,
              row.original?.group?.allowedOrganismIds,
              props.organismById,
              props.loginById,
            );
            return items;
          },
          renderItem: (item) => <EchoChip label={item.label} tone="neutral" />,
          measurementScope: 'admin-directions:access',
          getItemKey: (item) => `${item.kind}:${item.id}`,
          getItemText: (item) => item.label,
          emptyValue: 'без обмежень',
        }),
        size: 220,
      },
      {
        header: 'Адміни',
        id: 'admins',
        accessorFn: (row) =>
          row?.group?.adminLogins?.length > 0
            ? [
                formatZoneGroupLoginIds(
                  row.group.adminLogins,
                  row.group.adminLoginDetails,
                  props.loginById,
                ),
              ]
            : [NO_DATA_LABEL],
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<ZoneGroupRow, string>({
          items: ({ row }) => {
            const loginIds = row.original?.group?.adminLogins ?? [];
            const detailsById = new Map<string, SignalGroupLogin>(
              (row.original?.group?.adminLoginDetails ?? []).map((detail) => [
                detail.loginId,
                detail,
              ]),
            );
            return loginIds.length > 0
              ? loginIds.map(
                  (id) => detailsById.get(id)?.login ?? props.loginById.get(id)?.login ?? id,
                )
              : [];
          },
          renderItem: (label) => <EchoChip label={label} tone="neutral" />,
          measurementScope: 'admin-directions:admins',
          getItemKey: (label) => label,
          getItemText: (label) => label,
          emptyValue: NO_DATA_LABEL,
        }),
        size: 220,
      },
      {
        header: 'Смуги',
        id: 'aors',
        accessorFn: (row) => buildAorFilterNames(row?.group?.areasOfResponsibility),
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<ZoneGroupRow, string>({
          items: ({ row }) => buildAorNames(row.original?.group?.areasOfResponsibility),
          renderItem: (name) => <EchoChip label={name} tone="neutral" />,
          measurementScope: 'admin-directions:aors',
          getItemKey: (name) => name,
          getItemText: (name) => name,
          emptyValue: NO_DATA_LABEL,
        }),
        filterVariant: 'multi-select',
        filterSelectOptions: props.aorFilterOptions,
        filterFn: 'arrIncludesSome',
        size: 240,
      },
      {
        header: 'Нотатки',
        id: 'notes',
        accessorFn: (row) => {
          const shortNote = formatOptionalText(row?.group?.shortNote ?? null);
          const longNote = formatOptionalText(row?.group?.longNote ?? null);
          if (shortNote === NO_DATA_LABEL && longNote === NO_DATA_LABEL) return NO_DATA_LABEL;
          if (shortNote === NO_DATA_LABEL) return longNote;
          if (longNote === NO_DATA_LABEL) return shortNote;
          return `${shortNote} / ${longNote}`;
        },
        meta: { overflowMode: 'wrap' },
        Cell: ({ row }) => {
          const shortNote = formatOptionalText(row.original?.group?.shortNote ?? null);
          const longNote = formatOptionalText(row.original?.group?.longNote ?? null);
          if (shortNote === NO_DATA_LABEL && longNote === NO_DATA_LABEL)
            return <span>{NO_DATA_LABEL}</span>;
          const tooltipLabel =
            shortNote === NO_DATA_LABEL
              ? longNote
              : longNote === NO_DATA_LABEL
                ? shortNote
                : `${shortNote} / ${longNote}`;
          return (
            <Tooltip title={tooltipLabel}>
              <div className="flex flex-col">
                {shortNote !== NO_DATA_LABEL ? <span>{shortNote}</span> : null}
                {longNote !== NO_DATA_LABEL ? (
                  <span className="text-muted-foreground text-xs">{longNote}</span>
                ) : null}
              </div>
            </Tooltip>
          );
        },
        size: 260,
      },
    ],
    [
      isLoading,
      props.datasourceById,
      props.organismById,
      props.loginById,
      props.groupInfos,
      props.aorFilterOptions,
      timeline.data,
      timeline.status,
      timeline.error,
    ],
  );

  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps =
    typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

  const state = {
    showAlertBanner: false,
    showLoadingOverlay: false,
    showSkeletons: Boolean(props.loading),
    globalFilter: tableStateContext.globalFilter,
    columnVisibility: tableStateContext.columnVisibility,
    columnFilters: tableStateContext.columnFilters,
    density: tableStateContext.density,
    sorting: tableStateContext.sorting,
    columnOrder: tableStateContext.columnOrder,
    columnSizing: { ...tableStateContext.columnSizing, 'mrt-row-actions': 76 },
  };

  const table = useAppMaterialReactTable({
    columns,
    data: isLoading ? buildZoneLoadingRows() : props.rows,
    enableSorting: true,
    enableColumnActions: true,
    enableGlobalFilter: true,
    enableHiding: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowVirtualization: false,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    columnFilterDisplayMode: 'popover',
    globalFilterFn: 'contains',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onSortingChange: tableStateContext.onSortingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    onDensityChange: tableStateContext.setDensity,
    getColumnCanGlobalFilter: (column) => ZONE_GLOBAL_FILTER_COLUMN_IDS.has(column.id),
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) =>
      isLoading || !row.original?.group ? null : (
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <MrtRowActionButton
            label="Редагувати"
            onClick={() =>
              props.onEdit(row.original.zoneId, row.original.datasourceId, row.original.group)
            }
            icon={<EditIcon fontSize="small" />}
            opensModal
          />
          <MrtRowActions forceMenu>
            <MrtRowActionButton
              label="Переглянути"
              onClick={() => props.onView(row.original.group.groupMasterKey)}
              icon={<VisibilityOutlinedIcon fontSize="small" />}
            />
            <MrtRowActionButton
              label="Архівувати"
              onClick={() =>
                props.onArchive(row.original.zoneId, row.original.datasourceId, row.original.group)
              }
              icon={<ArchiveOutlinedIcon fontSize="small" />}
              tone="warning"
              opensModal
            />
            <MrtRowActionButton
              label="Видалити"
              onClick={() =>
                props.onDelete(row.original.zoneId, row.original.datasourceId, row.original.group)
              }
              icon={<DeleteIcon fontSize="small" />}
              tone="danger"
              opensModal
            />
          </MrtRowActions>
        </Box>
      ),
    defaultColumn: {
      size: 200,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: 76,
        minSize: 76,
        maxSize: 76,
        enableResizing: false,
      },
    },
    muiTablePaperProps: ({ table }) => {
      const baseProps = resolvedPaperProps({ table });
      return {
        ...baseProps,
        sx: {
          ...(baseProps as any)?.sx,
          ...FULL_WIDTH_TABLE_PAPER_SX,
          height: isLoading ? '100%' : 'auto',
          minHeight: isLoading ? '100%' : undefined,
          maxHeight: '100%',
        },
      };
    },
    muiTableContainerProps: {
      sx: {
        ...(CUSTOM_STYLES.muiTableContainerProps as any)?.sx,
        ...getPageScrollTableContainerSx({
          loading: isLoading,
          height: isLoading ? '100%' : 'auto',
          minHeight: isLoading ? '100%' : undefined,
          maxHeight: '100%',
          idleOverflow: 'auto',
        }),
      },
    },
    state,
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return (
    <Box
      sx={{
        display: 'flex',
        width: '100%',
        flex: isLoading ? 1 : undefined,
        minHeight: 0,
        minWidth: 0,
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <TableTabControls
        globalFilter={tableStateContext.globalFilter}
        onGlobalFilterChange={(value) => tableStateContext.onChangeGlobalFilter(value)}
        table={table}
        disabled={isLoading}
      />
      <Box
        sx={{
          width: '100%',
          minHeight: 0,
          minWidth: 0,
          overflow: 'hidden',
          maxHeight: '100%',
          flex: isLoading ? 1 : undefined,
          position: 'relative',
          cursor: isLoading ? 'progress' : undefined,
        }}
      >
        {isLoading ? (
          <SectionLoadingOverlay
            open
            ariaLabel="Завантаження таблиці напрямків"
            showSpinner={false}
            sx={{ zIndex: 12 }}
          />
        ) : null}
        <MaterialReactTable table={table} />
      </Box>
    </Box>
  );
}

function OrphanGroupsSection(props: {
  tableId?: string;
  data: OrphanSignalGroupEntry[];
  loading?: boolean;
  datasourceById: Map<number, Datasource>;
  aorFilterOptions: { text: string; value: string }[];
  onAssign?: (group: OrphanSignalGroupEntry) => void;
  onEdit?: (group: OrphanSignalGroupEntry) => void;
  onArchive?: (group: OrphanSignalGroupEntry) => void;
  onUnarchive?: (group: OrphanSignalGroupEntry) => void;
  onView?: (group: OrphanSignalGroupEntry) => void;
}) {
  return (
    <TableStateProvider
      tableId={props.tableId ?? 'admin-orphan-groups'}
      defaultColumnOrder={DEFAULT_ORPHAN_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_ORPHAN_COLUMNS_VISIBILITY}
      defaultSorting={DEFAULT_ACTIVITY_DAY_SORTING}
      defaultEnableColumnOrdering={false}
    >
      <div className="flex min-h-0 w-full min-w-0 max-h-full overflow-hidden">
        <OrphanGroupsTable
          data={props.data}
          loading={props.loading}
          datasourceById={props.datasourceById}
          aorFilterOptions={props.aorFilterOptions}
          onAssign={props.onAssign}
          onEdit={props.onEdit}
          onArchive={props.onArchive}
          onUnarchive={props.onUnarchive}
          onView={props.onView}
        />
      </div>
    </TableStateProvider>
  );
}

function ZoneGroupsSection(props: {
  zoneId: number;
  rows: ZoneGroupRow[];
  loading?: boolean;
  datasourceById: Map<number, Datasource>;
  organismById: OrganismById;
  loginById: Map<string, Login>;
  groupInfos: Map<string, SignalGroupEntry>;
  aorFilterOptions: { text: string; value: string }[];
  onEdit: (zoneId: number, datasourceId: number, group: ZoneDatasourceGroup) => void;
  onDelete: (zoneId: number, datasourceId: number, group: ZoneDatasourceGroup) => void;
  onArchive: (zoneId: number, datasourceId: number, group: ZoneDatasourceGroup) => void;
  onView: (masterKey: string) => void;
}) {
  return (
    <TableStateProvider
      tableId={`admin-zone-${props.zoneId}`}
      defaultColumnOrder={DEFAULT_ZONE_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_ZONE_COLUMNS_VISIBILITY}
      defaultSorting={DEFAULT_ACTIVITY_DAY_SORTING}
      defaultEnableColumnOrdering={false}
    >
      <div className="flex min-h-0 w-full min-w-0 max-h-full overflow-hidden">
        <ZoneGroupsTable
          rows={props.rows}
          loading={props.loading}
          datasourceById={props.datasourceById}
          organismById={props.organismById}
          loginById={props.loginById}
          groupInfos={props.groupInfos}
          aorFilterOptions={props.aorFilterOptions}
          onEdit={props.onEdit}
          onDelete={props.onDelete}
          onArchive={props.onArchive}
          onView={props.onView}
        />
      </div>
    </TableStateProvider>
  );
}

type DirectionsTab =
  | {
      key: 'orphans';
      label: string;
      content: ReactNode;
    }
  | {
      key: 'archive';
      label: string;
      content: ReactNode;
    }
  | {
      key: `zone-${number}`;
      label: string;
      content: ReactNode;
    };

function AdminDirectionsNeoPageBody() {
  const [status, setStatus] = useState<LoadingStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [datasources, setDatasources] = useState<DatasourceEntry[]>([]);
  const [zones, setZones] = useState<ZoneEntry[]>([]);
  const [zoneDatasourceIds, setZoneDatasourceIds] = useState<Map<number, number[]>>(new Map());
  const [zoneGroups, setZoneGroups] = useState<Map<string, ZoneDatasourceGroup[]>>(new Map());
  const [groupInfos, setGroupInfos] = useState<Map<string, SignalGroupEntry>>(new Map());
  const [orphanGroups, setOrphanGroups] = useState<OrphanSignalGroupEntry[]>([]);
  const [archivedGroups, setArchivedGroups] = useState<OrphanSignalGroupEntry[]>([]);
  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);
  const [organisms, setOrganisms] = useState<Organism[]>([]);

  const [editDialog, setEditDialog] = useState<GroupEditState | null>(null);
  const [orphanEditDialog, setOrphanEditDialog] = useState<OrphanEditState | null>(null);
  const [assignDialog, setAssignDialog] = useState<OrphanAssignState | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteState | null>(null);
  const [archiveDialog, setArchiveDialog] = useState<ArchiveState | null>(null);
  const [unarchiveDialog, setUnarchiveDialog] = useState<UnarchiveState | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const [selectedGroupMasterKey, setSelectedGroupMasterKey] = useState(getSelectedGroupMasterKey);

  const [logins, setLogins] = useState<Login[]>([]);
  const [supportNonRerInterceptions, setSupportNonRerInterceptions] = useState(false);

  const datasourceById = useMemo(() => new Map(datasources), [datasources]);
  const organismById = useMemo(
    () => new Map(organisms.map((organism) => [organism.id, organism])),
    [organisms],
  );
  const loginById = useMemo(() => new Map(logins.map((login) => [login.id, login])), [logins]);
  const activeOrganismOptions = useMemo(
    () => organisms.filter((organism) => organism.enabled),
    [organisms],
  );
  const aorOptions = useMemo(() => aors, [aors]);
  const aorFilterOptions = useMemo(() => buildAorFilterOptions(aors), [aors]);
  const selectedGroup = useMemo(
    () =>
      selectedGroupMasterKey
        ? buildGroupCardData({
            masterKey: selectedGroupMasterKey,
            groupInfos,
            orphanGroups,
            archivedGroups,
            zoneGroups,
            zones,
            zoneDatasourceIds,
            datasourceById,
          })
        : null,
    [
      archivedGroups,
      datasourceById,
      groupInfos,
      orphanGroups,
      selectedGroupMasterKey,
      zoneDatasourceIds,
      zoneGroups,
      zones,
    ],
  );
  const directionTabs = useMemo<DirectionsTab[]>(() => {
    if (status === 'loading' || status === 'idle') {
      return [
        {
          key: 'orphans',
          label: 'Орфан групи',
          content: (
            <OrphanGroupsSection
              data={[]}
              loading
              datasourceById={datasourceById}
              aorFilterOptions={aorFilterOptions}
              onAssign={openAssignDialog}
              onEdit={openOrphanEditDialog}
              onView={(group) => openGroupCard(group.masterKey)}
            />
          ),
        },
        {
          key: 'archive',
          label: '🗑️ АРХІВ',
          content: (
            <OrphanGroupsSection
              tableId="admin-archived-groups"
              data={[]}
              loading
              datasourceById={datasourceById}
              aorFilterOptions={aorFilterOptions}
              onEdit={openOrphanEditDialog}
              onUnarchive={openUnarchiveDialog}
              onView={(group) => openGroupCard(group.masterKey)}
            />
          ),
        },
      ];
    }

    const tabs: DirectionsTab[] = [
      {
        key: 'orphans',
        label: 'Орфан групи',
        content:
          orphanGroups.length === 0 ? (
            <SectionEmptyState message="Орфан групи відсутні" />
          ) : (
            <OrphanGroupsSection
              data={orphanGroups}
              datasourceById={datasourceById}
              aorFilterOptions={aorFilterOptions}
              onAssign={openAssignDialog}
              onEdit={openOrphanEditDialog}
              onArchive={openArchiveOrphanDialog}
              onView={(group) => openGroupCard(group.masterKey)}
            />
          ),
      },
    ];

    zones.forEach((zoneEntry) => {
      const [zoneId, zone] = zoneEntry;
      const datasourceIds = zoneDatasourceIds.get(zoneId) ?? [];

      const zoneRows = datasourceIds.flatMap((datasourceId) => {
        const key = buildGroupKey(zoneId, datasourceId);
        const groups = zoneGroups.get(key) ?? [];
        return groups.map((group) => ({
          id: `${zoneId}-${datasourceId}-${group.sigintZoneDatasourceId}`,
          zoneId,
          datasourceId,
          group,
        }));
      });

      const filteredRows = zoneRows.sort((a, b) => {
        const nameA = getGroupName(a.group.groupMasterKey, null, groupInfos);
        const nameB = getGroupName(b.group.groupMasterKey, null, groupInfos);
        if (nameA !== nameB) return nameA.localeCompare(nameB, 'uk-UA');
        const datasourceA = getDatasourceLabel(a.datasourceId, datasourceById);
        const datasourceB = getDatasourceLabel(b.datasourceId, datasourceById);
        return datasourceA.localeCompare(datasourceB, 'uk-UA');
      });

      tabs.push({
        key: `zone-${zoneId}`,
        label: `Напрямок: ${zone.name}`,
        content:
          datasourceIds.length === 0 ? (
            <SectionEmptyState message="Немає джерел даних" />
          ) : filteredRows.length === 0 ? (
            <SectionEmptyState message="Немає груп для цього напрямку" />
          ) : (
            <ZoneGroupsSection
              zoneId={zoneId}
              rows={filteredRows}
              datasourceById={datasourceById}
              organismById={organismById}
              loginById={loginById}
              groupInfos={groupInfos}
              aorFilterOptions={aorFilterOptions}
              onEdit={openEditDialog}
              onDelete={openDeleteDialog}
              onArchive={openArchiveZoneDialog}
              onView={openGroupCard}
            />
          ),
      });
    });

    tabs.push({
      key: 'archive',
      label: '🗑️ АРХІВ',
      content:
        archivedGroups.length === 0 ? (
          <SectionEmptyState message="Архівні групи відсутні" />
        ) : (
          <OrphanGroupsSection
            tableId="admin-archived-groups"
            data={archivedGroups}
            datasourceById={datasourceById}
            aorFilterOptions={aorFilterOptions}
            onEdit={openOrphanEditDialog}
            onUnarchive={openUnarchiveDialog}
            onView={(group) => openGroupCard(group.masterKey)}
          />
        ),
    });

    return tabs;
  }, [
    status,
    aorFilterOptions,
    archivedGroups,
    datasourceById,
    groupInfos,
    loginById,
    organismById,
    orphanGroups,
    zoneDatasourceIds,
    zoneGroups,
    zones,
  ]);

  useEffect(() => {
    setActiveTab((current) => Math.min(current, Math.max(directionTabs.length - 1, 0)));
  }, [directionTabs.length]);

  useEffect(() => {
    function handlePopState() {
      setSelectedGroupMasterKey(getSelectedGroupMasterKey());
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  function openGroupCard(masterKey: string) {
    updateSelectedGroupUrl(masterKey);
    setSelectedGroupMasterKey(masterKey);
  }

  function closeGroupCard() {
    updateSelectedGroupUrl(null, true);
    setSelectedGroupMasterKey(null);
  }

  async function loadData() {
    setStatus('loading');
    setError(null);
    try {
      const [
        datasourceList,
        zoneList,
        orphanList,
        archivedList,
        aorList,
        organismList,
        settings,
        loginList,
      ] = await Promise.all([
        listDatasources(),
        listSigintZones(),
        listOrphanSignalGroups(),
        listArchivedSignalGroups(),
        listAors({ sortBy: null }),
        listOrganisms({ sortBy: null }),
        currentSystemSettings(),
        listLogins({ sortBy: null, filterByRoles: null }),
      ]);

      setDatasources(datasourceList);
      setZones(zoneList);
      setOrphanGroups(orphanList);
      setArchivedGroups(archivedList);
      setAors(aorList);
      setOrganisms(organismList);
      setLogins(buildLoginOptions(loginList.users));
      setSupportNonRerInterceptions(settings.supportNonRerInterceptions);

      const zoneDatasourceEntries = await Promise.all(
        zoneList.map(async ([zoneId]) => [zoneId, await listZoneDatasources(zoneId)] as const),
      );

      const zoneDatasourceMap = new Map<number, number[]>();
      zoneDatasourceEntries.forEach(([zoneId, datasourceIds]) => {
        zoneDatasourceMap.set(zoneId, datasourceIds || []);
      });
      setZoneDatasourceIds(zoneDatasourceMap);

      const groupEntries = await Promise.all(
        zoneDatasourceEntries.flatMap(([zoneId, datasourceIds]) =>
          datasourceIds.map(async (datasourceId) => ({
            zoneId,
            datasourceId,
            groups: await listZoneDatasourceGroups({ zoneId, datasourceId }),
          })),
        ),
      );

      const groupMap = new Map<string, ZoneDatasourceGroup[]>();
      const groupKeys = new Set<string>();
      groupEntries.forEach(({ zoneId, datasourceId, groups }) => {
        groupMap.set(buildGroupKey(zoneId, datasourceId), groups);
        groups.forEach((group) => groupKeys.add(group.groupMasterKey));
      });

      const infoList = await fetchSignalGroupInfoBatch(Array.from(groupKeys));
      const infoMap = new Map(infoList.map((info) => [info.masterKey, info]));

      orphanList.forEach((group) => {
        if (!infoMap.has(group.masterKey)) {
          infoMap.set(group.masterKey, {
            masterKey: group.masterKey,
            name: group.name,
            ignoreOperativny: group.ignoreOperativny,
            interseptionKind: group.interseptionKind,
            disableNetworkAssignment: group.disableNetworkAssignment,
            groupStats: group.groupStats,
            adminData: group.groupAdminData,
            areasOfResponsibility: group.areasOfResponsibility,
          });
        }
      });

      setZoneGroups(groupMap);
      setGroupInfos(infoMap);

      setStatus('success');
    } catch (err) {
      setStatus('error');
      setError(formatErrorMessage(err));
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  function openEditDialog(zoneId: number, datasourceId: number, group: ZoneDatasourceGroup) {
    const groupName = getGroupName(group.groupMasterKey, null, groupInfos);
    setEditDialog({
      zoneId,
      datasourceId,
      group,
      groupName,
      isSecret: group.isGroupSecret,
      interseptionKind: group.interseptionKind,
      disableNetworkAssignment: group.disableNetworkAssignment,
      selectedUsers: group.allowedUsers,
      selectedUserDetails: group.allowedUserDetails,
      selectedOrganismIds: group.allowedOrganismIds,
      selectedAdmins: group.adminLogins,
      selectedAdminDetails: group.adminLoginDetails,
      shortNote: group.shortNote ?? '',
      longNote: group.longNote ?? '',
      selectedAorIds: (group.areasOfResponsibility ?? []).map((aor) => aor.id),
      isSaving: false,
      error: null,
    });
  }

  function openOrphanEditDialog(group: OrphanSignalGroupEntry) {
    const groupName = getOrphanGroupName(group);
    setOrphanEditDialog({
      group,
      groupName,
      interseptionKind: group.interseptionKind,
      disableNetworkAssignment: group.disableNetworkAssignment,
      shortNote: group.groupAdminData?.shortNote ?? '',
      longNote: group.groupAdminData?.longNote ?? '',
      selectedAorIds: (group.areasOfResponsibility ?? []).map((aor) => aor.id),
      isSaving: false,
      error: null,
    });
  }

  function openAssignDialog(group: OrphanSignalGroupEntry) {
    const preselectedZones = zones.length === 1 ? zones : [];

    setAssignDialog({
      group,
      selectedZones: preselectedZones,
      isSecret: false,
      interseptionKind: group.interseptionKind,
      disableNetworkAssignment: group.disableNetworkAssignment,
      selectedUsers: [],
      selectedOrganismIds: [],
      selectedAdmins: [],
      isSaving: false,
      error: null,
    });
  }

  function openArchiveOrphanDialog(group: OrphanSignalGroupEntry) {
    setArchiveDialog({
      masterKey: group.masterKey,
      groupName: getOrphanGroupName(group),
      isSaving: false,
      error: null,
    });
  }

  function openUnarchiveDialog(group: OrphanSignalGroupEntry) {
    setUnarchiveDialog({
      masterKey: group.masterKey,
      groupName: getOrphanGroupName(group),
      isSaving: false,
      error: null,
    });
  }

  function openArchiveZoneDialog(
    _zoneId: number,
    _datasourceId: number,
    group: ZoneDatasourceGroup,
  ) {
    setArchiveDialog({
      masterKey: group.groupMasterKey,
      groupName: getGroupName(group.groupMasterKey, null, groupInfos),
      isSaving: false,
      error: null,
    });
  }

  function openDeleteDialog(zoneId: number, datasourceId: number, group: ZoneDatasourceGroup) {
    const groupName = getGroupName(group.groupMasterKey, null, groupInfos);
    setDeleteDialog({
      zoneId,
      datasourceId,
      group,
      groupName,
      isDeleting: false,
      error: null,
    });
  }

  async function handleArchiveGroup() {
    if (!archiveDialog) return;
    setArchiveDialog({ ...archiveDialog, isSaving: true, error: null });
    try {
      await archiveSignalGroup({ masterKey: archiveDialog.masterKey });
      setArchiveDialog(null);
      await loadData();
    } catch (err) {
      setArchiveDialog({
        ...archiveDialog,
        isSaving: false,
        error: 'Не вдалося архівувати групу',
      });
    }
  }

  async function handleUnarchiveGroup() {
    if (!unarchiveDialog) return;
    setUnarchiveDialog({ ...unarchiveDialog, isSaving: true, error: null });
    try {
      await unarchiveSignalGroup({ masterKey: unarchiveDialog.masterKey });
    } catch (err) {
      setUnarchiveDialog({
        ...unarchiveDialog,
        isSaving: false,
        error: 'Не вдалося розархівувати групу',
      });
      return;
    }
    setUnarchiveDialog(null);
    await loadData();
  }

  async function handleSaveGroupEdit() {
    if (!editDialog) return;
    setEditDialog({ ...editDialog, isSaving: true, error: null });

    const selectedUsers = editDialog.isSecret ? editDialog.selectedUsers : [];
    const selectedOrganismIds = editDialog.isSecret ? editDialog.selectedOrganismIds : [];
    const req: ZoneDatasourceGroupUpdateReq = {
      id: editDialog.group.sigintZoneDatasourceId,
      isSecret: editDialog.isSecret,
      interseptionKind: supportNonRerInterceptions ? editDialog.interseptionKind : null,
      disableNetworkAssignment: editDialog.disableNetworkAssignment,
      userLogins: selectedUsers,
      organismIds: selectedOrganismIds,
      adminLogins: editDialog.selectedAdmins,
      shortNote: editDialog.shortNote.trim() ? editDialog.shortNote.trim() : null,
      longNote: editDialog.longNote.trim() ? editDialog.longNote.trim() : null,
      areaOfResponsibilityId: null,
      areaOfResponsibilityIds:
        editDialog.selectedAorIds.length > 0 ? editDialog.selectedAorIds : null,
    };

    try {
      const updatedGroup = await updateZoneDatasourceGroup(req);
      setZoneGroups((prev) => {
        const next = new Map(prev);
        const key = buildGroupKey(editDialog.zoneId, editDialog.datasourceId);
        const groups = next.get(key) ?? [];
        next.set(
          key,
          groups.map((item) =>
            item.sigintZoneDatasourceId === updatedGroup.sigintZoneDatasourceId
              ? updatedGroup
              : item,
          ),
        );
        return next;
      });
      setEditDialog(null);
    } catch (err) {
      setEditDialog({
        ...editDialog,
        isSaving: false,
        error: 'Не вдалося зберегти групу',
      });
    }
  }

  async function handleSaveOrphanEdit() {
    if (!orphanEditDialog) return;
    setOrphanEditDialog({ ...orphanEditDialog, isSaving: true, error: null });

    try {
      const updated = await editGroup({
        masterKey: orphanEditDialog.group.masterKey,
        shortNote: orphanEditDialog.shortNote.trim() ? orphanEditDialog.shortNote.trim() : null,
        longNote: orphanEditDialog.longNote.trim() ? orphanEditDialog.longNote.trim() : null,
        areaOfResponsibilityId: null,
        areaOfResponsibilityIds:
          orphanEditDialog.selectedAorIds.length > 0 ? orphanEditDialog.selectedAorIds : null,
        interseptionKind: supportNonRerInterceptions ? orphanEditDialog.interseptionKind : null,
        disableNetworkAssignment: orphanEditDialog.disableNetworkAssignment,
      });

      setOrphanGroups((prev) =>
        prev.map((group) => {
          if (group.masterKey !== updated.masterKey) return group;
          return {
            ...group,
            groupAdminData:
              updated.shortNote || updated.longNote
                ? {
                    shortNote: updated.shortNote ?? null,
                    longNote: updated.longNote ?? null,
                  }
                : null,
            areasOfResponsibility: updated.areasOfResponsibility ?? null,
            interseptionKind: orphanEditDialog.interseptionKind,
            disableNetworkAssignment: orphanEditDialog.disableNetworkAssignment,
          };
        }),
      );
      setArchivedGroups((prev) =>
        prev.map((group) => {
          if (group.masterKey !== updated.masterKey) return group;
          return {
            ...group,
            groupAdminData:
              updated.shortNote || updated.longNote
                ? {
                    shortNote: updated.shortNote ?? null,
                    longNote: updated.longNote ?? null,
                  }
                : null,
            areasOfResponsibility: updated.areasOfResponsibility ?? null,
            interseptionKind: orphanEditDialog.interseptionKind,
            disableNetworkAssignment: orphanEditDialog.disableNetworkAssignment,
          };
        }),
      );

      setOrphanEditDialog(null);
    } catch (err) {
      setOrphanEditDialog({
        ...orphanEditDialog,
        isSaving: false,
        error: 'Не вдалося зберегти зміни',
      });
    }
  }

  async function handleAssignOrphanGroup() {
    if (!assignDialog) return;
    const hasAor =
      assignDialog.group.areasOfResponsibility &&
      assignDialog.group.areasOfResponsibility.length > 0;
    if (!hasAor) {
      setAssignDialog({
        ...assignDialog,
        error: 'Спочатку призначте смугу відповідальності для групи',
      });
      return;
    }
    if (!assignDialog.group.datasourceId) {
      setAssignDialog({
        ...assignDialog,
        error: 'У групи немає привʼязаного датасорса',
      });
      return;
    }

    setAssignDialog({ ...assignDialog, isSaving: true, error: null });

    const datasourceId = assignDialog.group.datasourceId;
    const selectedUsers = assignDialog.isSecret ? assignDialog.selectedUsers : [];
    const selectedOrganismIds = assignDialog.isSecret ? assignDialog.selectedOrganismIds : [];
    const requests: ZoneDatasourceGroupAddReq[] = assignDialog.selectedZones.map(([zoneId]) => ({
      zoneId,
      datasourceId,
      masterKey: assignDialog.group.masterKey,
      isSecret: assignDialog.isSecret,
      interseptionKind: supportNonRerInterceptions ? assignDialog.interseptionKind : null,
      userLogins: selectedUsers,
      organismIds: selectedOrganismIds,
      adminLogins: assignDialog.selectedAdmins,
      shortNote: assignDialog.group.groupAdminData?.shortNote ?? null,
      longNote: assignDialog.group.groupAdminData?.longNote ?? null,
    }));

    try {
      const responses = await Promise.all(requests.map((req) => addZoneDatasourceGroup(req)));

      setZoneGroups((prev) => {
        const next = new Map(prev);
        responses.forEach((response) => {
          const key = buildGroupKey(response.zoneId, response.datasourceId);
          const groups = next.get(key) ?? [];
          next.set(key, [...groups, response.zoneDatasourceGroup]);
        });
        return next;
      });

      setZoneDatasourceIds((prev) => {
        const next = new Map(prev);
        responses.forEach((response) => {
          const current = next.get(response.zoneId) ?? [];
          if (!current.includes(response.datasourceId)) {
            next.set(response.zoneId, [...current, response.datasourceId]);
          }
        });
        return next;
      });

      setGroupInfos((prev) => {
        const next = new Map(prev);
        responses.forEach((response) => {
          if (!response.groupName) return;
          if (!next.has(response.groupMasterKey)) {
            next.set(response.groupMasterKey, {
              masterKey: response.groupMasterKey,
              name: response.groupName,
              ignoreOperativny: false,
              interseptionKind: assignDialog.interseptionKind,
              disableNetworkAssignment: assignDialog.disableNetworkAssignment,
              groupStats: assignDialog.group.groupStats,
              adminData: assignDialog.group.groupAdminData,
              areasOfResponsibility: assignDialog.group.areasOfResponsibility,
            });
          }
        });
        return next;
      });

      setOrphanGroups((prev) =>
        prev.filter((group) => group.masterKey !== assignDialog.group.masterKey),
      );
      setAssignDialog(null);
    } catch (err) {
      setAssignDialog({
        ...assignDialog,
        isSaving: false,
        error: 'Не вдалося призначити групу',
      });
    }
  }

  async function handleDeleteGroup() {
    if (!deleteDialog) return;
    setDeleteDialog({ ...deleteDialog, isDeleting: true, error: null });
    try {
      await deleteZoneDatasourceGroup(deleteDialog.group.sigintZoneDatasourceId);
      setZoneGroups((prev) => {
        const next = new Map(prev);
        const key = buildGroupKey(deleteDialog.zoneId, deleteDialog.datasourceId);
        const groups = next.get(key) ?? [];
        next.set(
          key,
          groups.filter(
            (group) => group.sigintZoneDatasourceId !== deleteDialog.group.sigintZoneDatasourceId,
          ),
        );
        return next;
      });
      setDeleteDialog(null);
    } catch (err) {
      setDeleteDialog({
        ...deleteDialog,
        isDeleting: false,
        error: 'Не вдалося видалити групу',
      });
    }
  }

  const renderContent = () => {
    if (status === 'error') {
      return <PageErrorState message={error || 'Помилка завантаження'} />;
    }

    if (status === 'success' && selectedGroupMasterKey) {
      if (!selectedGroup) {
        return (
          <PageErrorState
            message="Групу не знайдено"
            actionLabel="До списку груп"
            onAction={closeGroupCard}
          />
        );
      }
      return <GroupCardView group={selectedGroup} onBack={closeGroupCard} />;
    }

    return (
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <Tabs
          value={activeTab}
          onChange={(_, value: number) => setActiveTab(value)}
          variant="scrollable"
          allowScrollButtonsMobile
          sx={{
            minHeight: 48,
            borderBottom: '1px solid',
            borderColor: 'divider',
            flexShrink: 0,
          }}
        >
          {directionTabs.map((tab) => (
            <Tab
              key={tab.key}
              label={tab.label}
              sx={{
                alignItems: 'flex-start',
                textAlign: 'left',
                minHeight: 48,
              }}
            />
          ))}
        </Tabs>

        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            display: 'flex',
            overflow: 'hidden',
            pt: 1.5,
          }}
        >
          {directionTabs.map((tab, index) => (
            <Box
              key={tab.key}
              role="tabpanel"
              hidden={activeTab !== index}
              sx={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                display: activeTab === index ? 'flex' : 'none',
                overflow: 'hidden',
              }}
            >
              <Box
                sx={{
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  display: 'flex',
                  overflow: 'hidden',
                }}
              >
                {tab.content}
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
    );
  };

  return (
    <div className="flex h-full w-full min-w-0 flex-col gap-4 overflow-hidden">
      {error ? (
        <PowerAlert severity="error" onClose={() => setError(null)}>
          {error}
        </PowerAlert>
      ) : null}

      <TablePageToolbar
        title="Напрямки"
        withGlobalTextFilter={false}
        internalActionsHidden
        internalActionsDisabled={status === 'loading'}
      />

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">{renderContent()}</div>

      <Dialog
        open={Boolean(editDialog)}
        onClose={() => setEditDialog(null)}
        maxWidth="md"
        fullWidth
        disableRestoreFocus
      >
        <DialogTitle>Редагувати групу</DialogTitle>
        <DialogContent className="space-y-4">
          {editDialog?.error ? <PowerAlert severity="error">{editDialog.error}</PowerAlert> : null}
          <div className="text-sm text-muted-foreground">Група: {editDialog?.groupName}</div>
          <FormControlLabel
            control={
              <Switch
                checked={editDialog?.isSecret ?? false}
                onChange={(event) =>
                  editDialog &&
                  setEditDialog({
                    ...editDialog,
                    isSecret: event.target.checked,
                  })
                }
              />
            }
            label="Прихована група"
          />
          {supportNonRerInterceptions ? (
            <InterseptionKindSelect
              value={editDialog?.interseptionKind ?? 'rer'}
              onChange={(interseptionKind) =>
                editDialog &&
                setEditDialog({
                  ...editDialog,
                  interseptionKind,
                })
              }
            />
          ) : null}
          <FormControlLabel
            control={
              <Switch
                checked={editDialog?.disableNetworkAssignment ?? false}
                onChange={(event) =>
                  editDialog &&
                  setEditDialog({
                    ...editDialog,
                    disableNetworkAssignment: event.target.checked,
                  })
                }
              />
            }
            label={<DisableNetworkAssignmentLabel />}
          />
          {editDialog?.isSecret ? (
            <LoginAutocomplete
              label="Користувачі"
              options={logins}
              selectedIds={editDialog.selectedUsers}
              selectedDetails={editDialog.selectedUserDetails}
              onChange={(selectedUsers) =>
                editDialog &&
                setEditDialog({
                  ...editDialog,
                  selectedUsers,
                })
              }
            />
          ) : null}
          {editDialog?.isSecret ? (
            <Autocomplete
              multiple
              options={activeOrganismOptions}
              getOptionLabel={(option) => option.name}
              value={selectedOrganisms(editDialog.selectedOrganismIds, activeOrganismOptions)}
              onChange={(_, value) =>
                editDialog &&
                setEditDialog({
                  ...editDialog,
                  selectedOrganismIds: value.map((organism) => organism.id),
                })
              }
              renderOption={(props, option) => {
                const { key: _unusedKey, ...optionProps } = props;
                return (
                  <Box component="li" {...optionProps} key={option.id}>
                    {option.name}
                  </Box>
                );
              }}
              renderInput={(params) => <TextField {...params} label="Організми" />}
              isOptionEqualToValue={(option, value) => option.id === value.id}
            />
          ) : null}
          <LoginAutocomplete
            label="Адміністратори групи"
            options={logins}
            selectedIds={editDialog?.selectedAdmins ?? []}
            selectedDetails={editDialog?.selectedAdminDetails ?? []}
            onChange={(selectedAdmins) =>
              editDialog &&
              setEditDialog({
                ...editDialog,
                selectedAdmins,
              })
            }
          />
          <Autocomplete
            multiple
            options={aorOptions}
            getOptionLabel={(option) => option.name}
            value={
              (editDialog?.selectedAorIds ?? [])
                .map((id) => aorOptions.find((aor) => aor.id === id))
                .filter(Boolean) as AreaOfResponsibility[]
            }
            onChange={(_, value) =>
              editDialog &&
              setEditDialog({
                ...editDialog,
                selectedAorIds: value.map((aor) => aor.id),
              })
            }
            renderOption={(props, option) => {
              const { key: _unusedKey, ...optionProps } = props;
              return (
                <Box component="li" {...optionProps} key={option.id}>
                  {option.name}
                </Box>
              );
            }}
            renderInput={(params) => <TextField {...params} label="Смуги відповідальності" />}
            isOptionEqualToValue={(option, value) => option.id === value.id}
          />
          <TextField
            label="Коротка нотатка"
            multiline
            minRows={2}
            value={editDialog?.shortNote ?? ''}
            onChange={(event) =>
              editDialog && setEditDialog({ ...editDialog, shortNote: event.target.value })
            }
          />
          <TextField
            label="Довга нотатка"
            multiline
            minRows={3}
            value={editDialog?.longNote ?? ''}
            onChange={(event) =>
              editDialog && setEditDialog({ ...editDialog, longNote: event.target.value })
            }
          />
        </DialogContent>
        <DialogActions>
          <PowerButton
            variant="outlined"
            onClick={() => setEditDialog(null)}
            disabled={editDialog?.isSaving}
          >
            Скасувати
          </PowerButton>
          <PowerButton
            variant="contained"
            onClick={handleSaveGroupEdit}
            disabled={editDialog?.isSaving}
          >
            Зберегти
          </PowerButton>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(orphanEditDialog)}
        onClose={() => setOrphanEditDialog(null)}
        maxWidth="md"
        fullWidth
        disableRestoreFocus
      >
        <DialogTitle>Редагувати орфан групу</DialogTitle>
        <DialogContent className="space-y-4">
          {orphanEditDialog?.error ? (
            <PowerAlert severity="error">{orphanEditDialog.error}</PowerAlert>
          ) : null}
          <div className="text-sm text-muted-foreground">Група: {orphanEditDialog?.groupName}</div>
          {supportNonRerInterceptions ? (
            <InterseptionKindSelect
              value={orphanEditDialog?.interseptionKind ?? 'rer'}
              onChange={(interseptionKind) =>
                orphanEditDialog &&
                setOrphanEditDialog({
                  ...orphanEditDialog,
                  interseptionKind,
                })
              }
            />
          ) : null}
          <FormControlLabel
            control={
              <Switch
                checked={orphanEditDialog?.disableNetworkAssignment ?? false}
                onChange={(event) =>
                  orphanEditDialog &&
                  setOrphanEditDialog({
                    ...orphanEditDialog,
                    disableNetworkAssignment: event.target.checked,
                  })
                }
              />
            }
            label={<DisableNetworkAssignmentLabel />}
          />
          <Autocomplete
            multiple
            options={aorOptions}
            getOptionLabel={(option) => option.name}
            value={
              (orphanEditDialog?.selectedAorIds ?? [])
                .map((id) => aorOptions.find((aor) => aor.id === id))
                .filter(Boolean) as AreaOfResponsibility[]
            }
            onChange={(_, value) =>
              orphanEditDialog &&
              setOrphanEditDialog({
                ...orphanEditDialog,
                selectedAorIds: value.map((aor) => aor.id),
              })
            }
            renderOption={(props, option) => {
              const { key: _unusedKey, ...optionProps } = props;
              return (
                <Box component="li" {...optionProps} key={option.id}>
                  {option.name}
                </Box>
              );
            }}
            renderInput={(params) => <TextField {...params} label="Смуги відповідальності" />}
            isOptionEqualToValue={(option, value) => option.id === value.id}
          />
          <TextField
            label="Коротка нотатка"
            multiline
            minRows={2}
            value={orphanEditDialog?.shortNote ?? ''}
            onChange={(event) =>
              orphanEditDialog &&
              setOrphanEditDialog({
                ...orphanEditDialog,
                shortNote: event.target.value,
              })
            }
          />
          <TextField
            label="Довга нотатка"
            multiline
            minRows={3}
            value={orphanEditDialog?.longNote ?? ''}
            onChange={(event) =>
              orphanEditDialog &&
              setOrphanEditDialog({
                ...orphanEditDialog,
                longNote: event.target.value,
              })
            }
          />
        </DialogContent>
        <DialogActions>
          <PowerButton
            variant="outlined"
            onClick={() => setOrphanEditDialog(null)}
            disabled={orphanEditDialog?.isSaving}
          >
            Скасувати
          </PowerButton>
          <PowerButton
            variant="contained"
            onClick={handleSaveOrphanEdit}
            disabled={orphanEditDialog?.isSaving}
          >
            Зберегти
          </PowerButton>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(assignDialog)}
        onClose={() => setAssignDialog(null)}
        maxWidth="md"
        fullWidth
        disableRestoreFocus
      >
        <DialogTitle>Додати орфан групу до напрямків</DialogTitle>
        <DialogContent className="space-y-4">
          {assignDialog?.error ? (
            <PowerAlert severity="error">{assignDialog.error}</PowerAlert>
          ) : null}
          <div className="text-sm text-muted-foreground">
            Група: {assignDialog?.group.name || assignDialog?.group.masterKey.slice(-5)}
          </div>
          <Autocomplete
            multiple
            options={zones}
            getOptionLabel={(option) => option[1].name}
            value={assignDialog?.selectedZones ?? []}
            onChange={(_, value) =>
              assignDialog && setAssignDialog({ ...assignDialog, selectedZones: value })
            }
            renderOption={(props, option) => {
              const { key: _unusedKey, ...optionProps } = props;
              return (
                <Box component="li" {...optionProps} key={option[0]}>
                  {option[1].name}
                </Box>
              );
            }}
            renderInput={(params) => <TextField {...params} label="Напрямки" />}
            isOptionEqualToValue={(option, value) => option[0] === value[0]}
          />
          <FormControlLabel
            control={
              <Switch
                checked={assignDialog?.isSecret ?? false}
                onChange={(event) =>
                  assignDialog &&
                  setAssignDialog({
                    ...assignDialog,
                    isSecret: event.target.checked,
                  })
                }
              />
            }
            label="Прихована група"
          />
          {supportNonRerInterceptions ? (
            <InterseptionKindSelect
              value={assignDialog?.interseptionKind ?? 'rer'}
              onChange={(interseptionKind) =>
                assignDialog &&
                setAssignDialog({
                  ...assignDialog,
                  interseptionKind,
                })
              }
            />
          ) : null}
          {assignDialog?.isSecret ? (
            <LoginAutocomplete
              label="Користувачі"
              options={logins}
              selectedIds={assignDialog.selectedUsers}
              selectedDetails={[]}
              onChange={(selectedUsers) =>
                assignDialog &&
                setAssignDialog({
                  ...assignDialog,
                  selectedUsers,
                })
              }
            />
          ) : null}
          {assignDialog?.isSecret ? (
            <Autocomplete
              multiple
              options={activeOrganismOptions}
              getOptionLabel={(option) => option.name}
              value={selectedOrganisms(assignDialog.selectedOrganismIds, activeOrganismOptions)}
              onChange={(_, value) =>
                assignDialog &&
                setAssignDialog({
                  ...assignDialog,
                  selectedOrganismIds: value.map((organism) => organism.id),
                })
              }
              renderOption={(props, option) => {
                const { key: _unusedKey, ...optionProps } = props;
                return (
                  <Box component="li" {...optionProps} key={option.id}>
                    {option.name}
                  </Box>
                );
              }}
              renderInput={(params) => <TextField {...params} label="Організми" />}
              isOptionEqualToValue={(option, value) => option.id === value.id}
            />
          ) : null}
          <LoginAutocomplete
            label="Адміністратори групи"
            options={logins}
            selectedIds={assignDialog?.selectedAdmins ?? []}
            selectedDetails={[]}
            onChange={(selectedAdmins) =>
              assignDialog &&
              setAssignDialog({
                ...assignDialog,
                selectedAdmins,
              })
            }
          />
        </DialogContent>
        <DialogActions>
          <PowerButton
            variant="outlined"
            onClick={() => setAssignDialog(null)}
            disabled={assignDialog?.isSaving}
          >
            Скасувати
          </PowerButton>
          <PowerButton
            variant="contained"
            onClick={handleAssignOrphanGroup}
            disabled={assignDialog?.isSaving}
          >
            Додати
          </PowerButton>
        </DialogActions>
      </Dialog>

      <ConfirmDangerDialog
        open={Boolean(archiveDialog)}
        onClose={() => setArchiveDialog(null)}
        onConfirm={handleArchiveGroup}
        submitting={Boolean(archiveDialog?.isSaving)}
        disabled={!archiveDialog}
        title="Архівувати групу"
        confirmLabel="Архівувати"
        disableRestoreFocus
      >
        {archiveDialog?.error ? (
          <PowerAlert severity="error">{archiveDialog.error}</PowerAlert>
        ) : null}
        <Typography variant="body2" className="text-muted-foreground">
          Група {archiveDialog?.groupName} буде відвʼязана від напрямків і перенесена в архів.
        </Typography>
      </ConfirmDangerDialog>

      <ConfirmDangerDialog
        open={Boolean(unarchiveDialog)}
        onClose={() => setUnarchiveDialog(null)}
        onConfirm={handleUnarchiveGroup}
        submitting={Boolean(unarchiveDialog?.isSaving)}
        disabled={!unarchiveDialog}
        title="Розархівувати групу"
        confirmLabel="Розархівувати"
        disableRestoreFocus
      >
        {unarchiveDialog?.error ? (
          <PowerAlert severity="error">{unarchiveDialog.error}</PowerAlert>
        ) : null}
        <Typography variant="body2" className="text-muted-foreground">
          Розархівувати групу {unarchiveDialog?.groupName} і повернути її до списку орфан груп?
        </Typography>
      </ConfirmDangerDialog>

      <ConfirmDangerDialog
        open={Boolean(deleteDialog)}
        onClose={() => setDeleteDialog(null)}
        onConfirm={handleDeleteGroup}
        submitting={Boolean(deleteDialog?.isDeleting)}
        disabled={!deleteDialog}
        disableRestoreFocus
      >
        {deleteDialog?.error ? (
          <PowerAlert severity="error">{deleteDialog.error}</PowerAlert>
        ) : null}
        <Typography variant="body2" className="text-muted-foreground">
          Ви впевнені, що хочете видалити групу {deleteDialog?.groupName}?
        </Typography>
      </ConfirmDangerDialog>
    </div>
  );
}

export function AdminDirectionsNeoPage() {
  return <AdminDirectionsNeoPageBody />;
}
