import { expect, test } from '@playwright/test';
import { holdNext, row } from './group-feed-actors.fixtures';
import { openThread, relation, visit, withReplyActors } from './message-replies.fixtures';

for (const screen of ['duty', 'analysis'] as const) {
  test(`@regression #3612 ${screen}: opens a thread in Analysis with scoped filters and disabled analytics`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      const actor = await fixture.attach(page!, screen, 'user-1');
      const root = fixture.seed('user-2', 'Thread original');
      const first = fixture.seed('user-1', 'Thread first reply');
      const last = fixture.seed('user-2', 'Thread last reply');
      fixture.seed('user-1', 'Unrelated message');
      fixture.respondWithReplies([relation(1, root, first), relation(2, root, last)]);
      await visit(actor);
      const panel = await openThread(actor, root, 3);
      const link = panel.getByRole('link', { name: 'Відкрити в Аналізі', exact: true });
      await expect(link).toHaveAttribute('target', '_blank');
      const target = await page!.context().newPage();
      const analysis = await fixture.attach(target, 'analysis', 'user-1');
      await target.goto((await link.getAttribute('href'))!);
      await expect(target.getByRole('region', { name: 'Перегляд ланцюжка' })).toBeVisible();
      await expect(row(analysis, root.id)).toBeVisible();
      await expect(row(analysis, first.id)).toBeAttached();
      await expect(row(analysis, last.id)).toBeAttached();
      await expect(target.getByRole('button', { name: 'Звіти', exact: true })).toBeDisabled();
      await target.getByRole('button', { name: 'Розгорнути праву панель', exact: true }).click();
      await expect(
        target.getByText('Аналітика недоступна під час перегляду ланцюжка.', { exact: true }),
      ).toBeVisible();
      await target.getByRole('button', { name: 'Згорнути праву панель', exact: true }).click();
      await expect(target.getByText('Unrelated message', { exact: true })).toHaveCount(0);
      await expect(target.getByRole('tab', { name: 'Мапа', exact: true })).toBeDisabled();
      await expect(
        target.getByRole('tab', { name: 'Зведена таблиця', exact: true }),
      ).toBeDisabled();
      expect(analysis.requests.some(({ path }) => path === '/api/rer-importer/get-inbox')).toBe(
        false,
      );
      expect(
        analysis.requests.some(({ path }) => path === '/api/rer-importer/get-inbox-count'),
      ).toBe(false);
      const search = target.getByRole('combobox', { name: 'Пошук', exact: true });
      await search.fill('last reply');
      await expect(row(analysis, last.id)).toBeAttached();
      await expect(row(analysis, root.id)).toHaveCount(0);
      await expect(row(analysis, first.id)).toHaveCount(0);
      const matching = analysis.requests.filter(({ path }) =>
        path.endsWith('messages-by-id-matching-filters'),
      );
      expect(matching.length).toBeGreaterThan(0);
      expect(
        matching.every(({ body }) =>
          (body.message_ids as number[]).every((id) => [root.id, first.id, last.id].includes(id)),
        ),
      ).toBe(true);
      await search.fill('');
      await expect(row(analysis, root.id)).toBeAttached();
      const newestFirst = target.getByRole('checkbox', { name: 'спочатку нові', exact: true });
      const unitsError = target
        .getByRole('alert')
        .filter({ hasText: 'Помилка оновлення підрозділів' });
      if (await unitsError.isVisible())
        await unitsError.getByRole('button', { name: 'Закрити сповіщення', exact: true }).click();
      await newestFirst.uncheck();
      await expect(target.locator('[data-message-id]').first()).toHaveAttribute(
        'data-message-id',
        String(root.id),
      );
      await search.fill('no such thread message');
      await expect(target.locator('[data-message-id]')).toHaveCount(0);
      expect(analysis.requests.some(({ path }) => path === '/api/rer-importer/get-inbox')).toBe(
        false,
      );
      await search.fill('');
      await expect(row(analysis, root.id)).toBeAttached();
      await target.getByRole('button', { name: 'Фільтри', exact: true }).click();
      await target.getByRole('button', { name: /^Позивні/ }).click();
      await expect(target.getByRole('combobox', { name: 'Позивні', exact: true })).toBeVisible();
      expect(analysis.requests.some(({ path }) => path.includes('callsign-page'))).toBe(false);
      await target.getByRole('button', { name: /^Частоти/ }).click();
      await expect(
        target.getByRole('checkbox', { name: 'Тільки нові частоти', exact: true }),
      ).toBeDisabled();
      await target.getByRole('button', { name: 'Фільтри', exact: true }).click();
      await target.reload();
      await expect(target.getByRole('region', { name: 'Перегляд ланцюжка' })).toBeVisible();
      await expect(target.getByText('Unrelated message', { exact: true })).toHaveCount(0);
      await target.screenshot({ path: test.info().outputPath(`${screen}-thread-analysis.png`) });
      await target.getByRole('button', { name: 'Вийти з ланцюжка', exact: true }).click();
      await expect(target.getByRole('region', { name: 'Перегляд ланцюжка' })).toHaveCount(0);
      await expect(target.getByText('Unrelated message', { exact: true })).toBeVisible();
      await expect(target.getByRole('tab', { name: 'Мапа', exact: true })).toBeEnabled();
    });
  });
}

