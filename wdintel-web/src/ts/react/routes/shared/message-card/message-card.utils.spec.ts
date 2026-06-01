import { describe, expect, it } from 'vitest';

import {
  buildCopyTextWithNetworkAndNote,
  buildCopyTextWithNetworkName,
  extractMessageTextForCopy,
} from './message-card.utils';

const sampleMessageText = `Отримано з поста "33_1"
--------------------------------------
08.09.2025, 14:07:06
143.1500
УКХ р/м управління, ймовірно, зрбатр 1 мсп 2 мсд 1 ТА (КАРПІВКА, НОВЕ, ДОНЕЦЬКА ОБЛАСТЬ) 143.150 МГц
ДУБ 3
ГУСАР

— Гусар, Гусар, я Дуб 3. Проверка связи. Как меня слышно?
— Гусар, Гусар, я Дуб 3. Как меня слышишь? Прием.`;

describe('extractMessageTextForCopy', () => {
  it('extracts from datetime row to end and removes frequency information', () => {
    expect(extractMessageTextForCopy(sampleMessageText)).toBe(
      `08.09.2025, 14:07:06
УКХ р/м управління, ймовірно, зрбатр 1 мсп 2 мсд 1 ТА (КАРПІВКА, НОВЕ, ДОНЕЦЬКА ОБЛАСТЬ)
ДУБ 3
ГУСАР

— Гусар, Гусар, я Дуб 3. Проверка связи. Как меня слышно?
— Гусар, Гусар, я Дуб 3. Как меня слышишь? Прием.`,
    );
  });
});

describe('buildCopyTextWithNetworkName', () => {
  it('replaces the first metadata line after datetime with the network name', () => {
    expect(buildCopyTextWithNetworkName(sampleMessageText, 'р/м Alpha')).toBe(
      `08.09.2025, 14:07:06
р/м Alpha
ДУБ 3
ГУСАР

— Гусар, Гусар, я Дуб 3. Проверка связи. Как меня слышно?
— Гусар, Гусар, я Дуб 3. Как меня слышишь? Прием.`,
    );
  });
});

describe('buildCopyTextWithNetworkAndNote', () => {
  it('puts the note above the message with network name', () => {
    expect(buildCopyTextWithNetworkAndNote(sampleMessageText, 'р/м Alpha', 'Мій коментар')).toBe(
      `Мій коментар

08.09.2025, 14:07:06
р/м Alpha
ДУБ 3
ГУСАР

— Гусар, Гусар, я Дуб 3. Проверка связи. Как меня слышно?
— Гусар, Гусар, я Дуб 3. Как меня слышишь? Прием.`,
    );
  });
});
