import { expect, test, type Browser, type Page, type Response } from '@playwright/test';
import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';
import { transformCamelToSnake } from '../../src/ts/snake-to-camel';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';

export type Screen = 'analysis' | 'duty';
export type Scope = 'group-1' | 'group-2' | 'all';
export type Message = {
  id: number;
  author: string;
  groups: string[];
  text: string;
  at: number;
  timestamp: number;
  sender: string;
  deleted?: boolean;
};
type GateKind = 'inbox' | 'submit' | 'reply-metadata';
type Gate = { entered: () => void; wait: Promise<void> };
export type Actor = {
  page: Page;
  screen: Screen;
  user: string;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  failSubmissions: number;
  gates: Partial<Record<GateKind, Gate>>;
};

export function holdNext(actor: Actor, kind: GateKind) {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  actor.gates[kind] = { entered, wait };
  return { started, release };
}

export function groupFeedPath(screen: Screen, scope: Scope, filters = '') {
  return screen === 'analysis'
    ? `/rer-analysis-neo?leftPanelOpen=true&rightPanelOpen=false${scope === 'all' ? '' : `&group=${scope}`}${filters}`
    : `/rer-duty-neo?state=${encodeURIComponent(JSON.stringify({ messageFeeds: [['mf-0', {}, { groupScopeMasterKey: scope === 'all' ? null : scope }]] }))}${filters}`;
}

export async function groupList(actor: Actor) {
  const { page, screen } = actor;
  if (screen === 'analysis') return page.locator('[data-analysis-group-list]:visible').first();
  const panel = page.locator('[data-group-panel]').first();
  if (!(await panel.isVisible()))
    await page.getByRole('button', { name: 'Розгорнути список груп' }).first().click();
  return panel;
}

export async function selectGroup(actor: Actor, scope: Scope) {
  const name = scope === 'all' ? 'Всі групи' : scope;
  await (await groupList(actor)).getByRole('button', { name: new RegExp(`^${name}(,|$)`) }).click();
}

