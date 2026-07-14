/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PalitraDetails } from '../maps/palitra-types';
import './analysis-map-palitras-element';

function createPalitraDetails(overrides?: Partial<PalitraDetails>): PalitraDetails {
  return {
    palitra: {
      id: 1,
      name: 'Test palette',
      color_hex: '#00aa00',
      geometry: {
        perimeter_linear_ring: [
          { lat: 47.1, lng: 35.1 },
          { lat: 47.2, lng: 35.1 },
          { lat: 47.2, lng: 35.2 },
        ],
      },
      ...overrides?.palitra,
    },
    points: [],
    ...overrides,
  };
}

function createPolygonGeometry() {
  return {
    perimeter_linear_ring: [
      { lat: 47.1, lng: 35.1 },
      { lat: 47.2, lng: 35.1 },
      { lat: 47.2, lng: 35.2 },
    ],
  };
}

function createLineGeometry() {
  return {
    line_strings: [
      [
        { lat: 47.1, lng: 35.1 },
        { lat: 47.2, lng: 35.2 },
      ],
    ],
  };
}

function createElement(): HTMLElement & {
  setPalitras: (palitras: PalitraDetails[]) => void;
  setVisibleIds: (visibleIds: number[]) => void;
  setLoadState: (loadState: 'idle' | 'loading' | 'success' | 'error') => void;
  setInteractionDisabled: (disabled: boolean) => void;
  setCollapsed: (collapsed: boolean) => void;
} {
  return document.createElement('analysis-map-palitras') as HTMLElement & {
    setPalitras: (palitras: PalitraDetails[]) => void;
    setVisibleIds: (visibleIds: number[]) => void;
    setLoadState: (loadState: 'idle' | 'loading' | 'success' | 'error') => void;
    setInteractionDisabled: (disabled: boolean) => void;
    setCollapsed: (collapsed: boolean) => void;
  };
}

async function mountElement(element: HTMLElement, container: HTMLElement): Promise<void> {
  await act(async () => {
    container.appendChild(element);
  });
}

describe('analysis-map-palitras', () => {
  let container: HTMLElement;

  beforeEach(() => {
    try {
      window.localStorage.removeItem('palitras-control-collapsed');
    } catch {
      // ignore
    }
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container) {
      act(() => {
        container.remove();
      });
    }
  });

  it('shows the explicit focus action for selected polygon geometry', async () => {
    const element = createElement();
    element.setPalitras([createPalitraDetails()]);
    element.setVisibleIds([1]);
    element.setLoadState('success');
    await mountElement(element, container);

    expect(element.querySelector('button[aria-label="Показати обрані палітри"]')).toBeTruthy();
  });

  it('shows the explicit focus action for selected line geometry', async () => {
    const element = createElement();
    element.setPalitras([
      createPalitraDetails({
        palitra: {
          id: 2,
          name: 'Line geometry',
          color_hex: '#aa0000',
          geometry: createLineGeometry(),
        },
      }),
    ]);
    element.setVisibleIds([2]);
    element.setLoadState('success');
    await mountElement(element, container);

    expect(element.querySelector('button[aria-label="Показати обрані палітри"]')).toBeTruthy();
  });

  it('hides the explicit focus action for selected null geometry', async () => {
    const element = createElement();
    element.setPalitras([
      createPalitraDetails({
        palitra: {
          id: 3,
          name: 'No geometry',
          color_hex: '#aa0000',
          geometry: null,
        },
      }),
    ]);
    element.setVisibleIds([3]);
    element.setLoadState('success');
    await mountElement(element, container);

    expect(element.querySelector('button[aria-label="Показати обрані палітри"]')).toBeNull();
  });

  it('hides the explicit focus action for selected center-only geometry', async () => {
    const element = createElement();
    element.setPalitras([
      createPalitraDetails({
        palitra: {
          id: 4,
          name: 'Center only',
          color_hex: '#aa0000',
          geometry: {
            center: { lat: 47.15, lng: 35.15 },
          },
        },
      }),
    ]);
    element.setVisibleIds([4]);
    element.setLoadState('success');
    await mountElement(element, container);

    expect(element.querySelector('button[aria-label="Показати обрані палітри"]')).toBeNull();
  });

  it('hides the explicit focus action for selected short geometry arrays', async () => {
    const cases = [
      {
        id: 5,
        name: 'Short ring',
        geometry: {
          perimeter_linear_ring: [
            { lat: 47.1, lng: 35.1 },
            { lat: 47.2, lng: 35.2 },
          ],
        },
      },
      {
        id: 6,
        name: 'Short line',
        geometry: {
          line_strings: [[{ lat: 47.1, lng: 35.1 }]],
        },
      },
    ] as const;

    for (const testCase of cases) {
      const element = createElement();
      element.setPalitras([
        createPalitraDetails({
          palitra: {
            id: testCase.id,
            name: testCase.name,
            color_hex: '#aa0000',
            geometry: testCase.geometry,
          },
        }),
      ]);
      element.setVisibleIds([testCase.id]);
      element.setLoadState('success');
      await mountElement(element, container);

      expect(element.querySelector('button[aria-label="Показати обрані палітри"]')).toBeNull();
      element.remove();
    }
  });

  it('dispatches a focus request when the explicit fit button is clicked', async () => {
    const element = createElement();
    element.setPalitras([createPalitraDetails()]);
    element.setVisibleIds([1]);
    element.setLoadState('success');
    await mountElement(element, container);

    const focusEvents: Event[] = [];
    element.addEventListener('palitras-focus-visible-request', (event) => {
      focusEvents.push(event);
    });

    const button = element.querySelector<HTMLButtonElement>(
      'button[aria-label="Показати обрані палітри"]',
    );
    expect(button).not.toBeNull();

    await act(async () => {
      button?.click();
    });

    expect(focusEvents).toHaveLength(1);
  });

  it('toggles visibility without dispatching a focus request', async () => {
    const element = createElement();
    element.setPalitras([createPalitraDetails()]);
    element.setVisibleIds([1]);
    element.setLoadState('success');
    await mountElement(element, container);

    const focusEvents: Event[] = [];
    const visibleEvents: number[][] = [];
    element.addEventListener('palitras-focus-visible-request', (event) => {
      focusEvents.push(event);
    });
    element.addEventListener('palitras-visible-ids-change', (event) => {
      visibleEvents.push((event as CustomEvent<{ visibleIds: number[] }>).detail.visibleIds ?? []);
    });

    const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();

    await act(async () => {
      checkbox?.click();
    });

    expect(visibleEvents).toHaveLength(1);
    expect(focusEvents).toHaveLength(0);
  });
});
