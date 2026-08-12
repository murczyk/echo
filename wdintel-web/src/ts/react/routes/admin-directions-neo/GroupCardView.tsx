import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { Box, Button, IconButton, Paper, Tooltip, Typography } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import type { MRT_ColumnDef } from 'material-react-table';
import { MaterialReactTable, useMaterialReactTable } from 'material-react-table';

import type { InboxMessage, InboxMessagesReq } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PageErrorState } from '../../components/PageErrorState';
import { SectionEmptyState } from '../../components/SectionEmptyState';
import { SidePanelToggleButton } from '../../components/SidePanelToggleButton';
import { fetchInboxMessages } from '../../services/api/inbox-messages';
import { formatDateTime24, NO_DATA_LABEL } from '../../utils/misc';

export type GroupCardData = {
  masterKey: string;
  name: string;
  datasourceLabels: string[];
  directionLabels: string[];
  activityLastDay: number;
  activityLastWeek: number;
  aorLabels: string[];
  shortNote: string | null;
  longNote: string | null;
  interseptionKind: string;
  disableNetworkAssignment: boolean;
  isArchived: boolean;
};

type MessageRow = {
  id: number;
  message: InboxMessage;
};

function buildGroupMessagesRequest(masterKey: string): InboxMessagesReq {
  return {
    sinceIdNoninclusive: null,
    beforeIdNoninclusive: null,
    sinceDateInclusiveMs: null,
    tillDateInclusiveMs: null,
    onlyShowUnprocessed: null,
    checkedOnly: null,
    selectedGroups: [masterKey],
    deniedGroups: null,
    selectedSenders: null,
    deniedSenders: null,
    selectedFreqs: null,
    selectedPosts: null,
    deniedPosts: null,
    deniedFreqs: null,
    selectedCallsigns: null,
    selectedUnits: null,
    selectedDeviceNames: null,
    deniedUnits: null,
    selectedLocations: null,
    nolimit: null,
    orWithExtendedForm: null,
    loadLatest: true,
    returnDuplicates: true,
    orBookmarked: null,
    orImportant: null,
    orWithCoords: null,
    orWithoutCoords: null,
    newestFirst: true,
    search: null,
    highlightCallsigns: null,
    highlightKeywords: null,
    highlightSearchres: null,
    highlightSignals: null,
    highlightPoints: null,
    highlightKeywordSetId: null,
    selectedTags: null,
    deniedTags: null,
    tagPresence: null,
    selectedAors: null,
    selectedNetworks: null,
    withoutNetwork: null,
    metadataCc: null,
    metadataSender: null,
    metadataReceiver: null,
    metadataHash: null,
    onlyWithMetadata: null,
    withoutMetadata: null,
    onlyWithMedia: null,
    sortBy: 'IMSTimestamp',
    reportTagsOnlyThisUnit: null,
    ignoreImportedCoords: null,
    includePelengLocations: null,
    unitsExactMatchOnly: null,
    calculateFreqPelengsSummary: null,
    skipGroupStats: true,
    filterTagsOption: null,
    pageId: 'admin-directions-group-card',
    withoutModelTags: null,
  };
}

