import UploadFileIcon from '@mui/icons-material/UploadFile';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  Pagination,
  Paper,
  Snackbar,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  BattleLineState,
  BattleLineTestRsp,
  BattleLineUnlinkedInboxRsp,
  BattleLineUnresolvedLocationsRsp,
} from '../../../../Bindings';
import {
  fetchBattleLineState,
  fetchBattleLineUnlinkedInbox,
  fetchBattleLineUnresolvedLocations,
  testBattleLine,
  uploadBattleLine,
} from '../../services/api/battle-line';
import { toErrorMessage } from '../rer-analysis-neo/use-analysis-data.shared';
import { MessageCard } from '../shared/message-card/MessageCard';
import { BattleLineMap } from './BattleLineMap';

function ReadOnlyMessage({ id, message }: { id: number; message: BattleLineTestRsp['message'] }) {
  return (
    <MessageCard
      id={id}
      msg={message}
      readOnly
      displayMode="analysis"
      analysisDestination="neo"
      referenceTimeMs={Date.now()}
      authUserName={null}
      groupName={message.groupMasterKey}
      senderName={message.sender}
      copiedFeedbackId={null}
      networkDisplayMap={{}}
      tagsMap={{}}
    />
  );
}

function formatVersionTime(timestamp: number | null): string {
  return timestamp == null ? '—' : new Date(timestamp).toLocaleString('uk-UA');
}

function LbzTab({ state, reload }: { state: BattleLineState; reload: () => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const testSerialRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [inboxItemId, setInboxItemId] = useState('');
  const [testResult, setTestResult] = useState<BattleLineTestRsp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    testSerialRef.current += 1;
    setTesting(false);
    setTestResult(null);
  }, [state.activeVersion?.id]);

  const selectedSettlements = useMemo(
    () =>
      (testResult?.locations ?? []).flatMap((location) => {
        const selected = location.candidates.find(
          (candidate) => candidate.settlementId === location.chosenSettlementId,
        );
        return selected
          ? [
              {
                id: selected.settlementId,
                lat: selected.coordinate.lat,
                lon: selected.coordinate.lon,
                label: `${location.location}: ${selected.name}`,
              },
            ]
          : [];
      }),
    [testResult],
  );

  const submitUpload = async (file: File) => {
    if (state.activeVersion && !window.confirm('Замінити активну ЛБЗ новим файлом?')) return;
    testSerialRef.current += 1;
    setTesting(false);
    setTestResult(null);
    setUploading(true);
    setError(null);
    try {
      await uploadBattleLine(file);
      await reload();
    } catch (uploadError) {
      setError(toErrorMessage(uploadError));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const submitTest = async () => {
    const id = Number(inboxItemId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      setError('Вкажіть коректний ID перехоплення');
      return;
    }
    const serial = testSerialRef.current + 1;
    testSerialRef.current = serial;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const result = await testBattleLine(id);
      if (testSerialRef.current === serial) setTestResult(result);
    } catch (testError) {
      if (testSerialRef.current === serial) setError(toErrorMessage(testError));
    } finally {
      if (testSerialRef.current === serial) setTesting(false);
    }
  };

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} justifyContent="space-between">
          <Box>
            <Typography variant="h6">Активна версія</Typography>
            {state.activeVersion ? (
              <Typography variant="body2">
                {state.activeVersion.sourceFileName} · {state.activeVersion.uploaderLogin} ·{' '}
                {formatVersionTime(state.activeVersion.uploadedAtTs)}
              </Typography>
            ) : (
              <Typography color="text.secondary">ЛБЗ ще не завантажено</Typography>
            )}
          </Box>
          <Button
            component="label"
            variant="contained"
            startIcon={uploading ? <CircularProgress size={18} /> : <UploadFileIcon />}
            disabled={uploading}
          >
            Завантажити KML/KMZ
            <input
              ref={inputRef}
              hidden
              type="file"
              accept=".kml,.kmz"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void submitUpload(file);
              }}
            />
          </Button>
        </Stack>
      </Paper>

      <BattleLineMap
        state={testResult?.battleLine ?? state}
        selectedSettlements={selectedSettlements}
      />

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h6" gutterBottom>
          Перевірка прив'язки населених пунктів
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Введіть ID перехоплення. Пошук використовує всі доступні групи та об'єднання їхніх AOR.
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 2 }}>
          <TextField
            size="small"
            label="ID перехоплення"
            value={inboxItemId}
            onChange={(event) => setInboxItemId(event.target.value)}
          />
          <Button
            variant="contained"
            onClick={() => void submitTest()}
            disabled={testing || !state.activeVersion}
          >
            {testing ? <CircularProgress size={20} /> : 'Перевірити'}
          </Button>
        </Stack>
        {testResult ? (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) minmax(0, 1fr)' },
              gap: 2,
            }}
          >
            <ReadOnlyMessage id={testResult.inboxItemId} message={testResult.message} />
            <Stack spacing={1}>
              <Typography variant="body2">
                Групи: {testResult.groupMasterKeys.join(', ') || 'немає'}
              </Typography>
              <Typography variant="body2">
                AOR: {testResult.aorIds.join(', ') || 'повна ЛБЗ'}
              </Typography>
              {testResult.locations.length === 0 ? (
                <Alert severity="info">У location_v2 немає локацій</Alert>
              ) : (
                testResult.locations.map((location) => (
                  <Paper key={location.location} variant="outlined" sx={{ p: 1.5 }}>
                    <Typography fontWeight={600}>{location.location}</Typography>
                    <Typography variant="body2">
                      Обрано: {location.chosenSettlementId ?? 'немає'}
                      {location.distanceM == null ? '' : ` · ${Math.round(location.distanceM)} м`}
                    </Typography>
                    <Typography variant="caption" display="block">
                      Кандидати:{' '}
                      {location.candidates
                        .map((candidate) => `${candidate.name} #${candidate.settlementId}`)
                        .join(', ') || 'немає'}
                    </Typography>
                    {location.invalidAorIds.length > 0 ? (
                      <Typography variant="caption" color="warning.main">
                        Недійсні AOR: {location.invalidAorIds.join(', ')}
                      </Typography>
                    ) : null}
                  </Paper>
                ))
              )}
            </Stack>
          </Box>
        ) : null}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="h6">Попередні версії</Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Файл</TableCell>
              <TableCell>Автор</TableCell>
              <TableCell>Завантажено</TableCell>
              <TableCell>Завершено</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {state.previousVersions.map((version) => (
              <TableRow key={version.id}>
                <TableCell>{version.sourceFileName}</TableCell>
                <TableCell>{version.uploaderLogin}</TableCell>
                <TableCell>{formatVersionTime(version.uploadedAtTs)}</TableCell>
                <TableCell>{formatVersionTime(version.retiredAtTs)}</TableCell>
              </TableRow>
            ))}
            {state.previousVersions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4}>Історія порожня</TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Paper>
      <Snackbar open={error != null} autoHideDuration={8000} onClose={() => setError(null)}>
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      </Snackbar>
    </Stack>
  );
}

