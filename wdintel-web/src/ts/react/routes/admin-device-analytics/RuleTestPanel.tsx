import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import { Box, CircularProgress, Paper, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import type { RuleExpression, RuleTestFileResult } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerChip } from '../../components/PowerChip';
import { PowerIconButton } from '../../components/PowerIconButton';
import {
  listAnalyticsTagTestFiles,
  testAnalyticsTagRule,
} from '../../services/api/device-analytics';

const MAX_TEST_FILES = 100;

type TestFileDraft = {
  key: number;
  absolutePath: string;
  expectedMatch: boolean;
};

type IndexedTestFile = {
  file: TestFileDraft;
  resultIndex: number;
};

function TestFileGroup({
  title,
  description,
  emptyText,
  addLabel,
  expectedMatch,
  files,
  results,
  testing,
  canAdd,
  onAdd,
  onUpdate,
  onDelete,
}: {
  title: string;
  description: string;
  emptyText: string;
  addLabel: string;
  expectedMatch: boolean;
  files: IndexedTestFile[];
  results: RuleTestFileResult[] | null;
  testing: boolean;
  canAdd: boolean;
  onAdd: () => void;
  onUpdate: (key: number, absolutePath: string) => void;
  onDelete: (key: number) => void;
}) {
  const titleId = expectedMatch
    ? 'positive-rule-test-files-title'
    : 'negative-rule-test-files-title';
  return (
    <Paper component="section" variant="outlined" aria-labelledby={titleId} sx={{ p: 1.5 }}>
      <Stack spacing={1.25}>
        <Box>
          <Typography id={titleId} variant="subtitle1" fontWeight={600}>
            {title}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {description}
          </Typography>
        </Box>
        {files.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {emptyText}
          </Typography>
        ) : null}
        {files.map(({ file, resultIndex }, caseIndex) => {
          const result = results?.find((candidate) => candidate.index === resultIndex);
          const resultLabel = result?.passed
            ? 'Кейс пройдено'
            : expectedMatch
              ? 'Тег не призначено'
              : 'Тег призначено помилково';
          return (
            <Paper key={file.key} variant="outlined" sx={{ p: 1.25 }}>
              <Stack spacing={1}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="subtitle2">Файл {caseIndex + 1}</Typography>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    {result ? (
                      <PowerChip
                        label={resultLabel}
                        color={result.passed ? 'success' : 'error'}
                        selected={result.passed}
                        interactive={false}
                      />
                    ) : null}
                    <PowerIconButton
                      size="small"
                      color="error"
                      title="Видалити"
                      aria-label={`Видалити ${expectedMatch ? 'позитивний' : 'негативний'} кейс ${caseIndex + 1}`}
                      onClick={() => onDelete(file.key)}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </PowerIconButton>
                  </Stack>
                </Stack>
                <TextField
                  label="Повний шлях до файла"
                  value={file.absolutePath}
                  onChange={(event) => onUpdate(file.key, event.target.value)}
                  helperText="Наприклад, C:\\Reports\\Звіт.pdf"
                  fullWidth
                  size="small"
                />
              </Stack>
            </Paper>
          );
        })}
        <Box>
          <PowerButton
            variant="outlined"
            startIcon={<AddIcon />}
            disabled={testing || !canAdd}
            onClick={onAdd}
          >
            {addLabel}
          </PowerButton>
        </Box>
      </Stack>
    </Paper>
  );
}

