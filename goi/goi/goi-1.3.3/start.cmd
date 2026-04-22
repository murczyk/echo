@echo off
setlocal ENABLEDELAYEDEXPANSION

rem Resolve repo root from this .cmd's folder
set "ROOT=%~dp0"
rem drop trailing backslash if present
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "BOOTSTRAP=%ROOT%\.bootstrap"
if not exist "%BOOTSTRAP%" mkdir "%BOOTSTRAP%"
set "LOGFILE=%BOOTSTRAP%\last-run.log"

set "NODE=%ROOT%\.runtime\node\node.exe"
set "BOOT=%ROOT%\scripts\bootstrap.js"

if not exist "%NODE%" (
  echo Node not found: "%NODE%"
  echo Make sure .runtime\node\node.exe and .runtime\node\node_modules\npm\ are available.
  echo.
  pause
  exit /b 1
)

if not exist "%BOOT%" (
  echo Missing script file: "%BOOT%"
  echo.
  pause
  exit /b 1
)

echo Starting GOIapp...
for /f "tokens=1 delims==" %%V in ('set npm_config_ 2^>nul') do set "%%V="
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & '%NODE%' '%BOOT%' %* 2>&1 | Tee-Object -FilePath '%LOGFILE%'; exit $LASTEXITCODE"
set "ERR=%ERRORLEVEL%"
echo Logs saved to %LOGFILE%
echo (hint) You can view startup logs with: notepad "%LOGFILE%"

echo.
if not "%ERR%"=="0" (
  echo Script execution error %ERR%.
  echo --- Last 20 log entries ---
  powershell -Command "Get-Content -Tail 20 -Path '%LOGFILE%'"
  echo Press any key to exit...
  pause >nul
  exit /b %ERR%
)

rem Optional: keep window open even on success
rem pause
exit /b 0