import { useEffect, useState, type MutableRefObject } from 'react';

import { updateImageEditorBrushStyle } from './image-editor-interaction-mode';
import { useImageEditorSelection } from './use-image-editor-selection';
import { useImageEditorSelectionStyle } from './use-image-editor-selection-style';
import { ImageEditorTool } from './image-editor.types';
import type { ImageEditorSelectionDescriptor } from './image-editor.types';

const INITIAL_STYLE = {
  stroke: '#ef4444',
  fill: 'transparent',
  strokeWidth: 4,
  dash: false,
  fontSize: 36,
  bold: false,
  textBackgroundColor: '#ffffff',
  textBackgroundEnabled: true,
  textBackgroundPadding: 6,
  highlightOpacity: 1,
};

export function useImageEditorStyleCoordination({
  canvasRef,
  fabricRef,
  canvasReady,
  tool,
  scheduleHistory,
}: {
  canvasRef: MutableRefObject<import('fabric').Canvas | null>;
  fabricRef: MutableRefObject<typeof import('fabric') | null>;
  canvasReady: boolean;
  tool: ImageEditorTool;
  scheduleHistory: () => void;
}) {
  const [selection, setSelection] = useState<ImageEditorSelectionDescriptor>();
  const [stroke, setStroke] = useState(INITIAL_STYLE.stroke);
  const [fill, setFill] = useState(INITIAL_STYLE.fill);
  const [strokeWidth, setStrokeWidth] = useState(INITIAL_STYLE.strokeWidth);
  const [brushWidth, setBrushWidth] = useState(7);
  const [dash, setDash] = useState(INITIAL_STYLE.dash);
  const [fontSize, setFontSize] = useState(INITIAL_STYLE.fontSize);
  const [bold, setBold] = useState(INITIAL_STYLE.bold);
  const [textBackgroundColor, setTextBackgroundColor] = useState(INITIAL_STYLE.textBackgroundColor);
  const [textBackgroundEnabled, setTextBackgroundEnabled] = useState(
    INITIAL_STYLE.textBackgroundEnabled,
  );
  const [textBackgroundPadding, setTextBackgroundPadding] = useState(
    INITIAL_STYLE.textBackgroundPadding,
  );
  const [highlightOpacity, setHighlightOpacity] = useState(INITIAL_STYLE.highlightOpacity);
  const [selectedStyle, setSelectedStyle] = useState(INITIAL_STYLE);
  const [canDeleteSelected, setCanDeleteSelected] = useState(false);
  const activeStrokeWidth =
    tool === ImageEditorTool.Brush || selection?.kind === 'brush' ? brushWidth : strokeWidth;
  const { applySelectedStyle } = useImageEditorSelectionStyle({
    canvasRef,
    fabricRef,
    scheduleHistory,
  });
  const { refreshSelection } = useImageEditorSelection({
    canvasRef,
    fabricRef,
    canvasReady,
    onCanDeleteChange: setCanDeleteSelected,
    onStrokeChange: (value) => setSelectedStyle((style) => ({ ...style, stroke: value })),
    onFillChange: (value) => setSelectedStyle((style) => ({ ...style, fill: value })),
    onStrokeWidthChange: (value) => setSelectedStyle((style) => ({ ...style, strokeWidth: value })),
    onDashChange: (value) => setSelectedStyle((style) => ({ ...style, dash: value })),
    onFontSizeChange: (value) => setSelectedStyle((style) => ({ ...style, fontSize: value })),
    onBoldChange: (value) => setSelectedStyle((style) => ({ ...style, bold: value })),
    onTextBackgroundColorChange: (value) =>
      setSelectedStyle((style) => ({ ...style, textBackgroundColor: value })),
    onTextBackgroundEnabledChange: (value) =>
      setSelectedStyle((style) => ({ ...style, textBackgroundEnabled: value })),
    onTextBackgroundPaddingChange: (value) =>
      setSelectedStyle((style) => ({ ...style, textBackgroundPadding: value })),
    onHighlightOpacityChange: (value) =>
      setSelectedStyle((style) => ({ ...style, highlightOpacity: value })),
    onSelectionChange: setSelection,
  });

  useEffect(() => {
    if (tool !== ImageEditorTool.Brush) return;
    updateImageEditorBrushStyle({
      canvas: canvasRef.current,
      stroke,
      strokeWidth: brushWidth,
      highlightOpacity,
    });
  }, [brushWidth, canvasRef, highlightOpacity, stroke, tool]);

  const showingSelectionStyle = selection != null;
  const displayed = {
    stroke: showingSelectionStyle ? selectedStyle.stroke : stroke,
    fill: showingSelectionStyle ? selectedStyle.fill : fill,
    strokeWidth: showingSelectionStyle ? selectedStyle.strokeWidth : activeStrokeWidth,
    dash: showingSelectionStyle ? selectedStyle.dash : dash,
    fontSize: showingSelectionStyle ? selectedStyle.fontSize : fontSize,
    bold: showingSelectionStyle ? selectedStyle.bold : bold,
    textBackgroundColor: showingSelectionStyle
      ? selectedStyle.textBackgroundColor
      : textBackgroundColor,
    textBackgroundEnabled: showingSelectionStyle
      ? selectedStyle.textBackgroundEnabled
      : textBackgroundEnabled,
    textBackgroundPadding: showingSelectionStyle
      ? selectedStyle.textBackgroundPadding
      : textBackgroundPadding,
    highlightOpacity: showingSelectionStyle ? selectedStyle.highlightOpacity : highlightOpacity,
  };
  const applyOrSetDefault = <T>(
    change: Parameters<typeof applySelectedStyle>[0],
    value: T,
    updateSelected: (style: typeof INITIAL_STYLE, value: T) => typeof INITIAL_STYLE,
    setDefault: (value: NoInfer<T>) => void,
  ) => {
    const result = applySelectedStyle(change);
    if (result === true) setSelectedStyle((style) => updateSelected(style, value));
    else if (result === undefined) setDefault(value);
    return result;
  };

  return {
    activeStrokeWidth,
    canDeleteSelected,
    drawing: {
      bold,
      dash,
      fill,
      fontSize,
      highlightOpacity,
      stroke,
      textBackgroundColor,
      textBackgroundEnabled,
      textBackgroundPadding,
    },
    displayed,
    refreshSelection,
    selection,
    onBoldChange: () =>
      applyOrSetDefault(
        { property: 'bold', value: !displayed.bold },
        !displayed.bold,
        (style, value) => ({ ...style, bold: value }),
        setBold,
      ),
    onDashChange: (value: boolean) =>
      applyOrSetDefault(
        { property: 'dash', value },
        value,
        (style, nextValue) => ({ ...style, dash: nextValue }),
        setDash,
      ),
    onFillChange: (value: string) =>
      applyOrSetDefault(
        { property: 'fill', value },
        value,
        (style, nextValue) => ({ ...style, fill: nextValue }),
        setFill,
      ),
    onFontSizeChange: (value: number) =>
      applyOrSetDefault(
        { property: 'fontSize', value },
        value,
        (style, nextValue) => ({ ...style, fontSize: nextValue }),
        setFontSize,
      ),
    onHighlightOpacityChange: (value: number) =>
      applyOrSetDefault(
        { property: 'highlightOpacity', value },
        value,
        (style, nextValue) => ({ ...style, highlightOpacity: nextValue }),
        setHighlightOpacity,
      ),
    onStrokeChange: (value: string) =>
      applyOrSetDefault(
        { property: 'stroke', value, highlightOpacity: displayed.highlightOpacity },
        value,
        (style, nextValue) => ({ ...style, stroke: nextValue }),
        setStroke,
      ),
    onStrokeWidthChange: (value: number) => {
      const result = applySelectedStyle({ property: 'strokeWidth', value });
      if (result === true) setSelectedStyle((style) => ({ ...style, strokeWidth: value }));
      else if (result === undefined) {
        if (tool === ImageEditorTool.Brush) setBrushWidth(value);
        else setStrokeWidth(value);
      }
    },
    onTextBackgroundColorChange: (value: string) => {
      const result = applyOrSetDefault(
        { property: 'textBackgroundColor', value },
        value,
        (style, nextValue) => ({ ...style, textBackgroundColor: nextValue }),
        setTextBackgroundColor,
      );
      if (result === undefined) setTextBackgroundEnabled(true);
    },
    onTextBackgroundEnabledChange: (value: boolean) =>
      applyOrSetDefault(
        { property: 'textBackgroundEnabled', value },
        value,
        (style, nextValue) => ({ ...style, textBackgroundEnabled: nextValue }),
        setTextBackgroundEnabled,
      ),
    onTextBackgroundPaddingChange: (value: number) =>
      applyOrSetDefault(
        { property: 'textBackgroundPadding', value },
        value,
        (style, nextValue) => ({ ...style, textBackgroundPadding: nextValue }),
        setTextBackgroundPadding,
      ),
  };
}
