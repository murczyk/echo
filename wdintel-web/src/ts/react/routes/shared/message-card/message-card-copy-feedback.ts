import type { PowerSnackbarNotification } from '../../../components/PowerSnackbar';

export function notifyMessageCopySuccess(
  feedbackId: string,
  notify: (notification: PowerSnackbarNotification) => unknown,
): void {
  const message = feedbackId.startsWith('link-')
    ? 'Посилання на повідомлення скопійовано.'
    : feedbackId.startsWith('text-')
      ? 'Повідомлення скопійовано.'
      : 'Скопійовано в буфер обміну.';
  notify({ severity: 'success', message });
}
