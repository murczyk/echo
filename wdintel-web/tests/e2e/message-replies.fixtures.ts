import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import type { CitedMessage, MessageReply } from '../../src/Bindings';
import { transformCamelToSnake } from '../../src/ts/snake-to-camel';
import {
  groupFeedPath,
  row,
  withGroupFeedActors,
  type Actor,
  type Message,
  type Screen,
} from './group-feed-actors.fixtures';

export function member(message: Message) {
  return {
    signal_message_id: message.id,
    created_at: message.at,
    summary: {
      id: message.id,
      is_accessible: true,
      is_deleted: message.deleted === true,
      text: message.deleted ? '' : message.text,
      attachments_count: 0,
      timestamp: message.timestamp,
      date: null,
      time: null,
      is_time_null: false,
      group_name: message.groups[0],
      group_master_key: message.groups[0],
      coords: null,
      media_file_names: [],
    },
  };
}

type FeedFixture = Parameters<Parameters<typeof withGroupFeedActors>[2]>[0];

export function relation(
  id: number,
  original: Message,
  reply: Message,
  options: Partial<MessageReply> = {},
): MessageReply {
  return {
    id,
    threadId: original.id,
    originalSignalMessageId: original.id,
    replySignalMessageId: reply.id,
    createdAt: reply.at,
    deleted: Boolean(original.deleted || reply.deleted),
    originalDeleted: Boolean(original.deleted),
    replyDeleted: Boolean(reply.deleted),
    ...options,
  };
}

async function waitForGate(actor: Actor, kind: 'submit' | 'reply-metadata') {
  const gate = actor.gates[kind];
  if (!gate) return;
  delete actor.gates[kind];
  gate.entered();
  await gate.wait;
}

function installReplyResponses(feed: FeedFixture) {
  const fields = new Map<number, Record<string, unknown>>();
  let relations: MessageReply[] = [];
  const attach = async (page: Page, screen: Screen, user: string) => {
    const actor = await feed.attach(page, screen, user);
    await page.route('**/api/rer-importer/message-replies', async (route) => {
      const body = route.request().postDataJSON();
      actor.requests.push({ path: '/api/rer-importer/message-replies', body });
      expect(body.screen).toBe(screen === 'duty' ? 'Duty' : 'Analysis');
      expect(body.signal_message_ids.length).toBeLessThanOrEqual(512);
      const anchors = new Set<number>(body.signal_message_ids);
      const threads = new Set(
        relations
          .filter(
            (edge) =>
              anchors.has(edge.originalSignalMessageId ?? -1) ||
              anchors.has(edge.replySignalMessageId ?? -1),
          )
          .map((edge) => edge.threadId),
      );
      const replies = relations.filter((edge) => threads.has(edge.threadId));
      const ids = new Set([
        ...anchors,
        ...replies.flatMap((edge) => [
          edge.originalDeleted ? null : edge.originalSignalMessageId,
          edge.replyDeleted ? null : edge.replySignalMessageId,
        ]),
      ]);
      const replyMessages: CitedMessage[] = feed.messages
        .filter((message) => ids.has(message.id) && !message.deleted)
        .map((message) => ({
          id: message.id,
          timestamp: message.timestamp,
          createdAt: message.at,
          preview: message.text,
          href: `/rer-${screen}-neo?m=${message.id}`,
        }));
      const response = transformCamelToSnake({ replies, replyMessages });
      await waitForGate(actor, 'reply-metadata');
      await route.fulfill({ json: response });
    });
    return actor;
  };
  const nextCreate = async (
    actor: Actor,
    text: string,
    sourceId: number | null,
    commit: () => Message,
  ) => {
    await actor.page.route(
      '**/api/1.1/submit-direct',
      async (route) => {
        const body = route.request().postDataJSON();
        actor.requests.push({ path: '/api/1.1/submit-direct', body });
        expect(body.full_body ?? body.text).toBe(text);
        expect(body.engaged_message_id ?? null).toBe(sourceId);
        expect(body.cited_signal_message_ids).toBeUndefined();
        expect(body.signal_group_master_key).toBe('group-1');
        expect(body.parent_signal_message_ids).toBeUndefined();
        expect(body.copy_source_signal_message_ids).toBeUndefined();
        await waitForGate(actor, 'submit');
        const message = commit();
        await route.fulfill({ json: { signal_message_id: message.id } });
      },
      { times: 1 },
    );
  };
  const nextEdit = async (actor: Actor, message: Message, commit: () => void) => {
    const path = `/api/1.1/message/${message.id}/edit`;
    await actor.page.route(
      `**${path}`,
      async (route) => {
        const body = route.request().postDataJSON();
        actor.requests.push({ path, body });
        expect(body.engaged_message_id).toBeUndefined();
        message.text = body.full_body ?? body.text;
        commit();
        await route.fulfill({ json: { signal_message_id: message.id } });
      },
      { times: 1 },
    );
  };
  const nextDelete = async (actor: Actor, message: Message, commit: () => void) => {
    await actor.page.route(
      '**/api/rer-importer/delete-message',
      async (route) => {
        const body = route.request().postDataJSON();
        expect(body.id).toBe(message.id);
        message.deleted = true;
        commit();
        await route.fulfill({ json: {} });
      },
      { times: 1 },
    );
  };
  const seed = (author: string, text: string, options: Partial<Message> = {}) => {
    const id = feed.messages.length + 101;
    const at = Date.now() - 60_000 + id;
    const message: Message = {
      id,
      author,
      text,
      at,
      timestamp: at,
      groups: ['group-1'],
      sender: author,
      ...options,
    };
    feed.messages.push(message);
    return message;
  };
  return {
    ...feed,
    attach,
    seed,
    respondWithReplies: (snapshot: MessageReply[]) => {
      relations = snapshot;
    },
    notify: (ids: number[]) => ids.forEach((id) => feed.emit(id)),
    nextCreate,
    nextEdit,
    nextDelete,
    setMessageFields: (message: Message, value: Record<string, unknown>) =>
      fields.set(message.id, value),
    messageFields: (message: Message) => fields.get(message.id) ?? {},
  };
}

