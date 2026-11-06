/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';

import {
  buildPrivateChatCopyText,
  formatRelativeDateLabel,
  getSenderUiState,
  missingAttachmentNotice,
} from '../messenger-message-ui';

const member = (patch: object = {}) =>
  ({
    id: 'm1',
    externalId: '7',
    firstName: 'Ivan',
    lastName: null,
    username: null,
    phone: null,
    ...patch,
  }) as never;

describe('getSenderUiState', () => {
  const base = { chatType: 'GROUP', accountName: 'Me', member: member(), isOutgoing: false };

  it('shows the sender of an incoming group message', () => {
    expect(getSenderUiState(base)).toMatchObject({ showName: true, needsCopyPrefix: false });
  });

  it('never shows a name for an outgoing message', () => {
    expect(getSenderUiState({ ...base, isOutgoing: true }).showName).toBe(false);
  });

  it('hides the name of a known member in a private chat and prefixes copies', () => {
    expect(getSenderUiState({ ...base, chatType: 'PRIVATE' })).toEqual({
      showName: false,
      copyName: 'Ivan',
      needsCopyPrefix: true,
    });
  });

  it('prefixes copies of outgoing private messages with the account name', () => {
    expect(
      getSenderUiState({ ...base, chatType: 'private', isOutgoing: true, member: undefined }),
    ).toEqual({
      showName: false,
      copyName: 'Me',
      needsCopyPrefix: true,
    });
  });

  it('has no name to show for an unknown sender, in any chat type', () => {
    expect(getSenderUiState({ ...base, member: undefined }).showName).toBe(false);
    expect(getSenderUiState({ ...base, chatType: 'PRIVATE', member: undefined })).toMatchObject({
      showName: false,
      needsCopyPrefix: false,
    });
  });

  it('does not prefix copies outside private chats', () => {
    expect(getSenderUiState({ ...base, isOutgoing: true }).needsCopyPrefix).toBe(false);
  });

  it('treats a missing outgoing flag as incoming', () => {
    expect(getSenderUiState({ ...base, isOutgoing: null }).showName).toBe(true);
  });
});

describe('formatRelativeDateLabel', () => {
  const now = new Date(2026, 8, 15, 12, 0);

  it('names today and yesterday', () => {
    expect(formatRelativeDateLabel(new Date(2026, 8, 15, 0, 1).getTime(), now)).toBe('Сьогодні');
    expect(formatRelativeDateLabel(new Date(2026, 8, 14, 23, 59).getTime(), now)).toBe('Вчора');
  });

  it('uses day and month for older dates this year and adds the year for other years', () => {
    const sameYear = formatRelativeDateLabel(new Date(2026, 8, 12).getTime(), now);
    expect(sameYear).toMatch(/12/);
    expect(sameYear).not.toMatch(/2026/);
    expect(formatRelativeDateLabel(new Date(2025, 8, 12).getTime(), now)).toMatch(/2025/);
  });

  it('is empty for an invalid timestamp', () => {
    expect(formatRelativeDateLabel(Number.NaN, now)).toBe('');
  });
});

describe('buildPrivateChatCopyText', () => {
  function render() {
    document.body.innerHTML = `<div id="c">
      <div data-messenger-copy-text data-copy-sender="Ivan"><p id="a">hello</p></div>
      <div data-messenger-copy-text><p id="b">no sender</p></div>
    </div>`;
    return document.getElementById('c')!;
  }
  const select = (from: Node, to: Node) => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(from, 0);
    range.setEnd(to, to.childNodes.length || (to.textContent?.length ?? 0));
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  };

  it('returns null without a selection', () => {
    const container = render();
    window.getSelection()!.removeAllRanges();
    expect(buildPrivateChatCopyText(container, window.getSelection()!)).toBeNull();
  });

  it('prefixes a message that has a copy sender', () => {
    const container = render();
    const selection = select(document.getElementById('a')!, document.getElementById('a')!);
    expect(buildPrivateChatCopyText(container, selection)).toBe('Ivan: hello');
  });

  it('joins several messages and leaves senderless ones plain', () => {
    const container = render();
    const selection = select(document.getElementById('a')!, document.getElementById('b')!);
    expect(buildPrivateChatCopyText(container, selection)).toBe('Ivan: hello\n\nno sender');
  });
});

describe('missingAttachmentNotice', () => {
  const now = Date.UTC(2026, 8, 15, 12, 0);

  it('says the attachment is still arriving for a fresh message', () => {
    expect(missingAttachmentNotice(now - 60_000, now)).toBe('Вкладення завантажується…');
    expect(missingAttachmentNotice(now - 10 * 60_000 + 1, now)).toBe('Вкладення завантажується…');
  });

  it('says the attachment is unavailable once the arrival window has passed', () => {
    expect(missingAttachmentNotice(now - 10 * 60_000, now)).toBe('Вкладення недоступне');
    expect(missingAttachmentNotice(now - 86_400_000, now)).toBe('Вкладення недоступне');
  });

  it('treats a message sent slightly in the future (clock skew) as fresh', () => {
    expect(missingAttachmentNotice(now + 30_000, now)).toBe('Вкладення завантажується…');
  });
});
