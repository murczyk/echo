import CloseIcon from '@mui/icons-material/Close';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import { CircularProgress, Drawer, IconButton, MenuItem, useMediaQuery } from '@mui/material';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { AiAgentMapRecord, AiAgentMapSummary } from '../../../../Bindings';
import { designTokens } from '../../../../design-system/design-tokens';
import { DEFAULT_BASE_LAYER_ID } from '../../../maps/base-layers';
import { CoordinateMapPreviewControls } from '../shared/message-card/CoordinateMapPreviewControls';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerMenu } from '../../components/PowerMenu';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { downloadAiAgentMap } from '../../services/api/ai-agent';
import { CitationMarkdown } from './CitationMarkdown';
import { useMapDocument } from './map-documents';
import './maps.css';

const MapCanvas = lazy(() => import('./MapCanvas'));

export function MapPanel({
  summary,
  onClose,
}: {
  summary: AiAgentMapSummary;
  onClose: () => void;
}) {
  const wide = useMediaQuery(`(min-width: ${designTokens.breakpoint.lg})`);
  const { document, failed, retry } = useMapDocument(summary);
  const [baseLayerId, setBaseLayerId] = useState(DEFAULT_BASE_LAYER_ID);
  const [recordIndex, setRecordIndex] = useState(0);
  const [showRecord, setShowRecord] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [downloading, setDownloading] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const { notify } = usePowerSnackbar();
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  const record = showRecord ? document?.records[recordIndex] : null;

  function selectRecord(index: number) {
    setRecordIndex(index);
    setShowRecord(true);
  }

  async function download(format: 'csv' | 'kmz') {
    setMenuAnchor(null);
    setDownloading(true);
    try {
      const blob = await downloadAiAgentMap(summary, format);
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `map-${summary.id}.${format}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      notify({
        severity: 'error',
        message: `Не вдалося завантажити ${format.toUpperCase()} мапи. Спробуйте ще раз.`,
      });
    } finally {
      setDownloading(false);
    }
  }

  const content = (
    <section
      className="flex h-full min-h-0 w-full flex-col bg-echo-surface text-echo-text"
      aria-label="Мапа відповіді"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !menuAnchor) onClose();
      }}
    >
      <header className="flex items-center gap-echo-sm border-b border-echo-border p-echo-sm">
        <h2 className="ai-map-panel-title min-w-0 flex-1 truncate" title={summary.title}>
          {summary.title}
        </h2>
        <IconButton
          type="button"
          aria-label="Завантажити мапу"
          aria-haspopup="menu"
          disabled={!document || downloading}
          onClick={(event) => setMenuAnchor(event.currentTarget)}
        >
          {downloading ? <CircularProgress size={20} /> : <DownloadOutlinedIcon />}
        </IconButton>
        <IconButton ref={closeRef} type="button" aria-label="Закрити мапу" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </header>
      <div className="flex items-center justify-between gap-echo-sm p-echo-sm">
        <span>
          {summary.totalCount} записів · {summary.validCount} точок · {summary.invalidCount}{' '}
          некоректних
        </span>
      </div>
      {summary.warnings.length || summary.invalidCount ? (
        <details className="max-h-40 overflow-auto p-echo-sm">
          <summary>Попередження координат ({summary.warnings.length})</summary>
          <ul>
            {summary.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
          {document ? (
            <ul>
              {document.records.map((item, index) =>
                item.latitude == null || item.longitude == null ? (
                  <li key={index}>
                    <button type="button" className="underline" onClick={() => selectRecord(index)}>
                      {index + 1}. {item.name}
                    </button>
                  </li>
                ) : null,
              )}
            </ul>
          ) : null}
        </details>
      ) : null}
      {!summary.validCount ? (
        <p className="p-echo-sm">
          KMZ недоступний: мапа не містить коректних точок. Завантажте CSV.
        </p>
      ) : null}
      {failed ? (
        <div className="p-echo-sm">
          <PowerAlert severity="error">Мапа недоступна.</PowerAlert>
          <PowerButton onClick={retry}>Спробувати ще раз</PowerButton>
        </div>
      ) : document ? (
        <div className="relative isolate flex min-h-0 flex-1" data-testid="ai-map-stage">
          <Suspense fallback={<CircularProgress />}>
            <MapCanvas
              key={document.id}
              document={document}
              baseLayerId={baseLayerId}
              onSelect={selectRecord}
            />
          </Suspense>
          <CoordinateMapPreviewControls
            baseLayerId={baseLayerId}
            onBaseLayerChange={setBaseLayerId}
            pointNavigation={{
              index: recordIndex,
              count: document.records.length,
              onPrevious: () =>
                selectRecord((recordIndex - 1 + document.records.length) % document.records.length),
              onNext: () => selectRecord((recordIndex + 1) % document.records.length),
            }}
          />
          {record ? (
            <MapRecordDetails record={record} onClose={() => setShowRecord(false)} />
          ) : null}
        </div>
      ) : (
        <div className="grid flex-1 place-items-center">
          <CircularProgress />
        </div>
      )}
      <PowerMenu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={() => setMenuAnchor(null)}
      >
        <MenuItem onClick={() => void download('csv')}>CSV</MenuItem>
        <MenuItem disabled={!summary.validCount} onClick={() => void download('kmz')}>
          KMZ
        </MenuItem>
      </PowerMenu>
    </section>
  );
  return wide ? (
    <aside className="flex h-full min-w-0 flex-1 border-l border-echo-border">{content}</aside>
  ) : (
    <Drawer anchor="right" open onClose={onClose} slotProps={{ paper: { className: 'w-full' } }}>
      {content}
    </Drawer>
  );
}

function MapRecordDetails({ record, onClose }: { record: AiAgentMapRecord; onClose: () => void }) {
  return (
    <div className="ai-map-record-details" data-testid="ai-map-record-details">
      <div className="flex items-start gap-echo-xs">
        <h3 className="min-w-0 flex-1">{record.name}</h3>
        <IconButton type="button" size="small" aria-label="Закрити картку запису" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </div>
      <p>{record.observationDatetime || 'Дата не вказана'}</p>
      <p>
        {record.coordinateSystem}: X={record.originalX}, Y={record.originalY}
      </p>
      {record.comments.map((comment, index) => (
        <p key={index}>{comment}</p>
      ))}
      <CitationMarkdown citations={record.sources}>
        {record.sources
          .map(
            (source) =>
              `[джерело](/rer-analysis-neo?${new URLSearchParams({ m: source.messageIdentifier })})`,
          )
          .join(' ')}
      </CitationMarkdown>
    </div>
  );
}
