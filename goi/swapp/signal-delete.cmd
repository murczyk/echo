@echo off
setlocal ENABLEDELAYEDEXPANSION

set "BASE=%~dp0"
if "%BASE:~-1%"=="\" set "BASE=%BASE:~0,-1%"

set "APPROOT=%BASE%"
if not exist "%APPROOT%\package.json" (
  if exist "%BASE%\..\package.json" set "APPROOT=%BASE%\.."
)

set "RUNTIME=%APPROOT%\.runtime\node"
if not exist "%RUNTIME%\node.exe" (
  if exist "%BASE%\..\.runtime\node\node.exe" set "RUNTIME=%BASE%\..\.runtime\node"
)

set "EMBEDDED_NODE=%RUNTIME%\node.exe"
set "EMBEDDED_NPM=%RUNTIME%\npm.cmd"

if exist "%EMBEDDED_NODE%" (
  echo Node: "%EMBEDDED_NODE%"
) else (
  echo Node: not found at "%EMBEDDED_NODE%"
)

if exist "%EMBEDDED_NPM%" (
  echo npm: "%EMBEDDED_NPM%"
) else (
  echo npm: not found at "%EMBEDDED_NPM%"
)

cd /d "%APPROOT%"

if not exist "%EMBEDDED_NPM%" (
  echo ERROR: Embedded npm not found at "%EMBEDDED_NPM%".
  goto :on_error
)

set "OLD_PATH=%PATH%"
set "PATH=%RUNTIME%;%APPROOT%\node_modules\.bin;%PATH%"

set "npm_config_loglevel=info"

call "%EMBEDDED_NPM%" run signal:delete
set "RC=%ERRORLEVEL%"

set "PATH=%OLD_PATH%"

echo.
if "%RC%"=="0" (
  echo Success: npm run signal:delete completed.
  goto :done
) else (
  echo Failure: npm run signal:delete exited with code %RC%.
  goto :on_error
)

:done
echo.
if "%1"=="/nopause" (
  exit /b 0
) else (
  echo Press any key to close...
  pause >nul
  exit /b 0
)

:on_error
echo.
if "%1"=="/nopause" (
  exit /b 1
) else (
  echo Press any key to close...
  pause >nul
  exit /b 1
)

endlocal