test('@regression #3612 thread Analysis survives source deletion, discovers new replies and recovers from a filter error', async ({
  browser,
  baseURL,
}) => {
  await withReplyActors(browser, baseURL, async (fixture, [page]) => {
    const actor = await fixture.attach(page!, 'analysis', 'user-1');
    const root = fixture.seed('user-2', 'Original for deletion');
    const reply = fixture.seed('user-1', 'Surviving reply');
    fixture.seed('user-2', 'Unrelated live message');
    fixture.respondWithReplies([relation(1, root, reply)]);
    await page!.clock.install();
    await page!.goto(
      `/rer-analysis-neo?threadMessageId=${root.id}&leftPanelOpen=false&rightPanelOpen=false&filterPanelOpen=false`,
    );
    await expect(row(actor, root.id)).toBeAttached();
    root.deleted = true;
    fixture.respondWithReplies([relation(1, root, reply, { originalSignalMessageId: null })]);
    fixture.notify([root.id]);
    await expect(row(actor, root.id)).toHaveCount(0);
    await expect(row(actor, reply.id)).toBeAttached();
    await expect(page!.getByText('Видалено повідомлень: 1', { exact: true })).toBeVisible();
    await expect(page!).toHaveURL(new RegExp(`threadMessageId=${reply.id}(?:&|$)`));
    await page!.reload();
    await expect(row(actor, reply.id)).toBeAttached();
    const latest = fixture.seed('user-2', 'New thread reply');
    fixture.respondWithReplies([relation(1, root, reply), relation(2, root, latest)]);
    fixture.notify([latest.id]);
    await page!.clock.runFor(31_000);
    await expect(row(actor, latest.id)).toBeAttached();
    await expect(page!.getByText('Unrelated live message', { exact: true })).toHaveCount(0);
    await page!.route(
      '**/api/rer-importer/messages-by-id-matching-filters',
      (route) => route.fulfill({ status: 503, json: { error: 'Thread filter unavailable' } }),
      { times: 1 },
    );
    const search = page!.getByRole('combobox', { name: 'Пошук', exact: true });
    await search.fill('reply');
    await page!.clock.runFor(1000);
    await expect(page!.getByText(/Не вдалося відфільтрувати ланцюжок/).first()).toBeVisible();
    await expect(page!.locator('[data-message-id]')).toHaveCount(0);
    await page!.getByRole('button', { name: 'Оновити', exact: true }).click();
    await expect(row(actor, reply.id)).toBeAttached();
    await expect(row(actor, latest.id)).toBeAttached();
    expect(actor.requests.some(({ path }) => path === '/api/rer-importer/get-inbox')).toBe(false);
  });
});

