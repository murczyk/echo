import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { ListItemButton } from '@mui/material';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

import { PowerIconButton } from '../../../components/PowerIconButton';

export function DeviceFileTreeRow({
  name,
  depth,
  icon,
  selected = false,
  hasContent = true,
  entryId,
  label,
  onClick,
  onToggle,
  expanded,
  childrenId,
  toggleLabel,
  trailing,
}: {
  name: string;
  depth: number;
  icon: ReactNode;
  selected?: boolean;
  hasContent?: boolean;
  entryId?: string;
  label?: string;
  onClick: () => void;
  onToggle?: () => void;
  expanded?: boolean;
  childrenId?: string;
  toggleLabel?: string;
  trailing?: ReactNode;
}) {
  const row = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected && entryId) row.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, entryId]);
  return (
    <div className="relative min-w-0" style={{ '--device-tree-depth': depth } as CSSProperties}>
      <ListItemButton
        ref={row}
        component="button"
        data-testid={entryId ? `device-file-${entryId}` : undefined}
        selected={selected}
        aria-current={selected ? 'true' : undefined}
        aria-pressed={selected}
        aria-label={label}
        aria-description={hasContent ? undefined : 'Контент файлу відсутній'}
        aria-expanded={expanded}
        aria-controls={childrenId}
        onClick={onClick}
        className={`min-h-echo-xl! w-full! min-w-0! gap-echo-xs! rounded-echo-sm! py-0! pr-echo-xs! max-echo-lg:min-h-echo-control-lg! focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-echo-focus ${selected ? 'bg-echo-primary/15!' : ''} ${hasContent ? '' : 'opacity-55'}`}
        style={{
          paddingLeft:
            'calc(var(--echo-spacing-xs) + var(--device-tree-depth) * var(--echo-spacing-md))',
        }}
      >
        <span aria-hidden="true" className="w-echo-lg shrink-0 max-echo-lg:w-echo-2xl" />
        <span className="inline-flex shrink-0 [&_svg]:size-echo-icon-sm!">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-echo-sm" title={name}>
          {name}
        </span>
        {trailing}
      </ListItemButton>
      {depth > 0 ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-echo-md opacity-45 max-echo-lg:left-echo-icon-md"
          style={{
            width: 'calc(var(--device-tree-depth) * var(--echo-spacing-md))',
            backgroundImage:
              'linear-gradient(to right, var(--echo-color-border) 1px, transparent 1px)',
            backgroundSize: 'var(--echo-spacing-md) 100%',
          }}
        />
      ) : null}
      {onToggle ? (
        <PowerIconButton
          size="small"
          aria-label={toggleLabel}
          aria-expanded={expanded}
          aria-controls={childrenId}
          onClick={onToggle}
          className="absolute! inset-y-0! z-10! w-echo-lg! rounded-none! p-0! max-echo-lg:w-echo-2xl! [&_svg]:size-echo-icon-sm!"
          style={{
            left: 'calc(var(--echo-spacing-xs) + var(--device-tree-depth) * var(--echo-spacing-md))',
          }}
        >
          {expanded ? <ExpandMoreIcon /> : <ChevronRightIcon />}
        </PowerIconButton>
      ) : null}
    </div>
  );
}
