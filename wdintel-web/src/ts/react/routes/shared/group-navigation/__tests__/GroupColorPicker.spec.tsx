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

  it('reports the selected dropdown color without changing the controlled value', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <ThemeProvider theme={createTheme()}>
          <GroupColorPicker value="blue" onChange={onChange} />
        </ThemeProvider>,
      );
    });

    const trigger = container.querySelector<HTMLElement>('[role="combobox"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain('Синій');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    const option = document.querySelector<HTMLElement>(
      '[role="option"][data-group-color="deep_purple"]',
    );
    expect(option).not.toBeNull();
    await act(async () => option!.click());
    expect(onChange).toHaveBeenCalledWith('deep_purple');
    expect(trigger?.textContent).toContain('Синій');
  });

  it.each(['light', 'dark'] as const)('keeps every %s palette color readable', (mode) => {
    const theme = createTheme({ palette: { mode } });
    for (const colorKey of signalGroupColors) {
      const colors = resolveGroupColor(theme, colorKey);
      expect(getContrastRatio(colors.backgroundColor, colors.color)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
