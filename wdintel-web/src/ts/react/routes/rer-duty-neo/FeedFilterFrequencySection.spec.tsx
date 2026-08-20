/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
  notify: vi.fn(),
  selectionProps: null as Record<string, unknown> | null,
  selectionPropsList: [] as Array<Record<string, unknown>>,
}));

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CircularProgress: () => <span />,
  FormControl: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  IconButton: () => <button />,
  MenuItem: ({ children }: { children: ReactNode }) => <option>{children}</option>,
  Select: ({ children }: { children: ReactNode }) => <select>{children}</select>,
  Tooltip: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Typography: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@mui/icons-material/RefreshOutlined', () => ({ default: () => <span /> }));
vi.mock('../../../copy-to-clipboard', () => ({
  copyTextToClipboard: mocks.copyTextToClipboard,
}));
vi.mock('../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => ({ notify: mocks.notify }),
}));
vi.mock('./FeedFilterSelectionSection', () => ({
  FeedFilterSelectionSection: (props: Record<string, unknown>) => {
    mocks.selectionProps = props;
    mocks.selectionPropsList.push(props);
    return null;
  },
}));

import { FeedFilterFrequencySection } from './FeedFilterFrequencySection';

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  mocks.copyTextToClipboard.mockReset();
  mocks.notify.mockReset();
  mocks.selectionProps = null;
  mocks.selectionPropsList = [];
});

function renderFrequency(
  overrides: Partial<Parameters<typeof FeedFilterFrequencySection>[0]> = {},
) {
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => {
    root.render(
      <FeedFilterFrequencySection
        mode="include"
        onModeChange={vi.fn()}
        value={[]}
        onValueChange={vi.fn()}
        options={['153.6250', '154.0000', '155.3750']}
        reloadFreqsLoading={false}
        onReloadFreqs={vi.fn()}
        {...overrides}
      />,
    );
  });
  return mocks.selectionProps as {
    bulkPaste: boolean;
    bulkPasteSeparators: string[];
    bulkPasteMenuLabel: string;
    bulkCopy: boolean;
    bulkCopyMenuLabel: string;
    onBulkCopy: (selected: readonly string[]) => Promise<void>;
    onValueChange: (value: string[]) => void;
  };
}

describe('FeedFilterFrequencySection', () => {
  it('configures newline bulk paste and ordered frequency copy', async () => {
    mocks.copyTextToClipboard.mockResolvedValue(undefined);
    const props = renderFrequency({ value: ['153.6250', '154.0000'] });

    expect(props.bulkPaste).toBe(true);
    expect(props.bulkPasteSeparators).toEqual([',', '\n']);
    expect(props.bulkCopy).toBe(true);
    expect(props.bulkPasteMenuLabel).toBe('Додати кілька частот');
    expect(props.bulkCopyMenuLabel).toBe('Копіювати обрані частоти');

    await props.onBulkCopy(['153.6250', '154.0000']);

    expect(mocks.copyTextToClipboard).toHaveBeenCalledWith('153.6250\n154.0000');
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'Скопійовано значень: 2.',
    });
  });

  it('reports clipboard failures through an error notification', async () => {
    mocks.copyTextToClipboard.mockRejectedValue(new Error('clipboard denied'));
    const props = renderFrequency({ value: ['153.6250'] });

    await props.onBulkCopy(['153.6250']);

    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'error',
      message: 'Не вдалося скопіювати частоти.',
    });
  });

  it('routes bulk-pasted values through the active frequency selection', () => {
    const onValueChange = vi.fn();
    const props = renderFrequency({ mode: 'exclude', value: ['153.6250'], onValueChange });

    props.onValueChange(['153.6250', '154.0000', '155.3750']);

    expect(onValueChange).toHaveBeenCalledWith(['153.6250', '154.0000', '155.3750']);
  });
});
