import {
  Box,
  Button,
  CircularProgress,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  InboxMessage,
  InboxMessagesReq,
  SignalGroupEntry,
  UnitActivityPeriod,
  UnitActivityRsp,
} from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { fetchInboxMessages } from '../../services/api/inbox-messages';
import { getUnitActivity } from '../../services/api/units';
import { formatDateTime24, NO_DATA_LABEL } from '../../utils/misc';
import { NetworkDetailsActivityChart } from '../rer-network-details-neo/components/NetworkDetailsActivityChart';
import {
  buildChartMax,
  getGroupColor,
  type ActivityChartData,
  type HoveredBar,
} from '../rer-network-details-neo/components/NetworkDetailsActivityPanel.utils';

const INTERCEPTIONS_STEP = 5;
const ACTIVITY_GROUP_NAME = 'Перехоплення';
const KYIV_TIME_ZONE = 'Europe/Kyiv';

type Interception = {
  id: number;
  message: InboxMessage;
};

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Помилка запиту до сервера.';
}

function unitInterceptionsRequest(
  unitId: number,
  beforeIdNoninclusive: number | null,
): InboxMessagesReq {
  return {
    sinceIdNoninclusive: null,
    beforeIdNoninclusive,
    aroundMessageRef: null,
    sinceDateInclusiveMs: null,
    tillDateInclusiveMs: null,
    onlyShowUnprocessed: null,
    checkedOnly: null,
    selectedGroups: null,
    deniedGroups: null,
    selectedSenders: null,
    deniedSenders: null,
    selectedFreqs: null,
    selectedPosts: null,
    deniedPosts: null,
    deniedFreqs: null,
    selectedCallsigns: null,
    selectedUnits: null,
    selectedUnitIds: [unitId],
    selectedDeviceNames: null,
    deniedDeviceNames: null,
    deniedUnits: null,
    deniedUnitIds: null,
    selectedLocations: null,
    deniedLocations: null,
    nolimit: null,
    orWithExtendedForm: null,
    loadLatest: beforeIdNoninclusive === null,
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
    onlyWithNetwork: null,
    metadataCc: null,
    metadataSender: null,
    metadataReceiver: null,
    metadataHash: null,
    onlyWithMetadata: null,
    withoutMetadata: null,
    onlyWithMedia: null,
    sortBy: 'IMSCreatedAt',
    reportTagsOnlyThisUnit: null,
    ignoreImportedCoords: null,
    includePelengLocations: null,
    unitsExactMatchOnly: null,
    calculateFreqPelengsSummary: null,
    skipGroupStats: true,
    filterTagsOption: null,
    pageId: 'unit-details-interceptions',
    withoutModelTags: null,
  };
}

function InterceptionCard({
  interception,
  groups,
}: {
  interception: Interception;
  groups: Map<string, SignalGroupEntry>;
}) {
  const message = interception.message;
  const groupName = message.groupMasterKey
    ? (groups.get(message.groupMasterKey)?.name ?? message.groupMasterKey)
    : NO_DATA_LABEL;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between">
          <Typography variant="subtitle1" fontWeight={700}>
            Група: {groupName}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {formatDateTime24(message.timestamp ?? message.createdAt)}
          </Typography>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.5, sm: 3 }}>
          <Typography variant="body2">
            <Box component="span" fontWeight={700}>
              Відправник:
            </Box>{' '}
            {message.sender || NO_DATA_LABEL}
          </Typography>
          <Typography variant="body2">
            <Box component="span" fontWeight={700}>
              Частота:
            </Box>{' '}
            {message.freq || NO_DATA_LABEL}
          </Typography>
        </Stack>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {message.text || NO_DATA_LABEL}
        </Typography>
      </Stack>
    </Paper>
  );
}

