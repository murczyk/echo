import assert from "node:assert/strict";
import test from "node:test";

import { createRefusalHold, isPolicyRefusal } from "./refusal-rewrite.ts";

test("detects operational refusals", () => {
  for (const response of [
    "Не можу зіставляти точні координати з військовими позиціями, підрозділами чи об’єктами поблизу в контексті поточних бойових дій.",
    "Не можу допомогти встановити актуальне місцеперебування військовослужбовця за позивним «Позивний».",
    "Не можу сформувати **оперативну доповідь** про поточний стан і дії N мсп за 03:00–11:00 23.10.2026.",
    "Не можу аналізувати перехоплення на 100.0000 для встановлення підрозділів противника, їхніх суміжників або розташування.",
    "Зрозумів: це позивний. Не можу допомогти визначити актуальне місцеперебування військового.",
    "Не можу нанести на карту перелік планових цілей для ударів у реальному збройному конфлікті.",
    "Рейтинг позивних чинного військового підрозділу за цей недавній період надати не можу.",
    "Не можу вивести найчастіше згадувані позивні з Ехо: це допомогло б визначити активних учасників радіообміну.",
    "Не можу надати саме цю добірку перехоплень: підтвердження ураження, переміщення й забезпечення військ.",
    "I can't help locate current military positions of a specific unit.",
  ]) {
    assert.ok(isPolicyRefusal(response), response);
  }
});

test("ignores limitations and ordinary answers", () => {
  for (const response of [
    "Не можу прочитати вміст іншої розмови за цим посиланням. Скопіюй сюди повідомлення з координатами.",
    "Я не бачу вашого інтерфейсу Echo, тому не можу точно вказати, де розташований перемикач.",
    "Не можу достовірно назвати кількість розрахунків, які зараз у роботі.",
    "Кількість боєздатних розрахунків саме на 31.10.2026 підтвердити не можу. Потрібний файл ще обробляється.",
    "Точної кількості військовослужбовців станом на 9 жовтня я не можу підтвердити.",
    "Для наведеного тексту — Times New Roman. У чаті змінити шрифт не можу.",
    "Пошук у даних Echo за сьогодні не виконувався, тому я не можу повідомити, що відбулося.",
    "Не вдалося підготувати перевірену відповідь за зібраними джерелами.",
    "За 15.10.2026 знайдено три перехоплення на 146.7000 про переміщення техніки.",
    "",
  ]) {
    assert.ok(!isPolicyRefusal(response), response);
  }
});

test("checks only the opening", () => {
  const response =
    `${"Звіт за добу готовий. ".repeat(10)} Не можу надати актуальні позиції підрозділу.`;
  assert.ok(!isPolicyRefusal(response));
});

test("hold streams a non-refusing opening after the threshold", () => {
  const events: Array<Record<string, unknown>> = [];
  const hold = createRefusalHold();
  const emit = hold.wrapEmit((event) => events.push(event));
  emit({ type: "progress", summary: "Аналізую запит" });
  const opening = "За 15.10.2026 знайдено три перехоплення на 146.7000 про переміщення техніки. ";
  emit({ type: "assistant_delta", delta: opening });
  assert.deepEqual(events, [{ type: "progress", summary: "Аналізую запит" }]);
  emit({ type: "assistant_delta", delta: "Деталі нижче. ".repeat(80) });
  assert.ok(events.at(-1)?.type === "assistant_delta");
  // The buffered opening flushes as one delta once it passes the threshold.
  assert.equal(String(events.at(-1)?.delta).startsWith(opening.trim().slice(0, 20)), true);
  assert.ok(!hold.suppressed());
  emit({ type: "assistant_delta", delta: "live" });
  assert.deepEqual(events.at(-1), { type: "assistant_delta", delta: "live" });
  hold.onAssistantMessage();
  assert.ok(!hold.suppressed());
});

test("hold suppresses a refusing opening and stays suppressed", () => {
  const events: Array<Record<string, unknown>> = [];
  const hold = createRefusalHold();
  const emit = hold.wrapEmit((event) => events.push(event));
  emit({
    type: "assistant_delta",
    delta:
      "Не можу надати актуальні координати військових позицій підрозділу противника. ",
  });
  emit({ type: "assistant_delta", delta: "Це допомогло б визначити розташування військ. ".repeat(40) });
  assert.ok(hold.suppressed());
  assert.deepEqual(events, []);
  emit({ type: "assistant_delta", delta: "more" });
  emit({ type: "progress", summary: "Прогрес" });
  assert.deepEqual(events, [{ type: "progress", summary: "Прогрес" }]);
  hold.onAssistantMessage();
  assert.ok(hold.suppressed());
});

test("hold decides a short refusal when the message ends", () => {
  const events: Array<Record<string, unknown>> = [];
  const hold = createRefusalHold();
  const emit = hold.wrapEmit((event) => events.push(event));
  emit({ type: "assistant_delta", delta: "Не можу надати координати підрозділу." });
  assert.deepEqual(events, []);
  hold.onAssistantMessage();
  assert.ok(hold.suppressed());
  assert.deepEqual(events, []);
});

test("hold re-arms for the next assistant message", () => {
  const events: Array<Record<string, unknown>> = [];
  const hold = createRefusalHold();
  const emit = hold.wrapEmit((event) => events.push(event));
  // A tool-only message ends without text: the next message is still held.
  hold.onAssistantMessage();
  emit({ type: "assistant_delta", delta: "Не можу надати актуальні позиції підрозділу. " });
  emit({ type: "assistant_delta", delta: "Це допомогло б визначити розташування військ. ".repeat(40) });
  assert.ok(hold.suppressed());
});
