import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

test.setTimeout(60_000);

for (const assigned of [true, false]) {
  for (const canSend of [true, false]) {
    test(`@regression #4103 ${assigned ? 'assigned' : 'orphan'} group sending follows messenger capability ${canSend}`, async ({
      page,
    }, testInfo) => {
      await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
      let sendMessages = false;
      let senderOrganismIds: number[] = [];
      const saves: Record<string, unknown>[] = [];
      const group = () => ({
        master_key: 'sending-group',
        name: 'Sending group',
        sigint_zone_datasource_id: 1,
        group_master_key: 'sending-group',
        datasource_id: 1,
        interseption_kind: 'rer',
        group_stats: { activity_last_day: 0, activity_last_week: 0 },
      });
      await page.route('**/api/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        const responses: Record<string, unknown> = {
          '/api/datasources/list': [[1, { kind: 'signal', display_name: 'Signal' }]],
          '/api/sigint/zones/list': assigned ? [[1, { name: 'Test direction' }]] : [],
          '/api/sigint/zones/zone-datasources': [1],
          '/api/sigint/zones/zone-datasource-groups': { zone_datasource_groups: [group()] },
          '/api/rer-importer/orphan-signal-groups': assigned ? [] : [group()],
          '/api/rer-importer/archived-signal-groups': [],
          '/api/rer-importer/signal-group-batch': { data: [group()] },
          '/api/rer-importer/group-stats-timeline': { data: [] },
          '/api/sigint/aor': [],
          '/api/organisms': [{ id: 1, name: 'Allowed organism', enabled: true }],
          '/api/logins': { users: [] },
          '/api/messenger/group-sending-settings': {
            can_send_messages: canSend,
            send_messages: sendMessages,
            sender_organism_ids: senderOrganismIds,
          },
        };
        if (
          path === '/api/sigint/zones/zone-datasource-group-update' ||
          path === '/api/messenger/edit-group'
        ) {
          const body = route.request().postDataJSON();
          saves.push(body);
          if (body.send_messages !== null) sendMessages = body.send_messages;
          if (body.sender_organism_ids !== null) senderOrganismIds = body.sender_organism_ids;
          await route.fulfill({ json: group() });
        } else if (path in responses) {
          await route.fulfill({ json: responses[path] });
        } else {
          await route.fallback();
        }
      });
      const openEditor = async () => {
        if (assigned) await page.getByRole('tab', { name: 'Напрямок: Test direction' }).click();
        await page.getByRole('button', { name: 'Редагувати', exact: true }).click();
      };
      await page.goto('/admin/directions-neo');
      await openEditor();
      const dialog = page.getByRole('dialog');
      const toggle = dialog.getByRole('checkbox', { name: 'Надсилати повідомлення', exact: true });
      const organisms = dialog.getByRole('combobox', {
        name: 'Організми, яким дозволено надсилати',
      });
      await expect(
        dialog.getByRole('checkbox', { name: 'Обов’язковий підрозділ' }).locator('..'),
      ).toHaveClass(/MuiSwitch/);
      await expect(
        dialog.getByRole('checkbox', { name: 'Обов’язкова назва пристрою' }).locator('..'),
      ).toHaveClass(/MuiSwitch/);
      if (!canSend) {
        await expect(toggle).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
        await expect(dialog).not.toBeVisible();
        expect(saves[0]).toMatchObject({ send_messages: null, sender_organism_ids: null });
        return;
      }
      await expect(toggle).not.toBeChecked();
      await expect(organisms).toHaveCount(0);
      await toggle.focus();
      await page.keyboard.press('Space');
      await expect(toggle).toBeChecked();
      await organisms.fill('Allowed organism');
      await page.getByRole('option', { name: 'Allowed organism', exact: true }).click();
      await organisms.press('Tab');
      if (assigned) {
        for (const width of [1280, 768, 360]) {
          await page.setViewportSize({ width, height: 900 });
          await organisms.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: testInfo.outputPath(`group-sending-${width}.png`),
            animations: 'disabled',
          });
        }
        await page.setViewportSize({ width: 1280, height: 900 });
      }
      await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect(saves[0]).toMatchObject({ send_messages: true, sender_organism_ids: [1] });
      await page.reload();
      await openEditor();
      await expect(toggle).toBeChecked();
      await expect(dialog.getByText('Allowed organism', { exact: true })).toBeVisible();
      await toggle.uncheck();
      await expect(organisms).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect(saves[1]).toMatchObject({ send_messages: false, sender_organism_ids: [1] });
    });
  }
}
