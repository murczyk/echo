import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { IconButton, InputAdornment, Tab, Tabs, TextField, Tooltip } from '@mui/material';
import { useMemo, useState, type MouseEvent } from 'react';
import type { AiAgentMapRecord, AiAgentMapSidcComponents } from '../../../../Bindings';
import { PowerButton } from '../../components/PowerButton';
import { CitationMarkdown } from './CitationMarkdown';
import { describeSidc, type App6dCatalog } from './app6d-catalog';
import { symbolImage } from './map-symbol';
import { SymbolEditor } from './SymbolEditor';

export type InspectorTab = 'records' | 'selection';

type Group = { sidc: string; label: string; records: AiAgentMapRecord[] };

export function groupBySymbol(records: AiAgentMapRecord[], catalog: App6dCatalog | null): Group[] {
  const groups = new Map<string, Group>();
  for (const record of records) {
    const group = groups.get(record.sidc) ?? {
      sidc: record.sidc,
      label: describeSidc(catalog, record.sidc),
      records: [],
    };
    group.records.push(record);
    groups.set(record.sidc, group);
  }
  return [...groups.values()].sort((a, b) => b.records.length - a.records.length);
}

function matches(record: AiAgentMapRecord, needle: string): boolean {
  if (!needle) return true;
  return [record.name, record.observationDatetime ?? '', ...record.comments]
    .join('\n')
    .toLowerCase()
    .includes(needle);
}

function Glyph({ sidc }: { sidc: string }) {
  const image = symbolImage(sidc, 18);
  return (
    <img
      className="ai-map-glyph"
      src={image.url}
      width={image.width}
      height={image.height}
      alt=""
    />
  );
}

function RecordRow({
  record,
  index,
  selected,
  onSelect,
}: {
  record: AiAgentMapRecord;
  index: number;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
}) {
  const invalid = record.latitude == null || record.longitude == null;
  return (
    <li>
      <button
        type="button"
        className={`ai-map-record-row${selected ? ' is-selected' : ''}`}
        aria-pressed={selected}
        onClick={(event: MouseEvent) =>
          onSelect(record.id, event.ctrlKey || event.metaKey || event.shiftKey)
        }
      >
        <span className="ai-map-record-index">{index + 1}</span>
        <span className="min-w-0 flex-1 truncate" title={record.name}>
          {record.name}
        </span>
        {record.observationDatetime ? (
          <span className="ai-map-record-time">
            {record.observationDatetime.slice(0, 16).replace('T', ' ')}
          </span>
        ) : null}
        {invalid || record.warnings.length ? (
          <Tooltip title={record.warnings.join('; ') || 'Без координат'}>
            <WarningAmberOutlinedIcon fontSize="inherit" color="warning" />
          </Tooltip>
        ) : null}
      </button>
    </li>
  );
}

