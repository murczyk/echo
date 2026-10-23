import { expect, test } from '@playwright/test';
import { createMessage, holdNext, row, type Message } from './group-feed-actors.fixtures';
import {
  beginReply,
  closeThread,
  deleteMessage,
  detachReply,
  editMessage,
  editor,
  expectThread,
  fillReply,
  relation,
  openThread,
  saveReply,
  visit,
  withReplyActors,
} from './message-replies.fixtures';

test('@reply #3612 E3: three users see one creation-ordered thread across both screens', async ({
  browser,
  baseURL,
}) => {
  await withReplyActors(browser, baseURL, async (fixture, pages) => {
    const a = await fixture.attach(pages[0]!, 'duty', 'user-1');
    const b = await fixture.attach(pages[1]!, 'analysis', 'user-2');
    const c = await fixture.attach(pages[2]!, 'duty', 'user-3');
    await Promise.all([a, b, c].map((actor) => visit(actor)));
    let m1!: Message;
    let m2!: Message;
    let m3!: Message;
    let m4!: Message;
    await fixture.nextCreate(a, 'M1 original', null, () => {
      m1 = fixture.add(a.user, 'M1 original');
      return m1;
    });
    await createMessage(a, 'M1 original');
    await expect(editor(a).getByRole('textbox', { name: 'Текст повідомлення' })).toBeEmpty();
    await editor(a).getByRole('button', { name: 'Закрити', exact: true }).focus();
    await editor(a).getByRole('button', { name: 'Закрити', exact: true }).press('Enter');
    await fixture.nextCreate(b, 'M2 by B', m1.id, () => {
      m2 = fixture.add(b.user, 'M2 by B');
      fixture.respondWithReplies([relation(1, m1, m2)]);
      fixture.notify([m1.id, m2.id]);
      return m2;
    });
    await beginReply(b, m1);
    await saveReply(b, 'M2 by B');
    await fixture.nextCreate(c, 'M3 by C', m2.id, () => {
      m3 = fixture.add(c.user, 'M3 by C');
      fixture.respondWithReplies([relation(1, m1, m2), relation(2, m2, m3)]);
      fixture.notify([m2.id, m3.id]);
      return m3;
    });
    await beginReply(c, m2);
    await saveReply(c, 'M3 by C');
    await fixture.nextCreate(a, 'M4 to original by A', m1.id, () => {
      m4 = fixture.add(a.user, 'M4 to original by A');
      fixture.respondWithReplies([relation(1, m1, m2), relation(2, m2, m3), relation(3, m1, m4)]);
      fixture.notify([m1.id, m4.id]);
      return m4;
    });
    await beginReply(a, m1);
    await saveReply(a, 'M4 to original by A');
    for (const actor of [a, b, c]) {
      await expect(row(actor, m4.id)).toContainText('M4 to original by A');
      const panel = await openThread(actor, m4, 4);
      await expectThread(panel, ['M1 original', 'M2 by B', 'M3 by C', 'M4 to original by A']);
      await panel.getByText('M1 original', { exact: true }).click();
      await expect(row(actor, m1.id)).toBeInViewport();
      const reverse = await openThread(actor, m1, 4);
      await reverse.getByText('M3 by C', { exact: true }).click();
      await expect(row(actor, m3.id)).toBeInViewport();
    }
  });
});

test('@reply #3612 E5: overlapping first replies converge to one visible thread in all sessions', async ({
  browser,
  baseURL,
}) => {
  await withReplyActors(browser, baseURL, async (fixture, pages) => {
    const a = await fixture.attach(pages[0]!, 'duty', 'user-1');
    const b = await fixture.attach(pages[1]!, 'analysis', 'user-2');
    const c = await fixture.attach(pages[2]!, 'duty', 'user-3');
    const source = fixture.seed(a.user, 'Concurrent original');
    await Promise.all([a, b, c].map((actor) => visit(actor)));
    let bReply!: Message;
    await fixture.nextCreate(b, 'Concurrent B', source.id, () => {
      bReply = fixture.add(b.user, 'Concurrent B');
      fixture.respondWithReplies([relation(1, source, bReply)]);
      fixture.notify([source.id, bReply.id]);
      return bReply;
    });
    await fixture.nextCreate(c, 'Concurrent C', source.id, () => {
      const reply = fixture.add(c.user, 'Concurrent C', { at: bReply.at });
      fixture.respondWithReplies([relation(1, source, bReply), relation(2, source, reply)]);
      fixture.notify([source.id, reply.id]);
      return reply;
    });
    await Promise.all([beginReply(b, source), beginReply(c, source)]);
    await fillReply(b, 'Concurrent B');
    await fillReply(c, 'Concurrent C');
    const bGate = holdNext(b, 'submit');
    const cGate = holdNext(c, 'submit');
    await Promise.all(
      [b, c].map((actor) =>
        editor(actor).getByRole('button', { name: 'Створити', exact: true }).click(),
      ),
    );
    await Promise.all([bGate.started, cGate.started]);
    bGate.release();
    await expect(editor(b)).toHaveCount(0);
    cGate.release();
    await expect(editor(c)).toHaveCount(0);
    for (const actor of [a, b, c]) {
      const panel = await openThread(actor, source, 3);
      await expectThread(panel, ['Concurrent original', 'Concurrent B', 'Concurrent C']);
      await closeThread(actor);
    }
  });
});

