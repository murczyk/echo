import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import FormatBoldIcon from '@mui/icons-material/FormatBold';

import FormatColorResetIcon from '@mui/icons-material/FormatColorReset';

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
  highlightOpacity: number;
  onHighlightOpacityChange: (value: number) => void;
  concealMode: ConcealMode;
  onConcealModeChange: (value: ConcealMode) => void;
  magnification: number;
  onMagnificationChange: (value: number) => void;
  cropActive: boolean;
  onApplyCrop: () => void;
  onCancelCrop: () => void;
};

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
    <ImageEditorContextInspector bordered={props.tool !== 'conceal'}>
      <div
        data-image-editor-contextual-row
        className="flex min-w-0 max-w-full flex-wrap items-center gap-3"
      >
        {showText ? (
          <ImageEditorContextGroup>
            <ImageEditorColorControl
              label="Колір"
              value={props.stroke}
              onChange={props.onStrokeChange}
              disabled={props.disabled}
            />
            <ImageEditorCompactNumericControl
              label="Розмір тексту"
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
          </ImageEditorContextGroup>
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
              <ImageEditorIconButton
                label="Пунктир"
                icon={<ImageEditorDashedLineIcon />}
                onClick={() => props.onDashChange(!props.dash)}
                disabled={props.disabled}
                active={props.dash}
                compact
              />
            ) : null}
            {context === 'highlight' ? (
              <ImageEditorSliderControl
                label="Прозорість"
                value={props.highlightOpacity}
                display={`${Math.round(props.highlightOpacity * 100)}%`}
                min={0.1}
                max={0.8}
                step={0.1}
                onChange={props.onHighlightOpacityChange}
                disabled={props.disabled}
              />
            ) : null}
          </ImageEditorContextGroup>
        ) : null}
        {props.tool === 'conceal' ? (
          <ImageEditorContextGroup>
            <ImageEditorSegmentedControl
              value={props.concealMode}
              choices={[
                { value: 'blur', label: 'Розмиття' },
                { value: 'pixelate', label: 'Пікселізація' },
                { value: 'redact', label: 'Затемнення' },
              ]}
              onChange={props.onConcealModeChange}
              disabled={props.disabled}
            />
          </ImageEditorContextGroup>
        ) : null}
        {props.tool === 'magnifier' ? (
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
        {props.tool === 'crop' && props.cropActive ? (
          <ImageEditorContextGroup>
            <span className="shrink-0 whitespace-nowrap text-echo-sm">
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
