import { expect, test } from '@playwright/test';
import { createMessage, holdNext, row, type Message } from './group-feed-actors.fixtures';
import {
  beginReply,
  closeThread,
  deleteMessage,
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
      fixture.respondWithReplies([relation(1, m1, m2), relation(2, m1, m3)]);
      fixture.notify([m2.id, m3.id]);
      return m3;
    });
    await beginReply(c, m2);
    await saveReply(c, 'M3 by C');
    await fixture.nextCreate(a, 'M4 to original by A', m1.id, () => {
      m4 = fixture.add(a.user, 'M4 to original by A');
      fixture.respondWithReplies([relation(1, m1, m2), relation(2, m1, m3), relation(3, m1, m4)]);
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
    await fixture.nextEdit(a, source, () => {
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
      const panel = row(actor, reply.id).getByRole('region', { name: 'Відповіді', exact: true });
      await expectThread(panel, ['After editing']);
      await expect(panel.getByText('Before editing', { exact: true })).toHaveCount(0);
      await expectThread(
        row(actor, source.id).getByRole('region', { name: 'Відповіді', exact: true }),
        ['Reply stays unchanged'],
      );
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
          relation(2, root, last),
          ...(extra ? [relation(3, root, extra)] : []),
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

for (const screen of ['duty', 'analysis'] as const) {
  for (const hasThread of [false, true]) {
    test(`@reply #3612 E10 ${screen}: deleting the source while composing ${hasThread ? 'a nested' : 'the first'} reply saves an independent message`, async ({
      browser,
      baseURL,
    }) => {
      await withReplyActors(browser, baseURL, async (fixture, pages) => {
        const author = await fixture.attach(pages[0]!, screen, 'user-1');
        const owner = await fixture.attach(pages[1]!, 'analysis', 'user-2');
        const reader = await fixture.attach(pages[2]!, 'analysis', 'user-3');
        const original = hasThread ? fixture.seed(reader.user, 'Previous original') : null;
        const source = fixture.seed(owner.user, 'Source deleted while writing');
        if (original) fixture.respondWithReplies([relation(1, original, source)]);
        await fixture.nextDelete(owner, source, () => {
          if (original) fixture.respondWithReplies([relation(1, original, source)]);
          fixture.notify([source.id]);
        });
        await fixture.nextCreate(author, 'Keep this reply', null, () =>
          fixture.add(author.user, 'Keep this reply'),
        );
        await Promise.all([author, owner, reader].map((actor) => visit(actor)));
        await beginReply(author, source);
        await fillReply(author, 'Keep this reply');
        let releaseUpload: (() => void) | undefined;
        const attachment = Buffer.from('Keep this attachment');
        if (hasThread) {
          let uploadStarted!: () => void;
          const started = new Promise<void>((resolve) => {
            uploadStarted = resolve;
          });
          const wait = new Promise<void>((resolve) => {
            releaseUpload = resolve;
          });
          await author.page.route('**/api/sigint/file-upload/tus', async (route) => {
            uploadStarted();
            await wait;
            await route.fulfill({
              status: 201,
              headers: {
                Location: '/api/sigint/file-upload/tus/reply-attachment',
                'Tus-Resumable': '1.0.0',
                'Upload-Offset': '0',
              },
            });
          });
          await author.page.route(
            '**/api/sigint/file-upload/tus/reply-attachment',
            async (route) => {
              expect(route.request().postDataBuffer()).toEqual(attachment);
              await route.fulfill({
                status: 204,
                headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(attachment.length) },
              });
            },
          );
          await editor(author)
            .locator('input[type="file"]')
            .setInputFiles({ name: 'reply.txt', mimeType: 'text/plain', buffer: attachment });
          await editor(author).getByRole('button', { name: 'Створити', exact: true }).click();
          await started;
        }
        await deleteMessage(owner, source);
        await expect(editor(author)).toContainText(
          'Повідомлення буде збережено як звичайне, без зв’язку з джерелом.',
        );
        await expect(
          editor(author).getByRole('textbox', { name: 'Текст повідомлення' }),
        ).toHaveValue('Keep this reply');
        await expect(
          editor(author).getByRole('combobox', { name: 'Група', exact: true }),
        ).toBeDisabled();
        await author.page.screenshot({
          path: test.info().outputPath('deleted-source-draft.png'),
          animations: 'disabled',
        });
        if (releaseUpload) {
          releaseUpload();
          await expect(editor(author)).toHaveCount(0);
        } else await saveReply(author, 'Keep this reply');
        const reply = fixture.messages.at(-1)!;
        for (const actor of [author, reader]) {
          await expect(row(actor, reply.id)).toContainText('Keep this reply');
          await expect(
            row(actor, reply.id).getByRole('region', { name: 'Відповіді', exact: true }),
          ).toHaveCount(0);
        }
        await expect(editor(author)).toHaveCount(0);
        await author.page.screenshot({
          path: test.info().outputPath('independent-message-saved.png'),
          animations: 'disabled',
        });
        expect(
          author.requests.filter(({ path }) => path === '/api/1.1/submit-direct'),
        ).toHaveLength(1);
        if (hasThread) {
          const body = author.requests.find(({ path }) => path === '/api/1.1/submit-direct')!.body;
          expect(body.upload_urls).toEqual(['/api/sigint/file-upload/tus/reply-attachment']);
          await expect(
            row(reader, original!.id).getByRole('region', { name: 'Відповіді', exact: true }),
          ).toContainText('Повідомлення видалено');
        }
      });
    });
  }
}
