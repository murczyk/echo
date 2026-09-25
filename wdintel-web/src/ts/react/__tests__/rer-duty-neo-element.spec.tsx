/** @vitest-environment happy-dom */
import { useEffect, useState } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const page = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn(),
  requests: new Map<string, Promise<string>>(),
}));

vi.mock('../routes/rer-duty-neo', () => ({
  RerDutyNeoPage: ({ authUserName }: { authUserName: string | null }) => {
    const [groups, setGroups] = useState<string[]>([]);
    useEffect(() => {
      page.mounted(authUserName);
      page.requests.get(authUserName ?? 'anonymous')?.then((group) => setGroups([group]));
      return () => page.unmounted(authUserName);
    }, [authUserName]);
    return (
      <div data-testid="duty-page" data-user={authUserName ?? 'anonymous'}>
        {groups}
      </div>
    );
  },
}));

import '../rer-duty-neo-element';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
describe('rer-duty-neo custom element identity remounting', () => {
  afterEach(() => {
    document.body.replaceChildren();
    page.mounted.mockClear();
    page.unmounted.mockClear();
    page.requests.clear();
  });

  it('remounts on auth identity changes and ignores the old delayed response', async () => {
    const userA = deferred<string>();
    const userB = deferred<string>();
    page.requests.set('user-a', userA.promise);
    page.requests.set('user-b', userB.promise);
    const shell = document.createElement('div');
    shell.className = 'app-shell';
    shell.setAttribute('data-auth-user-name', 'user-a');
    const element = document.createElement('rer-duty-neo');
    shell.append(element);

    await act(async () => document.body.append(shell));
    expect(document.querySelector('[data-user="user-a"]')).not.toBeNull();

    await act(async () => shell.setAttribute('data-auth-user-name', 'user-b'));
    expect(page.unmounted).toHaveBeenCalledWith('user-a');
    expect(document.querySelector('[data-user="user-b"]')).not.toBeNull();

    await act(async () => userA.resolve('A1'));
    expect(document.querySelector('[data-user="user-b"]')?.textContent).toBe('');
    await act(async () => userB.resolve('B1'));
    expect(document.querySelector('[data-user="user-b"]')?.textContent).toBe('B1');
  });

  it('does not remount for unrelated shell attributes', async () => {
    const shell = document.createElement('div');
    shell.className = 'app-shell';
    shell.setAttribute('data-auth-user-name', 'user-a');
    shell.append(document.createElement('rer-duty-neo'));

    await act(async () => document.body.append(shell));
    await act(async () => shell.setAttribute('data-theme', 'dark'));

    expect(page.mounted).toHaveBeenCalledTimes(1);
    expect(page.unmounted).not.toHaveBeenCalled();
  });
});
