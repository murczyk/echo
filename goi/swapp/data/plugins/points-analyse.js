/* пошук згадок точок в тексті повідомлення */

const MODE = "strict"; // "strict" | "light" | "all"

const POINTER_STRONG_KEYWORDS = [
  "ТОЧКА",
  "ТОЧКЕ",
  "ТОЧКИ",
  "ТОЧЕК",
  "ТОЧКУ",
  "ТОЧКОЙ",
  "ТОЧКАХ",
];
const POINTER_LOCATION_WEAK_PREFIXES = [
  "ЧЕРЕЗ",
  "НА",
  "ЗА",
  "А",
  "В",
  "К",
  "С",
  "У",
  "Д",
  "СО",
  "ОТ",
  "ПО",
  "РАЙОН",
  "РАЙОНЕ",
  "МЕЖДУ",
];
const POINTER_LOCATION_PREFIXES = [
  ...POINTER_STRONG_KEYWORDS,
  ...POINTER_LOCATION_WEAK_PREFIXES,
  "ВОЗЛЕ",
  "ДО",
  "Е",
  "Н",
  "Г",
  "Ф",
  "П",
  "Р",
  "О",
  "Ж",
  "Ч",
  "М",
  "Т",
  "Б",
  "Ю",
];

const POINTER_LOCATION_SUFFIXES = [
  ...POINTER_STRONG_KEYWORDS,
  "АЯ",
  "ОЙ",
  "УЮ",
  "Ю",
];

const POINTER_LOCATION_SUFFIXES_FORBIDDEN = [
  "МИНУТ",
  "МАЛЫХ",
  "МАЛАЯ",
  "БОЛЬШИХ",
  "БОЛЬШАЯ",
  "МЕТРОВ",
  "МЕТРА",
  "ЧАСОВ",
];

const SET_OF_POINTER_LOCATION_PREFIXES = new Set(POINTER_LOCATION_PREFIXES);

const isLocationPointerPrefix = (prefix) => {
  if (!prefix) return false;

  return SET_OF_POINTER_LOCATION_PREFIXES.has(prefix);
};

const SET_OF_POINTER_LOCATION_SUFFIXES = new Set(POINTER_LOCATION_SUFFIXES);

const isLocationPointerSuffix = (suffix) => {
  if (!suffix) return false;

  return SET_OF_POINTER_LOCATION_SUFFIXES.has(suffix);
};

const getMessageUpperWords = (message) => {
  const normalized = message
    .toUpperCase()
    .replace(/\n+/g, " . ")
    .replace(/[.!?](\s*|\n|$)/g, " . ")
    .replace(/[\u2000-\u200B\u202F\u2060,;:()\[\]{}"«»“”'’\-–—]/g, " ")
    .replace(/([А-ЯЁ])(\d)/gi, "$1 $2");

  return normalized.split(/\s+/).filter(Boolean);
};

// eslint-disable-next-line import/no-anonymous-default-export
export default function (message) {
  const results = [];
  const msg = message.replace(/[\u2000-\u200B\u202F\u2060]/g, " ");

  const isAll = MODE === "all";
  const isLightMode = isAll || MODE === "light";
  // Find matches of 1-3 number blocks separated by space or dash
  const pointersRegex = /(?:\d{1,2}[-\s]?){1,3}/g;

  let match;
  while ((match = pointersRegex.exec(msg)) !== null) {
    const raw = match[0];
    const digits = raw.replace(/[-\s]/g, "");
    if (digits.length < 2 || digits.length > 4) continue;

    const index = match.index;

    // Look for prefix: last word before match
    const prefixMatch = msg.slice(0, index).match(/(\p{L}+)[\s\-]*$/u);
    const prefix = prefixMatch?.[1] ?? null;

    // Look for suffix: first word right after match
    const after = msg.slice(index + raw.length);
    const suffixMatch = after.match(/^[-\s]*([^\s\d.,!?]+)/u);
    const suffix = suffixMatch?.[1] ?? null;

    const number = +digits;

    if (isNaN(number)) continue;

    results.push({
      raw: raw.replace(/[^\d]+$/, ""),
      number: digits,
      prefix: prefix ? prefix.toUpperCase() : null,
      suffix: suffix ? suffix.toUpperCase() : null,
    });
  }

  const words = getMessageUpperWords(msg);

  const containStrongKeyword =
    isLightMode ||
    (results.length
      ? words.some((word) => POINTER_STRONG_KEYWORDS.includes(word))
      : false);

  const matches = new Set();

  for (const { prefix, suffix, number, raw } of results) {
    const isTwoDigit = number.length === 2;

    if (suffix) {
      if (POINTER_LOCATION_SUFFIXES_FORBIDDEN.some((x) => suffix.includes(x))) {
        continue;
      }
      if (isLocationPointerSuffix(suffix) || isAll) {
        if (
          isTwoDigit &&
          !POINTER_STRONG_KEYWORDS.includes(suffix) &&
          !containStrongKeyword
        ) {
          continue;
        }
        matches.add(raw);
      }
    }
    if (isLocationPointerPrefix(prefix) || isAll) {
      if (containStrongKeyword) {
        matches.add(raw);
      }
      if (prefix && !POINTER_LOCATION_WEAK_PREFIXES.includes(prefix)) {
        matches.add(raw);
      }
    }
  }

  return !!matches.size;
}
