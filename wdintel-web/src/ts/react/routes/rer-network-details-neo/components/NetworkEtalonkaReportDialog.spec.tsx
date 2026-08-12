/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';

const powerDateTimePickerMock = vi.fn(
  (props: {
    label?: string;
    value: unknown;
    onChange?: (value: unknown) => void;
    onAccept?: (value: unknown) => void;
    onClose?: () => void;
  }) => <div data-testid={`picker-${props.label ?? 'unknown'}`} />,
);

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
  const onIncludeFreqActiveFromChange = vi.fn();
  const onIncludeFreqCreatedAtChange = vi.fn();
  const onIncludeCallsignFullNamesChange = vi.fn();
  const onIncludeSigintSignsChange = vi.fn();
  const onIncludeConfirmationChange = vi.fn();
  const onIncludeUnitCallsignsChange = vi.fn();
  const onIncludePelengsMapChange = vi.fn();
  const onFromDateTimeStrChange = vi.fn();
  const onToDateTimeStrChange = vi.fn();

  const props: Parameters<typeof NetworkEtalonkaReportDialog>[0] = {
    report: {
      dialogOpen: true,
      taskRunId: 0,
      taskId: null,
      startedAtMs: null,
      running: false,
      curr: 0,
      overall: 4,
      logs: [],
      reportType: 'ExtendedReport',
      activeFreqsOnly: true,
      includeFreqActiveFrom: false,
      includeFreqCreatedAt: true,
      includeCallsignFullNames: false,
      includeSigintSigns: true,
      includeConfirmation: true,
      includeUnitCallsigns: false,
      includePelengsMap: true,
      fromDateTimeStr: '2026-05-01T10:00',
      toDateTimeStr: '2026-05-02T11:00',
      downloadFileName: null,
      error: null,
      finishedAt: null,
      progressExpanded: false,
    },
    description: 'Для поточної радіомережі',
    onClose,
    onDownload,
    onSetProgressExpanded: vi.fn(),
    onTypeChange,
    onActiveFreqsOnlyChange,
    onIncludeFreqActiveFromChange,
    onIncludeFreqCreatedAtChange,
    onIncludeCallsignFullNamesChange,
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
    onIncludeFreqActiveFromChange,
    onIncludeFreqCreatedAtChange,
    onIncludeCallsignFullNamesChange,
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

  it('forwards the full-name option change', () => {
    const view = renderDialog();
    const label = Array.from(document.querySelectorAll('label')).find((element) =>
      element.textContent?.includes('Включити ПІБ у позивні'),
    );
    const checkbox = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');

    act(() => checkbox?.click());

    expect(view.onIncludeCallsignFullNamesChange).toHaveBeenCalledWith(true);
    act(() => view.root.unmount());
  });

  it('forwards both frequency date column options independently', () => {
    const view = renderDialog();
    const labels = Array.from(document.querySelectorAll('label'));
    const activeFromCheckbox = labels
      .find((element) => element.textContent?.includes('Активна з'))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const createdAtCheckbox = labels
      .find((element) => element.textContent?.includes("Дата прив'язки"))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');

    act(() => activeFromCheckbox?.click());
    act(() => createdAtCheckbox?.click());

    expect(view.onIncludeFreqActiveFromChange).toHaveBeenCalledWith(true);
    expect(view.onIncludeFreqCreatedAtChange).toHaveBeenCalledWith(false);
    act(() => view.root.unmount());
  });

  it('keeps extended report edits local until accept and resets on close', () => {
    const view = renderDialog();

    const fromPickerProps = powerDateTimePickerMock.mock.calls
      .filter((call) => call[0].label === 'Від')
      .at(-1)?.[0];
    expect(fromPickerProps).toBeDefined();
    expect((fromPickerProps?.value as dayjs.Dayjs).format('YYYY-MM-DDTHH:mm')).toBe(
      '2026-05-01T10:00',
    );

    act(() => {
      fromPickerProps?.onChange?.(dayjs('2026-05-03T12:30'));
    });

    expect(view.onFromDateTimeStrChange).not.toHaveBeenCalled();

    const updatedFromPickerProps = powerDateTimePickerMock.mock.calls
      .filter((call) => call[0].label === 'Від')
      .at(-1)?.[0];
    expect((updatedFromPickerProps?.value as dayjs.Dayjs).format('YYYY-MM-DDTHH:mm')).toBe(
      '2026-05-03T12:30',
    );

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

    const draftFromPickerProps = powerDateTimePickerMock.mock.calls
      .filter((call) => call[0].label === 'Від')
      .at(-1)?.[0];
    expect((draftFromPickerProps?.value as dayjs.Dayjs).format('YYYY-MM-DDTHH:mm')).toBe(
      '2026-05-04T13:45',
    );

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

    const resetFromPickerProps = powerDateTimePickerMock.mock.calls
      .filter((call) => call[0].label === 'Від')
      .at(-1)?.[0];
    expect((resetFromPickerProps?.value as dayjs.Dayjs).format('YYYY-MM-DDTHH:mm')).toBe(
      '2026-05-01T10:00',
    );

    act(() => {
      view.root.unmount();
    });
  });

  it('keeps technical task ids out of the visible header and shows the long-running hint', () => {
    const originalNow = Date.now;
    Date.now = () => 192_000 + 1;

    try {
      const view = renderDialog({
        report: {
          dialogOpen: true,
          taskRunId: 7,
          taskId: 42,
          historyRow: {
            id: 42,
            reportKind: 'etalonka',
            requestedBy: 'user',
            createdAt: '2026-05-01T09:57:00',
            startedAt: '2026-05-01T09:57:30',
            plannedForTs: null,
            queuePosition: 2,
            status: 'in_progress',
            completedAt: null,
            hasFile: false,
            fileName: null,
            contentType: null,
            bgtaskId: 77,
            lastError: null,
            details: '',
            progress: 50,
            errorLog: null,
          },
          startedAtMs: 0,
          running: true,
          curr: 2,
          overall: 4,
          logs: ['[1/4] Підготовка даних'],
          reportType: 'ExtendedReport',
          activeFreqsOnly: true,
          includeFreqActiveFrom: false,
          includeFreqCreatedAt: true,
          includeCallsignFullNames: false,
          includeSigintSigns: true,
          includeConfirmation: true,
          includeUnitCallsigns: false,
          includePelengsMap: true,
          fromDateTimeStr: '2026-05-01T10:00',
          toDateTimeStr: '2026-05-02T11:00',
          downloadFileName: null,
          error: null,
          finishedAt: null,
          progressExpanded: true,
        },
      });

      expect(document.body.textContent).not.toContain('task 42');
      expect(document.body.textContent).toContain('#42');
      expect(document.body.textContent).toContain('3 хв 12 с');
      expect(document.body.textContent).toContain('Етап');
      expect(document.body.textContent).toContain('Логи');
      expect(document.body.textContent).toContain('Файл');
      expect(document.body.textContent).toContain('Формування може тривати кілька хвилин');

      act(() => {
        view.root.unmount();
      });
    } finally {
      Date.now = originalNow;
    }
  });

  it('hides empty progress details for a queued report and shows them when logs exist', () => {
    const queuedView = renderDialog({
      report: {
        dialogOpen: true,
        taskRunId: 11,
        taskId: 99,
        historyRow: {
          id: 99,
          reportKind: 'etalonka',
          requestedBy: 'user',
          createdAt: '2026-05-01T09:57:00',
          startedAt: null,
          plannedForTs: null,
          queuePosition: 2,
          status: 'planned',
          completedAt: null,
          hasFile: false,
          fileName: null,
          contentType: null,
          bgtaskId: null,
          lastError: null,
          details: '',
          progress: 0,
          errorLog: null,
        },
        startedAtMs: null,
        running: true,
        curr: 0,
        overall: 4,
        logs: [],
        reportType: 'ExtendedReport',
        activeFreqsOnly: true,
        includeFreqActiveFrom: false,
        includeFreqCreatedAt: true,
        includeCallsignFullNames: false,
        includeSigintSigns: true,
        includeConfirmation: true,
        includeUnitCallsigns: false,
        includePelengsMap: true,
        fromDateTimeStr: '2026-05-01T10:00',
        toDateTimeStr: '2026-05-02T11:00',
        downloadFileName: null,
        error: null,
        finishedAt: null,
        progressExpanded: false,
      },
    });

    const queuedText = document.body.textContent ?? '';
    expect(queuedText).toContain('Очікує запуску');
    expect(queuedText).not.toContain('[1/4]');
    expect(queuedText).not.toContain('Підготовка даних');
    expect(queuedText).toContain('Показати деталі');
    expect(queuedText).not.toContain('ID звіту');

    queuedView.props.onSetProgressExpanded(true);

    act(() => {
      queuedView.root.render(
        <NetworkEtalonkaReportDialog
          {...queuedView.props}
          report={{
            ...queuedView.props.report,
            progressExpanded: true,
          }}
        />,
      );
    });

    const expandedQueuedText = document.body.textContent ?? '';
    expect(expandedQueuedText).toContain('ID звіту');
    expect(expandedQueuedText).toContain('Черга');
    expect(expandedQueuedText).toContain('ID задачі');

    queuedView.props.onSetProgressExpanded(false);

    act(() => {
      queuedView.root.render(
        <NetworkEtalonkaReportDialog
          {...queuedView.props}
          report={{
            ...queuedView.props.report,
            progressExpanded: false,
          }}
        />,
      );
    });

    const collapsedQueuedText = document.body.textContent ?? '';
    expect(collapsedQueuedText).not.toContain('ID звіту');

    act(() => {
      queuedView.root.unmount();
    });

    const detailedView = renderDialog({
      report: {
        ...queuedView.props.report,
        historyRow: {
          ...queuedView.props.report.historyRow!,
          status: 'in_progress',
          bgtaskId: 77,
        },
        logs: ['backend note', '[1/4] Підготовка даних'],
        running: true,
        curr: 1,
        overall: 4,
        progressExpanded: true,
      },
    });

    const detailedText = document.body.textContent ?? '';
    expect(detailedText).toContain('backend note');
    expect(detailedText).toContain('[1/4] Підготовка даних');

    act(() => {
      detailedView.root.unmount();
    });
  });

  it('shows the cancelled message when polling ends with a user cancel', () => {
    const view = renderDialog({
      report: {
        dialogOpen: true,
        taskRunId: 14,
        taskId: 101,
        historyRow: {
          id: 101,
          reportKind: 'etalonka',
          requestedBy: 'user',
          createdAt: '2026-05-01T09:57:00',
          startedAt: '2026-05-01T09:57:30',
          plannedForTs: null,
          queuePosition: 2,
          status: 'failed',
          completedAt: '2026-05-01T10:05:00',
          hasFile: false,
          fileName: null,
          contentType: null,
          bgtaskId: 77,
          lastError: 'Скасовано користувачем',
          details: '',
          progress: 0,
          errorLog: null,
        },
        startedAtMs: null,
        running: false,
        curr: 0,
        overall: 4,
        logs: ['backend note'],
        reportType: 'ExtendedReport',
        activeFreqsOnly: true,
        includeFreqActiveFrom: false,
        includeFreqCreatedAt: true,
        includeCallsignFullNames: false,
        includeSigintSigns: true,
        includeConfirmation: true,
        includeUnitCallsigns: false,
        includePelengsMap: true,
        fromDateTimeStr: '2026-05-01T10:00',
        toDateTimeStr: '2026-05-02T11:00',
        downloadFileName: null,
        error: 'Звіт скасовано в Моїх звітах.',
        finishedAt: '2026-05-01T10:05:00',
        progressExpanded: false,
      },
    });

    const text = document.body.textContent ?? '';
    expect(text).toContain('Звіт скасовано в Моїх звітах.');
    expect(text).not.toContain('Формування може тривати кілька хвилин');

    act(() => {
      view.root.unmount();
    });
  });
});
