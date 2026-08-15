/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { SignalGroupEntry } from '../../../../../Bindings';
import type { IntelligenceReportSummary } from '../intelligence-reports';
import { MessageCardIntelligenceReports } from './MessageCardIntelligenceReports';

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
  });

  async function renderSummaries() {
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

  it('shows authorized parent and report details on hover', async () => {
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
    const parentTooltip = document.querySelector('[role="tooltip"]');
    expect(parentTooltip?.textContent).toContain('Повний текст оригінального повідомлення');
    expect(parentTooltip?.textContent).toContain('Група оригіналу');
    expect(parentTooltip?.textContent).toContain('2026-08-15 09:10');
    expect(parentTooltip?.textContent).toContain('Вкладення:1');

    await act(async () => {
      parentMessage?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    await hover(reportMessage);
    const reportTooltip = document
      .querySelector('[data-testid="message-summary-tooltip-91"]')
      ?.closest('[role="tooltip"]');
    expect(reportTooltip?.textContent).toContain('Повний текст розвіддонесення');
    expect(reportTooltip?.textContent).toContain('Група донесення');
    expect(reportTooltip?.textContent).toContain('2026-08-15 09:30');
    expect(reportTooltip?.textContent).toContain('Вкладення:2');
  });

  it('keeps inaccessible relationship blocks without exposing details or editing', async () => {
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

    expect(container.textContent).toContain('Оригінальне повідомлення');
    expect(container.textContent).toContain('Розвіддонесення');
    expect(container.textContent).toContain('Група оригіналу · 2026-08-15 09:10');
    expect(container.textContent).toContain('Група донесення · 2026-08-15 09:30');
    expect(container.querySelector('[aria-label="Редагувати розвіддонесення"]')).toBeNull();

    for (const relationship of container.querySelectorAll('article')) {
      await hover(relationship);
    }
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('shows a tombstone for a deleted parent and hides deleted reports', async () => {
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

    expect(container.querySelectorAll('article')).toHaveLength(1);
    expect(container.textContent).toContain('Оригінальне повідомлення');
    expect(container.textContent).toContain('Повідомлення видалено');
    expect(container.textContent).not.toContain('Розвіддонесення');
    expect(container.textContent).not.toContain('Група оригіналу');
    expect(container.textContent).not.toContain('2026-08-15 09:10');
    expect(container.querySelector('[aria-label="Редагувати розвіддонесення"]')).toBeNull();

    for (const relationship of container.querySelectorAll('article')) {
      await hover(relationship);
    }
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
