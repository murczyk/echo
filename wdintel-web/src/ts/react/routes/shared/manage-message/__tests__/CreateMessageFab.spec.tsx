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
