import CloseIcon from '@mui/icons-material/Close';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import {
  CircularProgress,
  Drawer,
  IconButton,
  MenuItem,
  Select,
  useMediaQuery,
} from '@mui/material';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { AiAgentMapSummary } from '../../../../Bindings';
import { designTokens } from '../../../../design-system/design-tokens';
import {
  BASE_LAYER_IDS,
  BASE_LAYER_LABELS,
  DEFAULT_BASE_LAYER_ID,
  isBaseLayerId,
} from '../../../maps/base-layers';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerMenu } from '../../components/PowerMenu';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { downloadAiAgentMap } from '../../services/api/ai-agent';
import { CitationMarkdown } from './CitationMarkdown';
import { useMapDocument } from './map-documents';

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
  const [recordIndex, setRecordIndex] = useState<number | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [downloading, setDownloading] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const { notify } = usePowerSnackbar();
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  const record = recordIndex == null ? null : document?.records[recordIndex];

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
        <h2 className="min-w-0 flex-1 truncate text-echo-base" title={summary.title}>
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
        <Select
          size="small"
          value={baseLayerId}
          inputProps={{ 'aria-label': 'Базовий шар мапи' }}
          onChange={(event) => {
            if (isBaseLayerId(event.target.value)) setBaseLayerId(event.target.value);
          }}
        >
          {BASE_LAYER_IDS.map((id) => (
            <MenuItem key={id} value={id}>
              {BASE_LAYER_LABELS[id]}
            </MenuItem>
          ))}
        </Select>
      </div>
      {summary.warnings.length ? (
        <details className="max-h-40 overflow-auto p-echo-sm">
          <summary>Попередження координат ({summary.warnings.length})</summary>
          <ul>
            {summary.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
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
        <>
          <div className="flex min-h-0 flex-1" data-testid="ai-map-stage">
            <Suspense fallback={<CircularProgress />}>
              <MapCanvas
                key={document.id}
                document={document}
                baseLayerId={baseLayerId}
                onSelect={setRecordIndex}
              />
            </Suspense>
          </div>
          <div className="max-h-[40%] overflow-auto border-t border-echo-border p-echo-sm">
            <Select
              displayEmpty
              fullWidth
              size="small"
              value={recordIndex ?? ''}
              inputProps={{ 'aria-label': 'Запис мапи' }}
              onChange={(event) =>
                setRecordIndex(event.target.value === '' ? null : Number(event.target.value))
              }
            >
              <MenuItem value="">Оберіть точку або запис</MenuItem>
              {document.records.map((item, index) => (
                <MenuItem key={index} value={index}>
                  {index + 1}. {item.name}
                </MenuItem>
              ))}
            </Select>
            {record ? (
              <div className="mt-echo-sm" data-testid="ai-map-record-details">
                <h3>{record.name}</h3>
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
            ) : null}
          </div>
        </>
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
