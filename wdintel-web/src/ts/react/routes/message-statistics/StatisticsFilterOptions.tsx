import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Checkbox, IconButton } from '@mui/material';
import type { CSSProperties } from 'react';
import { normalizeSearchValue } from '../../utils/search-filter';

export type StatisticsFilterOption = {
  value: string;
  label: string;
  count?: number;
  children?: StatisticsFilterOption[];
  selectable?: boolean;
};

export function searchOptions(
  options: StatisticsFilterOption[],
  search: string,
): StatisticsFilterOption[] {
  const query = normalizeSearchValue(search);
  if (!query) return options;
  return options.flatMap((option) => {
    if (normalizeSearchValue(option.label).includes(query)) return [option];
    const children = searchOptions(option.children ?? [], search);
    return children.length ? [{ ...option, children }] : [];
  });
}

export function flattenOptions(options: StatisticsFilterOption[]): StatisticsFilterOption[] {
  return options.flatMap((option) => [option, ...flattenOptions(option.children ?? [])]);
}

export function selectedAncestors(options: StatisticsFilterOption[], selected: string[]): string[] {
  return options.flatMap((option) => {
    const nested = flattenOptions(option.children ?? []);
    return nested.some((child) => selected.includes(child.value))
      ? [option.value, ...selectedAncestors(option.children ?? [], selected)]
      : [];
  });
}

type Props = {
  options: StatisticsFilterOption[];
  value: string[];
  onChange: (value: string[]) => void;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  tree: boolean;
  depth?: number;
};

export function StatisticsFilterOptions({
  options,
  value,
  onChange,
  expanded,
  onToggle,
  tree,
  depth = 0,
}: Props) {
  return (
    <ul className="message-statistics-option-list">
      {options.map((option) => {
        const selected = value.includes(option.value);
        const children = option.children ?? [];
        const open = expanded.has(option.value);
        const indeterminate =
          !selected && flattenOptions(children).some((child) => value.includes(child.value));
        return (
          <li key={option.value}>
            <div
              className={`message-statistics-option${tree ? ' message-statistics-option--tree' : ''}`}
              data-selected={selected || undefined}
              style={{ '--statistics-option-depth': depth } as CSSProperties}
            >
              {tree ? (
                children.length ? (
                  <IconButton
                    size="small"
                    aria-label={`${open ? 'Згорнути' : 'Розгорнути'} ${option.label}`}
                    aria-expanded={open}
                    onClick={() => onToggle(option.value)}
                  >
                    {open ? <ExpandMoreIcon /> : <ChevronRightIcon />}
                  </IconButton>
                ) : (
                  <span className="message-statistics-option-chevron" />
                )
              ) : null}
              <label className="message-statistics-option-label" title={option.label}>
                {option.selectable !== false ? (
                  <Checkbox
                    size="small"
                    checked={selected}
                    indeterminate={indeterminate}
                    inputProps={{
                      'aria-label': option.label,
                      'aria-checked': indeterminate ? 'mixed' : selected,
                    }}
                    onChange={(_, checked) =>
                      onChange(
                        checked
                          ? [...value, option.value]
                          : value.filter((key) => key !== option.value),
                      )
                    }
                  />
                ) : null}
                <span className="message-statistics-option-name">{option.label}</span>
                {option.count != null ? (
                  <span className="message-statistics-option-count">
                    {option.count.toLocaleString('uk-UA')}
                  </span>
                ) : null}
              </label>
            </div>
            {children.length > 0 && open ? (
              <StatisticsFilterOptions
                options={children}
                value={value}
                onChange={onChange}
                expanded={expanded}
                onToggle={onToggle}
                tree={tree}
                depth={depth + 1}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
