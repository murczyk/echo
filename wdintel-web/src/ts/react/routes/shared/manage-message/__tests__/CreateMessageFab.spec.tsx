/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Fab: ({ children, onClick, ...props }: any) => (
    <button {...props} onClick={onClick}>
      {children}
    </button>
  ),
}));

import { CreateMessageFab } from '../CreateMessageFab';
import { MessageWriteAccessContext } from '../../message-card/MessageWriteAccess';
import { canWriteMessages } from '../../../../utils/roles';

// Regression: https://github.com/echoua/echo/issues/3099
it('blurs the launcher before opening the drawer', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClick = vi.fn();
  await act(async () => root.render(<CreateMessageFab onClick={onClick} />));
  const button = container.querySelector('button') as HTMLButtonElement;
  button.focus();
  await act(async () => button.click());
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(document.activeElement).not.toBe(button);
  root.unmount();
  container.remove();
});

// Regression: https://github.com/echoua/echo/issues/3569
it.each([
  { roles: ['Basic'], allowed: false },
  { roles: ['Cyber'], allowed: true },
  { roles: ['CyberViewer'], allowed: false },
  { roles: ['CyberViewer', 'Cyber'], allowed: true },
  { roles: ['CyberViewer', 'Rer'], allowed: true },
  { roles: ['Admin'], allowed: true },
  { roles: ['Basic', 'Cyber'], allowed: true },
  { roles: ['Basic', 'Admin'], allowed: true },
])('applies message creation permissions for %j', async ({ roles, allowed }) => {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MessageWriteAccessContext.Provider value={canWriteMessages(roles)}>
        <CreateMessageFab onClick={vi.fn()} />
      </MessageWriteAccessContext.Provider>,
    ),
  );
  expect(container.querySelector('button') != null).toBe(allowed);
  await act(async () => root.unmount());
});
