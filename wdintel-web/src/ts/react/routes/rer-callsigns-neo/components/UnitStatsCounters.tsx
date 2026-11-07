import InfoIcon from '@mui/icons-material/Info';
import { Tooltip } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { designTokens } from '../../../../../design-system/design-tokens';
import { PowerChip } from '../../../components/PowerChip';
import { PowerIconButton } from '../../../components/PowerIconButton';

type CounterProps = {
  count: number;
  own?: boolean;
  selected?: boolean;
  onClick?: () => void;
  title?: string;
};

export function getUnitStatsItemsLabel(countLabel: string): string {
  if (countLabel === 'Пристроїв') return 'пристрої';
  if (countLabel === 'Мереж') return 'мережі';
  return 'позивні';
}

export function UnitStatsCounter({ count, own = false, selected, onClick, title }: CounterProps) {
  const theme = useTheme();
  const colors = designTokens.color[theme.palette.mode];
  return (
    <PowerChip
      size="small"
      label={count}
      selected={selected}
      onClick={onClick}
      interactive={Boolean(onClick)}
      ariaLabel={onClick ? title : undefined}
      title={title}
      unselectedOpacity={1}
      backgroundColor={own ? colors.ownRecords : 'action.selected'}
      selectedTextColor={own ? colors.onOwnRecords : 'text.primary'}
      unselectedTextColor={own ? colors.onOwnRecords : 'text.primary'}
      selectedBorderColor="text.primary"
      unselectedBorderColor="transparent"
    />
  );
}

export function UnitStatsCounterLegend({ countLabel }: { countLabel: string }) {
  const items = getUnitStatsItemsLabel(countLabel);
  return (
    <Tooltip
      arrow
      describeChild
      title={
        <span className="grid grid-cols-[auto_1fr] items-center gap-echo-sm">
          <UnitStatsCounter count={1} own />
          <span>Власні {items} підрозділу; натисніть для перегляду</span>
          <UnitStatsCounter count={1} />
          <span>Всі {items}</span>
        </span>
      }
    >
      <PowerIconButton size="small" aria-label="Пояснення лічильників підрозділів">
        <InfoIcon fontSize="small" />
      </PowerIconButton>
    </Tooltip>
  );
}
