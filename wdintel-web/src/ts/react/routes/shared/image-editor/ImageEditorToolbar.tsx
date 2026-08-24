import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import BlurOnIcon from '@mui/icons-material/BlurOn';
import BrushIcon from '@mui/icons-material/Brush';
import CropIcon from '@mui/icons-material/Crop';
import DeleteIcon from '@mui/icons-material/Delete';
import HighlightIcon from '@mui/icons-material/Highlight';
import PanToolIcon from '@mui/icons-material/PanTool';
import RedoIcon from '@mui/icons-material/Redo';
import RemoveRedEyeIcon from '@mui/icons-material/RemoveRedEye';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import UndoIcon from '@mui/icons-material/Undo';
import { Button, IconButton, MenuItem, Slider, TextField, Tooltip } from '@mui/material';
import type { ReactNode } from 'react';

import type { ConcealMode, ImageEditorTool } from './image-editor.types';

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
  onDeleteSelected: () => void;
  onZoomChange: (next: number) => void;
  onFitViewport: () => void;
  onActualSize: () => void;
  onResetViewport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onResetEdits: () => void;
};

function ToolButton({
  active,
  label,
  icon,
  onClick,
  disabled,
}: {
  active: boolean;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <Tooltip title={label}>
      <IconButton
        aria-label={label}
        aria-pressed={active}
        color={active ? 'primary' : 'default'}
        onClick={onClick}
        disabled={disabled}
      >
        {icon}
      </IconButton>
    </Tooltip>
  );
}