function GroupMessagesTable({ masterKey }: { masterKey: string }) {
  const [rows, setRows] = useState<MessageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchInboxMessages(buildGroupMessagesRequest(masterKey), { signal: controller.signal })
      .then((response) => {
        setRows(response.inboxItems.map(([id, message]) => ({ id, message })));
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setError(
          loadError instanceof Error ? loadError.message : 'Не вдалося завантажити повідомлення',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [masterKey]);

  const columns = useMemo<MRT_ColumnDef<MessageRow>[]>(
    () => [
      {
        id: 'timestamp',
        header: 'Дата й час',
        accessorFn: (row) => row.message.timestamp,
        Cell: ({ row }) => formatDateTime24(row.original.message.timestamp),
        size: 170,
      },
      {
        id: 'text',
        header: 'Повідомлення',
        accessorFn: (row) => row.message.text,
        Cell: ({ row }) => (
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {row.original.message.text || NO_DATA_LABEL}
          </Typography>
        ),
        size: 520,
      },
      {
        id: 'sender',
        header: 'Відправник',
        accessorFn: (row) => row.message.sender ?? NO_DATA_LABEL,
        size: 180,
      },
      {
        id: 'freq',
        header: 'Частота',
        accessorFn: (row) => row.message.freq ?? NO_DATA_LABEL,
        size: 140,
      },
      {
        id: 'post',
        header: 'Пост / підрозділ',
        accessorFn: (row) =>
          [row.message.post, row.message.unit].filter(Boolean).join(' / ') || NO_DATA_LABEL,
        size: 220,
      },
    ],
    [],
  );

  const table = useMaterialReactTable({
    columns,
    data: rows,
    enableColumnFilters: false,
    enableColumnActions: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    enableHiding: false,
    enableRowNumbers: true,
    enableTopToolbar: false,
    initialState: { density: 'compact', sorting: [{ id: 'timestamp', desc: true }] },
    state: { isLoading: loading },
    muiTableContainerProps: { sx: { flex: 1, minHeight: 0, maxHeight: '100%' } },
    muiTablePaperProps: { sx: { height: '100%', display: 'flex', flexDirection: 'column' } },
  });

  if (error) return <PageErrorState message={error} />;
  if (!loading && rows.length === 0) {
    return <SectionEmptyState message="Повідомлення цієї групи відсутні" />;
  }
  return <MaterialReactTable table={table} />;
}

function GroupInfoCard({ group }: { group: GroupCardData }) {
  const fields = [
    ['Ключ', group.masterKey],
    ['Джерело', group.datasourceLabels.join(', ') || NO_DATA_LABEL],
    ['Напрямок', group.directionLabels.join(', ') || NO_DATA_LABEL],
    ['Категорія', group.interseptionKind === 'rer' ? 'РЕР' : 'Інше'],
    ['Активність за день', String(group.activityLastDay)],
    ['Активність за тиждень', String(group.activityLastWeek)],
    ['Смуги', group.aorLabels.join(', ') || NO_DATA_LABEL],
    ['Коротка нотатка', group.shortNote || NO_DATA_LABEL],
    ['Розширена нотатка', group.longNote || NO_DATA_LABEL],
  ];

  return (
    <Paper variant="outlined" sx={{ height: '100%', overflow: 'auto', p: 2 }}>
      <Typography variant="h6" sx={{ mb: 2 }}>
        {group.name}
      </Typography>
      <Box component="dl" sx={{ m: 0, display: 'grid', gap: 1.5 }}>
        {fields.map(([label, value]) => (
          <Box key={label}>
            <Typography component="dt" variant="caption" color="text.secondary">
              {label}
            </Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: 'anywhere' }}>
              {value}
            </Typography>
          </Box>
        ))}
      </Box>
      {group.isArchived ? (
        <Typography color="warning.main" variant="body2" sx={{ mt: 2 }}>
          Група в архіві
        </Typography>
      ) : null}
      {group.disableNetworkAssignment ? (
        <Typography color="text.secondary" variant="body2" sx={{ mt: 1 }}>
          Привʼязку мереж вимкнено
        </Typography>
      ) : null}
    </Paper>
  );
}

export function GroupCardView({ group, onBack }: { group: GroupCardData; onBack: () => void }) {
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);

  return (
    <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <PageHeader
        title={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Tooltip title="До списку груп">
              <IconButton size="small" onClick={onBack} aria-label="До списку груп">
                <ArrowBackIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <span>{group.name}</span>
          </Box>
        }
        titleLeadingActions={
          <SidePanelToggleButton
            side="left"
            active={leftPanelOpen}
            label={leftPanelOpen ? 'Згорнути ліву панель' : 'Розгорнути ліву панель'}
            onClick={() => setLeftPanelOpen((current) => !current)}
          />
        }
        actions={<Button onClick={onBack}>До списку</Button>}
      />
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gap: 2,
          gridTemplateColumns: leftPanelOpen ? 'minmax(320px, 400px) minmax(0, 1fr)' : '1fr',
          overflow: 'hidden',
        }}
      >
        {leftPanelOpen ? <GroupInfoCard group={group} /> : null}
        <Box sx={{ minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
          <GroupMessagesTable masterKey={group.masterKey} />
        </Box>
      </Box>
    </Box>
  );
}