test('@reply #3612 E8: an edit updates previews for other users without changing reply bodies or creation order', async ({
  browser,
  baseURL,
}) => {
  await withReplyActors(browser, baseURL, async (fixture, pages) => {
    const a = await fixture.attach(pages[0]!, 'analysis', 'user-1');
    const b = await fixture.attach(pages[1]!, 'duty', 'user-2');
    const c = await fixture.attach(pages[2]!, 'analysis', 'user-3');
    const source = fixture.seed(a.user, 'Before editing');
    const reply = fixture.seed(b.user, 'Reply stays unchanged', {
      timestamp: source.timestamp - 5_000,
    });
    fixture.respondWithReplies([relation(1, source, reply)]);
    await fixture.nextEdit(a, source, false, () => {
      fixture.respondWithReplies([relation(1, source, reply)]);
      fixture.notify([source.id]);
    });
    await Promise.all([a, b, c].map((actor) => visit(actor)));
    await editMessage(a, source);
    await fillReply(a, 'After editing');
    await editor(a).getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(editor(a)).toHaveCount(0);
    for (const actor of [b, c]) {
      await expect(row(actor, reply.id)).toContainText('After editing');
      await expect(row(actor, reply.id)).toContainText('Reply stays unchanged');
      const panel = await openThread(actor, source, 2);
      await expectThread(panel, ['After editing', 'Reply stays unchanged']);
      await expect(panel.getByText('Before editing', { exact: true })).toHaveCount(0);
      await closeThread(actor);
    }
  });
});

for (const position of ['root', 'middle', 'last'] as const) {
  test(`@reply #3612 E9: deleting the ${position} leaves a placeholder and the remaining thread usable`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, pages) => {
      const actors = await Promise.all([
        fixture.attach(pages[0]!, 'duty', 'user-1'),
        fixture.attach(pages[1]!, 'analysis', 'user-2'),
        fixture.attach(pages[2]!, 'duty', 'user-3'),
      ]);
      const messages = [
        fixture.seed('user-1', 'Root private contents'),
        fixture.seed('user-2', 'Middle private contents'),
        fixture.seed('user-3', 'Last private contents'),
      ];
      const [root, middle, last] = messages as [Message, Message, Message];
      const index = { root: 0, middle: 1, last: 2 }[position];
      const removed = messages[index]!;
      const survivor = index === 0 ? middle : root;
      const publish = (revision: number, extra?: Message) =>
        fixture.respondWithReplies([
          relation(1, root, middle),
          relation(2, middle, last),
          ...(extra ? [relation(3, survivor, extra)] : []),
        ]);
      publish(1);
      await fixture.nextDelete(actors[1]!, removed, () => {
        publish(2);
        fixture.notify([removed.id]);
      });
      await Promise.all(actors.map((actor) => visit(actor)));
      await deleteMessage(actors[1]!, removed);
      for (const actor of actors) {
        await expect(row(actor, removed.id)).toHaveCount(0);
        const panel = await openThread(actor, survivor, 3);
        await expect(panel.getByRole('listitem')).toHaveCount(3);
        const placeholder = panel.getByRole('listitem').nth(index);
        await expect(placeholder).toContainText('Повідомлення видалено');
        await expect(panel.getByText(removed.text, { exact: true })).toHaveCount(0);
        await expect(placeholder.locator('img, audio, video, a[href]')).toHaveCount(0);
        await closeThread(actor);
      }
      await fixture.nextCreate(actors[1]!, 'Reply after deletion', survivor.id, () => {
        const reply = fixture.add('user-2', 'Reply after deletion');
        publish(3, reply);
        fixture.notify([survivor.id, reply.id]);
        return reply;
      });
      await beginReply(actors[1]!, survivor);
      await saveReply(actors[1]!, 'Reply after deletion');
      const panel = await openThread(actors[2]!, survivor, 4);
      await expect(panel.getByRole('listitem')).toHaveCount(4);
      await expect(panel.getByRole('listitem').last()).toContainText('Reply after deletion');
    });
  });
}

