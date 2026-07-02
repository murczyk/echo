import { IconButton, Tooltip } from '@mui/material';

import { SearchInput, SearchInputProps } from './SearchInput';

const SEARCH_WILDCARD_TOOLTIP = `Приклади пошуку:
 "40" — точний збіг
 "40*" — пошук за префіксом (наприклад 40, 400, 401, ...)
 "*40" — пошук за суфіксом (наприклад 40, 540, 840, ...)
 "*40*" — пошук за входженням (наприклад 40, 400, 540, 840, ...)`;

export type MapSearchInputProps = Omit<SearchInputProps, 'emptyEndAdornment'>;

function WildcardHelpButton() {
  return (
    <Tooltip
      title={SEARCH_WILDCARD_TOOLTIP}
      placement="bottom"
      arrow
      slotProps={{
        tooltip: {
          sx: {
            maxWidth: 320,
            whiteSpace: 'pre-line',
            lineHeight: 1.4,
            fontSize: 13,
          },
        },
      }}
    >
      <span>
        <IconButton
          edge="end"
          size="small"
          aria-label={SEARCH_WILDCARD_TOOLTIP}
          sx={{ color: 'text.secondary' }}
        >
          <i className="bi bi-question-circle" />
        </IconButton>
      </span>
    </Tooltip>
  );
}

export function MapSearchInput(props: MapSearchInputProps) {
  return <SearchInput {...props} emptyEndAdornment={<WildcardHelpButton />} />;
}
