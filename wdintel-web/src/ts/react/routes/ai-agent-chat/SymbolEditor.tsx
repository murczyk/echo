import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import {
  Autocomplete,
  IconButton,
  Menu,
  MenuItem,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import type { AiAgentMapRecord, AiAgentMapSidcComponents } from '../../../../Bindings';
import { PowerButton } from '../../components/PowerButton';
import {
  describeSidc,
  joinSidc,
  searchSymbolTypes,
  sidcParts,
  symbolTypeOf,
  type App6dCatalog,
  type SymbolType,
} from './app6d-catalog';
import { symbolImage } from './map-symbol';

// Friend and hostile cover almost every map; the rest sit in an overflow menu.
const MAIN_IDENTITIES = [
  { code: '3', label: 'Дружній' },
  { code: '6', label: 'Ворожий' },
];
const EXTRA_IDENTITIES = [
  { code: '4', label: 'Нейтральний' },
  { code: '1', label: 'Невідомий' },
  { code: '5', label: 'Підозрілий' },
];
const STATUSES = ['0', '1', '3', '4'];
const KEEP = '';

type Draft = {
  identity: string;
  status: string;
  echelon: string;
  type: SymbolType | null;
};

const EMPTY_DRAFT: Draft = { identity: KEEP, status: KEEP, echelon: KEEP, type: null };

function shared(values: string[]): string {
  return values.every((value) => value === values[0]) ? (values[0] ?? KEEP) : KEEP;
}

/** Components that differ from what the selection already has. */
export function draftComponents(
  draft: Draft,
  records: AiAgentMapRecord[],
): Partial<AiAgentMapSidcComponents> {
  const parts = records.map((record) => sidcParts(record.sidc));
  const changed = (value: string, current: string[]) =>
    value !== KEEP && current.some((item) => item !== value) ? value : null;
  const components: Partial<AiAgentMapSidcComponents> = {};
  const identity = changed(
    draft.identity,
    parts.map((part) => part.identity),
  );
  const status = changed(
    draft.status,
    parts.map((part) => part.status),
  );
  const echelon = changed(
    draft.echelon,
    parts.map((part) => part.echelon),
  );
  if (identity) components.identity = identity;
  if (status) components.status = status;
  if (echelon) components.echelon = echelon;
  if (draft.type) {
    const type = draft.type;
    const differs = parts.some(
      (part) =>
        part.symbolSet !== type.symbolSet ||
        part.entity !== type.entity ||
        part.modifier1 !== type.modifier1 ||
        part.modifier2 !== type.modifier2,
    );
    if (differs) {
      components.symbolSet = type.symbolSet;
      components.mainIcon = type.entity;
      components.modifier1 = type.modifier1;
      components.modifier2 = type.modifier2;
    }
  }
  return components;
}

function previewSidc(record: AiAgentMapRecord, components: Partial<AiAgentMapSidcComponents>) {
  const parts = sidcParts(record.sidc);
  return joinSidc({
    ...parts,
    identity: components.identity ?? parts.identity,
    status: components.status ?? parts.status,
    echelon: components.echelon ?? parts.echelon,
    symbolSet: components.symbolSet ?? parts.symbolSet,
    entity: components.mainIcon ?? parts.entity,
    modifier1: components.modifier1 ?? parts.modifier1,
    modifier2: components.modifier2 ?? parts.modifier2,
  });
}

function SymbolGlyph({ sidc, size = 28 }: { sidc: string; size?: number }) {
  const image = symbolImage(sidc, size);
  return <img src={image.url} width={image.width} height={image.height} alt="" />;
}

export function SymbolEditor({
  catalog,
  records,
  busy,
  onApply,
}: {
  catalog: App6dCatalog | null;
  records: AiAgentMapRecord[];
  busy: boolean;
  onApply: (components: Partial<AiAgentMapSidcComponents>) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [query, setQuery] = useState('');
  const [identityMenu, setIdentityMenu] = useState<HTMLElement | null>(null);
  const [showMore, setShowMore] = useState(false);
  const selectionKey = records.map((record) => `${record.id}:${record.sidc}`).join('|');
  useEffect(() => setDraft(EMPTY_DRAFT), [selectionKey]);
  const parts = records.map((record) => sidcParts(record.sidc));
  const current = {
    identity: shared(parts.map((part) => part.identity)),
    status: shared(parts.map((part) => part.status)),
    echelon: shared(parts.map((part) => part.echelon)),
  };
  const components = draftComponents(draft, records);
  const changed = Object.keys(components).length > 0;
  const preview = records[0] ? previewSidc(records[0], components) : null;
  const options = useMemo(
    () => (catalog ? searchSymbolTypes(catalog, query, 40) : []),
    [catalog, query],
  );
  const currentType = catalog && records[0] ? symbolTypeOf(catalog, records[0].sidc) : null;
  const echelons = catalog ? [...catalog.echelons, ...catalog.mobility] : [];

  async function apply() {
    if (await onApply(components)) setDraft(EMPTY_DRAFT);
  }

  return (
    <div className="ai-map-symbol-editor" data-testid="ai-map-symbol-editor">
      <div className="flex items-center gap-echo-sm">
        {preview ? <SymbolGlyph sidc={preview} size={40} /> : null}
        <Typography variant="body2" className="min-w-0 flex-1">
          {preview ? describeSidc(catalog, preview) : ''}
          {records.length > 1 ? ` · ${records.length} точок` : ''}
        </Typography>
      </div>
      <IdentityPicker
        value={draft.identity || current.identity}
        anchor={identityMenu}
        onAnchor={setIdentityMenu}
        onChange={(identity) => setDraft((state) => ({ ...state, identity }))}
      />
      <Autocomplete<SymbolType>
        size="small"
        options={options}
        // Shows the current type until another is picked.
        value={draft.type ?? currentType}
        filterOptions={(items) => items}
        isOptionEqualToValue={(option, value) =>
          option.symbolSet === value.symbolSet &&
          option.entity === value.entity &&
          option.modifier1 === value.modifier1
        }
        getOptionLabel={(option) => option.label}
        onInputChange={(_event, value) => setQuery(value)}
        onChange={(_event, value) => setDraft((state) => ({ ...state, type: value }))}
        noOptionsText={catalog ? 'Нічого не знайдено' : 'Завантаження каталогу…'}
        renderOption={(props, option) => {
          const { key, ...rest } = props as typeof props & { key: string };
          const sample = records[0]
            ? previewSidc(records[0], {
                symbolSet: option.symbolSet,
                mainIcon: option.entity,
                modifier1: option.modifier1,
                modifier2: option.modifier2,
              })
            : null;
          return (
            <li key={key} {...rest} className={`${rest.className ?? ''} ai-map-type-option`}>
              {sample ? <SymbolGlyph sidc={sample} size={22} /> : null}
              <span>
                {option.label}
                <small>{option.detail}</small>
              </span>
            </li>
          );
        }}
        renderInput={(params) => (
          <TextField {...params} label="Тип позначки" placeholder="Танк, БпЛА, РЕБ…" />
        )}
      />
      <div className="grid grid-cols-2 items-center gap-echo-sm">
        <TextField
          select
          size="small"
          label="Стан"
          value={draft.status || current.status}
          onChange={(event) => setDraft((state) => ({ ...state, status: event.target.value }))}
        >
          {current.status === KEEP ? <MenuItem value={KEEP}>Різний</MenuItem> : null}
          {(catalog?.statuses ?? [])
            .filter((status) => STATUSES.includes(status.code) || status.code === current.status)
            .map((status) => (
              <MenuItem key={status.code} value={status.code}>
                {status.uk}
              </MenuItem>
            ))}
        </TextField>
        <button
          type="button"
          className="ai-map-more-toggle"
          aria-expanded={showMore}
          onClick={() => setShowMore((open) => !open)}
        >
          {showMore ? 'Менше' : 'Більше'}
        </button>
        {showMore || draft.echelon ? (
          <TextField
            select
            size="small"
            label="Ешелон"
            value={draft.echelon || current.echelon}
            onChange={(event) => setDraft((state) => ({ ...state, echelon: event.target.value }))}
          >
            {current.echelon === KEEP ? <MenuItem value={KEEP}>Різний</MenuItem> : null}
            {echelons.map((echelon) => (
              <MenuItem key={echelon.code} value={echelon.code}>
                {echelon.uk}
              </MenuItem>
            ))}
          </TextField>
        ) : null}
      </div>
      <div className="flex justify-end gap-echo-sm">
        <PowerButton
          type="button"
          variant="text"
          disabled={!changed || busy}
          onClick={() => setDraft(EMPTY_DRAFT)}
        >
          Скинути
        </PowerButton>
        <PowerButton
          type="button"
          variant="contained"
          disabled={!changed || busy}
          onClick={() => void apply()}
        >
          Застосувати до {records.length}
        </PowerButton>
      </div>
    </div>
  );
}

function IdentityPicker({
  value,
  anchor,
  onAnchor,
  onChange,
}: {
  value: string;
  anchor: HTMLElement | null;
  onAnchor: (anchor: HTMLElement | null) => void;
  onChange: (identity: string) => void;
}) {
  const extra = EXTRA_IDENTITIES.find((identity) => identity.code === value);
  const shown = extra ? [...MAIN_IDENTITIES, extra] : MAIN_IDENTITIES;
  return (
    <div className="flex items-center gap-echo-xs">
      <ToggleButtonGroup
        exclusive
        size="small"
        aria-label="Приналежність"
        value={value}
        onChange={(_event, next: string | null) => onChange(next ?? KEEP)}
      >
        {shown.map((identity) => (
          <ToggleButton key={identity.code} value={identity.code}>
            {identity.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <IconButton
        size="small"
        aria-label="Інша приналежність"
        aria-haspopup="menu"
        onClick={(event) => onAnchor(event.currentTarget)}
      >
        <MoreHorizIcon fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => onAnchor(null)}>
        {EXTRA_IDENTITIES.map((identity) => (
          <MenuItem
            key={identity.code}
            selected={identity.code === value}
            onClick={() => {
              onChange(identity.code);
              onAnchor(null);
            }}
          >
            {identity.label}
          </MenuItem>
        ))}
      </Menu>
    </div>
  );
}
