/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listLogins: vi.fn(),
  getStatus: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  testConnection: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../../services/api/logins', () => ({ listLogins: mocks.listLogins }));
vi.mock('../../services/api/ai-agent', () => ({
  getAiAgentUserStatus: mocks.getStatus,
  startAiAgentContainer: mocks.start,
  stopAiAgentContainer: mocks.stop,
  testAiAgentConnection: mocks.testConnection,
}));
vi.mock('../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));

import { AdminUserDetailsPage } from '.';

const LOGIN = {
  id: 'human-1',
  login: 'ziggy',
  roles: ['Rer'],
  createdAt: 1_700_000_000_000,
  deleted: false,
  sigintZoneId: 1,
  sigintZoneName: 'Зона',
  organismId: 1,
  organismName: 'Організм',
  organismEnabled: true,
  deltaLogin: null,
  lastActiveAt: null,
  deactivationReason: null,
  description: null,
  passwordAuthEnabled: true,
  totpEnabled: false,
};

const STATUS = {
  humanLoginId: LOGIN.id,
  linkedLoginId: null,
  linkedLogin: null,
  linkedLoginEnabled: false,
  roles: [],
  organismName: LOGIN.organismName,
  zoneName: LOGIN.sigintZoneName,
  hiddenGroups: [],
  container: null,
};

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  });
}

async function openAiAgentTab() {
  const tab = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]')).find(
    (candidate) => candidate.textContent === 'AI Agent',
  );
  expect(tab).toBeDefined();
  await act(async () => tab?.click());
  await flush();
}

function clickButton(label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  button?.click();
}

beforeEach(async () => {
  mocks.listLogins.mockResolvedValue({ users: [LOGIN] });
  mocks.getStatus.mockResolvedValue(STATUS);
  mocks.start.mockResolvedValue(STATUS);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<AdminUserDetailsPage loginId={LOGIN.id} />));
  await flush();
  await openAiAgentTab();
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('AdminUserDetailsPage AI agent lifecycle', () => {
  it('starts the selected user agent and refreshes its status', async () => {
    await act(async () => clickButton('Start'));
    await flush();

    expect(mocks.start).toHaveBeenCalledWith(LOGIN.id);
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'Запуск агента розпочато.',
    });
  });

  it('shows lifecycle failures in an error toast', async () => {
    mocks.start.mockRejectedValueOnce(new Error('dispatcher unavailable'));

    await act(async () => clickButton('Start'));
    await flush();

    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'error',
      message: 'Не вдалося змінити стан агента: dispatcher unavailable',
    });
  });
});
