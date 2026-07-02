type RankedOption<T> = {
  option: T;
  index: number;
  rank: number;
  label: string;
};

export function normalizeSearchValue(value: string): string {
  return value.toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').trim();
}

function isNumericToken(token: string): boolean {
  return /^\d+$/.test(token);
}

function matchesTokenSequence(labelTokens: string[], searchTokens: string[]): boolean {
  let nextIndex = 0;

  for (const token of searchTokens) {
    let matchedIndex = -1;

    for (let index = nextIndex; index < labelTokens.length; index += 1) {
      const labelToken = labelTokens[index];
      const tokenMatches = isNumericToken(token)
        ? labelToken === token
        : labelToken.includes(token);

      if (tokenMatches) {
        matchedIndex = index;
        break;
      }
    }

    if (matchedIndex === -1) return false;
    nextIndex = matchedIndex + 1;
  }

  return true;
}

function getSearchRank(
  normalizedLabel: string,
  normalizedInput: string,
  searchTokens: string[],
): number | null {
  if (normalizedLabel === normalizedInput) return 0;
  if (normalizedLabel.startsWith(normalizedInput)) return 1;
  if (normalizedLabel.includes(normalizedInput)) return 2;
  if (matchesTokenSequence(normalizedLabel.split(' '), searchTokens)) return 3;

  return null;
}

export function createRankedFilterOptions<T>(getOptionLabel: (option: T) => string, limit = 20) {
  return (options: T[], state: { inputValue: string }): T[] => {
    const normalizedInput = normalizeSearchValue(state.inputValue);
    if (normalizedInput === '') return options.slice(0, limit);

    const searchTokens = normalizedInput.split(' ');
    const rankedOptions: Array<RankedOption<T>> = [];

    options.forEach((option, index) => {
      const label = getOptionLabel(option);
      const normalizedLabel = normalizeSearchValue(label);
      const rank = getSearchRank(normalizedLabel, normalizedInput, searchTokens);
      if (rank === null) return;

      rankedOptions.push({
        option,
        index,
        label: normalizedLabel,
        rank,
      });
    });

    return rankedOptions
      .sort((left, right) => {
        if (left.rank !== right.rank) return left.rank - right.rank;
        const labelCompare = left.label.localeCompare(right.label, 'uk');
        if (labelCompare !== 0) return labelCompare;
        return left.index - right.index;
      })
      .slice(0, limit)
      .map(({ option }) => option);
  };
}

export function findExactSearchMatch<T>(
  options: T[],
  inputValue: string,
  getOptionLabel: (option: T) => string,
): T | null {
  const normalizedInput = normalizeSearchValue(inputValue);
  if (normalizedInput === '') return null;

  return (
    options.find((option) => {
      const normalizedLabel = normalizeSearchValue(getOptionLabel(option));
      return normalizedLabel === normalizedInput;
    }) ?? null
  );
}
