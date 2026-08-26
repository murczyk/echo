import { Slider, TextField, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export function ImageEditorContextGroup({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{children}</div>;
}

export function ImageEditorCompactNumericControl({
  label,
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  const skipNextBlurCommitRef = useRef(false);
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Number(draft);
    if (!Number.isFinite(next)) return setDraft(String(value));
    onChange(Math.max(min, Math.min(max, next)));
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(String(value));
      skipNextBlurCommitRef.current = true;
      event.stopPropagation();
      event.currentTarget.blur();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const parsedDraft = Number(draft);
      const basis = Number.isFinite(parsedDraft) ? parsedDraft : value;
      const next = Math.max(min, Math.min(max, basis + (event.key === 'ArrowUp' ? 1 : -1)));
      setDraft(String(next));
      onChange(next);
    }
  };
  return (
    <TextField
      size="small"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (skipNextBlurCommitRef.current) {
          skipNextBlurCommitRef.current = false;
          return;
        }
        commit();
      }}
      slotProps={{
        htmlInput: {
          'aria-label': label,
          inputMode: 'numeric',
          'data-image-editor-local-escape': true,
          onKeyDown: handleKeyDown,
        },
      }}
      sx={{
        width: 56,
        '& .MuiInputBase-root': { height: 32 },
        '& .MuiInputBase-input': {
          boxSizing: 'border-box',
          height: 32,
          padding: '0 6px',
          textAlign: 'center',
          fontVariantNumeric: 'tabular-nums',
        },
      }}
      disabled={disabled}
    />
  );
}

export function ImageEditorColorControl({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label
      className={`relative flex size-8 shrink-0 overflow-hidden rounded-full border border-echo-border ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-echo-focus'}`}
      title={label}
      aria-disabled={disabled}
    >
      <span className="sr-only">{label}</span>
      <span className="absolute inset-0" style={{ backgroundColor: value }} />
      <input
        aria-label={label}
        className={`absolute inset-0 size-full opacity-0 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </label>
  );
}

export function ImageEditorSliderControl({
  label,
  value,
  display,
  min,
  max,
  step = 1,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  const id = `image-editor-${label}`;
  return (
    <div className="grid h-8 shrink-0 grid-cols-[max-content_80px_40px] items-center gap-2 whitespace-nowrap text-echo-sm">
      <span id={id} className="min-w-0">
        {label}
      </span>
      <Slider
        aria-labelledby={id}
        className="w-20"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(_, next) => onChange(next as number)}
        disabled={disabled}
      />
      <output className="text-right tabular-nums">{display}</output>
    </div>
  );
}

export function ImageEditorSegmentedControl<T extends string>({
  value,
  choices,
  onChange,
  disabled,
}: {
  value: T;
  choices: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled: boolean;
}) {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      color="primary"
      value={value}
      onChange={(_, next) => next && onChange(next)}
      disabled={disabled}
    >
      {choices.map((choice) => (
        <ToggleButton
          key={choice.value}
          value={choice.value}
          className="whitespace-nowrap px-2 text-echo-sm"
        >
          {choice.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
