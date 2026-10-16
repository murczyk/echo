/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ThemeProvider, createTheme, getContrastRatio } from '@mui/material/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GroupColorPicker } from '../GroupColorPicker';
import { resolveGroupColor, signalGroupColors } from '../group-colors';

describe('GroupColorPicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the controlled palette and reports a selected color', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <ThemeProvider theme={createTheme()}>
          <GroupColorPicker value="blue" onChange={onChange} />
        </ThemeProvider>,
      );
    });

    const options = container.querySelectorAll<HTMLButtonElement>('[data-group-color]');
    expect(options).toHaveLength(16);
    expect(container.querySelector('[data-group-color="blue"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );

    await act(async () => options[3].click());
    expect(onChange).toHaveBeenCalledWith('deep_purple');
  });

  it.each(['light', 'dark'] as const)('keeps every %s palette color readable', (mode) => {
    const theme = createTheme({ palette: { mode } });
    for (const colorKey of signalGroupColors) {
      const colors = resolveGroupColor(theme, colorKey);
      expect(getContrastRatio(colors.backgroundColor, colors.color)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