for (const hasThread of [false, true]) {
  test(`@reply #3612 E10: deleting the source while composing ${hasThread ? 'a nested' : 'the first'} reply does not block saving`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, pages) => {
      const author = await fixture.attach(pages[0]!, 'duty', 'user-1');
      const owner = await fixture.attach(pages[1]!, 'analysis', 'user-2');
      const reader = await fixture.attach(pages[2]!, 'analysis', 'user-3');
      const source = fixture.seed(owner.user, 'Source deleted while writing');
      const previous = hasThread ? fixture.seed(reader.user, 'Previous reply') : null;
      if (previous) fixture.respondWithReplies([relation(1, source, previous)]);
      await fixture.nextDelete(owner, source, () => {
        if (previous) fixture.respondWithReplies([relation(1, source, previous)]);
        fixture.notify([source.id]);
      });
      await fixture.nextCreate(author, 'Keep this reply', source.id, () => {
        const reply = fixture.add(author.user, 'Keep this reply');
        fixture.respondWithReplies([
          relation(1, source, reply),
          ...(previous ? [relation(2, source, previous)] : []),
        ]);
        fixture.notify([source.id, reply.id]);
        return reply;
      });
      await Promise.all([author, owner, reader].map((actor) => visit(actor)));
      await beginReply(author, source);
      await fillReply(author, 'Keep this reply');
      await deleteMessage(owner, source);
      await expect(
        editor(author).getByText('Повідомлення видалено', { exact: true }),
      ).toBeVisible();
      await expect(
        editor(author).getByRole('combobox', { name: 'Група', exact: true }),
      ).toBeDisabled();
      await saveReply(author, 'Keep this reply');
      const reply = fixture.messages.at(-1)!;
      await expect(row(reader, reply.id)).toContainText('Keep this reply');
      const panel = await openThread(reader, reply, hasThread ? 3 : 2);
      await expectThread(
        panel,
        hasThread
          ? ['Повідомлення видалено', 'Previous reply', 'Keep this reply']
          : ['Повідомлення видалено', 'Keep this reply'],
      );
      await expect(panel.getByText('Source deleted while writing', { exact: true })).toHaveCount(0);
    });
  });
}

test('@reply #3612 E11: cancel keeps membership; saving detach removes one member for all users', async ({
  browser,
  baseURL,
}) => {
  await withReplyActors(browser, baseURL, async (fixture, pages) => {
    const a = await fixture.attach(pages[0]!, 'duty', 'user-1');
    const b = await fixture.attach(pages[1]!, 'analysis', 'user-2');
    const c = await fixture.attach(pages[2]!, 'duty', 'user-3');
    const root = fixture.seed(a.user, 'Detach root');
    const middle = fixture.seed(b.user, 'Detach middle');
    const last = fixture.seed(c.user, 'Detach last');
    fixture.respondWithReplies([relation(1, root, middle), relation(2, middle, last)]);
    await Promise.all([a, b, c].map((actor) => visit(actor)));
    await editMessage(b, middle);
    await detachReply(b);
    await editor(b).getByRole('button', { name: 'Закрити', exact: true }).click();
    await b.page.getByRole('button', { name: 'Відхилити зміни', exact: true }).click();
    const unchanged = await openThread(a, root, 3);
    await expectThread(unchanged, ['Detach root', 'Detach middle', 'Detach last']);
    await closeThread(a);
    await fixture.nextEdit(b, middle, true, () => {
      fixture.clearReplies(middle);
      fixture.respondWithReplies([]);
      fixture.notify([middle.id]);
    });
    await editMessage(b, middle);
    await detachReply(b);
    await editor(b).getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(editor(b)).toHaveCount(0);
    for (const actor of [a, b, c]) {
      await expect(row(actor, middle.id)).toContainText('Detach middle');
      await expect(row(actor, middle.id).getByRole('button', { name: /^Усі \d+$/ })).toHaveCount(0);
      await expectThread(await openThread(actor, root, 2), ['Detach root', 'Detach last']);
      await closeThread(actor);
      await expect(row(actor, last.id).getByText('Detach middle', { exact: true })).toHaveCount(0);
    }
    await fixture.nextEdit(c, last, true, () => {
      fixture.clearReplies(root);
      fixture.clearReplies(last);
      fixture.notify([last.id]);
    });
    await editMessage(c, last);
    await detachReply(c);
    await editor(c).getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(editor(c)).toHaveCount(0);
    for (const actor of [a, b, c]) {
      await expect(row(actor, root.id).getByRole('button', { name: /^Усі \d+$/ })).toHaveCount(0);
      await expect(row(actor, last.id)).toContainText('Detach last');
    }
  });
});

