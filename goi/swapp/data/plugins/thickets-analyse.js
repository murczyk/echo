/* пошук згадок точок в тексті повідомлення */

const MODE = "strict"; // "strict" | "light" | "all"

const THICKET_KEYWORDS_MATCH = ["ПОЛК", "ПОСАДК", "ПОЛОС"];

const removeAsterisk = (str) =>
  str.replace(/^"(.*)"$/, "$1").replace(/\*$/, "");

const getSearchKeywords = (keywords) => {
  const result = {
    full: {
      single: new Set(),
      double: new Set(),
      triple: new Set(),
      includes: [],
    },
    smart: [],
  };

  for (const keyword of keywords.toUpperCase().split(", ")) {
    if (!keyword) continue;

    if (keyword.match(/-\S+|\S+\*/g)) {
      const [search, ...restWords] = keyword.split(" ");

      const include = [];
      const exclude = [];

      for (const value of restWords) {
        if (value.startsWith("-")) {
          exclude.push(value.slice(1));
        } else {
          include.push(value);
        }
      }

      result.smart.push({ search, config: { include, exclude } });
    } else {
      const cleanKeyword = removeAsterisk(keyword);
      const wordsCount = cleanKeyword.split(" ").length;

      if (wordsCount === 1) {
        result.full.single.add(cleanKeyword);
      } else if (wordsCount === 2) {
        result.full.double.add(cleanKeyword);
      } else if (wordsCount === 3) {
        result.full.triple.add(cleanKeyword);
      } else if (wordsCount > 3) {
        result.full.includes.push({ search: cleanKeyword });
      }
    }
  }

  return result;
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
export default function (message, { task }) {
  const msg = message.replace(/[\u2000-\u200B\u202F\u2060]/g, " ");

  const isAll = MODE === "all";
  const isLightMode = isAll || MODE === "light";

  const words = getMessageUpperWords(msg);

  const thickets = task.keywords || "БАТОН, КАСАТКА, ЗМЕЯ, КРОВАТКА";
  const matches = new Set();
  const addMatch = (value) => {
    matches.add(value);
  };

  const searchKeywords = getSearchKeywords(thickets);

  const containThicketKeyword = words.some((word) =>
    THICKET_KEYWORDS_MATCH.some((x) => word.includes(x))
  );

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    // check if prev or next word match thicket keyword
    const isThicket = () =>
      isLightMode
        ? containThicketKeyword
        : THICKET_KEYWORDS_MATCH.some((x) => {
            if (words[i - 1] && words[i - 1].includes(x)) return true;
            if (words[i + 1] && words[i + 1].includes(x)) return true;
            return false;
          });

    const checkConfigMatch = (config) => {
      if (!config.include.length && !isThicket()) {
        return;
      }

      const matches = [word];
      const includes = config.include.every((search, idx) => {
        const nextWord = words[i + idx + 1];
        if (nextWord) matches.push(nextWord);
        return isMatch(search, nextWord);
      });
      if (!includes) return;

      const excludes = config.exclude.some((search) =>
        words.some((x) => isMatch(search, x))
      );

      if (excludes) return;

      addMatch(matches.join(" "));
    };

    if (searchKeywords.full.single.size) {
      const singleKeywordMatch = searchKeywords.full.single.has(word);

      if (singleKeywordMatch && isThicket()) {
        addMatch(word);
      }
    }
    if (searchKeywords.full.double.size && words[i + 1]) {
      const doubleWord = [word, words[i + 1]].join(" ");
      const doubleKeywordMatch = searchKeywords.full.double.has(doubleWord);

      if (doubleKeywordMatch && (containThicketKeyword || isLightMode)) {
        addMatch(doubleWord);
      }
    }
    if (searchKeywords.full.triple.size && words[i + 1] && words[i + 2]) {
      const tripleWord = [word, words[i + 1], words[i + 2]].join(" ");
      const tripleKeywordMatch = searchKeywords.full.triple.has(tripleWord);

      if (tripleKeywordMatch && (containThicketKeyword || isLightMode)) {
        addMatch(tripleWord);
      }
    }

    // check of partial matches
    for (const item of searchKeywords.smart) {
      if (!containThicketKeyword || isLightMode) {
        continue;
      }

      const cleanSearch = removeAsterisk(item.search);
      if (item.search.length !== cleanSearch.length) {
        if (!word.startsWith(cleanSearch)) continue;
      } else {
        if (word !== cleanSearch) continue;
      }
      checkConfigMatch(item.config);
    }
  }

  return !!matches.size;
}