export function RuleTestPanel({
  tagId,
  expression,
}: {
  tagId: string | null;
  expression: RuleExpression | null;
}) {
  const nextKeyRef = useRef(1);
  const [files, setFiles] = useState<TestFileDraft[]>([]);
  const [results, setResults] = useState<RuleTestFileResult[] | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(tagId !== null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    setResults(null);
    setSaved(false);
    setTestError(null);
    if (tagId === null) {
      setFiles([]);
      setLoadError(null);
      setLoadingFiles(false);
      return;
    }

    const controller = new AbortController();
    setLoadingFiles(true);
    setLoadError(null);
    void listAnalyticsTagTestFiles({ id: tagId }, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        const loadedFiles = response.files.map((file, index) => ({
          key: index + 1,
          absolutePath: file.absolutePath,
          expectedMatch: file.expectedMatch,
        }));
        nextKeyRef.current = loadedFiles.length + 1;
        setFiles(loadedFiles);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingFiles(false);
      });

    return () => controller.abort();
  }, [reloadToken, tagId]);

  const clearTestResult = () => {
    setResults(null);
    setSaved(false);
    setTestError(null);
  };

  const updateFile = (key: number, patch: Partial<TestFileDraft>) => {
    setFiles((current) => current.map((file) => (file.key === key ? { ...file, ...patch } : file)));
    clearTestResult();
  };

  const runTest = async () => {
    if (tagId === null) return;
    setTesting(true);
    setTestError(null);
    setResults(null);
    setSaved(false);
    try {
      const response = await testAnalyticsTagRule({
        id: tagId,
        ruleExpression: expression,
        files: files.map((file) => ({
          absolutePath: file.absolutePath,
          expectedMatch: file.expectedMatch,
        })),
      });
      setResults(response.results);
      setSaved(true);
    } catch (error) {
      setTestError(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  const indexedFiles = files.map((file, resultIndex) => ({ file, resultIndex }));
  const failedCaseCount = results?.filter((result) => !result.passed).length ?? 0;

  return (
    <Paper
      component="section"
      variant="outlined"
      aria-labelledby="analytics-rule-test-title"
      sx={{ p: 2 }}
    >
      <Stack spacing={2}>
        <Box>
          <Typography id="analytics-rule-test-title" variant="h6">
            Тест правила
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Поточна локальна редакція правила перевіряється без збереження на сервері. Тестові файли
            зберігаються для наступних перевірок.
          </Typography>
        </Box>

        {tagId === null ? (
          <PowerAlert severity="info" autoHideDuration={null} dismissible={false}>
            Спочатку збережіть тег, щоб додати постійні тестові файли.
          </PowerAlert>
        ) : loadingFiles ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress aria-label="Завантаження тестових файлів" />
          </Box>
        ) : loadError ? (
          <PowerAlert
            severity="error"
            autoHideDuration={null}
            dismissible={false}
            action={
              <PowerButton
                color="inherit"
                size="small"
                onClick={() => setReloadToken((value) => value + 1)}
              >
                Повторити
              </PowerButton>
            }
          >
            Не вдалося завантажити тестові файли: {loadError}
          </PowerAlert>
        ) : (
          <>
            <TestFileGroup
              title="Позитивні кейси"
              description="Файли, яким правило має призначити цей тег."
              emptyText="Позитивних кейсів ще немає."
              addLabel="Додати позитивний кейс"
              expectedMatch
              files={indexedFiles.filter(({ file }) => file.expectedMatch)}
              results={results}
              testing={testing}
              canAdd={files.length < MAX_TEST_FILES}
              onAdd={() => {
                const key = nextKeyRef.current++;
                setFiles((current) => [...current, { key, absolutePath: '', expectedMatch: true }]);
                clearTestResult();
              }}
              onUpdate={(key, absolutePath) => updateFile(key, { absolutePath })}
              onDelete={(key) => {
                setFiles((current) => current.filter((file) => file.key !== key));
                clearTestResult();
              }}
            />
            <TestFileGroup
              title="Негативні кейси"
              description="Файли, яким правило не повинно призначати цей тег."
              emptyText="Негативних кейсів ще немає."
              addLabel="Додати негативний кейс"
              expectedMatch={false}
              files={indexedFiles.filter(({ file }) => !file.expectedMatch)}
              results={results}
              testing={testing}
              canAdd={files.length < MAX_TEST_FILES}
              onAdd={() => {
                const key = nextKeyRef.current++;
                setFiles((current) => [
                  ...current,
                  { key, absolutePath: '', expectedMatch: false },
                ]);
                clearTestResult();
              }}
              onUpdate={(key, absolutePath) => updateFile(key, { absolutePath })}
              onDelete={(key) => {
                setFiles((current) => current.filter((file) => file.key !== key));
                clearTestResult();
              }}
            />

            {testError ? (
              <PowerAlert severity="error" autoHideDuration={null} dismissible={false}>
                {testError}
              </PowerAlert>
            ) : null}
            {saved ? (
              <PowerAlert
                severity={failedCaseCount === 0 ? 'success' : 'warning'}
                autoHideDuration={null}
                dismissible={false}
              >
                {failedCaseCount === 0
                  ? 'Тестові файли збережено. Усі кейси пройдено.'
                  : `Тестові файли збережено. Не пройдено кейсів: ${failedCaseCount}.`}
              </PowerAlert>
            ) : null}

            <PowerButton
              variant="contained"
              startIcon={
                testing ? <CircularProgress size={18} color="inherit" /> : <ScienceOutlinedIcon />
              }
              disabled={testing}
              onClick={() => void runTest()}
              sx={{ alignSelf: { sm: 'flex-start' } }}
            >
              {testing ? 'Зберігаємо й перевіряємо…' : 'Зберегти й перевірити'}
            </PowerButton>
          </>
        )}
      </Stack>
    </Paper>
  );
}
