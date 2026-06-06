/**
 * @vitest-environment happy-dom
 */
import * as L from 'leaflet';
import { describe, expect, it, vi } from 'vitest';

import { initializeAnalysisMapControls } from './map-controls';

describe('initializeAnalysisMapControls', () => {
  it('adds the palitras control to the map', () => {
    const addedControls: L.Control[] = [];
    const map = {
      addControl: vi.fn((control: L.Control) => {
        addedControls.push(control);
        return map;
      }),
    } as unknown as L.Map;

    const controls = initializeAnalysisMapControls({
      map,
      tileLayers: {
        openStreetMap: L.tileLayer(''),
        googleHybrid: L.tileLayer(''),
      },
      daterange: { startDate: 0, endDate: 0 },
      isDateRangeInteractionLocked: false,
      isFullscreen: false,
      featureToggleState: { palitrasEnabled: true, kmzEnabled: true, pelengsEnabled: true },
      pelengLabelsPermanent: true,
      onToggleFullscreen: vi.fn(),
      onFeatureToggle: vi.fn(),
      onPelengLabelsPermanentChange: vi.fn(),
      onVisiblePalitraIdsChange: vi.fn(),
    });

    expect(addedControls).toContain(controls.palitrasControl);
  });
});