test('@regression #3612 large thread Analysis batches IDs and never fetches global history or statistics', async ({
  browser,
  baseURL,
}) => {
  await withReplyActors(browser, baseURL, async (fixture, [page]) => {
    const actor = await fixture.attach(page!, 'analysis', 'user-1');
    const pageErrors: string[] = [];
    page!.on('pageerror', (error) => pageErrors.push(error.message));
    const root = fixture.seed('user-2', 'Large thread root');
    const replies = Array.from({ length: 104 }, (_, index) =>
      fixture.seed('user-1', `Large reply ${index + 1}`),
    );
    fixture.seed('user-2', 'Unrelated large thread message');
    fixture.respondWithReplies(replies.map((reply, index) => relation(index + 1, root, reply)));
    await page!.goto(
      `/rer-analysis-neo?threadMessageId=${root.id}&leftPanelOpen=false&rightPanelOpen=false&filterPanelOpen=false`,
    );
    await expect
      .poll(
        async () => {
          expect(pageErrors).toEqual([]);
          return page!.locator('[data-message-id]').count();
        },
        { timeout: 15_000 },
      )
      .toBe(105);
    const batches = actor.requests.filter(({ path }) =>
      path.endsWith('messages-by-id-with-metadata'),
    );
    expect(batches.length).toBe(2);
    expect(
      batches.every(
        ({ body }) =>
          (body.message_ids as number[]).length <= 100 &&
          (body.inbox_req as Record<string, unknown>).skip_group_stats === true,
      ),
    ).toBe(true);
    const search = page!.getByRole('combobox', { name: 'Пошук', exact: true });
    await search.fill('Large reply 104');
    await expect(page!.locator('[data-message-id]')).toHaveCount(1);
    expect(
      actor.requests.some(
        ({ path }) =>
          path === '/api/rer-importer/get-inbox' ||
          path === '/api/rer-importer/get-inbox-count' ||
          path.startsWith('/api/rer/analysis/stats'),
      ),
    ).toBe(false);
    [root, ...replies.slice(0, 99)].forEach((message) => {
      message.deleted = true;
    });
    fixture.respondWithReplies(
      replies.map((reply, index) =>
        relation(index + 1, root, reply, {
          originalSignalMessageId: null,
          replySignalMessageId: reply.deleted ? null : reply.id,
        }),
      ),
    );
    fixture.notify([root.id]);
    await expect(page!.getByText('Видалено повідомлень: 100', { exact: true })).toBeVisible();
    await expect(row(actor, replies[103]!.id)).toBeAttached();
    await page!.setViewportSize({ width: 390, height: 844 });
    await expect(page!.getByRole('region', { name: 'Перегляд ланцюжка' })).toBeVisible();
    await page!.screenshot({ path: test.info().outputPath('thread-analysis-mobile.png') });
  });
});

