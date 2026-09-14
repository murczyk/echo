/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import * as fabric from 'fabric';
import { describe, expect, it, vi } from 'vitest';

import { useImageEditorSelectionStyle } from './use-image-editor-selection-style';
import { ImageEditorObjectRole } from './image-editor.types';

function renderSelectionStyle(selected: import('fabric').FabricObject) {
  const requestRenderAll = vi.fn(),
    scheduleHistory = vi.fn();
  let apply: ReturnType<typeof useImageEditorSelectionStyle>['applySelectedStyle'] | undefined;
  const root = createRoot(document.createElement('div'));
  function Harness() {
    const canvasRef = useRef({ getActiveObject: () => selected, requestRenderAll }),
      fabricRef = useRef(fabric);
    apply = useImageEditorSelectionStyle({
      canvasRef: canvasRef as never,
      fabricRef,
      scheduleHistory,
    }).applySelectedStyle;
    return null;
  }
  act(() => root.render(createElement(Harness)));
  return { apply: apply!, requestRenderAll, root, scheduleHistory };
}

describe('selected dashed annotation width #3448', () => {
  it.each([
    [() => new fabric.Rect(), ImageEditorObjectRole.Rectangle],
    [() => new fabric.Ellipse(), ImageEditorObjectRole.Ellipse],
    [() => new fabric.Line([0, 0, 20, 20]), ImageEditorObjectRole.Line],
  ] as const)('recalculates dash spacing for %p', (create, editorRole) => {
    const selected = create();
    selected.set({ editorRole, strokeWidth: 4, strokeDashArray: [8, 8] });
    const harness = renderSelectionStyle(selected);
    expect(harness.apply({ property: 'strokeWidth', value: 12 })).toBe(true);
    expect(selected.strokeWidth).toBe(12);
    expect(selected.strokeDashArray).toEqual([24, 24]);
    expect(harness.requestRenderAll).toHaveBeenCalledOnce();
    expect(harness.scheduleHistory).toHaveBeenCalledOnce();
    expect(harness.apply({ property: 'strokeWidth', value: 12 })).toBe(false);
    expect(harness.requestRenderAll).toHaveBeenCalledOnce();
    expect(harness.scheduleHistory).toHaveBeenCalledOnce();
    harness.root.unmount();
  });

  it('keeps solid annotations undashed', () => {
    const selected = new fabric.Rect({
      editorRole: ImageEditorObjectRole.Rectangle,
      strokeWidth: 4,
    });
    const harness = renderSelectionStyle(selected);
    expect(harness.apply({ property: 'strokeWidth', value: 12 })).toBe(true);
    expect(selected.strokeDashArray).toBeNull();
    expect(harness.requestRenderAll).toHaveBeenCalledOnce();
    expect(harness.scheduleHistory).toHaveBeenCalledOnce();
    harness.root.unmount();
  });
});
