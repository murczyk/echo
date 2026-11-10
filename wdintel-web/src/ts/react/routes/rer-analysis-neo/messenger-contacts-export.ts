import { strToU8, zipSync } from 'fflate';

import type { MessengersChatMemberItem, MessengersContactItem } from '../../../../Bindings';
import type { MessengerAccountItem } from './components/MessengerAccountList';

// A person of the contacts table: a contact of the account, the account itself, or a chat member.
export type ContactRow = {
  id: string;
  userId: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  // A chat member that left the chat but is still referenced by old messages.
  deleted?: boolean;
};

export function toContactRow(contact: MessengersContactItem): ContactRow {
  return {
    id: contact.id,
    userId: contact.telegram?.userId ?? null,
    username: contact.username,
    firstName: contact.firstName,
    lastName: contact.lastName,
    phone: contact.phone,
  };
}

export function toMemberRow(member: MessengersChatMemberItem): ContactRow {
  return {
    id: member.id,
    userId: member.telegram?.userId ?? member.externalId,
    username: member.username,
    firstName: member.firstName,
    lastName: member.lastName,
    phone: member.phone,
    deleted: member.deleted,
  };
}

// The account itself, listed first as in kontur, unless it is already among its contacts.
export function withAccountRow(
  contacts: readonly MessengersContactItem[],
  account: MessengerAccountItem,
): ContactRow[] {
  const rows = contacts.map(toContactRow);
  if (account.userId != null && rows.some((row) => row.userId === account.userId)) return rows;
  const self: ContactRow = {
    id: `account-${account.id}`,
    userId: account.userId ?? null,
    username: account.username ?? null,
    firstName: account.name,
    lastName: null,
    // Contacts carry the number without the plus sign.
    phone: account.phone ? account.phone.replace(/^\+/, '') : null,
  };
  return [self, ...rows];
}

export function contactFullName(row: ContactRow): string {
  return [row.firstName, row.lastName].filter(Boolean).join(' ');
}

const cells = (row: ContactRow): string[] => [
  row.userId ?? '',
  row.username ? `@${row.username}` : '',
  row.firstName ?? '',
  row.lastName ?? '',
  row.phone ?? '',
];

// shortcut: a spreadsheet may run a text that starts with = + - or a control character as a formula, so those
// are prefixed with an apostrophe; the username column always starts with @ by design and is left alone.
const FORMULA_START = /^[=+\-\t\r]/;
const csvCell = (value: string, guard: boolean) => {
  const safe = guard && FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

const CSV_HEADER = ['telegramId', 'username', 'firstName', 'lastName', 'phone'];

// With a byte order mark, so a spreadsheet reads the Cyrillic as UTF-8.
export function buildContactsCsv(rows: readonly ContactRow[]): string {
  const lines = [
    CSV_HEADER.join(','),
    ...rows.map((row) =>
      cells(row)
        .map((value, i) => csvCell(value, i !== 1))
        .join(','),
    ),
  ];
  return `﻿${lines.join('\n')}`;
}

const XLSX_HEADER = ['User ID', 'Username', 'First Name', 'Last Name', 'Phone'];

const xmlEscape = (value: string) =>
  // Control characters are not valid in XML 1.0, a stray one would corrupt the file.
  // eslint-disable-next-line no-control-regex
  value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(
      /[&<>"]/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!,
    );
const columnLetter = (index: number) => String.fromCharCode(65 + index);

// A workbook with one sheet. Every value is an inline string, so a spreadsheet never reads one as a number
// (user ids and phones are too long for that) or as a formula.
export function buildContactsXlsx(rows: readonly ContactRow[]): Uint8Array {
  const sheetRows = [XLSX_HEADER, ...rows.map(cells)].map(
    (values, rowIndex) =>
      `<row r="${rowIndex + 1}">${values
        .map(
          (value, col) =>
            `<c r="${columnLetter(col)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`,
        )
        .join('')}</row>`,
  );
  const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
  return zipSync({
    '[Content_Types].xml': strToU8(
      xml(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>',
      ),
    ),
    '_rels/.rels': strToU8(
      xml(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      ),
    ),
    'xl/workbook.xml': strToU8(
      xml(
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Contacts" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      xml(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>',
      ),
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      xml(
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows.join('')}</sheetData></worksheet>`,
      ),
    ),
  });
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const contactsFileName = (accountId: string, extension: 'csv' | 'xlsx') =>
  `contacts_account_${accountId}.${extension}`;

export const membersFileName = (chatId: string, extension: 'csv' | 'xlsx') =>
  `members_chat_${chatId}.${extension}`;
