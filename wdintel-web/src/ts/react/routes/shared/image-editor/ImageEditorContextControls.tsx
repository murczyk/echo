import { Slider } from '@mui/material';
import type { ReactNode } from 'react';

export function ImageEditorContextGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-r border-echo-border pr-3 last:border-r-0">
      {children}
    </div>
  );
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
  return (
    <input
      aria-label={label}
      className="h-8 w-14 rounded-echo-sm border border-echo-border bg-transparent px-1 text-center text-echo-sm tabular-nums"
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
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
      className="flex size-8 shrink-0 items-center justify-center rounded-full border border-echo-border"
      title={label}
    >
      <span className="sr-only">{label}</span>
      <input
        aria-label={label}
        className="size-6 cursor-pointer rounded-full border-0 bg-transparent p-0"
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
    <div className="flex h-8 items-center gap-2 whitespace-nowrap text-echo-sm">
      <span id={id}>{label}</span>
      <Slider
        aria-labelledby={id}
        className="w-20 shrink-0"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(_, next) => onChange(next as number)}
        disabled={disabled}
      />
      <output className="min-w-8 text-right tabular-nums">{display}</output>
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
    <div className="flex h-8 items-center rounded-md border border-echo-border p-0.5">
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          className="h-7 rounded px-2 text-echo-sm aria-pressed:bg-echo-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-echo-focus"
          aria-pressed={value === choice.value}
          onClick={() => onChange(choice.value)}
          disabled={disabled}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}