function UnlinkedTab() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<BattleLineUnlinkedInboxRsp | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    fetchBattleLineUnlinkedInbox({ page }, { signal: controller.signal })
      .then(setData)
      .catch((loadError) => {
        if (!controller.signal.aborted) setError(toErrorMessage(loadError));
      });
    return () => controller.abort();
  }, [page]);
  if (!data) return error ? <Alert severity="error">{error}</Alert> : <CircularProgress />;
  return (
    <Stack spacing={2}>
      {data.items.length === 0 ? (
        <Alert severity="info">Перехоплень без НП немає</Alert>
      ) : (
        data.items.map(([id, message]) => (
          <Paper key={id} variant="outlined">
            <ReadOnlyMessage id={id} message={message} />
          </Paper>
        ))
      )}
      <Pagination
        page={page}
        count={Math.max(1, Math.ceil(data.total / data.pageSize))}
        onChange={(_, value) => setPage(value)}
      />
    </Stack>
  );
}

function UnresolvedTab() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<BattleLineUnresolvedLocationsRsp | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    fetchBattleLineUnresolvedLocations({ page }, { signal: controller.signal })
      .then(setData)
      .catch((loadError) => {
        if (!controller.signal.aborted) setError(toErrorMessage(loadError));
      });
    return () => controller.abort();
  }, [page]);
  if (!data) return error ? <Alert severity="error">{error}</Alert> : <CircularProgress />;
  return (
    <Stack spacing={2}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Локація</TableCell>
            <TableCell align="right">Кількість</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {data.items.map((item) => (
            <TableRow key={item.settlementText}>
              <TableCell>{item.settlementText}</TableCell>
              <TableCell align="right">{item.itemCount}</TableCell>
            </TableRow>
          ))}
          {data.items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={2}>Невизначених локацій немає</TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      <Pagination
        page={page}
        count={Math.max(1, Math.ceil(data.total / data.pageSize))}
        onChange={(_, value) => setPage(value)}
      />
    </Stack>
  );
}

export function AdminBattleLinePage() {
  const [tab, setTab] = useState(0);
  const [state, setState] = useState<BattleLineState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadSerialRef = useRef(0);
  const reload = useCallback(async () => {
    const serial = loadSerialRef.current + 1;
    loadSerialRef.current = serial;
    setError(null);
    try {
      const nextState = await fetchBattleLineState();
      if (loadSerialRef.current === serial) setState(nextState);
    } catch (loadError) {
      if (loadSerialRef.current === serial) setError(toErrorMessage(loadError));
    }
  }, []);
  useEffect(() => {
    void reload();
    return () => {
      loadSerialRef.current += 1;
    };
  }, [reload]);
  return (
    <Stack spacing={2} sx={{ height: '100%', minHeight: 0 }}>
      <Typography variant="h4">Карта</Typography>
      <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable">
        <Tab label="ЛБЗ" />
        <Tab label="ПЕРЕХОПЛЕННЯ БЕЗ НП" />
        <Tab label="НЕВИЗНАЧЕНІ ЛОКАЦІЇ" />
      </Tabs>
      <Divider />
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 0 ? state ? <LbzTab state={state} reload={reload} /> : <CircularProgress /> : null}
        {tab === 1 ? <UnlinkedTab /> : null}
        {tab === 2 ? <UnresolvedTab /> : null}
      </Box>
      <Snackbar open={error != null} autoHideDuration={8000} onClose={() => setError(null)}>
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      </Snackbar>
    </Stack>
  );
}
