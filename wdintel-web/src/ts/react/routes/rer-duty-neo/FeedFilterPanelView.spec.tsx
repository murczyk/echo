/** @vitest-environment happy-dom */
import { createTheme, ThemeProvider } from '@mui/material';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../components/SavedFiltersControl', () => ({ SavedFiltersControl: () => null }));
vi.mock('../../components/PowerButton', () => ({ PowerButton: () => null }));
vi.mock('./FeedFilterAdvancedSection', () => ({ FeedFilterAdvancedSection: () => null }));
vi.mock('./FeedFilterFrequencySection', () => ({ FeedFilterFrequencySection: () => null }));
vi.mock('./FeedFilterSelectionSection', () => ({ FeedFilterSelectionSection: () => null }));
vi.mock('./FeedFilterDeviceNamesSection', () => ({ FeedFilterDeviceNamesSection: () => null }));

import { FeedFilterPanelView } from './FeedFilterPanelView';

const darkTheme = createTheme({ palette: { mode: 'dark' } });

describe('FeedFilterPanelView', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('uses the shared duty panel surface without a separate dark gradient', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ThemeProvider theme={darkTheme}>
          <FeedFilterPanelView
            isDarkMode
            hasActiveFilter={false}
            onDiscardCurrentFilter={vi.fn()}
            groups={{} as never}
            senders={{} as never}
            freqs={{} as never}
            posts={{} as never}
            units={{ showExactMatchControl: false } as never}
            advanced={{}}
            savedFilters={{} as never}
          />
        </ThemeProvider>,
      );
    });

    const surface = container.querySelector('[aria-label="Панель фільтрів"] > div');
    expect(getComputedStyle(surface as Element).backgroundColor).toBe('#121212');
    expect(getComputedStyle(surface as Element).backgroundImage).toBe('none');

    await act(async () => root.unmount());
  });
});
