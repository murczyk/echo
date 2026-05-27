/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';

const powerDateTimePickerMock = vi.fn((props: {
  label?: string;
  value: unknown;
  onChange?: (value: unknown) => void;
  onAccept?: (value: unknown) => void;
  onClose?: () => void;
}) => <div data-testid={`picker-${props.label ?? 'unknown'}`} />);

vi.mock('../../../components/PowerDateTimePicker', () => ({
  PowerDateTimePicker: (props: {
    label?: string;
    value: unknown;
    onChange?: (value: unknown) => void;
    onAccept?: (value: unknown) => void;
    onClose?: () => void;
  }) => powerDateTimePickerMock(props),
}));

import { NetworkEtalonkaReportDialog } from './NetworkEtalonkaReportDialog';

function renderDialog(overrides: Partial<Parameters<typeof NetworkEtalonkaReportDialog>[0]> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClose = vi.fn();
  const onDownload = vi.fn();
  const onTypeChange = vi.fn();
  const onActiveFreqsOnlyChange = vi.fn();
  const onIncludeSigintSignsChange = vi.fn();
  const onIncludeConfirmationChange = vi.fn();
  const onIncludeUnitCallsignsChange = vi.fn();
  const onIncludePelengsMapChange = vi.fn();
  const onFromDateTimeStrChange = vi.fn();
  const onToDateTimeStrChange = vi.fn();

  const props: Parameters<typeof NetworkEtalonkaReportDialog>[0] = {
    report: {
      dialogOpen: true,
      downloading: false,
      reportType: 'ExtendedReport',
      activeFreqsOnly: true,
      includeSigintSigns: true,
      includeConfirmation: true,
      includeUnitCallsigns: false,
      includePelengsMap: true,
      fromDateTimeStr: '2026-05-01T10:00',
      toDateTimeStr: '2026-05-02T11:00',
      error: null,
    },
    onClose,
    onDownload,
    onTypeChange,
    onActiveFreqsOnlyChange,
    onIncludeSigintSignsChange,
    onIncludeConfirmationChange,
    onIncludeUnitCallsignsChange,
    onIncludePelengsMapChange,
    onFromDateTimeStrChange,
    onToDateTimeStrChange,
    ...overrides,
  };

  act(() => {
    root.render(<NetworkEtalonkaReportDialog {...props} />);
  });

  return {
    container,
    root,
    props,
    onClose,
    onDownload,
    onTypeChange,
    onActiveFreqsOnlyChange,
    onIncludeSigintSignsChange,
    onIncludeConfirmationChange,
    onIncludeUnitCallsignsChange,
    onIncludePelengsMapChange,
    onFromDateTimeStrChange,
    onToDateTimeStrChange,
  };
}

describe('NetworkEtalonkaReportDialog', () => {
  afterEach(() => {
    powerDateTimePickerMock.mockClear();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('keeps extended report edits local until accept and resets on close', () => {
    const view = renderDialog();

    const fromPickerProps = powerDateTimePickerMock.mock.calls.filter((call) => call[0].label === 'Від').at(-1)?.[0];
    expect(fromPickerProps).toBeDefined();
    expect((fromPickerProps?.value as dayjs.Dayjs).format('YYYY-MM-DDTHH:mm')).toBe('2026-05-01T10:00');

    act(() => {
      fromPickerProps?.onChange?.(dayjs('2026-05-03T12:30'));
    });

    expect(view.onFromDateTimeStrChange).not.toHaveBeenCalled();

    const updatedFromPickerProps = powerDateTimePickerMock.mock.calls.filter((call) => call[0].label === 'Від').at(-1)?.[0];
    expect((updatedFromPickerProps?.value as dayjs.Dayjs).format('YYYY-MM-DDTHH:mm')).toBe('2026-05-03T12:30');

    act(() => {
      updatedFromPickerProps?.onAccept?.(dayjs('2026-05-03T12:30'));
    });

    expect(view.onFromDateTimeStrChange).toHaveBeenCalledWith('2026-05-03T12:30');

    act(() => {
      view.root.render(
        <NetworkEtalonkaReportDialog
          {...view.props}
          report={{
            ...view.props.report,
            fromDateTimeStr: '2026-05-03T12:30',
          }}
        />,
      );
    });

    act(() => {
      updatedFromPickerProps?.onChange?.(dayjs('2026-05-04T13:45'));
    });

    const draftFromPickerProps = powerDateTimePickerMock.mock.calls.filter((call) => call[0].label === 'Від').at(-1)?.[0];
    expect((draftFromPickerProps?.value as dayjs.Dayjs).format('YYYY-MM-DDTHH:mm')).toBe('2026-05-04T13:45');

    act(() => {
      draftFromPickerProps?.onClose?.();
    });

    act(() => {
      view.container.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
        if (button.textContent?.trim() === 'Закрити') {
          button.click();
        }
      });
    });

    act(() => {
      view.root.render(
        <NetworkEtalonkaReportDialog
          {...view.props}
          report={{
            ...view.props.report,
            dialogOpen: false,
          }}
        />,
      );
    });

    act(() => {
      view.root.render(
        <NetworkEtalonkaReportDialog
          {...view.props}
          report={{
            ...view.props.report,
            dialogOpen: true,
          }}
        />,
      );
    });

    const resetFromPickerProps = powerDateTimePickerMock.mock.calls.filter((call) => call[0].label === 'Від').at(-1)?.[0];
    expect((resetFromPickerProps?.value as dayjs.Dayjs).format('YYYY-MM-DDTHH:mm')).toBe('2026-05-01T10:00');

    act(() => {
      view.root.unmount();
    });
  });
});
