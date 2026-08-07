import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
  Box,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useId } from 'react';

import type { RuleExpression, RuleField, RuleMatcher } from '../../../../Bindings';
import { PowerButton } from '../../components/PowerButton';
import { PowerIconButton } from '../../components/PowerIconButton';

const RULE_FIELD_OPTIONS: Array<{ value: RuleField; label: string }> = [
  { value: 'file_name', label: 'Назва файла' },
  { value: 'directory_path', label: 'Шлях каталогу' },
  { value: 'full_path', label: 'Повний шлях' },
  { value: 'extension', label: 'Розширення' },
];

const RULE_MATCHER_OPTIONS: Array<{ value: RuleMatcher; label: string }> = [
  { value: 'equals', label: 'Дорівнює' },
  { value: 'contains', label: 'Містить' },
  { value: 'contains_token', label: 'Містить окремий токен' },
  { value: 'regex', label: 'Регулярний вираз' },
];

const MAX_RULE_DEPTH = 16;

type RuleNodeKind = 'All' | 'Any' | 'Not' | 'Match';

function createMatchExpression(): RuleExpression {
  return {
    match: {
      field: 'file_name',
      matcher: 'contains',
      values: [''],
    },
  };
}

function createExpression(kind: RuleNodeKind): RuleExpression {
  if (kind === 'All') return { all: { children: [createMatchExpression()] } };
  if (kind === 'Any') return { any: { children: [createMatchExpression()] } };
  if (kind === 'Not') return { not: { child: createMatchExpression() } };
  return createMatchExpression();
}

function expressionKind(expression: RuleExpression): RuleNodeKind {
  if ('all' in expression) return 'All';
  if ('any' in expression) return 'Any';
  if ('not' in expression) return 'Not';
  return 'Match';
}

