/**
 * @vitest-environment happy-dom
 */
import * as fabric from 'fabric';
import { describe, expect, it } from 'vitest';

import { createArrow } from '../image-editor-arrow';

function renderedEndpoints(arrow: import('fabric').Group) {
  const [shaft, head] = arrow.getObjects() as [import('fabric').Line, import('fabric').Triangle];
  const linePoints = (
    shaft as unknown as { calcLinePoints: () => { x1: number; y1: number } }
  ).calcLinePoints();
  const start = fabric.util.transformPoint(
    new fabric.Point(linePoints.x1, linePoints.y1),
    shaft.calcTransformMatrix(),
  );
  const end = fabric.util.transformPoint(
    new fabric.Point(head.left ?? 0, head.top ?? 0),
    arrow.calcTransformMatrix(),
  );
  return { start, end };
}

// @test-scope regression: https://github.com/echoua/echo/issues/3099
describe('image editor arrow geometry #3099', () => {
  it.each([
    [
      { x: 100, y: 100 },
      { x: 500, y: 500 },
    ],
    [
      { x: 500, y: 500 },
      { x: 100, y: 100 },
    ],
    [
      { x: 100, y: 500 },
      { x: 500, y: 100 },
    ],
    [
      { x: 500, y: 100 },
      { x: 100, y: 500 },
    ],
  ])('keeps rendered endpoints aligned with the gesture', (start, end) => {
    const arrow = createArrow({
      fabric,
      start,
      end,
      stroke: '#ef4444',
      strokeWidth: 4,
      dash: false,
    });
    expect(arrow).not.toBeNull();
    const rendered = renderedEndpoints(arrow!);
    expect(rendered.start.x).toBeCloseTo(start.x, 3);
    expect(rendered.start.y).toBeCloseTo(start.y, 3);
    expect(rendered.end.x).toBeCloseTo(end.x, 3);
    expect(rendered.end.y).toBeCloseTo(end.y, 3);
  });
});
