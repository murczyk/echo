import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItemContextRsp } from '../../../../../../Bindings';

import {
  createMessageNavigationController,
  messageNavigationErrorText,
  type MessageNavigationHost,
} from '../message-navigation-controller';

const fetchInboxItemContext = vi.hoisted(() => vi.fn());

vi.mock('../../../../services/api/inbox-messages', () => ({ fetchInboxItemContext }));

const context: InboxItemContextRsp = {
  message: [41, { messageUid: 'target-41' } as never],
  groupMasterKeys: [],
  sigintInboxItemIds: [41],
  sinceTs: null,
  tillTs: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function host() {
  return {
    materialize: vi.fn(async () => 41 as number | null),
    land: vi.fn(async () => true),
    invalidateNavigation: vi.fn(),
  } satisfies MessageNavigationHost<number>;
}

describe('linked-message navigation controller', () => {
  beforeEach(() => {
    fetchInboxItemContext.mockReset();
    fetchInboxItemContext.mockResolvedValue(context);
  });

  it('resolves access before materializing and landing', async () => {
    const calls: string[] = [];
    fetchInboxItemContext.mockImplementationOnce(async () => {
      calls.push('resolve');
      return context;
    });
    const navigationHost = host();
    navigationHost.materialize.mockImplementationOnce(async () => {
      calls.push('materialize');
      return 41;
    });
    navigationHost.land.mockImplementationOnce(async () => {
      calls.push('land');
      return true;
    });
    const onOutcome = vi.fn();

    const outcome = await createMessageNavigationController(
      () => navigationHost,
      onOutcome,
    ).navigate('target-41');

    expect(calls).toEqual(['resolve', 'materialize', 'land']);
    expect(outcome).toEqual({ status: 'focused' });
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith({ status: 'focused' });
    expect(fetchInboxItemContext).toHaveBeenCalledWith(
      { messageUid: 'target-41' },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('does not materialize a missing or inaccessible target', async () => {
    fetchInboxItemContext.mockResolvedValueOnce({ ...context, message: null });
    const navigationHost = host();

    const outcome = await createMessageNavigationController(() => navigationHost, vi.fn()).navigate(
      'hidden-41',
    );

    expect(outcome).toEqual({ status: 'unavailable' });
    expect(navigationHost.materialize).not.toHaveBeenCalled();
    expect(messageNavigationErrorText(outcome)).toBe(
      'Повідомлення за посиланням не знайдено або воно недоступне.',
    );
  });

  it('uses an already resolved search result while retaining host validation', async () => {
    const navigationHost = host();
    navigationHost.materialize.mockResolvedValueOnce(null);
    const outcome = await createMessageNavigationController(() => navigationHost, vi.fn()).navigate(
      'target-41',
      context,
    );

    expect(fetchInboxItemContext).not.toHaveBeenCalled();
    expect(navigationHost.materialize).toHaveBeenCalledWith(context, expect.any(AbortSignal));
    expect(navigationHost.land).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: 'landing-error' });
  });

  it('cancels a known result while its host is validating it', async () => {
    const request = deferred<number | null>();
    const navigationHost = host();
    navigationHost.materialize.mockReturnValueOnce(request.promise);
    const onOutcome = vi.fn();
    const controller = createMessageNavigationController(() => navigationHost, onOutcome);
    const result = controller.navigate('target-41', context);
    await vi.waitFor(() => expect(navigationHost.materialize).toHaveBeenCalledOnce());
    controller.cancel();
    request.resolve(41);

    expect(await result).toEqual({ status: 'cancelled' });
    expect(fetchInboxItemContext).not.toHaveBeenCalled();
    expect(navigationHost.land).not.toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it('does not materialize an empty resolved context', async () => {
    const navigationHost = host();
    const result = await createMessageNavigationController(() => navigationHost, vi.fn()).navigate(
      'hidden-41',
      { ...context, message: null },
    );
    expect(result).toEqual({ status: 'unavailable' });
    expect(fetchInboxItemContext).not.toHaveBeenCalled();
    expect(navigationHost.materialize).not.toHaveBeenCalled();
  });

  it.each(['context', 'materialize'] as const)('classifies a %s request failure', async (step) => {
    const navigationHost = host();
    if (step === 'context') fetchInboxItemContext.mockRejectedValueOnce(new Error('private group'));
    else navigationHost.materialize.mockRejectedValueOnce(new Error('network failed'));

    const outcome = await createMessageNavigationController(() => navigationHost, vi.fn()).navigate(
      'target-41',
    );

    expect(outcome).toEqual({ status: 'load-error' });
    expect(messageNavigationErrorText(outcome)).toBe(
      'Не вдалося відкрити повідомлення за посиланням. Спробуйте ще раз.',
    );
  });

  it.each(['materialize', 'land'] as const)(
    'classifies a missing target after %s',
    async (step) => {
      const navigationHost = host();
      if (step === 'materialize') navigationHost.materialize.mockResolvedValueOnce(null);
      else navigationHost.land.mockResolvedValueOnce(false);

      const outcome = await createMessageNavigationController(
        () => navigationHost,
        vi.fn(),
      ).navigate('target-41');

      expect(outcome).toEqual({ status: 'landing-error' });
      expect(messageNavigationErrorText(outcome)).toBe(
        'Повідомлення за посиланням відсутнє у стрічці.',
      );
    },
  );

  it('cancels a pending context lookup without notifying or touching the host', async () => {
    const request = deferred<InboxItemContextRsp>();
    fetchInboxItemContext.mockReturnValueOnce(request.promise);
    const navigationHost = host();
    const onOutcome = vi.fn();
    const controller = createMessageNavigationController(() => navigationHost, onOutcome);
    const result = controller.navigate('target-41');

    controller.cancel();
    request.resolve(context);

    expect(await result).toEqual({ status: 'cancelled' });
    expect(navigationHost.materialize).not.toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it('cancels a pending materialization before landing', async () => {
    const request = deferred<number | null>();
    const navigationHost = host();
    navigationHost.materialize.mockReturnValueOnce(request.promise);
    const onOutcome = vi.fn();
    const controller = createMessageNavigationController(() => navigationHost, onOutcome);
    const result = controller.navigate('target-41');
    await vi.waitFor(() => expect(navigationHost.materialize).toHaveBeenCalledOnce());

    controller.cancel();
    request.resolve(41);

    expect(await result).toEqual({ status: 'cancelled' });
    expect(navigationHost.land).not.toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it('cancels a pending landing without reporting success', async () => {
    const request = deferred<boolean>();
    const navigationHost = host();
    navigationHost.land.mockReturnValueOnce(request.promise);
    const onOutcome = vi.fn();
    const controller = createMessageNavigationController(() => navigationHost, onOutcome);
    const result = controller.navigate('target-41');
    await vi.waitFor(() => expect(navigationHost.land).toHaveBeenCalledOnce());

    controller.cancel();
    request.resolve(true);

    expect(await result).toEqual({ status: 'cancelled' });
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it('allows a new navigation to supersede an older one', async () => {
    const firstRequest = deferred<InboxItemContextRsp>();
    fetchInboxItemContext.mockReturnValueOnce(firstRequest.promise);
    const navigationHost = host();
    const onOutcome = vi.fn();
    const controller = createMessageNavigationController(() => navigationHost, onOutcome);
    const first = controller.navigate('old-41');
    const second = controller.navigate('target-41');
    firstRequest.resolve(context);

    expect(await first).toEqual({ status: 'cancelled' });
    expect(await second).toEqual({ status: 'focused' });
    expect(onOutcome).toHaveBeenCalledTimes(1);
  });

  it('does not report an aborted request as a load error', async () => {
    const request = deferred<InboxItemContextRsp>();
    fetchInboxItemContext.mockReturnValueOnce(request.promise);
    const onOutcome = vi.fn();
    const controller = createMessageNavigationController(() => host(), onOutcome);
    const result = controller.navigate('target-41');
    controller.cancel();
    request.reject(new DOMException('The operation was aborted.', 'AbortError'));

    expect(await result).toEqual({ status: 'cancelled' });
    expect(onOutcome).not.toHaveBeenCalled();
  });
});
