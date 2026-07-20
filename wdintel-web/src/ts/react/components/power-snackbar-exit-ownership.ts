export type ExitFallback = {
  notificationId: number;
  timerId: ReturnType<typeof setTimeout>;
};

export function replaceExitFallback(
  previous: ExitFallback | null,
  notificationId: number,
  timerId: ReturnType<typeof setTimeout>,
): ExitFallback {
  if (previous?.notificationId === notificationId) {
    clearTimeout(previous.timerId);
  }
  return { notificationId, timerId };
}

export function releaseExitFallback(
  ownership: ExitFallback | null,
  notificationId: number,
): ExitFallback | null {
  if (ownership?.notificationId !== notificationId) return ownership;
  clearTimeout(ownership.timerId);
  return null;
}

export function consumeExitFallback(
  ownership: ExitFallback | null,
  notificationId: number,
): ExitFallback | null {
  return ownership?.notificationId === notificationId ? null : ownership;
}
