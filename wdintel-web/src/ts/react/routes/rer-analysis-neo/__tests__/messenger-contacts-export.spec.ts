import { strFromU8, unzipSync } from 'fflate';
import readXlsxFile from 'read-excel-file/web-worker';
import { describe, expect, it } from 'vitest';

import type { MessengersChatMemberItem, MessengersContactItem } from '../../../../../Bindings';
import {
  buildContactsCsv,
  buildContactsXlsx,
  contactFullName,
  contactsFileName,
  toContactRow,
  toMemberRow,
  withAccountRow,
  type ContactRow,
} from '../messenger-contacts-export';

const row = (overrides: Partial<ContactRow> = {}): ContactRow => ({
  id: 'c1',
  userId: '333407891',
  username: 'masu_tjwd',
  firstName: 'Сестра',
  lastName: 'Раи',
  phone: '79523597474',
  ...overrides,
});

const contact = (id: string, userId: string | null): MessengersContactItem => ({
  id,
  messengerType: 'Telegram',
  externalId: id,
  username: 'u',
  firstName: 'F',
  lastName: 'L',
  phone: '1',
  isMutual: null,
  isCloseFriend: null,
  createdAt: 0,
  updatedAt: 0,
  avatarUrl: null,
  telegram: userId == null ? null : { userId },
});

describe('messenger contacts export', () => {
  describe('rows', () => {
    it('reads the messenger user id from the telegram block', () => {
      expect(toContactRow(contact('c1', '7'))).toMatchObject({ id: 'c1', userId: '7' });
      expect(toContactRow(contact('c2', null)).userId).toBeNull();
    });

    it('carries the avatar of a contact, a member and the account itself', () => {
      const url = '/api/messengers/avatars/av1';
      expect(toContactRow({ ...contact('c1', '7'), avatarUrl: url }).avatarUrl).toBe(url);
      expect(
        toMemberRow({
          id: 'm1',
          externalId: '9',
          deleted: false,
          avatarUrl: url,
        } as MessengersChatMemberItem).avatarUrl,
      ).toBe(url);
      const rows = withAccountRow([], {
        id: 'a1',
        name: 'Me',
        phone: '',
        userId: '1',
        avatarUrl: url,
      });
      expect(rows[0].avatarUrl).toBe(url);
    });

    it('lists the account first, with its phone as contacts have it', () => {
      const rows = withAccountRow([contact('c1', '7')], {
        id: 'a1',
        name: 'Me',
        phone: '+905495911545',
        username: 'me',
        userId: '99',
      });
      expect(rows.map((item) => item.id)).toEqual(['account-a1', 'c1']);
      expect(rows[0]).toMatchObject({ firstName: 'Me', phone: '905495911545', userId: '99' });
    });

    it('does not list the account twice when it is among its contacts', () => {
      const rows = withAccountRow([contact('c1', '99')], {
        id: 'a1',
        name: 'Me',
        phone: '',
        userId: '99',
      });
      expect(rows.map((item) => item.id)).toEqual(['c1']);
    });

    it('builds the full name', () => {
      expect(contactFullName(row())).toBe('Сестра Раи');
      expect(contactFullName(row({ firstName: null, lastName: null }))).toBe('');
    });
  });

  describe('csv', () => {
    it('writes a header and a line per contact, after a byte order mark', () => {
      const csv = buildContactsCsv([row()]);
      expect(csv.startsWith('﻿')).toBe(true);
      expect(csv.slice(1).split('\n')).toEqual([
        'telegramId,username,firstName,lastName,phone',
        '333407891,@masu_tjwd,Сестра,Раи,79523597474',
      ]);
    });

    it('leaves a missing value empty and a missing list header-only', () => {
      expect(
        buildContactsCsv([row({ userId: null, username: null, lastName: null, phone: null })]),
      ).toContain('\n,,Сестра,,');
      expect(buildContactsCsv([]).slice(1)).toBe('telegramId,username,firstName,lastName,phone');
    });

    it('quotes a value with a comma, a quote or a line break', () => {
      const csv = buildContactsCsv([row({ firstName: 'A, "B"', lastName: 'C\nD' })]);
      expect(csv).toContain('"A, ""B""","C\nD"');
    });

    it('stops a spreadsheet from running a name as a formula, but keeps @username', () => {
      const csv = buildContactsCsv([
        row({ firstName: '=HYPERLINK("x")', lastName: '+1', phone: '-5' }),
      ]);
      expect(csv).toContain(`"'=HYPERLINK(""x"")",'+1,'-5`);
      expect(csv).toContain(',@masu_tjwd,');
    });
  });

  describe('xlsx', () => {
    const sheet = (rows: ContactRow[]) =>
      strFromU8(unzipSync(buildContactsXlsx(rows))['xl/worksheets/sheet1.xml']);

    it('is a workbook with the parts a spreadsheet needs', () => {
      expect(Object.keys(unzipSync(buildContactsXlsx([])))).toEqual(
        expect.arrayContaining([
          '[Content_Types].xml',
          '_rels/.rels',
          'xl/workbook.xml',
          'xl/_rels/workbook.xml.rels',
          'xl/worksheets/sheet1.xml',
        ]),
      );
    });

    it('writes the header and every value as a string', () => {
      const xml = sheet([row()]);
      expect(xml).toContain('<t xml:space="preserve">User ID</t>');
      expect(xml).toContain(
        '<c r="A2" t="inlineStr"><is><t xml:space="preserve">333407891</t></is></c>',
      );
      expect(xml).toContain(
        '<c r="B2" t="inlineStr"><is><t xml:space="preserve">@masu_tjwd</t></is></c>',
      );
      expect(xml).toContain('Сестра');
      expect(xml).toContain(
        '<c r="E2" t="inlineStr"><is><t xml:space="preserve">79523597474</t></is></c>',
      );
    });

    it('can be read back by a spreadsheet reader', async () => {
      const sheets = await readXlsxFile(
        new Blob([buildContactsXlsx([row({ lastName: null })])]) as never,
      );
      expect(sheets).toHaveLength(1);
      expect(sheets[0].sheet).toBe('Contacts');
      expect(sheets[0].data).toEqual([
        ['User ID', 'Username', 'First Name', 'Last Name', 'Phone'],
        ['333407891', '@masu_tjwd', 'Сестра', null, '79523597474'],
      ]);
    });

    it('escapes markup and drops characters XML cannot hold', () => {
      const xml = sheet([row({ firstName: 'A & <B> "C"', lastName: 'x\u0001y' })]);
      expect(xml).toContain('A &amp; &lt;B&gt; &quot;C&quot;');
      expect(xml).toContain('>xy<');
    });
  });

  it('names the files after the account', () => {
    expect(contactsFileName('a1', 'csv')).toBe('contacts_account_a1.csv');
    expect(contactsFileName('a1', 'xlsx')).toBe('contacts_account_a1.xlsx');
  });
});
