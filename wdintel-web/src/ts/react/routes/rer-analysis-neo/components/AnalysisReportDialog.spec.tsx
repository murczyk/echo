/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnalysisReportState } from '../report-helpers';
import { createDefaultReportState } from '../report-helpers';
import { createResetQueryState } from '../helpers';
import { AnalysisReportDialog } from './AnalysisReportDialog';

const dialogProps: Array<Record<string, unknown>> = [];

vi.mock('@mui/material', async () => {
  const actual = await vi.importActual<typeof import('@mui/material')>('@mui/material');
  return {
    ...actual,
    Dialog: (props: Record<string, unknown> & { children?: ReactNode }) => {
      dialogProps.push(props);
      return <div data-testid="dialog">{props.children}</div>;
    },
  };
});

function buildReport(overrides: Partial<AnalysisReportState> = {}): AnalysisReportState {
  return {
    ...createDefaultReportState(),
    ...overrides,
  };
}

function renderDialog(overrides: Partial<Parameters<typeof AnalysisReportDialog>[0]> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClose = vi.fn();
  const onDownload = vi.fn();
  const onRepeatTaskRun = vi.fn().mockResolvedValue(undefined);
  const onSetProgressExpanded = vi.fn();
  const onToggleTaskRunLogs = vi.fn();
  const onUpdate = vi.fn();

  const props: Parameters<typeof AnalysisReportDialog>[0] = {
    aors: [],
    downloadInFlight: false,
    progressExpanded: false,
    taskRuns: [],
    open: true,
    currentUser: null,
    supportNonRerInterceptions: false,
    report: buildReport(),
    queryState: createResetQueryState(),
    onClose,
    onDownload,
    onRepeatTaskRun,
    onSetProgressExpanded,
    onToggleTaskRunLogs,
    onUpdate,
    ...overrides,
  };

  act(() => {
    root.render(createElement(AnalysisReportDialog, props));
  });

  return {
    container,
    root,
    props,
    onClose,
    onDownload,
    onRepeatTaskRun,
    onSetProgressExpanded,
    onToggleTaskRunLogs,
    onUpdate,
  };
}

