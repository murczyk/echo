/** @vitest-environment happy-dom */
import { useEffect } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const page = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn(),
}));

vi.mock('../routes/rer-analysis-neo', () => ({
  RerAnalysisNeoPage: ({
    authUserName,
    authUserRoles,
  }: {
    authUserName: string | null;
    authUserRoles: string[];
  }) => {
    useEffect(() => {
      page.mounted(authUserName, authUserRoles);
      return () => page.unmounted(authUserName, authUserRoles);
    }, [authUserName, authUserRoles]);
    return <div data-roles={authUserRoles.join(',')} />;
  },
}));

import { showAnalysisSharedError } from '../rer-analysis-neo-element';

afterEach(() => {
  document.body.replaceChildren();
  page.mounted.mockClear();
  page.unmounted.mockClear();
});

describe('rer-analysis-neo custom element authorization', () => {
  it('passes roles on first render and remounts when they change', async () => {
    const shell = document.createElement('div');
    shell.className = 'app-shell';
    shell.setAttribute('data-auth-user-name', 'operator');
    const element = document.createElement('rer-analysis-neo');
    element.setAttribute('data-auth-user-roles', 'Rer, UnitsEditor');
    shell.append(element);

    await act(async () => document.body.append(shell));
    expect(document.querySelector('[data-roles="Rer,UnitsEditor"]')).not.toBeNull();

    await act(async () => element.setAttribute('data-auth-user-roles', 'Cyber'));
    expect(page.unmounted).toHaveBeenCalled();
    expect(document.querySelector('[data-roles="Cyber"]')).not.toBeNull();
  });
});

it('#4019 delivers a shared error received before Analysis finishes mounting', async () => {
  const previousUrl = window.location.href;
  window.history.replaceState({}, '', '/rer-analysis-neo');
  const element = document.createElement('rer-analysis-neo');
  try {
    showAnalysisSharedError({
      title: 'Помилка оновлення підрозділів',
      content: 'Помилка сервера (408). Код статусу: 408',
    });
    await act(async () => document.body.append(element));
    const error = document.querySelector('[role="alert"]');
    expect(error?.textContent).toContain('Помилка оновлення підрозділів');
    expect(error?.textContent).toContain('Код статусу: 408');
  } finally {
    await act(async () => element.remove());
    window.history.replaceState({}, '', previousUrl);
  }
});
