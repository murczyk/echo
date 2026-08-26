import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import FormatBoldIcon from '@mui/icons-material/FormatBold';
import { Slider } from '@mui/material';

import { PowerButton } from '../../../components/PowerButton';
import { ImageEditorIconButton } from './ImageEditorIconButton';
import type {
  ConcealMode,
  ImageEditorSelectionDescriptor,
  ImageEditorTool,
} from './image-editor.types';

export type ImageEditorContextToolbarProps = {
  disabled: boolean;
  tool: ImageEditorTool;
  selection?: ImageEditorSelectionDescriptor;
  stroke: string;
  onStrokeChange: (value: string) => void;
  fill: string;
  onFillChange: (value: string) => void;
  strokeWidth: number;
  onStrokeWidthChange: (value: number) => void;
  dash: boolean;
  onDashChange: (value: boolean) => void;
  fontSize: number;
  onFontSizeChange: (value: number) => void;
  bold: boolean;
  onBoldChange: () => void;
  concealMode: ConcealMode;
  onConcealModeChange: (value: ConcealMode) => void;
  magnification: number;
  onMagnificationChange: (value: number) => void;
  cropActive: boolean;
  onApplyCrop: () => void;
  onCancelCrop: () => void;
};

function ColorField({
  label,
  ariaLabel = label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-echo-sm">
      {label}
      <input
        aria-label={ariaLabel}
        className="size-8 appearance-none rounded border border-echo-border p-0"
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </label>
  );
}

export function ImageEditorContextToolbar(props: ImageEditorContextToolbarProps) {
  const context = props.tool === 'select' ? props.selection?.kind : props.tool;
  if (!shouldRenderContextualRow(props.tool, props.selection, context)) return null;
  const showText = context === 'text';
  const showShape = context === 'shape' || context === 'rectangle' || context === 'ellipse';
  const showLine = context === 'line' || context === 'arrow';
  const showBrush = context === 'brush' || context === 'highlight';
  const showStroke = showShape || showLine || showBrush;
  const showDash = showShape || showLine;
  return (
    <div className="absolute left-2 right-2 top-2 z-30">
      <div
        data-image-editor-contextual-row
        className="flex h-12 items-center gap-3 overflow-x-auto overflow-y-hidden border border-echo-border bg-echo-surface px-2 shadow-echo-lg"
      >
        {showText ? (
          <>
            <ColorField
              label="Колір"
              value={props.stroke}
              onChange={props.onStrokeChange}
              disabled={props.disabled}
            />
            <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-echo-sm">
              Розмір
              <input
                aria-label="Розмір тексту"
                className="h-8 w-16 rounded border border-echo-border bg-transparent px-1 text-echo-sm"
                type="number"
                min={10}
                max={160}
                value={props.fontSize}
                onChange={(event) => props.onFontSizeChange(Number(event.target.value))}
                disabled={props.disabled}
              />
            </label>
            <ImageEditorIconButton
              label="Напівжирний текст"
              icon={<FormatBoldIcon />}
              onClick={props.onBoldChange}
              disabled={props.disabled}
              active={props.bold}
              compact
            />
          </>
        ) : null}
        {showStroke ? (
          <>
            <ColorField
              label={showBrush ? 'Колір' : 'Контур'}
              ariaLabel={showBrush ? 'Колір' : 'Колір контуру'}
              value={props.stroke}
              onChange={props.onStrokeChange}
              disabled={props.disabled}
            />
            {showShape ? (
              <>
                <ColorField
                  label="Заливка"
                  ariaLabel="Колір заливки"
                  value={props.fill === 'transparent' ? '#ffffff' : props.fill}
                  onChange={props.onFillChange}
                  disabled={props.disabled}
                />
                <PowerButton
                  size="small"
                  onClick={() => props.onFillChange('transparent')}
                  disabled={props.disabled}
                >
                  Без заливки
                </PowerButton>
              </>
            ) : null}
            <div className="flex shrink-0 items-center gap-2 whitespace-nowrap text-echo-sm">
              <span id="image-editor-stroke-width">Товщина</span>
              <Slider
                aria-labelledby="image-editor-stroke-width"
                className="w-24 shrink-0"
                min={1}
                max={24}
                value={props.strokeWidth}
                onChange={(_, value) => props.onStrokeWidthChange(value as number)}
                disabled={props.disabled}
              />
            </div>
            {showDash ? (
              <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-echo-sm">
                <input
                  aria-label="Пунктир"
                  checked={props.dash}
                  type="checkbox"
                  onChange={(event) => props.onDashChange(event.target.checked)}
                  disabled={props.disabled}
                />
                Пунктир
              </label>
            ) : null}
          </>
        ) : null}
        {props.tool === 'conceal' ? (
          <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-echo-sm">
            Режим
            <select
              aria-label="Режим розмиття"
              className="h-8 rounded border border-echo-border bg-transparent px-2 text-echo-sm"
              value={props.concealMode}
              onChange={(event) => props.onConcealModeChange(event.target.value as ConcealMode)}
              disabled={props.disabled}
            >
              <option value="blur">Розмиття</option>
              <option value="pixelate">Пікселізація</option>
              <option value="redact">Затемнення</option>
            </select>
          </label>
        ) : null}
        {props.tool === 'magnifier' ? (
          <div className="flex shrink-0 items-center gap-2 whitespace-nowrap text-echo-sm">
            <span id="image-editor-magnification">Збільшення</span>
            <Slider
              aria-labelledby="image-editor-magnification"
              className="w-24 shrink-0"
              min={2}
              max={4}
              step={1}
              value={props.magnification}
              onChange={(_, value) => props.onMagnificationChange(value as number)}
              disabled={props.disabled}
            />
            <span className="min-w-5 text-center tabular-nums">{props.magnification}×</span>
          </div>
        ) : null}
        {props.tool === 'crop' && props.cropActive ? (
          <>
            <span className="shrink-0 whitespace-nowrap text-echo-sm">
              Перетягніть рамку, щоб обрізати
            </span>
            <ImageEditorIconButton
              label="Застосувати обрізання"
              icon={<CheckIcon />}
              onClick={props.onApplyCrop}
              disabled={props.disabled}
              compact
            />
            <ImageEditorIconButton
              label="Скасувати обрізання"
              icon={<CloseIcon />}
              onClick={props.onCancelCrop}
              disabled={props.disabled}
              compact
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function shouldRenderContextualRow(
  tool: ImageEditorTool,
  selection: ImageEditorSelectionDescriptor | undefined,
  context: ImageEditorTool | ImageEditorSelectionDescriptor['kind'] | undefined,
) {
  if (tool === 'select')
    return Boolean(
      selection && ['text', 'shape', 'line', 'brush', 'highlight'].includes(context ?? ''),
    );
  return [
    'text',
    'rectangle',
    'ellipse',
    'line',
    'arrow',
    'brush',
    'highlight',
    'conceal',
    'magnifier',
    'crop',
  ].includes(tool);
}