test('@reply #3612 E11: detaching a reply to a deleted original keeps the message and removes the placeholder', async ({
  browser,
  baseURL,
}) => {
  await withReplyActors(browser, baseURL, async (fixture, pages) => {
    const author = await fixture.attach(pages[0]!, 'analysis', 'user-1');
    const reader = await fixture.attach(pages[1]!, 'duty', 'user-2');
    const source = fixture.seed(reader.user, 'Deleted original private contents', {
      deleted: true,
    });
    const reply = fixture.seed(author.user, 'Keep this independent message');
    fixture.respondWithReplies([relation(1, source, reply)]);
    await fixture.nextEdit(author, reply, true, () => {
      fixture.clearReplies(reply);
      fixture.notify([reply.id]);
    });
    await Promise.all([author, reader].map((actor) => visit(actor)));
    await editMessage(author, reply);
    await expect(editor(author).getByText('Повідомлення видалено', { exact: true })).toBeVisible();
    await detachReply(author);
    await editor(author).getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(editor(author)).toHaveCount(0);
    for (const actor of [author, reader]) {
      await expect(row(actor, reply.id)).toContainText('Keep this independent message');
      await expect(
        row(actor, reply.id).getByText('Повідомлення видалено', { exact: true }),
      ).toHaveCount(0);
      await expect(row(actor, reply.id).getByRole('button', { name: /^Усі \d+$/ })).toHaveCount(0);
      await expect(row(actor, source.id)).toHaveCount(0);
    }
  });
});

for (const first of ['detach', 'reply'] as const) {
  test(`@reply #3612 E13: ${first} commits first while another user replies to the detached source`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, pages) => {
      const a = await fixture.attach(pages[0]!, 'analysis', 'user-1');
      const b = await fixture.attach(pages[1]!, 'duty', 'user-2');
      const c = await fixture.attach(pages[2]!, 'analysis', 'user-3');
      const root = fixture.seed(a.user, 'Race root');
      const source = fixture.seed(b.user, 'Race source');
      fixture.respondWithReplies([relation(1, root, source)]);
      let reply!: Message;
      await fixture.nextCreate(c, 'Reply during detach', source.id, () => {
        reply = fixture.add(c.user, 'Reply during detach');
        if (first === 'detach') {
          fixture.respondWithReplies([relation(1, source, reply)]);
          fixture.notify([source.id, reply.id]);
        } else {
          fixture.respondWithReplies([relation(1, root, source), relation(2, source, reply)]);
          fixture.notify([source.id, reply.id]);
        }
        return reply;
      });
      await fixture.nextEdit(b, source, true, () => {
        fixture.clearReplies(source);
        if (first === 'detach') fixture.clearReplies(root);
        else fixture.respondWithReplies([]);
        fixture.notify([source.id]);
      });
      await Promise.all([a, b, c].map((actor) => visit(actor)));
      await beginReply(c, source);
      await fillReply(c, 'Reply during detach');
      await editMessage(b, source);
      await detachReply(b);
      const saveDetach = async () => {
        await editor(b).getByRole('button', { name: 'Зберегти', exact: true }).click();
        await expect(editor(b)).toHaveCount(0);
      };
      if (first === 'detach') {
        await saveDetach();
        await saveReply(c, 'Reply during detach');
      } else {
        await saveReply(c, 'Reply during detach');
        await saveDetach();
      }
      for (const actor of [a, b, c]) {
        await expect(row(actor, reply.id)).toContainText('Reply during detach');
        const panel = await openThread(actor, reply, 2);
        await expectThread(
          panel,
          first === 'detach'
            ? ['Race source', 'Reply during detach']
            : ['Race root', 'Reply during detach'],
        );
        await closeThread(actor);
        const standalone = first === 'detach' ? root : source;
        await expect(
          row(actor, standalone.id).getByRole('button', { name: /^Усі \d+$/ }),
        ).toHaveCount(0);
      }
    });
  });
}