export type ReplyFixture = ReturnType<typeof installReplyResponses>;

export async function withReplyActors(
  browser: Browser,
  baseURL: string | undefined,
  run: (fixture: ReplyFixture, pages: Page[]) => Promise<void>,
) {
  let fixture!: ReplyFixture;
  await withGroupFeedActors(
    browser,
    baseURL,
    async (feed, pages) => {
      fixture = installReplyResponses(feed);
      try {
        await run(fixture, pages);
      } finally {
        await Promise.allSettled(
          fixture.actors.map(async ({ page, user, screen }) => {
            const path = test.info().outputPath(`${user}-${screen}-browser.png`);
            await page.screenshot({ path });
            await test.info().attach(`${user}-${screen}-browser`, {
              path,
              contentType: 'image/png',
            });
          }),
        );
      }
    },
    { actorCount: 3, messageFields: (message) => fixture.messageFields(message) },
  );
}

export async function visit(actor: Actor, scope: 'group-1' | 'all' = 'group-1', filters = '') {
  await actor.page.goto(groupFeedPath(actor.screen, scope, filters));
}

export function editor(actor: Actor) {
  return actor.page.locator('[data-manage-message-presentation]');
}

export async function beginReply(actor: Actor, source: Message) {
  await expect(row(actor, source.id)).toContainText(source.text);
  await row(actor, source.id).getByRole('button', { name: 'Відповісти', exact: true }).click();
  await expect(editor(actor).getByRole('region', { name: 'Цитоване повідомлення' })).toContainText(
    source.text,
  );
}

export async function fillReply(actor: Actor, text: string) {
  await editor(actor).getByRole('textbox', { name: 'Текст повідомлення', exact: true }).fill(text);
  await expect(
    editor(actor).getByRole('textbox', { name: 'Текст повідомлення', exact: true }),
  ).toHaveValue(text);
}

export async function saveReply(actor: Actor, text: string) {
  await fillReply(actor, text);
  await editor(actor).getByRole('button', { name: 'Створити', exact: true }).click();
  await expect(editor(actor)).toHaveCount(0);
}

export async function editMessage(actor: Actor, message: Message) {
  await row(actor, message.id).getByRole('button', { name: 'Більше дій', exact: true }).click();
  await actor.page.getByRole('menuitem', { name: 'Редагувати', exact: true }).click();
  await expect(editor(actor).getByRole('textbox', { name: 'Текст повідомлення' })).toHaveValue(
    message.text,
  );
}

export async function deleteMessage(actor: Actor, message: Message) {
  await row(actor, message.id).getByRole('button', { name: 'Більше дій', exact: true }).click();
  await actor.page.getByRole('menuitem', { name: 'Видалити', exact: true }).click();
  await actor.page
    .getByRole('dialog', { name: 'Видалити повідомлення?' })
    .getByRole('button', { name: 'Видалити', exact: true })
    .click();
  await expect(row(actor, message.id)).toHaveCount(0);
}

export async function openThread(actor: Actor, message: Message, count: number) {
  const button = row(actor, message.id).getByRole('button', {
    name: count > 2 ? `Усі повідомлення ${count}` : 'Усі повідомлення',
    exact: true,
  });
  await expect(button).toBeVisible();
  await button.click();
  const panel = actor.page.getByRole('dialog', { name: 'Ланцюжок повідомлень', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

export async function expectThread(panel: Locator, texts: string[]) {
  await expect(panel.getByRole('listitem')).toHaveCount(texts.length);
  for (const [index, text] of texts.entries())
    await expect(panel.getByRole('listitem').nth(index)).toContainText(text);
}

export async function closeThread(actor: Actor) {
  await actor.page.keyboard.press('Escape');
  await expect(
    actor.page.getByRole('dialog', { name: 'Ланцюжок повідомлень', exact: true }),
  ).toHaveCount(0);
}
