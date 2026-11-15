import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import SearchIcon from '@mui/icons-material/Search';
import { Button, CircularProgress, InputAdornment, Popover, TextField } from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { KeyboardEvent, ReactNode } from 'react';
import { useId, useRef, useState } from 'react';
import {
  flattenOptions,
  searchOptions,
  selectedAncestors,
  StatisticsFilterOptions,
  type StatisticsFilterOption,
} from './StatisticsFilterOptions';

type Props = {
  label: string;
  searchPlaceholder: string;
  options: StatisticsFilterOption[];
  value: string[];
  onChange: (value: string[]) => void;
  onSearch?: (value: string) => void;
  loading?: boolean;
  disabled?: boolean;
  suffix?: ReactNode;
  footer?: ReactNode;
  total?: number;
  onOpenChange?: (open: boolean) => void;
  labels?: ReadonlyMap<string, string>;
  tree?: boolean;
};

export function StatisticsFilter({
  label,
  searchPlaceholder,
  options,
  value,
  onChange,
  onSearch,
  loading,
  disabled,
  suffix,
  footer,
  total,
  onOpenChange,
  labels: knownLabels,
  tree = false,
}: Props) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(new Set<string>());
  const list = useRef<HTMLDivElement>(null);
  const labels = useRef(new Map<string, string>());
  const flat = flattenOptions(options);
  flat.forEach((option) => labels.current.set(option.value, option.label));
  knownLabels?.forEach((label, key) => labels.current.set(key, label));
  const summary = value.length
    ? value.map((key) => labels.current.get(key) ?? key).join(', ')
    : 'усі';
  const visible = onSearch ? options : searchOptions(options, search);
  const updateSearch = (query: string) => {
    setSearch(query);
    onSearch?.(query);
    if (query && tree) {
      const parents = flattenOptions(searchOptions(options, query)).filter(
        (option) => option.children?.length,
      );
      setExpanded((current) => new Set([...current, ...parents.map((option) => option.value)]));
    }
  };
  const moveFocus = (event: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    if ((event.target as HTMLInputElement).type === 'text' && ['Home', 'End'].includes(event.key))
      return;
    const inputs = [
      ...(list.current?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ?? []),
    ];
    if (!inputs.length) return;
    const current = inputs.indexOf(document.activeElement as HTMLInputElement);
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? inputs.length - 1
          : current < 0
            ? event.key === 'ArrowUp'
              ? inputs.length - 1
              : 0
            : (current + (event.key === 'ArrowUp' ? -1 : 1) + inputs.length) % inputs.length;
    event.preventDefault();
    inputs[index].focus();
  };
  return (
    <div
      className={`message-statistics-filter${suffix ? ' message-statistics-filter--suffix' : ''}`}
    >
      <Button
        variant="outlined"
        color="inherit"
        className="message-statistics-filter-trigger"
        disabled={disabled}
        title={`${label}: ${summary}`}
        aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)}
        aria-controls={anchor ? id : undefined}
        onClick={(event) => {
          updateSearch('');
          setExpanded((current) => new Set([...current, ...selectedAncestors(options, value)]));
          setAnchor(event.currentTarget);
          onOpenChange?.(true);
        }}
      >
        <span className="message-statistics-filter-prefix">{label}:</span>
        <span className="message-statistics-filter-summary">{summary}</span>
        <ArrowDropDownIcon className="message-statistics-filter-arrow" />
      </Button>
      {suffix ? <div className="message-statistics-filter-suffix">{suffix}</div> : null}
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => {
          setAnchor(null);
          onOpenChange?.(false);
        }}
        marginThreshold={8}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          paper: {
            className: `message-statistics-dropdown${tree ? ' message-statistics-dropdown--tree' : ''}`,
            sx: (theme) => ({
              backgroundColor: theme.echo.color[theme.palette.mode].headerSurface,
              backgroundImage: 'none',
              '--statistics-dropdown-primary': theme.palette.primary.main,
              '--statistics-dropdown-muted': theme.palette.text.secondary,
              '--statistics-dropdown-border': theme.palette.divider,
              '--statistics-dropdown-selected': alpha(theme.palette.primary.main, 0.24),
              '--statistics-dropdown-hover': theme.palette.action.hover,
            }),
          },
        }}
      >
        <div
          id={id}
          role="dialog"
          aria-label={`Фільтр: ${label}`}
          className="message-statistics-dropdown-content"
          onKeyDown={moveFocus}
        >
          <TextField
            autoFocus
            size="small"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(event) => updateSearch(event.target.value)}
            inputProps={{ 'aria-label': searchPlaceholder }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon />
                </InputAdornment>
              ),
              endAdornment: loading ? (
                <CircularProgress size={16} aria-label="Завантаження варіантів" />
              ) : undefined,
            }}
          />
          <div ref={list} className="message-statistics-dropdown-options">
            <StatisticsFilterOptions
              options={visible}
              value={value}
              onChange={onChange}
              tree={tree}
              expanded={expanded}
              onToggle={(key) =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            />
            {!visible.length ? (
              <p className="message-statistics-dropdown-empty">
                {loading ? 'Завантаження…' : 'Немає варіантів'}
              </p>
            ) : null}
            {footer}
          </div>
          <footer className="message-statistics-dropdown-footer">
            <span role="status">
              Обрано {value.length} з{' '}
              {total ?? flat.filter((option) => option.selectable !== false).length}
            </span>
            <Button size="small" onClick={() => onChange([])}>
              Скинути
            </Button>
          </footer>
        </div>
      </Popover>
    </div>
  );
}