function RecordList({
  records,
  catalog,
  selectedIds,
  hiddenSidcs,
  onToggleHidden,
  onSelect,
  onSelectMany,
}: {
  records: AiAgentMapRecord[];
  catalog: App6dCatalog | null;
  selectedIds: ReadonlySet<string>;
  hiddenSidcs: ReadonlySet<string>;
  onToggleHidden: (sidc: string) => void;
  onSelect: (id: string, additive: boolean) => void;
  onSelectMany: (ids: string[]) => void;
}) {
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const positions = useMemo(
    () => new Map(records.map((record, index) => [record.id, index])),
    [records],
  );
  const groups = useMemo(
    () =>
      groupBySymbol(
        records.filter((record) => matches(record, needle)),
        catalog,
      ),
    [records, catalog, needle],
  );
  return (
    <div className="ai-map-record-list">
      <TextField
        size="small"
        placeholder="Фільтр за назвою чи коментарем"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        slotProps={{
          input: {
            endAdornment: filter ? (
              <InputAdornment position="end">
                <button
                  type="button"
                  className="text-echo-text-muted"
                  onClick={() => setFilter('')}
                >
                  ×
                </button>
              </InputAdornment>
            ) : null,
          },
        }}
      />
      {groups.map((group) => {
        const hidden = hiddenSidcs.has(group.sidc);
        return (
          <section key={group.sidc} className={`ai-map-group${hidden ? ' is-hidden' : ''}`}>
            <header>
              <Glyph sidc={group.sidc} />
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                title="Вибрати всі точки групи"
                onClick={() => onSelectMany(group.records.map((record) => record.id))}
              >
                {group.label} <span className="text-echo-text-muted">{group.records.length}</span>
              </button>
              <IconButton
                size="small"
                aria-label={hidden ? 'Показати групу на мапі' : 'Сховати групу з мапи'}
                onClick={() => onToggleHidden(group.sidc)}
              >
                {hidden ? (
                  <VisibilityOffOutlinedIcon fontSize="small" />
                ) : (
                  <VisibilityOutlinedIcon fontSize="small" />
                )}
              </IconButton>
            </header>
            <ul>
              {group.records.map((record) => (
                <RecordRow
                  key={record.id}
                  record={record}
                  index={positions.get(record.id) ?? 0}
                  selected={selectedIds.has(record.id)}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {!groups.length ? (
        <p className="p-echo-sm text-echo-text-muted">Нічого не знайдено.</p>
      ) : null}
    </div>
  );
}

function RecordDetails({ record }: { record: AiAgentMapRecord }) {
  return (
    <div className="ai-map-record-details" data-testid="ai-map-record-details">
      <h3>{record.name}</h3>
      <p>{record.observationDatetime?.replace('T', ' ') || 'Дата не вказана'}</p>
      <p>
        {record.coordinateSystem}: X={record.originalX}, Y={record.originalY}
      </p>
      {record.warnings.map((warning) => (
        <p key={warning} className="text-echo-warning">
          {warning}
        </p>
      ))}
      {record.comments.map((comment, index) => (
        <p key={index} className="ai-map-comment">
          {comment}
        </p>
      ))}
      {record.sources.length ? (
        <CitationMarkdown citations={record.sources}>
          {record.sources
            .map(
              (source) =>
                `[джерело](/rer-analysis-neo?${new URLSearchParams({ m: source.messageIdentifier })})`,
            )
            .join(' ')}
        </CitationMarkdown>
      ) : null}
    </div>
  );
}

function Selection({
  records,
  catalog,
  busy,
  onApplySymbol,
  onRemove,
  onClear,
}: {
  records: AiAgentMapRecord[];
  catalog: App6dCatalog | null;
  busy: boolean;
  onApplySymbol: (components: Partial<AiAgentMapSidcComponents>) => Promise<boolean>;
  onRemove: () => void;
  onClear: () => void;
}) {
  if (!records.length) {
    return (
      <p className="p-echo-md text-echo-text-muted">
        Виберіть точки на мапі або у списку. Shift+перетягування — вибір рамкою, Ctrl+клік — додати
        до вибору.
      </p>
    );
  }
  return (
    <div className="ai-map-selection">
      <div className="flex items-center gap-echo-sm">
        <strong className="flex-1">Вибрано: {records.length}</strong>
        <PowerButton type="button" size="small" variant="text" onClick={onClear}>
          Зняти вибір
        </PowerButton>
        <Tooltip title="Видалити вибрані (Delete)">
          <span>
            <IconButton
              size="small"
              aria-label="Видалити вибрані"
              disabled={busy}
              onClick={onRemove}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </div>
      <SymbolEditor catalog={catalog} records={records} busy={busy} onApply={onApplySymbol} />
      {records.length === 1 ? <RecordDetails record={records[0]} /> : null}
    </div>
  );
}

export function MapInspector({
  tab,
  onTabChange,
  records,
  catalog,
  selectedIds,
  hiddenSidcs,
  busy,
  onToggleHidden,
  onSelect,
  onSelectMany,
  onApplySymbol,
  onRemove,
  onClear,
}: {
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  records: AiAgentMapRecord[];
  catalog: App6dCatalog | null;
  selectedIds: ReadonlySet<string>;
  hiddenSidcs: ReadonlySet<string>;
  busy: boolean;
  onToggleHidden: (sidc: string) => void;
  onSelect: (id: string, additive: boolean) => void;
  onSelectMany: (ids: string[]) => void;
  onApplySymbol: (components: Partial<AiAgentMapSidcComponents>) => Promise<boolean>;
  onRemove: () => void;
  onClear: () => void;
}) {
  const selected = records.filter((record) => selectedIds.has(record.id));
  return (
    <aside className="ai-map-inspector" aria-label="Інспектор мапи">
      <Tabs
        value={tab}
        onChange={(_event, value: InspectorTab) => onTabChange(value)}
        variant="fullWidth"
      >
        <Tab value="records" label={`Об'єкти (${records.length})`} />
        <Tab value="selection" label={`Вибране (${selected.length})`} />
      </Tabs>
      <div className="ai-map-inspector-body">
        {tab === 'records' ? (
          <RecordList
            records={records}
            catalog={catalog}
            selectedIds={selectedIds}
            hiddenSidcs={hiddenSidcs}
            onToggleHidden={onToggleHidden}
            onSelect={onSelect}
            onSelectMany={onSelectMany}
          />
        ) : (
          <Selection
            records={selected}
            catalog={catalog}
            busy={busy}
            onApplySymbol={onApplySymbol}
            onRemove={onRemove}
            onClear={onClear}
          />
        )}
      </div>
    </aside>
  );
}
