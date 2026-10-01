import CloseIcon from '@mui/icons-material/Close';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import HistoryIcon from '@mui/icons-material/History';
import RedoIcon from '@mui/icons-material/Redo';
import UndoIcon from '@mui/icons-material/Undo';
import ViewSidebarOutlinedIcon from '@mui/icons-material/ViewSidebarOutlined';
import {
  CircularProgress,
  Drawer,
  IconButton,
  InputBase,
  ListItemText,
  MenuItem,
  Tooltip,
  useMediaQuery,
} from '@mui/material';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type {
  AiAgentMapEditTarget,
  AiAgentMapRecord,
  AiAgentMapSidcComponents,
  AiAgentMapSummary,
  AiAgentMapWorkspaceRsp,
} from '../../../../Bindings';
import { designTokens } from '../../../../design-system/design-tokens';
import { DEFAULT_BASE_LAYER_ID } from '../../../maps/base-layers';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerMenu } from '../../components/PowerMenu';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { downloadAiAgentMap } from '../../services/api/ai-agent';
import { CoordinateMapPreviewControls } from '../shared/message-card/CoordinateMapPreviewControls';
import { loadCatalog, type App6dCatalog } from './app6d-catalog';
import { MapInspector, type InspectorTab } from './MapInspector';
import {
  componentsOperation,
  editingTarget,
  originLabel,
  removeOperation,
  titleOperation,
} from './map-edit';
import { symbolPngBase64 } from './map-symbol';
import { useMapWorkspace, type MapWorkspaceState } from './use-map-workspace';
import './maps.css';

const MapCanvas = lazy(() => import('./MapCanvas'));
const PULSE_MS = 2_400;

function editableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="listbox"]'))
  );
}

function useCatalog() {
  const [catalog, setCatalog] = useState<App6dCatalog | null>(null);
  const { notify } = usePowerSnackbar();
  useEffect(() => {
    let cancelled = false;
    loadCatalog()
      .then((loaded) => {
        if (!cancelled) setCatalog(loaded);
      })
      .catch(() =>
        notify({ severity: 'warning', message: 'Каталог позначок APP-6D недоступний.' }),
      );
    return () => {
      cancelled = true;
    };
  }, [notify]);
  return catalog;
}

/** Ids changed by the latest revision, highlighted briefly after it lands. */
function usePulse(workspace: AiAgentMapWorkspaceRsp | null): ReadonlySet<string> {
  const [pulse, setPulse] = useState<ReadonlySet<string>>(() => new Set());
  const revisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (!workspace) return;
    const previous = revisionRef.current;
    revisionRef.current = workspace.revision;
    if (previous === null || previous === workspace.revision) return;
    setPulse(new Set(workspace.changes.changes.map((change) => change.id)));
    const timer = window.setTimeout(() => setPulse(new Set()), PULSE_MS);
    return () => window.clearTimeout(timer);
  }, [workspace]);
  return pulse;
}

