import type { InboxItemContextRsp } from '../../../../../Bindings';
import { resolveLinkedMessageContext } from './message-navigation-context';

export type MessageNavigationOutcome = {
  status: 'focused' | 'unavailable' | 'load-error' | 'landing-error' | 'cancelled';
};

export type MessageNavigationHost<Landing> = {
  materialize: (context: InboxItemContextRsp, signal: AbortSignal) => Promise<Landing | null>;
  land: (landing: Landing, signal: AbortSignal) => Promise<boolean>;
  invalidateNavigation: () => void;
};

export type MessageNavigationController = {
  navigate: (reference: string) => Promise<MessageNavigationOutcome>;
  cancel: () => void;
};

export function messageNavigationErrorText(outcome: MessageNavigationOutcome): string | null {
  switch (outcome.status) {
    case 'unavailable':
      return 'Повідомлення за посиланням не знайдено або воно недоступне.';
    case 'load-error':
      return 'Не вдалося відкрити повідомлення за посиланням. Спробуйте ще раз.';
    case 'landing-error':
      return 'Повідомлення за посиланням відсутнє у стрічці.';
    default:
      return null;
  }
}

export function createMessageNavigationController<Landing>(
  getHost: () => MessageNavigationHost<Landing>,
  onOutcome: (outcome: MessageNavigationOutcome) => void,
): MessageNavigationController {
  type Operation = { controller: AbortController; host: MessageNavigationHost<Landing> };
  let active: Operation | null = null;

  const cancel = () => {
    const previous = active;
    if (!previous) return;
    active = null;
    previous.controller.abort();
    previous.host.invalidateNavigation();
  };

  const navigate = async (reference: string): Promise<MessageNavigationOutcome> => {
    cancel();
    const operation: Operation = { controller: new AbortController(), host: getHost() };
    active = operation;
    const { signal } = operation.controller;
    const isCurrent = () => active === operation && !signal.aborted;
    const finish = (status: MessageNavigationOutcome['status']): MessageNavigationOutcome => {
      if (!isCurrent()) return { status: 'cancelled' };
      active = null;
      const outcome = { status };
      onOutcome(outcome);
      return outcome;
    };

    try {
      const resolution = await resolveLinkedMessageContext(reference, signal);
      if (!isCurrent()) return { status: 'cancelled' };
      if (resolution.status === 'unavailable') return finish('unavailable');

      let landing: Landing | null;
      try {
        landing = await operation.host.materialize(resolution.context, signal);
      } catch (error) {
        if (!isCurrent()) return { status: 'cancelled' };
        console.error('Failed to load linked message window:', error);
        return finish('load-error');
      }
      if (!isCurrent()) return { status: 'cancelled' };
      if (landing == null) return finish('landing-error');

      try {
        const landed = await operation.host.land(landing, signal);
        if (!isCurrent()) return { status: 'cancelled' };
        return finish(landed ? 'focused' : 'landing-error');
      } catch (error) {
        if (!isCurrent()) return { status: 'cancelled' };
        console.error('Failed to land on linked message:', error);
        return finish('landing-error');
      }
    } catch (error) {
      if (!isCurrent()) return { status: 'cancelled' };
      console.error('Failed to resolve linked message:', error);
      return finish('load-error');
    }
  };

  return { navigate, cancel };
}
