import { Slider } from '@mui/material';
import type { ReactNode } from 'react';

export function ImageEditorContextGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-r border-echo-border pr-3 last:border-r-0">
      {children}
    </div>
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
    <label className="flex h-8 items-center gap-1.5 whitespace-nowrap text-echo-sm">
      <span>{label}</span>
      <input
        aria-label={label}
        className="size-8 cursor-pointer rounded-full border border-echo-border bg-transparent p-0"
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
          className="h-7 rounded px-2 text-echo-sm aria-pressed:bg-echo-primary"
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