function useSelection(records: AiAgentMapRecord[] | undefined) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    if (!records) return;
    const live = new Set(records.map((record) => record.id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => live.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [records]);
  return {
    selectedIds,
    focusId,
    select(id: string, additive: boolean) {
      setFocusId(id);
      setSelectedIds((current) => {
        if (!additive) return new Set([id]);
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    selectMany(ids: string[], additive = false) {
      setSelectedIds((current) => new Set(additive ? [...current, ...ids] : ids));
    },
    clear() {
      setSelectedIds(new Set());
    },
  };
}

async function saveDownload(summary: AiAgentMapSummary, format: 'csv' | 'kmz', sidcs: string[]) {
  const icons =
    format === 'kmz'
      ? sidcs.flatMap((sidc) => {
          const pngBase64 = symbolPngBase64(sidc);
          return pngBase64 ? [{ sidc, pngBase64 }] : [];
        })
      : [];
  const blob = await downloadAiAgentMap(summary, format, icons);
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = `map-${summary.id}.${format}`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TitleField({ title, onRename }: { title: string; onRename: (title: string) => void }) {
  const [value, setValue] = useState(title);
  useEffect(() => setValue(title), [title]);
  const commit = () => {
    const next = value.trim();
    if (next && next !== title) onRename(next);
    else setValue(title);
  };
  return (
    <InputBase
      className="ai-map-title"
      value={value}
      inputProps={{ 'aria-label': 'Назва мапи', title }}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        if (event.key === 'Escape') {
          event.stopPropagation();
          setValue(title);
        }
      }}
    />
  );
}

function RevisionControls({ state }: { state: MapWorkspaceState }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const workspace = state.workspace;
  const head = workspace?.revisions.find((item) => item.revision === workspace.revision);
  return (
    <>
      <Tooltip title={head ? `Скасувати: ${head.summary} (Ctrl+Z)` : 'Скасувати (Ctrl+Z)'}>
        <span>
          <IconButton
            aria-label="Скасувати зміну"
            disabled={!workspace?.canUndo || state.busy}
            onClick={() => void state.undo()}
          >
            <UndoIcon />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Повторити (Ctrl+Y)">
        <span>
          <IconButton
            aria-label="Повторити зміну"
            disabled={!workspace?.canRedo || state.busy}
            onClick={() => void state.redo()}
          >
            <RedoIcon />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Історія змін">
        <span>
          <IconButton
            aria-label="Історія змін"
            aria-haspopup="menu"
            disabled={!workspace}
            onClick={(event) => setAnchor(event.currentTarget)}
          >
            <HistoryIcon />
          </IconButton>
        </span>
      </Tooltip>
      <PowerMenu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        {workspace?.revisions.map((revision) => (
          <MenuItem
            key={revision.revision}
            selected={revision.revision === workspace.revision}
            disableRipple
          >
            <ListItemText
              primary={`${revision.revision}. ${revision.summary}`}
              secondary={`${originLabel(revision.origin)} · ${revision.createdAt.replace('T', ' ')}`}
            />
          </MenuItem>
        ))}
      </PowerMenu>
    </>
  );
}

export function MapWorkspace({
  summary,
  refreshToken = 0,
  onClose,
  onTargetChange,
}: {
  summary: AiAgentMapSummary;
  refreshToken?: number;
  onClose: () => void;
  onTargetChange?: (target: AiAgentMapEditTarget | null) => void;
}) {
  const wide = useMediaQuery(`(min-width: ${designTokens.breakpoint.lg})`);
  const state = useMapWorkspace(summary, refreshToken);
  const { workspace } = state;
  const records = workspace?.document.records;
  const catalog = useCatalog();
  const pulseIds = usePulse(workspace);
  const selection = useSelection(records);
  const [tab, setTab] = useState<InspectorTab>('records');
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [hiddenSidcs, setHiddenSidcs] = useState<ReadonlySet<string>>(() => new Set());
  const [baseLayerId, setBaseLayerId] = useState(DEFAULT_BASE_LAYER_ID);
  const [exportAnchor, setExportAnchor] = useState<HTMLElement | null>(null);
  const [downloading, setDownloading] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const { notify } = usePowerSnackbar();
  const onTargetChangeRef = useRef(onTargetChange);
  onTargetChangeRef.current = onTargetChange;

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    onTargetChangeRef.current?.(
      workspace ? editingTarget(summary, workspace.revision, [...selection.selectedIds]) : null,
    );
  }, [summary, workspace, selection.selectedIds]);
  useEffect(() => () => onTargetChangeRef.current?.(null), []);

  const visibleRecords = useMemo(
    () => records?.filter((record) => !hiddenSidcs.has(record.sidc)) ?? [],
    [records, hiddenSidcs],
  );
  const sidcs = useMemo(() => [...new Set(records?.map((record) => record.sidc))], [records]);

  function select(id: string, additive: boolean) {
    selection.select(id, additive);
    setTab('selection');
    setInspectorOpen(true);
  }

  async function removeSelected() {
    const ids = [...selection.selectedIds];
    if (!ids.length) return;
    if (await state.edit([removeOperation(ids)], `Видалено ${ids.length}`)) {
      notify({
        severity: 'info',
        message: (
          <span>
            Видалено точок: {ids.length}.{' '}
            <button type="button" className="underline" onClick={() => void state.undo()}>
              Скасувати
            </button>
          </span>
        ),
      });
    }
  }

  function applySymbol(components: Partial<AiAgentMapSidcComponents>) {
    return state.edit([componentsOperation([...selection.selectedIds], components)]);
  }

  async function download(format: 'csv' | 'kmz') {
    setExportAnchor(null);
    setDownloading(true);
    try {
      await saveDownload(summary, format, sidcs);
    } catch {
      notify({
        severity: 'error',
        message: `Не вдалося завантажити ${format.toUpperCase()} мапи. Спробуйте ще раз.`,
      });
    } finally {
      setDownloading(false);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape' && !editableTarget(event.target) && !exportAnchor) {
      onClose();
      return;
    }
    if (editableTarget(event.target) || state.busy) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && selection.selectedIds.size) {
      event.preventDefault();
      void removeSelected();
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey && workspace?.canUndo) {
      event.preventDefault();
      void state.undo();
    } else if ((key === 'y' || (key === 'z' && event.shiftKey)) && workspace?.canRedo) {
      event.preventDefault();
      void state.redo();
    }
  }

  const document = workspace?.document;
  const content = (
    <section
      className="ai-map-workspace"
      aria-label="Мапа відповіді"
      data-testid="ai-map-workspace"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="ai-map-topbar">
        {document ? (
          <TitleField
            title={document.title}
            onRename={(title) => void state.edit([titleOperation(title)])}
          />
        ) : (
          <span className="ai-map-title">{summary.title}</span>
        )}
        {document ? (
          <span className="ai-map-counts">
            {document.validCount} точок
            {document.invalidCount ? ` · ${document.invalidCount} без координат` : ''}
          </span>
        ) : null}
        {state.busy ? <CircularProgress size={16} aria-label="Зберігаємо" /> : null}
        <RevisionControls state={state} />
        <Tooltip title="Завантажити">
          <span>
            <IconButton
              aria-label="Завантажити мапу"
              aria-haspopup="menu"
              disabled={!document || downloading}
              onClick={(event) => setExportAnchor(event.currentTarget)}
            >
              {downloading ? <CircularProgress size={20} /> : <DownloadOutlinedIcon />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={inspectorOpen ? 'Сховати панель' : 'Показати панель'}>
          <IconButton
            aria-label={inspectorOpen ? 'Сховати панель об’єктів' : 'Показати панель об’єктів'}
            aria-pressed={inspectorOpen}
            onClick={() => setInspectorOpen((open) => !open)}
          >
            <ViewSidebarOutlinedIcon />
          </IconButton>
        </Tooltip>
        <IconButton ref={closeRef} aria-label="Закрити мапу" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </header>
      {state.failed ? (
        <div className="p-echo-md">
          <PowerAlert severity="error">Мапа недоступна.</PowerAlert>
          <PowerButton onClick={state.retry}>Спробувати ще раз</PowerButton>
        </div>
      ) : document ? (
        <div className={`ai-map-body${inspectorOpen ? ' has-inspector' : ''}`}>
          <div className="ai-map-stage" data-testid="ai-map-stage">
            <Suspense fallback={<CircularProgress />}>
              <MapCanvas
                fitKey={document.id}
                records={visibleRecords}
                selectedIds={selection.selectedIds}
                pulseIds={pulseIds}
                baseLayerId={baseLayerId}
                focusId={selection.focusId}
                onSelect={select}
                onBoxSelect={(ids, additive) => {
                  selection.selectMany(ids, additive);
                  if (ids.length) setTab('selection');
                }}
                onClearSelection={selection.clear}
              />
            </Suspense>
            <CoordinateMapPreviewControls
              baseLayerId={baseLayerId}
              onBaseLayerChange={setBaseLayerId}
            />
          </div>
          {inspectorOpen ? (
            <MapInspector
              tab={tab}
              onTabChange={setTab}
              records={document.records}
              catalog={catalog}
              selectedIds={selection.selectedIds}
              hiddenSidcs={hiddenSidcs}
              busy={state.busy}
              onToggleHidden={(sidc) =>
                setHiddenSidcs((current) => {
                  const next = new Set(current);
                  if (next.has(sidc)) next.delete(sidc);
                  else next.add(sidc);
                  return next;
                })
              }
              onSelect={select}
              onSelectMany={(ids) => {
                selection.selectMany(ids);
                setTab('selection');
              }}
              onApplySymbol={applySymbol}
              onRemove={() => void removeSelected()}
              onClear={selection.clear}
            />
          ) : null}
        </div>
      ) : (
        <div className="grid flex-1 place-items-center">
          <CircularProgress />
        </div>
      )}
      <PowerMenu
        anchorEl={exportAnchor}
        open={Boolean(exportAnchor)}
        onClose={() => setExportAnchor(null)}
      >
        <MenuItem onClick={() => void download('csv')}>CSV</MenuItem>
        <MenuItem disabled={!document?.validCount} onClick={() => void download('kmz')}>
          {document?.validCount ? 'KMZ' : 'KMZ недоступний: немає коректних точок'}
        </MenuItem>
      </PowerMenu>
    </section>
  );
  return wide ? (
    <div className="ai-map-workspace-frame">{content}</div>
  ) : (
    <Drawer anchor="right" open onClose={onClose} slotProps={{ paper: { className: 'w-full' } }}>
      {content}
    </Drawer>
  );
}