function GroupEditor({
  kind,
  children,
  depth,
  onChange,
}: {
  kind: 'All' | 'Any';
  children: RuleExpression[];
  depth: number;
  onChange: (expression: RuleExpression) => void;
}) {
  const updateChildren = (nextChildren: RuleExpression[]) => {
    onChange(
      kind === 'All' ? { all: { children: nextChildren } } : { any: { children: nextChildren } },
    );
  };

  const moveChild = (index: number, offset: -1 | 1) => {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= children.length) return;
    const nextChildren = [...children];
    [nextChildren[index], nextChildren[targetIndex]] = [
      nextChildren[targetIndex],
      nextChildren[index],
    ];
    updateChildren(nextChildren);
  };

  return (
    <Stack spacing={1} alignItems="flex-start" sx={{ width: '100%', minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
        {kind === 'All'
          ? 'Файл повинен відповідати кожній вкладеній умові.'
          : 'Файл повинен відповідати хоча б одній вкладеній умові.'}
      </Typography>
      {children.map((child, index) => (
        <RuleNodeEditor
          // A child has no persisted identity; its position is the expression identity.
          key={index}
          expression={child}
          depth={depth + 1}
          canRemove
          canMoveUp={index > 0}
          canMoveDown={index < children.length - 1}
          onMoveUp={() => moveChild(index, -1)}
          onMoveDown={() => moveChild(index, 1)}
          onChange={(nextChild) =>
            updateChildren(
              children.map((candidate, childIndex) =>
                childIndex === index ? nextChild : candidate,
              ),
            )
          }
          onRemove={() => updateChildren(children.filter((_, childIndex) => childIndex !== index))}
        />
      ))}
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <PowerButton
          variant="outlined"
          size="small"
          startIcon={<AddIcon />}
          disabled={depth >= MAX_RULE_DEPTH}
          onClick={() => updateChildren([...children, createMatchExpression()])}
        >
          Додати умову
        </PowerButton>
        <PowerButton
          variant="outlined"
          size="small"
          disabled={depth >= MAX_RULE_DEPTH}
          onClick={() => updateChildren([...children, createExpression('All')])}
        >
          Група «І»
        </PowerButton>
        <PowerButton
          variant="outlined"
          size="small"
          disabled={depth >= MAX_RULE_DEPTH}
          onClick={() => updateChildren([...children, createExpression('Any')])}
        >
          Група «АБО»
        </PowerButton>
        <PowerButton
          variant="outlined"
          size="small"
          disabled={depth >= MAX_RULE_DEPTH}
          onClick={() => updateChildren([...children, createExpression('Not')])}
        >
          Заперечення
        </PowerButton>
      </Stack>
    </Stack>
  );
}

function MatchEditor({
  expression,
  onChange,
}: {
  expression: Extract<RuleExpression, { match: unknown }>['match'];
  onChange: (expression: RuleExpression) => void;
}) {
  const fieldLabelId = useId();
  const matcherLabelId = useId();

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          md: 'minmax(180px, 0.7fr) minmax(200px, 0.8fr) minmax(280px, 1.5fr)',
        },
        gap: 1,
        alignItems: 'start',
        width: { xs: '100%', md: 760 },
        maxWidth: '100%',
      }}
    >
      <FormControl size="small" fullWidth>
        <InputLabel id={fieldLabelId}>Поле файла</InputLabel>
        <Select
          labelId={fieldLabelId}
          label="Поле файла"
          value={expression.field}
          inputProps={{ 'aria-label': 'Поле файла' }}
          onChange={(event) =>
            onChange({
              match: {
                ...expression,
                field: event.target.value as RuleField,
              },
            })
          }
        >
          {RULE_FIELD_OPTIONS.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {option.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <FormControl size="small" fullWidth>
        <InputLabel id={matcherLabelId}>Операція</InputLabel>
        <Select
          labelId={matcherLabelId}
          label="Операція"
          value={expression.matcher}
          onChange={(event) =>
            onChange({
              match: {
                ...expression,
                matcher: event.target.value as RuleMatcher,
                values:
                  event.target.value === 'regex'
                    ? [expression.values[0] ?? '']
                    : expression.values.length === 0
                      ? ['']
                      : expression.values,
              },
            })
          }
        >
          {RULE_MATCHER_OPTIONS.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {option.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <TextField
        label={expression.matcher === 'regex' ? 'Регулярний вираз' : 'Значення'}
        value={expression.values.join('\n')}
        multiline={expression.matcher !== 'regex'}
        minRows={1}
        maxRows={4}
        helperText={
          expression.matcher === 'regex'
            ? 'Без урахування регістру.'
            : 'Одне значення на рядок, без урахування регістру.'
        }
        onChange={(event) =>
          onChange({
            match: {
              ...expression,
              values:
                expression.matcher === 'regex'
                  ? [event.target.value]
                  : event.target.value.split('\n'),
            },
          })
        }
        fullWidth
        size="small"
      />
    </Box>
  );
}

function RuleNodeEditor({
  expression,
  depth,
  canRemove,
  canMoveUp = false,
  canMoveDown = false,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  expression: RuleExpression;
  depth: number;
  canRemove: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onChange: (expression: RuleExpression) => void;
  onRemove?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const kind = expressionKind(expression);

  return (
    <Paper
      component="fieldset"
      variant="outlined"
      sx={{
        m: 0,
        p: { xs: 1, sm: 1.25 },
        minWidth: 0,
        width: { xs: '100%', sm: 'fit-content' },
        maxWidth: '100%',
        borderColor: 'divider',
      }}
    >
      <Box component="legend" sx={{ px: 0.5 }}>
        <Typography component="span" variant="subtitle2">
          Вузол правила
        </Typography>
      </Box>
      <Stack spacing={1.25} alignItems="flex-start" sx={{ width: '100%', minWidth: 0 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={0.5}
          alignItems={{ xs: 'stretch', sm: 'center' }}
          sx={{ width: '100%', maxWidth: '100%' }}
        >
          <TextField
            select
            label="Тип вузла"
            size="small"
            value={kind}
            onChange={(event) => onChange(createExpression(event.target.value as RuleNodeKind))}
            sx={{ width: { xs: '100%', sm: 210 }, maxWidth: '100%' }}
          >
            <MenuItem value="All">Усі умови (І)</MenuItem>
            <MenuItem value="Any">Будь-яка умова (АБО)</MenuItem>
            <MenuItem value="Not">Заперечення (НЕ)</MenuItem>
            <MenuItem value="Match">Порівняння</MenuItem>
          </TextField>
          {canRemove ? (
            <Stack
              direction="row"
              spacing={0.25}
              sx={{ alignSelf: { xs: 'flex-start', sm: 'auto' } }}
            >
              <PowerIconButton
                size="small"
                title="Перемістити вище"
                aria-label="Перемістити вузол правила вище"
                disabled={!canMoveUp}
                onClick={onMoveUp}
              >
                <ArrowUpwardIcon fontSize="small" />
              </PowerIconButton>
              <PowerIconButton
                size="small"
                title="Перемістити нижче"
                aria-label="Перемістити вузол правила нижче"
                disabled={!canMoveDown}
                onClick={onMoveDown}
              >
                <ArrowDownwardIcon fontSize="small" />
              </PowerIconButton>
              <PowerIconButton
                size="small"
                color="error"
                title="Видалити"
                aria-label="Видалити вузол правила"
                onClick={onRemove}
              >
                <DeleteOutlineIcon fontSize="small" />
              </PowerIconButton>
            </Stack>
          ) : null}
        </Stack>

        {'all' in expression ? (
          <GroupEditor
            kind="All"
            children={expression.all.children}
            depth={depth}
            onChange={onChange}
          />
        ) : null}
        {'any' in expression ? (
          <GroupEditor
            kind="Any"
            children={expression.any.children}
            depth={depth}
            onChange={onChange}
          />
        ) : null}
        {'not' in expression ? (
          <RuleNodeEditor
            expression={expression.not.child}
            depth={depth + 1}
            canRemove={false}
            onChange={(child) => onChange({ not: { child } })}
          />
        ) : null}
        {'match' in expression ? (
          <MatchEditor expression={expression.match} onChange={onChange} />
        ) : null}
      </Stack>
    </Paper>
  );
}

export function RuleExpressionEditor({
  expression,
  onChange,
}: {
  expression: RuleExpression | null;
  onChange: (expression: RuleExpression | null) => void;
}) {
  if (expression === null) {
    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1.5} alignItems="flex-start">
          <Typography color="text.secondary">
            Тег не має активного правила і не призначатиметься файлам.
          </Typography>
          <PowerButton
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={() => onChange(createMatchExpression())}
          >
            Додати правило
          </PowerButton>
        </Stack>
      </Paper>
    );
  }

  return (
    <Stack spacing={1} alignItems="flex-start" sx={{ width: '100%', minWidth: 0 }}>
      <RuleNodeEditor expression={expression} depth={1} canRemove={false} onChange={onChange} />
      <PowerButton color="error" variant="text" onClick={() => onChange(null)}>
        Видалити правило
      </PowerButton>
    </Stack>
  );
}