export async function createMessage(actor: Actor, text: string, chooseGroup = false) {
  if (actor.screen === 'analysis')
    await expect(actor.page.getByRole('button', { name: 'Оновити', exact: true })).toBeEnabled();
  await actor.page
    .getByRole('button', { name: 'Додати повідомлення', exact: true })
    .first()
    .click();
  const input = actor.page.getByRole('textbox', { name: 'Текст повідомлення' });
  await input.click();
  await input.fill(text);
  if (chooseGroup) {
    await actor.page.getByRole('combobox', { name: 'Група', exact: true }).fill('group-1');
    await actor.page.getByRole('option', { name: 'group-1', exact: true }).click();
  }
  await expect(actor.page.getByRole('textbox', { name: 'Текст повідомлення' })).toHaveValue(text);
  const submit = actor.page.getByRole('button', { name: 'Створити', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
}

export async function settleResponse(actor: Actor, pending: Promise<Response | null>) {
  await (await pending)?.finished();
  await actor.page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

export function row(actor: Actor, id: number) {
  return actor.page.locator(
    actor.screen === 'duty' ? `[data-duty-message-id="${id}"]` : `[data-message-id="${id}"]`,
  );
}

export async function viewMessage(actor: Actor, id: number) {
  const scroller = actor.page
    .locator(
      actor.screen === 'analysis'
        ? '[data-analysis-message-scroller]'
        : '[data-duty-feed-scroller="true"]',
    )
    .first();
  await expect(row(actor, id)).toBeAttached();
  await scroller.hover();
  const target = await row(actor, id).boundingBox();
  const viewport = await scroller.boundingBox();
  expect(target).not.toBeNull();
  expect(viewport).not.toBeNull();
  await actor.page.mouse.wheel(
    0,
    target!.y + target!.height / 2 - viewport!.y - viewport!.height / 2,
  );
  await expect(row(actor, id)).toBeInViewport();
}

type GroupFeedActorsOptions = {
  actorCount?: number;
  messageFields?: (message: Message) => Record<string, unknown>;
};

export async function installGroupFeedActors(options: GroupFeedActorsOptions = {}) {
  const actors: Actor[] = [];
  const messages: Message[] = [];
  const events: number[] = [];
  const groups = [
    { key: 'group-1', hidden: false, accessible: true },
    { key: 'group-2', hidden: false, accessible: true },
  ];
  let pageLimit = 50;
  const emit = (id: number, copies = 1) => {
    for (let i = 0; i < copies; i++) events.push(id);
  };
  const add = (author: string, text: string, options: Partial<Message> = {}) => {
    const id = messages.length + 101;
    const at = Date.now() + id;
    const message = {
      id,
      author,
      text,
      at,
      timestamp: at,
      groups: ['group-1'],
      sender: author,
      ...options,
    };
    messages.push(message);
    emit(message.id);
    return message;
  };
  const uuid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
  const accessibleGroups = () => groups.filter((group) => group.accessible);
  const filterMessages = (request: Record<string, unknown>) => {
    const selectedGroups = request.selected_groups as string[] | null | undefined;
    const selectedSenders = request.selected_senders as string[] | null | undefined;
    const search = request.search as string | null | undefined;
    const since = request.since_date_inclusive_ms as number | null | undefined;
    const till = request.till_date_inclusive_ms as number | null | undefined;
    const before = messages.find((message) => message.id === request.before_id_noninclusive);
    const after = messages.find((message) => message.id === request.since_id_noninclusive);
    const time = (message: Message) =>
      request.sort_by === 'IMSCreatedAt' ? message.at : message.timestamp;
    const compare = (left: Message, right: Message) =>
      time(left) - time(right) || left.id - right.id;
    return messages
      .filter(
        (message) =>
          !message.deleted &&
          message.groups.some((key) => accessibleGroups().some((group) => group.key === key)) &&
          (!selectedGroups?.length || message.groups.some((key) => selectedGroups.includes(key))) &&
          (!selectedSenders?.length || selectedSenders.includes(message.sender)) &&
          (!search || message.text.toLowerCase().includes(search.toLowerCase())) &&
          (!request.only_with_media ||
            Boolean((options.messageFields?.(message)?.media as unknown[] | undefined)?.length)) &&
          (since == null || time(message) >= since) &&
          (till == null || time(message) <= till) &&
          (!after || compare(message, after) > 0) &&
          (!before || compare(message, before) < 0),
      )
      .sort(compare);
  };
  const attach = async (page: Page, screen: Screen, user: string): Promise<Actor> => {
    const installer =
      screen === 'analysis' ? installAnalysisNeoApiMocks : installRerDutyShortStateMocks;
    await installer(page, { signalGroups: groups.map((group) => group.key) });
    const actor: Actor = {
      page,
      screen,
      user,
      requests: [],
      failSubmissions: 0,
      gates: {},
    };
    let delivered = 0;
    const gate = async (kind: GateKind) => {
      const pending = actor.gates[kind];
      if (!pending) return;
      delete actor.gates[kind];
      pending.entered();
      await pending.wait;
    };
    const inboxMessage = (message: Message) => {
      const [date, time] = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Kyiv',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      })
        .format(message.timestamp)
        .split(' ');
      return transformCamelToSnake({
        ...minimalInboxMessage({
          messageUuid: uuid(message.id),
          messageUid: uuid(message.id),
          text: message.text,
          createdAt: message.at,
          createdAtOrder: message.at * 1000,
          timestamp: message.timestamp,
          date,
          time,
          groupMasterKey: message.groups[0],
          groupMasterKeys: message.groups.filter((key) =>
            accessibleGroups().some((group) => group.key === key),
          ),
          sender: message.sender,
        }),
        isOwn: message.author === user,
        ...options.messageFields?.(message),
      });
    };
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body =
        route.request().method() === 'POST' ? (route.request().postDataJSON() ?? {}) : {};
      actor.requests.push({ path, body });
      if (path === '/api/user') {
        await route.fulfill({
          json: {
            id: user,
            name: user,
            roles: ['Rer', 'Admin'],
            sigint_zone_id: null,
            organism_id: null,
            delta_login: null,
            goi_configured_for_organism: false,
            goi_full_access_for_organism: false,
            goi_host: null,
            goi_integrations: [],
            last_release_seen: null,
            rer_report_eligible: true,
          },
        });
      } else if (path === '/api/system-settings/current') {
        await route.fulfill({
          json: { ...systemSettingsCurrentResponse(), rer_duty_poll_interval_sec: 1 },
        });
      } else if (path === '/api/user/sigint-groups') {
        await route.fulfill({ json: accessibleGroups().map((group) => group.key) });
      } else if (path === '/api/rer-importer/signal-group-batch') {
        await route.fulfill({
          json: {
            data: accessibleGroups().map((group) => ({
              master_key: group.key,
              name: group.key,
              color_key: 'blue',
              ignore_operativny: group.hidden,
            })),
          },
        });
      } else if (path === '/api/1.1/submit-direct') {
        if (actor.failSubmissions-- > 0) {
          await route.fulfill({
            status: 503,
            json: { message: 'Creation temporarily unavailable' },
          });
          return;
        }
        const message = add(user, body.full_body ?? body.text, {
          groups: [body.signal_group_master_key],
        });
        await route.fulfill({ json: { signal_message_id: message.id } });
      } else if (
        path === '/api/rer-importer/get-inbox' ||
        path === '/api/rer-importer/get-inbox-count'
      ) {
        const ordered = filterMessages(body);
        if (path.endsWith('-count')) {
          await route.fulfill({
            json: { quantity: ordered.length, first_element_ts: ordered[0]?.at ?? null },
          });
          return;
        }
        if (!body.around_message_ref && body.newest_first) ordered.reverse();
        const target = body.around_message_ref
          ? ordered.findIndex(
              (message) =>
                uuid(message.id) === body.around_message_ref ||
                String(message.id) === body.around_message_ref,
            )
          : -1;
        const start =
          target >= 0
            ? Math.max(0, target - pageLimit)
            : body.load_latest && !body.newest_first
              ? Math.max(0, ordered.length - pageLimit)
              : 0;
        const response = {
          inbox_items: ordered
            .slice(start, target >= 0 ? target + pageLimit + 1 : start + pageLimit)
            .map((message) => [message.id, inboxMessage(message)]),
          callsigns: [],
          signal_profiles: {},
          signal_groups: [],
          freq_pelengs_summary: null,
          page_limit: pageLimit,
          around_message_messages_before: target >= 0 ? target : null,
          around_message_messages_after: target >= 0 ? ordered.length - target - 1 : null,
        };
        await gate('inbox');
        await route.fulfill({ json: response });
      } else if (path === '/api/rer-importer/inbox-item-context') {
        const message = messages.find(
          (message) =>
            (uuid(message.id) === body.message_uid || String(message.id) === body.message_uid) &&
            !message.deleted,
        );
        await route.fulfill({
          json: {
            message: message ? [message.id, inboxMessage(message)] : null,
            group_master_keys: message?.groups ?? [],
            sigint_inbox_item_ids: message ? [message.id] : [],
            since_ts: message ? message.timestamp - 15 * 60 * 1000 : null,
            till_ts: message ? message.timestamp + 15 * 60 * 1000 : null,
          },
        });
      } else if (
        path === '/api/rer-importer/messages-by-id' ||
        path === '/api/rer-importer/messages-by-id-with-metadata' ||
        path === '/api/rer-importer/messages-by-id-matching-filters'
      ) {
        const eligible = new Set(
          filterMessages(
            path === '/api/rer-importer/messages-by-id-matching-filters'
              ? (body.inbox_req ?? {})
              : {},
          ).map((message) => message.id),
        );
        const items = messages
          .filter((message) => body.message_ids.includes(message.id) && eligible.has(message.id))
          .map((message) => [message.id, inboxMessage(message)]);
        await route.fulfill({
          json: {
            ...(path.endsWith('-with-metadata')
              ? { inbox_items: items, page_limit: pageLimit, freq_pelengs_summary: null }
              : { messages: items }),
            signal_groups: [],
            signal_profiles: {},
            callsigns: [],
          },
        });
      } else if (path === '/api/event-stream/long-poll') {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const pending = events.slice(delivered);
        delivered = events.length;
        await route.fulfill({
          json: {
            events: pending.map((id, index) => ({
              id: `${delivered - pending.length + index + 1}`,
              event_type: { ETInboxChanged: id },
              created_at: Date.now(),
              origin: null,
              intelligence_report: false,
            })),
            last_event_id: `${delivered}`,
          },
        });
      } else {
        await route.fallback();
      }
    });
    actors.push(actor);
    return actor;
  };
  return {
    attach,
    actors,
    add,
    emit,
    messages,
    groups,
    setPageLimit: (limit: number) => {
      pageLimit = limit;
    },
  };
}

export async function withGroupFeedActors(
  browser: Browser,
  baseURL: string | undefined,
  run: (
    fixture: Awaited<ReturnType<typeof installGroupFeedActors>>,
    pages: Page[],
  ) => Promise<void>,
  options: GroupFeedActorsOptions = {},
) {
  const contexts = await Promise.all(
    Array.from({ length: options.actorCount ?? 2 }, () =>
      browser.newContext({ baseURL, viewport: { width: 1920, height: 900 } }),
    ),
  );
  const fixture = await installGroupFeedActors(options);
  try {
    await run(fixture, await Promise.all(contexts.map((context) => context.newPage())));
  } catch (error) {
    await test.info().attach('group-feed-requests.json', {
      body: JSON.stringify(
        fixture.actors.map(({ user, screen, requests }) => ({
          user,
          screen,
          requests: requests.filter(({ path }) => path !== '/api/event-stream/long-poll'),
        })),
        null,
        2,
      ),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
}