test('@regression #3612 thread Analysis keeps scope on access failure and exits during a pending refresh without losing filters', async ({
  browser,
  baseURL,
}) => {
  await withReplyActors(browser, baseURL, async (fixture, [page]) => {
    const actor = await fixture.attach(page!, 'analysis', 'user-1');
    const root = fixture.seed('user-1', 'Chain member');
    const reply = fixture.seed('user-2', 'Chain reply');
    const unrelated = fixture.seed('user-1', 'Outside chain');
    fixture.respondWithReplies([relation(1, root, reply)]);
    await page!.route(
      '**/api/rer-importer/message-replies',
      (route) => route.fulfill({ status: 403, json: { error: 'No access to chain' } }),
      { times: 1 },
    );
    await page!.goto(
      `/rer-analysis-neo?threadMessageId=${root.id}&leftPanelOpen=false&rightPanelOpen=false&filterPanelOpen=false`,
    );
    await expect(page!.getByText(/Не вдалося завантажити ланцюжок/).first()).toBeVisible();
    await expect(row(actor, unrelated.id)).toHaveCount(0);
    expect(actor.requests.some(({ path }) => path === '/api/rer-importer/get-inbox')).toBe(false);
    const unitsError = page!
      .getByRole('alert')
      .filter({ hasText: 'Помилка оновлення підрозділів' });
    if (await unitsError.isVisible())
      await unitsError.getByRole('button', { name: 'Закрити сповіщення', exact: true }).click();
    await page!.getByRole('button', { name: 'Оновити', exact: true }).click();
    await expect(row(actor, root.id)).toBeAttached();
    await expect(
      row(actor, root.id).getByRole('link', { name: 'Відкрити в Аналізі', exact: true }),
    ).toHaveCount(0);
    await page!.getByRole('combobox', { name: 'Пошук', exact: true }).fill('Outside');
    await expect(row(actor, root.id)).toHaveCount(0);
    const gate = holdNext(actor, 'reply-metadata');
    await page!.getByRole('button', { name: 'Оновити', exact: true }).click();
    await gate.started;
    await page!.getByRole('button', { name: 'Вийти з ланцюжка', exact: true }).click();
    gate.release();
    await expect(page!.getByRole('region', { name: 'Перегляд ланцюжка' })).toHaveCount(0);
    await expect(page!.getByRole('combobox', { name: 'Пошук', exact: true })).toHaveValue(
      'Outside',
    );
    await expect(row(actor, unrelated.id)).toBeAttached();
    await expect(row(actor, root.id)).toHaveCount(0);
    await expect(page!).not.toHaveURL(/threadMessageId/);
  });
});

test('@regression #3612 entering a thread rejects an ordinary inbox response and exiting reloads the same ordinary query', async ({
  browser,
  baseURL,
}) => {
  await withReplyActors(browser, baseURL, async (fixture, [page]) => {
    const actor = await fixture.attach(page!, 'analysis', 'user-1');
    const root = fixture.seed('user-2', 'Scope original');
    const reply = fixture.seed('user-1', 'Scope reply');
    const unrelated = fixture.seed('user-1', 'Ordinary outside message');
    fixture.respondWithReplies([relation(1, root, reply)]);
    await visit(actor, 'all', '&filterPanelOpen=false');
    await expect(page!.locator('.app-shell')).toHaveAttribute('data-auth-user-name', 'user-1');
    await expect(row(actor, unrelated.id)).toBeAttached();
    const unitsError = page!
      .getByRole('alert')
      .filter({ hasText: 'Помилка оновлення підрозділів' });
    if (await unitsError.isVisible())
      await unitsError.getByRole('button', { name: 'Закрити сповіщення', exact: true }).click();
    const gate = holdNext(actor, 'inbox');
    const pending = page!.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/rer-importer/get-inbox',
    );
    await page!.getByRole('button', { name: 'Оновити', exact: true }).click();
    const request = await pending;
    await gate.started;
    await page!.evaluate((id) => {
      const url = new URL(window.location.href);
      url.searchParams.set('threadMessageId', String(id));
      window.history.pushState({}, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, root.id);
    await expect(page!.getByRole('region', { name: 'Перегляд ланцюжка' })).toBeVisible();
    await expect(page!.locator('[data-message-id]')).toHaveCount(2);
    gate.release();
    const response = await request.response();
    if (response) await response.finished();
    await page!.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(row(actor, unrelated.id)).toHaveCount(0);
    await expect(row(actor, root.id)).toBeAttached();
    await expect(row(actor, reply.id)).toBeAttached();
    await page!.getByRole('button', { name: 'Вийти з ланцюжка', exact: true }).click();
    await expect(row(actor, unrelated.id)).toBeAttached();
  });
});
