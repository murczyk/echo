import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import FormatBoldIcon from '@mui/icons-material/FormatBold';
import FormatColorFillIcon from '@mui/icons-material/FormatColorFill';
import FormatColorResetIcon from '@mui/icons-material/FormatColorReset';
import { ToggleButton } from '@mui/material';

import { ImageEditorIconButton } from './ImageEditorIconButton';
import {
  ImageEditorCompactNumericControl,
  ImageEditorColorControl,
  ImageEditorContextGroup,
  ImageEditorSegmentedControl,
  ImageEditorSliderControl,
} from './ImageEditorContextControls';
import { ImageEditorContextInspector } from './ImageEditorContextInspector';
import { ImageEditorDashedLineIcon } from './ImageEditorIcons';
import {
  ConcealMode,
  ImageEditorSelectionDescriptor,
  ImageEditorSelectionKind,
  ImageEditorTool,
} from './image-editor.types';

export enum ImageEditorToolbarContext {
  Text = 'text',
  Shape = 'shape',
  Line = 'line',
  Brush = 'brush',
  Conceal = 'conceal',
  Magnifier = 'magnifier',
  Crop = 'crop',
}

export function resolveImageEditorToolbarContext(
  tool: ImageEditorTool,
  selection: ImageEditorSelectionDescriptor | undefined,
): ImageEditorToolbarContext | null {
  if (tool === ImageEditorTool.Select)
    return selection ? TOOLBAR_CONTEXT_BY_SELECTION_KIND[selection.kind] : null;
  return TOOLBAR_CONTEXT_BY_TOOL[tool];
}

const TOOLBAR_CONTEXT_BY_SELECTION_KIND = {
  [ImageEditorSelectionKind.Text]: ImageEditorToolbarContext.Text,
  [ImageEditorSelectionKind.Shape]: ImageEditorToolbarContext.Shape,
  [ImageEditorSelectionKind.Line]: ImageEditorToolbarContext.Line,
  [ImageEditorSelectionKind.Brush]: ImageEditorToolbarContext.Brush,
  [ImageEditorSelectionKind.Highlight]: ImageEditorToolbarContext.Brush,
  [ImageEditorSelectionKind.Concealment]: null,
} satisfies Record<ImageEditorSelectionKind, ImageEditorToolbarContext | null>;
const TOOLBAR_CONTEXT_BY_TOOL = {
  [ImageEditorTool.Select]: null,
  [ImageEditorTool.Pan]: null,
  [ImageEditorTool.Crop]: ImageEditorToolbarContext.Crop,
  [ImageEditorTool.Text]: ImageEditorToolbarContext.Text,
  [ImageEditorTool.Rectangle]: ImageEditorToolbarContext.Shape,
  [ImageEditorTool.Ellipse]: ImageEditorToolbarContext.Shape,
  [ImageEditorTool.Line]: ImageEditorToolbarContext.Line,
  [ImageEditorTool.Arrow]: ImageEditorToolbarContext.Line,
  [ImageEditorTool.Brush]: ImageEditorToolbarContext.Brush,
  [ImageEditorTool.Conceal]: ImageEditorToolbarContext.Conceal,
  [ImageEditorTool.Magnifier]: ImageEditorToolbarContext.Magnifier,
} satisfies Record<ImageEditorTool, ImageEditorToolbarContext | null>;

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
  textBackgroundColor: string;
  onTextBackgroundColorChange: (value: string) => void;
  textBackgroundEnabled: boolean;
  onTextBackgroundEnabledChange: (value: boolean) => void;
  textBackgroundPadding: number;
  onTextBackgroundPaddingChange: (value: number) => void;
  highlightOpacity: number;
  onHighlightOpacityChange: (value: number) => void;
  concealMode: ConcealMode;
  onConcealModeChange: (value: ConcealMode) => void;
  magnification: number;
  onMagnificationChange: (value: number) => void;
  cropActive: boolean;
  onApplyCrop: () => void;
  onCancelCrop: () => void;
  onDeleteAttachedArrow: () => void;
};

