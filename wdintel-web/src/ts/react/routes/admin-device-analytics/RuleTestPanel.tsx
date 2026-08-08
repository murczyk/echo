import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import { Box, CircularProgress, Paper, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import type { RuleExpression, RuleTestFile, RuleTestFileResult } from '../../../../Bindings';
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
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toDraft(file: RuleTestFile, key: number): TestFileDraft {
  return {
    key,
    absolutePath: file.absolutePath,
  };
}

function emptyTestFile(key: number): TestFileDraft {
  return { key, absolutePath: '' };
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
        const loadedFiles = response.files.map((file, index) => toDraft(file, index + 1));
        nextKeyRef.current = loadedFiles.length + 1;
        setFiles(loadedFiles);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(error));
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
        })),
      });
      setResults(response.results);
      setSaved(true);
    } catch (error) {
      setTestError(errorMessage(error));
    } finally {
      setTesting(false);
    }
  };

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
            {files.length === 0 ? (
              <Typography color="text.secondary">Тестових файлів ще немає.</Typography>
            ) : null}
            {files.map((file, index) => {
              const result = results?.find((candidate) => candidate.index === index);
              return (
                <Paper key={file.key} variant="outlined" sx={{ p: 1.25 }}>
                  <Stack spacing={1}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="subtitle2">Файл {index + 1}</Typography>
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        {result ? (
                          <PowerChip
                            label={result.matched ? 'Відповідає' : 'Не відповідає'}
                            color={result.matched ? 'success' : 'default'}
                            selected={result.matched}
                            interactive={false}
                          />
                        ) : null}
                        <PowerIconButton
                          size="small"
                          color="error"
                          title="Видалити"
                          aria-label={`Видалити тестовий файл ${index + 1}`}
                          onClick={() => {
                            setFiles((current) =>
                              current.filter((candidate) => candidate.key !== file.key),
                            );
                            clearTestResult();
                          }}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </PowerIconButton>
                      </Stack>
                    </Stack>
                    <TextField
                      label="Повний шлях до файла"
                      value={file.absolutePath}
                      onChange={(event) =>
                        updateFile(file.key, { absolutePath: event.target.value })
                      }
                      helperText="Наприклад, C:\\Reports\\Звіт.pdf"
                      fullWidth
                      size="small"
                    />
                  </Stack>
                </Paper>
              );
            })}

            {testError ? (
              <PowerAlert severity="error" autoHideDuration={null} dismissible={false}>
                {testError}
              </PowerAlert>
            ) : null}
            {saved ? (
              <PowerAlert severity="success" autoHideDuration={null} dismissible={false}>
                Тестові файли збережено.
              </PowerAlert>
            ) : null}

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <PowerButton
                variant="outlined"
                startIcon={<AddIcon />}
                disabled={testing || files.length >= MAX_TEST_FILES}
                onClick={() => {
                  const key = nextKeyRef.current++;
                  setFiles((current) => [...current, emptyTestFile(key)]);
                  clearTestResult();
                }}
              >
                Додати тестовий файл
              </PowerButton>
              <PowerButton
                variant="contained"
                startIcon={
                  testing ? <CircularProgress size={18} color="inherit" /> : <ScienceOutlinedIcon />
                }
                disabled={testing}
                onClick={() => void runTest()}
              >
                {testing ? 'Зберігаємо й перевіряємо…' : 'Зберегти й перевірити'}
              </PowerButton>
            </Stack>
          </>
        )}
      </Stack>
    </Paper>
  );
}
