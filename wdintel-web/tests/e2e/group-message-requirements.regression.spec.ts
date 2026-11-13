import { expect, test } from '@playwright/test';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';
import { openCreateReportDrawer, openEditMessageDrawer } from './image-editor-drawer.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';
import { beginReply, editor, fillReply, visit, withReplyActors } from './message-replies.fixtures';

test.use({ viewport: { width: 1600, height: 1000 } });

test('@regression #3935 replies waited for group requirements and retried failed metadata', async ({
  browser,
  baseURL,
}) => {
  await withReplyActors(browser, baseURL, async (fixture, [page]) => {
    const actor = await fixture.attach(page!, 'duty', 'user-1');
    const source = fixture.seed('user-2', 'Required reply destination 3935');
    await page!.route('**/api/user/settings', (route) =>
      route.fulfill({ json: { messageAutoParseEnabled: false } }),
    );
    await visit(actor);
    await expect(page!.locator(`[data-message-id="${source.id}"]`)).toBeVisible();
    let release!: () => void;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    await page!.route('**/api/rer-importer/signal-group-batch', async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await response;
        return route.fulfill({ status: 503, json: { error: 'Group metadata unavailable' } });
      }
      return route.fulfill({
        json: {
          data: [{ master_key: 'group-1', name: 'group-1', is_sigint_unit_mandatory: true }],
        },
      });
    });
    await beginReply(actor, source);
    await fillReply(actor, 'Reply 3935');
    const submit = editor(actor).getByRole('button', { name: 'Створити', exact: true });
    try {
      await expect.poll(() => attempts).toBe(1);
      await expect(submit).toBeDisabled();
    } finally {
      release();
    }
    await expect(editor(actor).getByText('Не вдалося завантажити довідкові дані.')).toBeVisible();
    await expect(submit).toBeDisabled();
    await editor(actor)
      .getByRole('button', { name: 'Повторити завантаження', exact: true })
      .click();
    await expect.poll(() => attempts).toBe(2);
    await expect(editor(actor).getByText('Не вдалося завантажити довідкові дані.')).toHaveCount(0);
    await expect(submit).toBeDisabled();
    await page!.route('**/api/sigint/unit/search', (route) =>
      route.fulfill({ json: { units: [{ id: 3935, name: 'Підрозділ 3935', active: true }] } }),
    );
    await editor(actor)
      .getByRole('combobox', { name: 'Підрозділ', exact: true })
      .fill('Підрозділ 3935');
    await page!.getByRole('option', { name: 'Підрозділ 3935', exact: true }).click();
    await expect(submit).toBeEnabled();
  });
});

for (const flow of ['message', 'report'] as const) {
  test(`@regression #3935 ${flow} validated the selected group's required fields`, async ({
    page,
  }) => {
    const submissions: Record<string, unknown>[] = [];
    const installGroups = async () => {
      await page.route('**/api/user/sigint-groups', (route) =>
        route.fulfill({ json: ['required-3935', 'optional-3935'] }),
      );
      await page.route('**/api/rer-importer/signal-group-batch', (route) =>
        route.fulfill({
          json: {
            data: [
              {
                master_key: 'required-3935',
                name: 'Обов’язкові 3935',
                is_sigint_unit_mandatory: true,
                is_device_mandatory: flow === 'message',
              },
              {
                master_key: 'optional-3935',
                name: 'Необов’язкові 3935',
                is_sigint_unit_mandatory: false,
                is_device_mandatory: false,
              },
            ],
          },
        }),
      );
    };
    if (flow === 'message') {
      await installRerDutyShortStateMocks(page, {
        signalGroups: ['required-3935', 'optional-3935'],
        userRoles: ['Rer', 'Cyber'],
      });
      await installGroups();
      await page.route('**/api/system-settings/current', (route) =>
        route.fulfill({
          json: { ...systemSettingsCurrentResponse(), devices_section_enabled: true },
        }),
      );
      await page.goto('/rer-duty-neo');
      await page.getByRole('button', { name: 'Додати повідомлення' }).click();
    } else {
      await openCreateReportDrawer(page, installGroups);
    }
    await page.route('**/api/sigint/unit/search', (route) =>
      route.fulfill({ json: { units: [{ id: 3935, name: 'Підрозділ 3935', active: true }] } }),
    );
    await page.route('**/api/sigint/device-name/create', (route) =>
      route.fulfill({ json: { device: { id: 3935, name: 'Пристрій 3935' } } }),
    );
    await page.route('**/api/1.1/submit-direct', (route) => {
      submissions.push(route.request().postDataJSON());
      return route.fulfill({ json: { signal_message_id: 3935 } });
    });
    await page
      .getByRole('textbox', {
        name: flow === 'message' ? 'Текст повідомлення' : 'Текст розвіддонесення',
      })
      .fill('Повідомлення 3935');
    const group = page.getByRole('combobox', {
      name: flow === 'message' ? 'Група' : 'Відправити в групу',
      exact: true,
    });
    const chooseGroup = async (name: string) => {
      await group.click();
      await page.getByRole('option', { name, exact: true }).click();
      if (flow === 'message') await group.press('Escape');
    };
    await chooseGroup('Обов’язкові 3935');
    const submit = page.getByRole('button', { name: 'Створити', exact: true });
    await expect(submit).toBeDisabled();
    await chooseGroup('Необов’язкові 3935');
    if (flow === 'message') {
      await expect(submit).toBeDisabled();
      await chooseGroup('Обов’язкові 3935');
    }
    await expect(submit).toBeEnabled();
    await chooseGroup('Обов’язкові 3935');
    await expect(submit).toBeDisabled();
    await page.getByRole('combobox', { name: 'Підрозділ', exact: true }).fill('Підрозділ 3935');
    await page.getByRole('option', { name: 'Підрозділ 3935', exact: true }).click();
    if (flow === 'message') {
      await expect(submit).toBeDisabled();
      await page.getByRole('combobox', { name: 'Назва пристрою' }).fill('Пристрій 3935');
    }
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0]).toMatchObject({
      unit_id: 3935,
      signal_group_master_key: flow === 'message' ? 'optional-3935' : 'required-3935',
      ...(flow === 'message' ? { additional_signal_group_master_keys: ['required-3935'] } : {}),
    });
    if (flow === 'message') expect(submissions[0]).toMatchObject({ device_name_id: 3935 });
  });
}

test('@regression #3935 existing edits remained valid when the group required missing fields', async ({
  page,
}) => {
  await openEditMessageDrawer(page, async () => {
    await page.route('**/api/rer-importer/signal-group-batch', (route) =>
      route.fulfill({
        json: {
          data: [
            {
              master_key: 'editor-e2e-group',
              name: 'editor-e2e-group',
              is_sigint_unit_mandatory: true,
              is_device_mandatory: true,
            },
          ],
        },
      }),
    );
  });
  await page.getByRole('combobox', { name: 'Підрозділ', exact: true }).fill('');
  await page.getByRole('textbox', { name: 'Текст повідомлення', exact: true }).fill('Edit 3935');
  let saved = false;
  await page.route('**/api/1.1/message/*/edit', (route) => {
    saved = true;
    return route.fulfill({ json: { signal_message_id: 3935 } });
  });
  const save = page.getByRole('button', { name: 'Зберегти', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => saved).toBe(true);
});