export function UnitInterceptionsPanel({ unitId }: { unitId: number }) {
  const [interceptions, setInterceptions] = useState<Interception[]>([]);
  const [groups, setGroups] = useState<Map<string, SignalGroupEntry>>(new Map());
  const [visibleCount, setVisibleCount] = useState(INTERCEPTIONS_STEP);
  const [hasRemoteMore, setHasRemoteMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    const controller = new AbortController();
    setInterceptions([]);
    setGroups(new Map());
    setVisibleCount(INTERCEPTIONS_STEP);
    setHasRemoteMore(false);
    setLoadingMore(false);
    setLoading(true);
    setError(null);
    void fetchInboxMessages(unitInterceptionsRequest(unitId, null), { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        setInterceptions(response.inboxItems.map(([id, message]) => ({ id, message })));
        setGroups(new Map(response.signalGroups.map((group) => [group.masterKey, group])));
        setHasRemoteMore(
          response.pageLimit !== null && response.inboxItems.length >= response.pageLimit,
        );
      })
      .catch((requestError) => {
        if (!controller.signal.aborted && generation === requestGeneration.current) {
          setError(formatError(requestError));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === requestGeneration.current) {
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      if (generation === requestGeneration.current) requestGeneration.current += 1;
    };
  }, [unitId]);

  const loadMore = async () => {
    if (visibleCount < interceptions.length) {
      setVisibleCount((current) => current + INTERCEPTIONS_STEP);
      return;
    }
    if (!hasRemoteMore || loadingMore) return;
    const beforeId = interceptions.at(-1)?.id;
    if (beforeId === undefined) return;
    const generation = requestGeneration.current;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await fetchInboxMessages(unitInterceptionsRequest(unitId, beforeId));
      if (generation !== requestGeneration.current) return;
      const knownIds = new Set(interceptions.map((item) => item.id));
      const appended = response.inboxItems
        .filter(([id]) => !knownIds.has(id))
        .map(([id, message]) => ({ id, message }));
      setInterceptions((current) => [...current, ...appended]);
      setGroups((current) => {
        const next = new Map(current);
        response.signalGroups.forEach((group) => next.set(group.masterKey, group));
        return next;
      });
      setVisibleCount((current) => current + INTERCEPTIONS_STEP);
      setHasRemoteMore(
        appended.length > 0 &&
          response.pageLimit !== null &&
          response.inboxItems.length >= response.pageLimit,
      );
    } catch (requestError) {
      if (generation === requestGeneration.current) setError(formatError(requestError));
    } finally {
      if (generation === requestGeneration.current) setLoadingMore(false);
    }
  };

  if (loading) {
    return (
      <Stack alignItems="center" sx={{ py: 4 }}>
        <CircularProgress aria-label="Завантаження перехоплень" />
      </Stack>
    );
  }
  return (
    <Stack spacing={1.5}>
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      {interceptions.length === 0 && !error ? (
        <Typography color="text.secondary">Перехоплень не знайдено.</Typography>
      ) : null}
      {interceptions.slice(0, visibleCount).map((interception) => (
        <InterceptionCard key={interception.id} interception={interception} groups={groups} />
      ))}
      {visibleCount < interceptions.length || hasRemoteMore ? (
        <Box sx={{ alignSelf: 'center' }}>
          <Button variant="outlined" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Завантаження…' : 'Завантажити ще'}
          </Button>
        </Box>
      ) : null}
    </Stack>
  );
}

const ACTIVITY_PERIOD_LABELS: Array<{ value: UnitActivityPeriod; label: string }> = [
  { value: 'Day', label: 'День' },
  { value: 'Week', label: 'Тиждень' },
  { value: 'Month', label: 'Місяць' },
  { value: 'ThreeMonths', label: '3 місяці' },
];

function activityChartData(
  response: UnitActivityRsp,
  period: UnitActivityPeriod,
): ActivityChartData {
  const labelFormatter = new Intl.DateTimeFormat('uk-UA', {
    ...(period === 'Day'
      ? { hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: '2-digit' }),
    timeZone: KYIV_TIME_ZONE,
  });
  const tooltipFormatter = new Intl.DateTimeFormat('uk-UA', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    ...(period === 'Day' ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone: KYIV_TIME_ZONE,
  });
  const color = getGroupColor(ACTIVITY_GROUP_NAME);
  const days = response.buckets.map((bucket) => ({
    dayMs: bucket.startedAt,
    dayLabel: labelFormatter.format(bucket.startedAt),
    tooltipLabel: tooltipFormatter.format(bucket.startedAt),
    countsByGroup: { [ACTIVITY_GROUP_NAME]: bucket.interceptionCount },
    total: bucket.interceptionCount,
    segments:
      bucket.interceptionCount > 0
        ? [{ groupName: ACTIVITY_GROUP_NAME, count: bucket.interceptionCount, color }]
        : [],
  }));
  return {
    days,
    groupNames: [ACTIVITY_GROUP_NAME],
    groupColors: new Map([[ACTIVITY_GROUP_NAME, color]]),
    maxValue: buildChartMax(days.map((day) => day.total)),
  };
}

export function UnitActivityPanel({ unitId }: { unitId: number }) {
  const [period, setPeriod] = useState<UnitActivityPeriod>('Day');
  const [response, setResponse] = useState<UnitActivityRsp | null>(null);
  const [hoveredBar, setHoveredBar] = useState<HoveredBar | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setResponse(null);
    setHoveredBar(null);
    void getUnitActivity(unitId, period, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setResponse(result);
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(formatError(requestError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [period, unitId]);

  const chartData = useMemo(
    () => (response === null ? null : activityChartData(response, period)),
    [period, response],
  );
  return (
    <Stack spacing={2}>
      <Typography id="unit-activity-chart-title" variant="h6">
        Активність підрозділу
      </Typography>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={period}
        onChange={(_, value: UnitActivityPeriod | null) => {
          if (value !== null) setPeriod(value);
        }}
        aria-label="Період активності"
      >
        {ACTIVITY_PERIOD_LABELS.map((option) => (
          <ToggleButton key={option.value} value={option.value}>
            {option.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      {loading ? (
        <Stack alignItems="center" sx={{ py: 4 }}>
          <CircularProgress aria-label="Завантаження активності" />
        </Stack>
      ) : chartData !== null ? (
        <NetworkDetailsActivityChart
          chartData={chartData}
          hoveredBar={hoveredBar}
          onHoveredBarChange={setHoveredBar}
          headingId="unit-activity-chart-title"
        />
      ) : null}
    </Stack>
  );
}