export function ImageEditorToolbar({
  disabled,
  tool,
  onToolChange,
  stroke,
  onStrokeChange,
  fill,
  onFillChange,
  strokeWidth,
  onStrokeWidthChange,
  dash,
  onDashChange,
  fontSize,
  onFontSizeChange,
  bold,
  onBoldChange,
  concealMode,
  onConcealModeChange,
  magnification,
  onMagnificationChange,
  zoom,
  canUndo,
  canRedo,
  onDeleteSelected,
  onZoomChange,
  onFitViewport,
  onActualSize,
  onResetViewport,
  onUndo,
  onRedo,
  onResetEdits,
}: Props) {
  const toolButton = (value: ImageEditorTool, label: string, icon: ReactNode) => (
    <ToolButton
      active={tool === value}
      label={label}
      icon={icon}
      onClick={() => onToolChange(value)}
      disabled={disabled}
    />
  );

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-echo-border p-2">
      {toolButton('select', 'Вибір', <PanToolIcon />)}
      {toolButton('pan', 'Перемістити полотно', <PanToolIcon />)}
      {toolButton('crop', 'Обрізати', <CropIcon />)}
      {toolButton('text', 'Текст', <TextFieldsIcon />)}
      {toolButton('rectangle', 'Прямокутник', <span>▭</span>)}
      {toolButton('ellipse', 'Еліпс', <span>◯</span>)}
      {toolButton('line', 'Лінія', <span>╱</span>)}
      {toolButton('arrow', 'Стрілка', <ArrowForwardIcon />)}
      {toolButton('brush', 'Пензель', <BrushIcon />)}
      {toolButton('highlight', 'Маркер', <HighlightIcon />)}
      {toolButton('conceal', 'Приховати дані', <BlurOnIcon />)}
      {toolButton('magnifier', 'Лупа', <RemoveRedEyeIcon />)}
      <Tooltip title="Видалити вибране">
        <IconButton aria-label="Видалити вибране" onClick={onDeleteSelected} disabled={disabled}>
          <DeleteIcon />
        </IconButton>
      </Tooltip>
      <label className="ml-2 text-echo-sm">
        Колір{' '}
        <input
          aria-label="Колір контуру"
          type="color"
          value={stroke}
          onChange={(event) => onStrokeChange(event.target.value)}
          disabled={disabled}
        />
      </label>
      <label className="text-echo-sm">
        Заливка{' '}
        <input
          aria-label="Колір заливки"
          type="color"
          value={fill === 'transparent' ? '#ffffff' : fill}
          onChange={(event) => onFillChange(event.target.value)}
          disabled={disabled}
        />
      </label>
      <Button size="small" onClick={() => onFillChange('transparent')} disabled={disabled}>
        Без заливки
      </Button>
      <label className="text-echo-sm">
        Текст{' '}
        <input
          aria-label="Розмір тексту"
          className="w-12"
          min={10}
          max={160}
          type="number"
          value={fontSize}
          onChange={(event) => onFontSizeChange(Number(event.target.value))}
          disabled={disabled}
        />
      </label>
      <Button
        aria-pressed={bold}
        size="small"
        variant={bold ? 'contained' : 'outlined'}
        onClick={onBoldChange}
        disabled={disabled}
      >
        B
      </Button>
      <label className="text-echo-sm">
        <input
          checked={dash}
          type="checkbox"
          onChange={(event) => onDashChange(event.target.checked)}
          disabled={disabled}
        />{' '}
        Пунктир
      </label>
      {tool === 'conceal' ? (
        <TextField
          select
          size="small"
          label="Приховування"
          value={concealMode}
          onChange={(event) => onConcealModeChange(event.target.value as ConcealMode)}
          disabled={disabled}
        >
          <MenuItem value="pixelate">Пікселізація</MenuItem>
          <MenuItem value="blur">Розмиття</MenuItem>
          <MenuItem value="whole-blur">Розмити все зображення</MenuItem>
          <MenuItem value="redact">Редакція (рекомендовано)</MenuItem>
        </TextField>
      ) : null}
      <label className="text-echo-sm">
        Лупа{' '}
        <Slider
          aria-label="Збільшення лупи"
          className="inline-block w-20 align-middle"
          min={1}
          max={4}
          step={1}
          value={magnification}
          onChange={(_, value) => onMagnificationChange(value as number)}
          disabled={disabled}
        />
      </label>
      <label className="text-echo-sm">
        Товщина{' '}
        <Slider
          aria-label="Товщина контуру"
          className="inline-block w-24 align-middle"
          min={1}
          max={24}
          value={strokeWidth}
          onChange={(_, value) => onStrokeWidthChange(value as number)}
          disabled={disabled}
        />
      </label>
      <span className="ml-auto text-echo-sm">{zoom}%</span>
      <Tooltip title="Зменшити масштаб">
        <IconButton
          aria-label="Зменшити масштаб"
          onClick={() => onZoomChange(zoom / 100 - 0.1)}
          disabled={disabled}
        >
          −
        </IconButton>
      </Tooltip>
      <Tooltip title="Збільшити масштаб">
        <IconButton
          aria-label="Збільшити масштаб"
          onClick={() => onZoomChange(zoom / 100 + 0.1)}
          disabled={disabled}
        >
          +
        </IconButton>
      </Tooltip>
      <Tooltip title="Вмістити у вікно">
        <IconButton aria-label="Вмістити у вікно" onClick={onFitViewport} disabled={disabled}>
          ⤢
        </IconButton>
      </Tooltip>
      <Tooltip title="Фактичний розмір">
        <IconButton aria-label="Фактичний розмір" onClick={onActualSize} disabled={disabled}>
          1:1
        </IconButton>
      </Tooltip>
      <Tooltip title="Скинути вигляд">
        <IconButton aria-label="Скинути вигляд" onClick={onResetViewport} disabled={disabled}>
          <RestartAltIcon />
        </IconButton>
      </Tooltip>
      <Tooltip title="Скасувати">
        <span>
          <IconButton aria-label="Скасувати" disabled={disabled || !canUndo} onClick={onUndo}>
            <UndoIcon />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Повторити">
        <span>
          <IconButton aria-label="Повторити" disabled={disabled || !canRedo} onClick={onRedo}>
            <RedoIcon />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Скинути зміни">
        <IconButton aria-label="Скинути зміни" onClick={onResetEdits} disabled={disabled}>
          <RestartAltIcon />
        </IconButton>
      </Tooltip>
    </div>
  );
}
