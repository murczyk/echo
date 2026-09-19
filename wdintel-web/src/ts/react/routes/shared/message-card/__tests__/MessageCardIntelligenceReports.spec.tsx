/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SignalGroupEntry } from '../../../../../../Bindings.ts';
import type { IntelligenceReportSummary } from '../../intelligence-reports.ts';
import { MessageCardIntelligenceReports } from '../MessageCardIntelligenceReports.tsx';

const inboxMessageMocks = vi.hoisted(() => ({ fetchMessagesByIds: vi.fn() }));

vi.mock('../../../../services/api/inbox-messages.ts', () => ({
  fetchMessagesByIds: inboxMessageMocks.fetchMessagesByIds,
}));

const groupInfos = {
  original: { masterKey: 'original', name: 'Група оригіналу' } as SignalGroupEntry,
  report: { masterKey: 'report', name: 'Група донесення' } as SignalGroupEntry,
};

const parent: IntelligenceReportSummary = {
  id: 42,
  isAccessible: true,
  isDeleted: false,
  text: 'Повний текст оригінального повідомлення',
  attachmentsCount: 1,
  timestamp: null,
  date: '2026-08-15',
  time: '09:10',
  groupName: null,
  groupMasterKey: 'original',
  coords: null,
  mediaFileNames: [],
};

const report: IntelligenceReportSummary = {
  id: 91,
  isAccessible: true,
  isDeleted: false,
  text: 'Повний текст розвіддонесення',
  attachmentsCount: 2,
  timestamp: null,
  date: '2026-08-15',
  time: '09:30',
  groupName: null,
  groupMasterKey: 'report',
  coords: null,
  mediaFileNames: [],
};
describe('MessageCardIntelligenceReports', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.body.innerHTML = '';
    inboxMessageMocks.fetchMessagesByIds.mockReset();
  });

  async function renderSummaries() {
    inboxMessageMocks.fetchMessagesByIds.mockImplementation(async ([id]: number[]) => {
      const summary = id === parent.id ? parent : report;
      return [
        [
          id,
          {
            text: id === report.id ? 'Оновлений текст розвіддонесення' : summary.text,
            media: Array.from({ length: summary.attachmentsCount }),
            timestamp: summary.timestamp,
            date: summary.date,
            time: summary.time,
            groupMasterKey: summary.groupMasterKey,
          },
        ],
      ];
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <MessageCardIntelligenceReports
          parents={[parent]}
          reports={[report]}
          groupInfos={groupInfos}
        />,
      );
    });
  }

  async function wait(delay: number) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    });
  }

  async function hover(element: Element | null) {
    await act(async () => {
      element?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await wait(750);
  }

  it('shows authorized parent and report previews on hover', async () => {
    await renderSummaries();
    const linkedMessages = container?.querySelectorAll('article');
    const parentMessage = linkedMessages?.item(0) ?? null;
    const reportMessage = linkedMessages?.item(1) ?? null;

    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      parentMessage?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await wait(500);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await wait(250);
    const parentPreview = document.querySelector('[role="tooltip"]');
    expect(parentPreview?.textContent).toContain('Оригінальне повідомлення');
    expect(parentPreview?.textContent).toContain('Повний текст оригінального повідомлення');
    expect(parentPreview?.textContent).toContain('Група оригіналу');
    expect(parentPreview?.textContent).toContain('2026-08-15 09:10');
    expect(parentPreview?.textContent).toContain('Вкладення1');

    await act(async () => {
      parentMessage?.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      parentMessage?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    await hover(reportMessage);
    const reportPreview = document
      .querySelector('[data-testid="message-summary-preview-91"]')
      ?.closest('[role="tooltip"]');
    expect(reportPreview?.textContent).toContain('Розвіддонесення');
    expect(reportPreview?.textContent).toContain('Оновлений текст розвіддонесення');
    expect(reportPreview?.textContent).not.toContain('Повний текст розвіддонесення');
    expect(reportPreview?.textContent).toContain('Група донесення');
    expect(reportPreview?.textContent).toContain('2026-08-15 09:30');
    expect(reportPreview?.textContent).toContain('Вкладення2');

    await act(async () => {
      reportMessage?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      reportMessage?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('hides inaccessible parent blocks and shows report text without group/date line', async () => {
    const inaccessibleParent = {
      ...parent,
      isAccessible: false,
      text: '',
      attachmentsCount: 0,
      groupName: 'Група оригіналу',
      groupMasterKey: null,
    };
    const inaccessibleReport = {
      ...report,
      isAccessible: false,
      text: '',
      attachmentsCount: 0,
      groupName: 'Група донесення',
      groupMasterKey: null,
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <MessageCardIntelligenceReports
          parents={[inaccessibleParent]}
          reports={[inaccessibleReport]}
          groupInfos={groupInfos}
          onEdit={() => undefined}
        />,
      );
    });

    expect(container.textContent).not.toContain('Оригінальне повідомлення');
    expect(container.textContent).toContain('Без тексту');
    expect(container.textContent).not.toContain('Група оригіналу');
    expect(container.textContent).not.toContain('Група донесення');
    expect(container.querySelector('[aria-label="Редагувати розвіддонесення"]')).toBeNull();

    for (const relationship of container.querySelectorAll('article')) {
      await hover(relationship);
    }
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('hides deleted parents and deleted reports', async () => {
    const deletedParent = {
      ...parent,
      isDeleted: true,
      text: '',
      attachmentsCount: 0,
      groupName: 'Група оригіналу',
      groupMasterKey: null,
    };
    const deletedReport = {
      ...report,
      isDeleted: true,
      text: '',
      attachmentsCount: 0,
      groupName: 'Група донесення',
      groupMasterKey: null,
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <MessageCardIntelligenceReports
          parents={[deletedParent]}
          reports={[deletedReport]}
          groupInfos={groupInfos}
          onEdit={() => undefined}
        />,
      );
    });

    expect(container.querySelectorAll('article')).toHaveLength(0);
    expect(container.textContent).toBe('');
  });

  it('does not open preview tooltip on touch tap', async () => {
    await renderSummaries();
    const linkedMessages = container?.querySelectorAll('article');
    const reportMessage = linkedMessages?.item(1) ?? null;

    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    // Simulate mobile touch sequence (touchstart / pointerdown with touch -> mouseenter -> focus)
    await act(async () => {
      reportMessage?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }),
      );
      reportMessage?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      reportMessage?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    await wait(800);

    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('renders attachment file names or coordinates as fallback when text is empty', async () => {
    const parentWithMedia: IntelligenceReportSummary = {
      ...parent,
      text: '',
      mediaFileNames: ['photo1.jpg', 'doc2.pdf'],
    };
    const reportWithCoords: IntelligenceReportSummary = {
      ...report,
      text: '   ',
      coords: '48.4500, 36.9833',
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <MessageCardIntelligenceReports
          parents={[parentWithMedia]}
          reports={[reportWithCoords]}
          groupInfos={groupInfos}
        />,
      );
    });

    expect(container.textContent).toContain('photo1.jpg, doc2.pdf');
    expect(container.textContent).toContain('48.4500, 36.9833');
  });
});
