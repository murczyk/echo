import FormatBoldIcon from '@mui/icons-material/FormatBold';
import { MenuItem, Slider, TextField } from '@mui/material';

import { PowerButton } from '../../../components/PowerButton';
import { ImageEditorIconButton } from './ImageEditorIconButton';
import { ImageEditorToolRail } from './ImageEditorToolRail';
import type {
  ConcealMode,
  ImageEditorSelectionDescriptor,
  ImageEditorTool,
} from './image-editor.types';

type Props = {
  disabled: boolean;
  tool: ImageEditorTool;
  onToolChange: (tool: ImageEditorTool) => void;
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
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  canDeleteSelected: boolean;
  selection?: ImageEditorSelectionDescriptor;
  onDeleteSelected: () => void;
  onZoomChange: (next: number) => void;
  onFitViewport: () => void;
  onActualSize: () => void;
  onCenterViewport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onResetEdits: () => void;
};

function ColorField({
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
    <label className="flex shrink-0 items-center gap-1 text-echo-sm">
      {label}
      <input
        aria-label={label}
        className="size-8 rounded border border-echo-border"
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </label>
  );
}

export function ImageEditorToolbar(props: Props) {
  const context = props.tool === 'select' ? props.selection?.kind : props.tool;
  const showText = context === 'text';
  const showShape = context === 'shape' || context === 'rectangle' || context === 'ellipse';
  const showLine = context === 'line' || context === 'arrow';
  const showBrush = context === 'brush' || context === 'highlight';
  const showStroke = showShape || showLine || showBrush;
  const showDash = showShape || showLine;
  return (
    <>
      <ImageEditorToolRail
        disabled={props.disabled}
        tool={props.tool}
        onToolChange={props.onToolChange}
        canUndo={props.canUndo}
        canRedo={props.canRedo}
        canDeleteSelected={props.canDeleteSelected}
        onDeleteSelected={props.onDeleteSelected}
        onUndo={props.onUndo}
        onRedo={props.onRedo}
        onResetEdits={props.onResetEdits}
        zoom={props.zoom}
        onZoomChange={props.onZoomChange}
        onFitViewport={props.onFitViewport}
        onActualSize={props.onActualSize}
        onCenterViewport={props.onCenterViewport}
      />
      {shouldRenderContextualRow(props.tool, props.selection, context) ? (
        <div
          data-image-editor-contextual-row
          className="flex h-14 shrink-0 items-center gap-3 overflow-x-auto border-b border-echo-border px-2"
        >
          {props.tool === 'select' && !props.selection ? (
            <span className="shrink-0 text-echo-sm text-echo-text">
              Оберіть об’єкт для редагування
            </span>
          ) : null}
          {showText ? (
            <>
              <ColorField
                label="Колір"
                value={props.stroke}
                onChange={props.onStrokeChange}
                disabled={props.disabled}
              />
              <TextField
                label="Розмір тексту"
                size="small"
                type="number"
                value={props.fontSize}
                onChange={(event) => props.onFontSizeChange(Number(event.target.value))}
                inputProps={{ min: 10, max: 160 }}
                disabled={props.disabled}
              />
              <ImageEditorIconButton
                label="Напівжирний текст"
                icon={<FormatBoldIcon />}
                onClick={props.onBoldChange}
                disabled={props.disabled}
                active={props.bold}
              />
            </>
          ) : null}
          {showShape || showStroke ? (
            <>
              <ColorField
                label={showBrush ? 'Колір' : 'Колір контуру'}
                value={props.stroke}
                onChange={props.onStrokeChange}
                disabled={props.disabled}
              />
              {showShape ? (
                <>
                  <ColorField
                    label="Колір заливки"
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
              <label className="flex shrink-0 items-center gap-2 text-echo-sm">
                Товщина
                <Slider
                  aria-label="Товщина контуру"
                  className="w-24"
                  min={1}
                  max={24}
                  value={props.strokeWidth}
                  onChange={(_, value) => props.onStrokeWidthChange(value as number)}
                  disabled={props.disabled}
                />
              </label>
              {showDash ? (
                <label className="flex shrink-0 items-center gap-1 text-echo-sm">
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
            <TextField
              select
              size="small"
              label="Приховування"
              value={props.concealMode}
              onChange={(event) => props.onConcealModeChange(event.target.value as ConcealMode)}
              disabled={props.disabled}
            >
              <MenuItem value="pixelate">Пікселізація</MenuItem>
              <MenuItem value="blur">Розмиття</MenuItem>
              <MenuItem value="whole-blur">Розмити все зображення</MenuItem>
              <MenuItem value="redact">Редакція (рекомендовано)</MenuItem>
            </TextField>
          ) : null}
          {props.tool === 'magnifier' ? (
            <label className="flex shrink-0 items-center gap-2 text-echo-sm">
              Лупа
              <Slider
                aria-label="Збільшення лупи"
                className="w-24"
                min={1}
                max={4}
                step={1}
                value={props.magnification}
                onChange={(_, value) => props.onMagnificationChange(value as number)}
                disabled={props.disabled}
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function shouldRenderContextualRow(
  tool: ImageEditorTool,
  selection: ImageEditorSelectionDescriptor | undefined,
  context: ImageEditorTool | ImageEditorSelectionDescriptor['kind'] | undefined,
) {
  if (tool === 'select')
    return !selection || ['text', 'shape', 'line', 'brush', 'highlight'].includes(context ?? '');
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
  ].includes(tool);
}
