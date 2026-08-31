/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useImageEditorDrawingGestures } from './use-image-editor-drawing-gestures';

class FabricObject {
  constructor(values: Record<string, unknown> = {}) {
    Object.assign(this, values);
  }
  set(values: Record<string, unknown>) {
    Object.assign(this, values);
  }
  setCoords = vi.fn();
}
class FabricLine extends FabricObject {
  constructor([x1, y1, x2, y2]: number[], values: Record<string, unknown>) {
    super({ ...values, x1, y1, x2, y2 });
  }
  calcLinePoints() {
    return { x1: this.x1 as number, y1: this.y1 as number };
  }
  calcTransformMatrix() {
    return [];
  }
}
class FabricGroup extends FabricObject {
  constructor(
    readonly objects: FabricObject[],
    values: Record<string, unknown>,
  ) {
    super(values);
  }
  getObjects() {
    return this.objects;
  }
}
const fabric = {
  Rect: class extends FabricObject {},
  Ellipse: class extends FabricObject {},
  Line: FabricLine,
  Triangle: class extends FabricObject {},
  Group: FabricGroup,
  Point: class {
    constructor(
      readonly x: number,
      readonly y: number,
    ) {}
  },
  util: { transformPoint: (point: { x: number; y: number }) => point },
};

function renderGesture(tool: 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'conceal') {
  const handlers: Record<string, (event: { e: MouseEvent }) => void> = {};
  const objects: FabricObject[] = [];
  const canvas = {
    width: 400,
    height: 200,
    upperCanvasEl: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }) },
    add: vi.fn((object: FabricObject) => objects.push(object)),
    remove: vi.fn((object: FabricObject) => objects.splice(objects.indexOf(object), 1)),
    on: vi.fn((name: string, handler: (event: { e: MouseEvent }) => void) => {
      handlers[name] = handler;
    }),
    off: vi.fn(),
    requestRenderAll: vi.fn(),
  };
  const saveHistory = vi.fn();
  const replaceConcealmentArea = vi.fn().mockResolvedValue(undefined);
  const container = document.createElement('div');
  const root = createRoot(container);
  function Harness() {
    const canvasRef = useRef(canvas),
      fabricRef = useRef(fabric),
      toolRef = useRef(tool);
    const cancelGestureRef = useRef(() => false),
      hiddenTextareaContainer = useRef<HTMLElement | null>(null);
    useImageEditorDrawingGestures({
      canvasRef: canvasRef as never,
      fabricRef: fabricRef as never,
      canvasReady: true,
      tool,
      toolRef,
      stroke: '#111827',
      fill: 'transparent',
      strokeWidth: 2,
      dash: false,
      fontSize: 16,
      bold: false,
      concealMode: 'blur',
      isInteractionLocked: () => false,
      saveHistory,
      replaceConcealmentArea,
      concealmentMarquee: { stroke: '#ef4444', fill: 'rgba(239, 68, 68, 0.1)' },
      cancelGestureRef,
      setError: vi.fn(),
      hiddenTextareaContainer,
    });
    return null;
  }
  document.body.appendChild(container);
  act(() => root.render(createElement(Harness)));
  const gesture = (name: string, clientX: number, clientY: number) =>
    act(() => handlers[name]!({ e: new MouseEvent('mouse', { clientX, clientY }) }));
  return { gesture, objects, replaceConcealmentArea, root, saveHistory };
}

// @test-scope regression: https://github.com/echoua/echo/issues/3099
describe('image editor Fabric drawing gestures #3099', () => {
  afterEach(() => document.body.replaceChildren());
  it.each([
    ['rectangle', { left: 20, top: 40, width: 120, height: 80 }],
    ['ellipse', { left: 20, top: 40, rx: 60, ry: 40 }],
    ['line', { x1: 20, y1: 40, x2: 140, y2: 120 }],
  ] as const)('creates %s with native endpoints at CSS scale', (tool, geometry) => {
    const harness = renderGesture(tool);
    harness.gesture('mouse:down', 10, 20);
    harness.gesture('mouse:move', 70, 60);
    harness.gesture('mouse:up', 70, 60);
    expect(harness.objects).toHaveLength(1);
    expect(harness.objects[0]).toMatchObject(geometry);
    expect(harness.saveHistory).toHaveBeenCalledOnce();
    harness.gesture('mouse:up', 70, 60);
    expect(harness.saveHistory).toHaveBeenCalledOnce();
    harness.root.unmount();
  });
  it('creates an arrow and commits only one history entry at CSS scale', () => {
    const harness = renderGesture('arrow');
    harness.gesture('mouse:down', 10, 20);
    harness.gesture('mouse:move', 70, 60);
    harness.gesture('mouse:up', 70, 60);
    expect(harness.objects).toHaveLength(1);
    const arrow = harness.objects[0] as FabricGroup,
      shaft = arrow.getObjects()[0] as FabricLine;
    expect(arrow).toMatchObject({ editorRole: 'arrow' });
    expect({ x: shaft.x2 - shaft.x1, y: shaft.y2 - shaft.y1 }).toEqual({ x: 120, y: 80 });
    expect(harness.saveHistory).toHaveBeenCalledOnce();
    harness.gesture('mouse:up', 70, 60);
    expect(harness.saveHistory).toHaveBeenCalledOnce();
    harness.root.unmount();
  });
  it('replaces one concealment draft using native bounds and ignores duplicate pointer-up', async () => {
    const harness = renderGesture('conceal');
    harness.gesture('mouse:down', 10, 20);
    harness.gesture('mouse:move', 70, 60);
    harness.gesture('mouse:up', 70, 60);
    await act(async () => Promise.resolve());
    expect(harness.objects).toHaveLength(0);
    expect(harness.replaceConcealmentArea).toHaveBeenCalledOnce();
    expect(harness.replaceConcealmentArea).toHaveBeenCalledWith(
      { left: 20, top: 40, width: 120, height: 80 },
      'blur',
    );
    harness.gesture('mouse:up', 70, 60);
    expect(harness.replaceConcealmentArea).toHaveBeenCalledOnce();
    harness.root.unmount();
  });
});
