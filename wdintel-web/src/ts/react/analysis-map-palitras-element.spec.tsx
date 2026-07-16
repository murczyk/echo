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

  it.each([
    {
      id: 3,
      name: 'No geometry',
      geometry: null,
    },
    {
      id: 4,
      name: 'Center only',
      geometry: {
        center: { lat: 47.15, lng: 35.15 },
      },
    },
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
  ] as const)(
    'hides focus actions for selected non-renderable geometry: $name',
    async (testCase) => {
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

      expect(element.querySelector('button[aria-label="Дії палітри"]')).toBeNull();
      expect(element.querySelector('button[aria-label="Показати обрані палітри"]')).toBeNull();
    },
  );

  it('hides the global focus action when nothing is selected', async () => {
    const element = createElement();
    element.setPalitras([
      createPalitraDetails({
        palitra: {
          id: 8,
          name: 'Unselected palette',
          color_hex: '#00aa00',
          geometry: createPolygonGeometry(),
        },
      }),
    ]);
    element.setVisibleIds([]);
    element.setLoadState('success');
    await mountElement(element, container);

    expect(element.querySelector('button[aria-label="Показати обрані палітри"]')).toBeNull();
  });

  it('shows the per-group overflow only after a group selection exists', async () => {
    const element = createElement();
    element.setPalitras([
      createPalitraDetails({
        palitra: {
          id: 7,
          name: 'Group palette',
          color_hex: '#00aa00',
          geometry: createPolygonGeometry(),
        },
      }),
    ]);
    element.setVisibleIds([]);
    element.setLoadState('success');
    await mountElement(element, container);

    expect(element.querySelector('button[aria-label="Дії палітри"]')).toBeNull();

    await act(async () => {
      element.setVisibleIds([7]);
    });

    expect(element.querySelector('button[aria-label="Дії палітри"]')).toBeTruthy();
  });

  it('dispatches the selected ids from the global focus button', async () => {
    const element = createElement();
    element.setPalitras([
      createPalitraDetails(),
      createPalitraDetails({
        palitra: {
          id: 2,
          name: 'Second palette',
          color_hex: '#0000aa',
          geometry: createLineGeometry(),
        },
      }),
    ]);
    element.setVisibleIds([1, 2]);
    element.setLoadState('success');
    await mountElement(element, container);

    const focusEvents: number[][] = [];
    element.addEventListener('palitras-focus-request', (event) => {
      focusEvents.push((event as CustomEvent<{ palitraIds: number[] }>).detail.palitraIds ?? []);
    });

    const button = element.querySelector<HTMLButtonElement>(
      'button[aria-label="Показати обрані палітри"]',
    );
    expect(button).not.toBeNull();

    await act(async () => {
      button?.click();
    });

    expect(focusEvents).toEqual([[1, 2]]);
  });

  it('dispatches only the selected ids from a partial group menu action', async () => {
    const element = createElement();
    element.setPalitras([
      createPalitraDetails({
        palitra: {
          id: 10,
          name: 'Partial group',
          color_hex: '#00aa00',
          geometry: createPolygonGeometry(),
        },
      }),
      createPalitraDetails({
        palitra: {
          id: 11,
          name: 'Partial group 2',
          color_hex: '#00bb00',
          geometry: createPolygonGeometry(),
        },
      }),
    ]);
    element.setVisibleIds([10]);
    element.setLoadState('success');
    await mountElement(element, container);

    const focusEvents: number[][] = [];
    element.addEventListener('palitras-focus-request', (event) => {
      focusEvents.push((event as CustomEvent<{ palitraIds: number[] }>).detail.palitraIds ?? []);
    });

    const trigger = element.querySelector<HTMLButtonElement>('button[aria-label="Дії палітри"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.click();
    });

    const menuItem = document.body.querySelector<HTMLLIElement>('li[role="menuitem"]');
    expect(menuItem).not.toBeNull();

    await act(async () => {
      menuItem?.click();
    });

    expect(focusEvents).toEqual([[10]]);
  });

  it('does not include selected ids from another group', async () => {
    const element = createElement();
    element.setPalitras([
      createPalitraDetails({
        palitra: {
          id: 20,
          name: 'Group A',
          color_hex: '#00aa00',
          geometry: createPolygonGeometry(),
        },
      }),
      createPalitraDetails({
        palitra: {
          id: 21,
          name: 'Group B',
          color_hex: '#00bb00',
          geometry: createPolygonGeometry(),
        },
      }),
    ]);
    element.setVisibleIds([20, 21]);
    element.setLoadState('success');
    await mountElement(element, container);

    const focusEvents: number[][] = [];
    element.addEventListener('palitras-focus-request', (event) => {
      focusEvents.push((event as CustomEvent<{ palitraIds: number[] }>).detail.palitraIds ?? []);
    });

    const triggers = element.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Дії палітри"]',
    );
    expect(triggers.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      triggers[0]?.click();
    });

    const menuItem = document.body.querySelector<HTMLLIElement>('li[role="menuitem"]');
    expect(menuItem).not.toBeNull();

    await act(async () => {
      menuItem?.click();
    });

    expect(focusEvents).toEqual([[20]]);
  });

  it('closes an open group menu when the selection becomes ineligible', async () => {
    const element = createElement();
    element.setPalitras([
      createPalitraDetails({
        palitra: {
          id: 30,
          name: 'Menu group',
          color_hex: '#00aa00',
          geometry: createPolygonGeometry(),
        },
      }),
    ]);
    element.setVisibleIds([30]);
    element.setLoadState('success');
    await mountElement(element, container);

    const trigger = element.querySelector<HTMLButtonElement>('button[aria-label="Дії палітри"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.click();
    });

    expect(document.body.querySelector('li[role="menuitem"]')).not.toBeNull();

    await act(async () => {
      element.setVisibleIds([]);
    });

    expect(document.body.querySelector('li[role="menuitem"]')).toBeNull();
  });

  it('keeps an eligible group menu trigger visible but disabled while locked', async () => {
    const element = createElement();
    element.setPalitras([
      createPalitraDetails({
        palitra: {
          id: 40,
          name: 'Locked group',
          color_hex: '#00aa00',
          geometry: createPolygonGeometry(),
        },
      }),
    ]);
    element.setVisibleIds([40]);
    element.setLoadState('success');
    element.setInteractionDisabled(true);
    await mountElement(element, container);

    const focusEvents: number[][] = [];
    element.addEventListener('palitras-focus-request', (event) => {
      focusEvents.push((event as CustomEvent<{ palitraIds: number[] }>).detail.palitraIds ?? []);
    });

    const trigger = element.querySelector<HTMLButtonElement>('button[aria-label="Дії палітри"]');
    expect(trigger?.disabled).toBe(true);

    await act(async () => {
      trigger?.click();
    });

    expect(document.body.querySelector('li[role="menuitem"]')).toBeNull();
    expect(focusEvents).toHaveLength(0);
  });
});