describe('AnalysisReportDialog', () => {
  afterEach(() => {
    dialogProps.splice(0);
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('blocks backdrop and escape close while queued', () => {
    const view = renderDialog({
      report: buildReport({
        open: true,
      }),
      taskRuns: [
        {
          id: 1,
          reportTitle: 'Донесення',
          reportName: 'report.docx',
          headerTitle: 'Звіт Донесення: report.docx',
          running: true,
          cancelled: false,
          curr: 0,
          overall: 100,
          logs: [],
          error: null,
          startedAt: null,
          finishedAt: null,
          expanded: true,
          historyRow: {
            id: 41,
            reportKind: 'tags',
            requestedBy: 'tester',
            createdAt: '2026-05-01T10:00:00',
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
        },
      ],
    });

    const dialog = dialogProps.at(-1);
    expect(dialog?.disableEscapeKeyDown).toBe(true);

    act(() => {
      (
        dialog?.onClose as
          ((event: unknown, reason?: 'backdropClick' | 'escapeKeyDown') => void) | undefined
      )?.({}, 'backdropClick');
      (
        dialog?.onClose as
          ((event: unknown, reason?: 'backdropClick' | 'escapeKeyDown') => void) | undefined
      )?.({}, 'escapeKeyDown');
    });

    expect(view.onClose).not.toHaveBeenCalled();

    act(() => {
      view.container.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
        if (button.textContent?.trim() === 'Закрити') {
          button.click();
        }
      });
    });

    expect(view.onClose).toHaveBeenCalledTimes(1);

    act(() => {
      view.root.unmount();
    });
  });

  it('requires Sposob unit name before download', () => {
    const view = renderDialog({
      supportNonRerInterceptions: true,
      report: buildReport({ template: 'sposob' }),
    });
    const downloadButton = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Завантажити'));

    expect(document.body.textContent).toContain('Назва підрозділу');
    expect(downloadButton?.disabled).toBe(true);

    act(() => {
      view.root.render(
        createElement(AnalysisReportDialog, {
          ...view.props,
          report: buildReport({ template: 'sposob', sposobUnitName: 'ручний підрозділ' }),
        }),
      );
    });

    const enabledDownloadButton = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Завантажити'));
    expect(enabledDownloadButton?.disabled).toBe(false);

    act(() => {
      view.root.unmount();
    });
  });

  it('keeps the generic export action visibly labelled', () => {
    const view = renderDialog({ report: buildReport({ template: 'summary_table' }) });

    const downloadButton = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Завантажити'));
    expect(downloadButton?.textContent).toContain('Завантажити');

    act(() => view.root.unmount());
  });

  it('shows report 1.2.5 as an advanced report option', () => {
    const view = renderDialog();
    const report125Button = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Звіт 1.2.5'));

    expect(report125Button).toBeTruthy();
    expect(report125Button?.disabled).toBe(true);

    act(() => {
      view.root.render(
        createElement(AnalysisReportDialog, {
          ...view.props,
          currentUser: { roles: ['AdvancedReports'] } as never,
        }),
      );
    });

    const enabledReport125Button = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Звіт 1.2.5'));
    expect(enabledReport125Button?.disabled).toBe(false);

    act(() => {
      view.root.unmount();
    });
  });

  it('shows queued warnings while keeping diagnostics collapsed', () => {
    const originalNow = Date.now;
    Date.now = () => new Date('2026-05-01T10:06:00Z').getTime();

    try {
      const view = renderDialog({
        taskRuns: [
          {
            id: 1,
            reportTitle: 'Донесення',
            reportName: 'report.docx',
            headerTitle: 'Звіт Донесення: report.docx',
            running: true,
            cancelled: false,
            curr: 0,
            overall: 100,
            logs: [],
            error: null,
            startedAt: null,
            finishedAt: null,
            expanded: true,
            historyRow: {
              id: 41,
              reportKind: 'tags',
              requestedBy: 'tester',
              createdAt: '2026-05-01T10:00:00',
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
          },
        ],
      });

      expect(document.body.textContent).toContain('Очікує запуску');
      expect(document.body.textContent).not.toContain('Формується');
      expect(document.body.textContent).toContain('Показати деталі');
      expect(document.body.textContent).not.toContain('ID звіту');
      expect(document.body.textContent).toContain(
        'Звіт ще не стартував. Перевірте його стан у Мої звіти.',
      );

      act(() => {
        view.root.unmount();
      });
    } finally {
      Date.now = originalNow;
    }
  });

  it('shows errors while keeping diagnostics collapsed', () => {
    const view = renderDialog({
      taskRuns: [
        {
          id: 1,
          reportTitle: 'Донесення',
          reportName: 'report.docx',
          headerTitle: 'Звіт Донесення: report.docx',
          running: false,
          cancelled: false,
          curr: 0,
          overall: 100,
          logs: [],
          error: 'Boom',
          startedAt: null,
          finishedAt: null,
          expanded: true,
          historyRow: {
            id: 41,
            reportKind: 'tags',
            requestedBy: 'tester',
            createdAt: '2026-05-01T10:00:00',
            startedAt: null,
            plannedForTs: null,
            queuePosition: 2,
            status: 'failed',
            completedAt: null,
            hasFile: false,
            fileName: null,
            contentType: null,
            bgtaskId: 77,
            lastError: 'Boom',
            details: '',
            progress: 0,
            errorLog: null,
          },
        },
      ],
    });

    expect(document.body.textContent).toContain('Boom');
    expect(document.body.textContent).not.toContain('ID звіту');
    expect(document.body.textContent).toContain('Показати деталі');

    act(() => {
      view.root.unmount();
    });
  });

  it('shows queued diagnostics when expanded and hides them again when collapsed', () => {
    const view = renderDialog({
      taskRuns: [
        {
          id: 1,
          reportTitle: 'Донесення',
          reportName: 'report.docx',
          headerTitle: 'Звіт Донесення: report.docx',
          running: true,
          cancelled: false,
          curr: 0,
          overall: 100,
          logs: [],
          error: null,
          startedAt: null,
          finishedAt: null,
          expanded: true,
          historyRow: {
            id: 41,
            reportKind: 'tags',
            requestedBy: 'tester',
            createdAt: '2026-05-01T10:00:00',
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
        },
      ],
    });

    expect(document.body.textContent).toContain('Показати деталі');
    expect(document.body.textContent).not.toContain('ID звіту');

    view.onSetProgressExpanded(true);

    act(() => {
      view.root.render(
        createElement(AnalysisReportDialog, {
          ...view.props,
          progressExpanded: true,
        }),
      );
    });

    expect(document.body.textContent).toContain('ID звіту');
    expect(document.body.textContent).toContain('#41');
    expect(document.body.textContent).toContain('#2');

    view.onSetProgressExpanded(false);

    act(() => {
      view.root.render(
        createElement(AnalysisReportDialog, {
          ...view.props,
          progressExpanded: false,
        }),
      );
    });

    expect(document.body.textContent).not.toContain('ID звіту');

    act(() => {
      view.root.unmount();
    });
  });
});
