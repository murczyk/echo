import type { PowerSnackbarNotification } from '../../../components/PowerSnackbar';

export function notifyMessageCopySuccess(
  feedbackId: string,
  notify: (notification: PowerSnackbarNotification) => unknown,
): void {
  if (!feedbackId.startsWith('link-')) return;
  notify({ severity: 'success', message: 'Посилання на повідомлення скопійовано.' });
}