export function ImageEditorContextToolbar(props: ImageEditorContextToolbarProps) {
  const context = resolveImageEditorToolbarContext(props.tool, props.selection);
  if (context === null) return null;
  const showText = context === ImageEditorToolbarContext.Text;
  const showShape = context === ImageEditorToolbarContext.Shape;
  const showLine = context === ImageEditorToolbarContext.Line;
  const showBrush = context === ImageEditorToolbarContext.Brush;
  const showStroke = showShape || showLine || showBrush;
  const showDash = showShape || showLine;
  return (
    <ImageEditorContextInspector bordered={context !== ImageEditorToolbarContext.Conceal}>
      <div
        data-image-editor-contextual-row
        className="flex min-w-0 max-w-full flex-wrap items-center gap-3"
      >
        {showText ? (
          <>
            <ImageEditorContextGroup>
              <ImageEditorColorControl
                label="Колір тексту"
                value={props.stroke}
                onChange={props.onStrokeChange}
                disabled={props.disabled}
              />
              <ImageEditorCompactNumericControl
                label="Розмір тексту"
                tooltip="Розмір тексту"
                value={props.fontSize}
                min={10}
                max={160}
                onChange={props.onFontSizeChange}
                disabled={props.disabled}
              />
              <ImageEditorIconButton
                label="Напівжирний текст"
                icon={<FormatBoldIcon />}
                onClick={props.onBoldChange}
                disabled={props.disabled}
                active={props.bold}
                compact
              />
              {props.selection?.hasAttachedArrow ? (
                <ImageEditorIconButton
                  label="Видалити стрілку"
                  icon={<CloseIcon />}
                  onClick={props.onDeleteAttachedArrow}
                  disabled={props.disabled}
                  compact
                />
              ) : null}
            </ImageEditorContextGroup>
            <span aria-hidden="true" className="h-8 w-px shrink-0 bg-echo-border" />
            <ImageEditorContextGroup>
              <ImageEditorIconButton
                label="Фон тексту"
                icon={<FormatColorFillIcon />}
                onClick={() => props.onTextBackgroundEnabledChange(!props.textBackgroundEnabled)}
                disabled={props.disabled}
                active={props.textBackgroundEnabled}
                compact
              />
              <ImageEditorColorControl
                label="Колір фону"
                value={props.textBackgroundColor}
                onChange={props.onTextBackgroundColorChange}
                disabled={props.disabled || !props.textBackgroundEnabled}
              />
              <ImageEditorCompactNumericControl
                label="Відступ фону"
                tooltip="Відступ фону"
                value={props.textBackgroundPadding}
                min={0}
                max={32}
                onChange={props.onTextBackgroundPaddingChange}
                disabled={props.disabled || !props.textBackgroundEnabled}
              />
            </ImageEditorContextGroup>
          </>
        ) : null}
        {showStroke ? (
          <ImageEditorContextGroup>
            <ImageEditorColorControl
              label={showBrush ? 'Колір' : 'Контур'}
              value={props.stroke}
              onChange={props.onStrokeChange}
              disabled={props.disabled}
            />
            {showShape ? (
              <>
                <ImageEditorColorControl
                  label="Заливка"
                  value={props.fill === 'transparent' ? '#ffffff' : props.fill}
                  onChange={props.onFillChange}
                  disabled={props.disabled}
                />
                <ImageEditorIconButton
                  label="Без заливки"
                  icon={<FormatColorResetIcon />}
                  onClick={() =>
                    props.onFillChange(props.fill === 'transparent' ? props.stroke : 'transparent')
                  }
                  disabled={props.disabled}
                  active={props.fill === 'transparent'}
                  compact
                />
              </>
            ) : null}
            <ImageEditorSliderControl
              label="Товщина"
              value={props.strokeWidth}
              display={String(props.strokeWidth)}
              min={1}
              max={24}
              onChange={props.onStrokeWidthChange}
              disabled={props.disabled}
            />
            {showDash ? (
              <ToggleButton
                value="dash"
                selected={props.dash}
                onChange={() => props.onDashChange(!props.dash)}
                disabled={props.disabled}
                aria-label="Пунктир"
                className="h-8 shrink-0 gap-1 whitespace-nowrap px-2 text-echo-sm"
              >
                <ImageEditorDashedLineIcon /> Пунктир
              </ToggleButton>
            ) : null}
            {context === ImageEditorToolbarContext.Brush ? (
              <ImageEditorSliderControl
                label="Непрозорість"
                value={props.highlightOpacity}
                display={`${Math.round(props.highlightOpacity * 100)}%`}
                min={0.1}
                max={1}
                step={0.1}
                onChange={props.onHighlightOpacityChange}
                disabled={props.disabled}
              />
            ) : null}
          </ImageEditorContextGroup>
        ) : null}
        {context === ImageEditorToolbarContext.Conceal ? (
          <ImageEditorContextGroup>
            <ImageEditorSegmentedControl
              value={props.concealMode}
              choices={[
                { value: ConcealMode.Blur, label: 'Розмиття' },
                { value: ConcealMode.Pixelate, label: 'Пікселізація' },
                { value: ConcealMode.Redact, label: 'Затемнення' },
              ]}
              onChange={props.onConcealModeChange}
              disabled={props.disabled}
            />
          </ImageEditorContextGroup>
        ) : null}
        {context === ImageEditorToolbarContext.Magnifier ? (
          <ImageEditorSliderControl
            label="Збільшення"
            value={props.magnification}
            display={`${props.magnification}×`}
            min={2}
            max={4}
            onChange={props.onMagnificationChange}
            disabled={props.disabled}
          />
        ) : null}
        {context === ImageEditorToolbarContext.Crop && props.cropActive ? (
          <ImageEditorContextGroup>
            <span className="shrink-0 whitespace-nowrap pl-1.5 text-echo-sm">
              Перетягніть рамку, щоб обрізати
            </span>
            <span className="flex items-center gap-0">
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
            </span>
          </ImageEditorContextGroup>
        ) : null}
      </div>
    </ImageEditorContextInspector>
  );
}
