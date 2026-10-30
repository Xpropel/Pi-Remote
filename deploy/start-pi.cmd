@echo off
REM pi-remote: start pi with the pi-remote environment (Windows).
REM Usage: deploy\start-pi.cmd [extra pi args...]  - run it from the project dir pi should work in.
REM Env source: the .env next to this script's parent (deploy\..\.env) > existing system env
REM (keys left empty in .env do not override the system value).
REM .env rules follow parseEnv in deploy\attach.cjs (and deploy/start-pi.sh): blank lines and
REM # comments (indented ones too) are skipped; spaces around the key are trimmed ("KEY = v");
REM keys containing spaces are skipped; leading/trailing spaces of the value are trimmed and a
REM pair of surrounding quotes is removed (KEY="a b" or KEY='a b'); & | > " ! in values are
REM never executed as commands. Two differences: every double quote in a key or value is dropped
REM (not only a surrounding pair), and a UTF-8 BOM in front of the first line is not stripped
REM (keep the first line a comment, as .env.example does).
REM
REM KEEP THIS FILE ASCII-ONLY. cmd.exe re-reads a batch file by byte offset after every line;
REM after "chcp 65001" multi-byte text (e.g. Chinese comments) shifts those offsets and cmd
REM starts executing comment fragments as commands. Delayed expansion stays OFF so "!" in .env
REM values and in pi arguments is passed through untouched (the npm pi.cmd shim inherits it).
setlocal EnableExtensions DisableDelayedExpansion

REM Remember the caller's code page BEFORE switching to UTF-8, restore it on exit.
set "PI_REMOTE_OLDCP="
for /f "tokens=2 delims=:" %%C in ('chcp') do set "PI_REMOTE_OLDCP=%%C"
if defined PI_REMOTE_OLDCP set "PI_REMOTE_OLDCP=%PI_REMOTE_OLDCP: =%"
if defined PI_REMOTE_OLDCP set "PI_REMOTE_OLDCP=%PI_REMOTE_OLDCP:.=%"
chcp 65001 >nul

REM attach injects PI_REMOTE_PI_ENV_FILE when it launches pi, so a pi started
REM via "attach --env <file>" reads that same file instead of the default one.
if defined PI_REMOTE_PI_ENV_FILE (set "PI_REMOTE_ENV=%PI_REMOTE_PI_ENV_FILE%") else (set "PI_REMOTE_ENV=%~dp0..\.env")
if not exist "%PI_REMOTE_ENV%" echo [warn] %PI_REMOTE_ENV% not found, run: node deploy\setup.cjs
if exist "%PI_REMOTE_ENV%" for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%PI_REMOTE_ENV%") do (
  set "_K=%%A"
  set "_V=%%B"
  call :setkv
)
set "_K="
set "_V="
set "_KEY="
set "_KREST="

setlocal EnableDelayedExpansion
if "!PI_REMOTE_RELAY!"=="" (
  echo [warn] PI_REMOTE_RELAY is empty: the extension will not connect to a relay, pi still works locally
) else (
  echo [pi-remote] relay=!PI_REMOTE_RELAY! label=!PI_REMOTE_LABEL!
)
endlocal

REM No -e here: the extension is installed in ~/.pi/agent/extensions/ and auto-loads.
REM Passing -e as well would load it twice (two connections kicking each other off the relay).
REM
REM Resolve pi in the same order as deploy/start-pi.sh: PI_REMOTE_PI_BIN (must be an
REM executable file) > PATH > npm global prefixes. Without this, a pinned path in .env is
REM ignored on Windows and a thin PATH (service / scheduled task) reports 9009.
set "PI_BIN="
if defined PI_REMOTE_PI_BIN call :resolve_pinned_pi
if not defined PI_BIN call :resolve_path_pi
if not defined PI_BIN goto :pi_missing

REM "call" is required: pi is the npm pi.cmd batch shim, and running a batch file without
REM "call" never returns here, so the code page would never be restored.
call "%PI_BIN%" %*
set "PI_EXIT=%ERRORLEVEL%"
if defined PI_REMOTE_OLDCP chcp %PI_REMOTE_OLDCP% >nul
endlocal & exit /b %PI_EXIT%

:pi_missing
echo [error] pi not found: install it (npm i -g) or set PI_REMOTE_PI_BIN in .env
if defined PI_REMOTE_OLDCP chcp %PI_REMOTE_OLDCP% >nul
endlocal & exit /b 127

REM PI_REMOTE_PI_BIN wins only when it names an existing, non-directory executable file.
:resolve_pinned_pi
if not exist "%PI_REMOTE_PI_BIN%" goto :resolve_pinned_bad
if exist "%PI_REMOTE_PI_BIN%\" goto :resolve_pinned_bad
set "PI_EXT="
for %%P in ("%PI_REMOTE_PI_BIN%") do set "PI_EXT=%%~xP"
if /i "%PI_EXT%"==".exe" goto :resolve_pinned_ok
if /i "%PI_EXT%"==".cmd" goto :resolve_pinned_ok
if /i "%PI_EXT%"==".bat" goto :resolve_pinned_ok
if /i "%PI_EXT%"==".com" goto :resolve_pinned_ok
:resolve_pinned_bad
echo [warn] PI_REMOTE_PI_BIN is not an executable file; falling back to PATH
goto :eof
:resolve_pinned_ok
set "PI_BIN=%PI_REMOTE_PI_BIN%"
goto :eof

REM PATH first, then the npm global prefixes (default on Windows: %APPDATA%\npm).
:resolve_path_pi
for /f "delims=" %%P in ('where pi.cmd 2^>nul') do if not defined PI_BIN set "PI_BIN=%%P"
if not defined PI_BIN for /f "delims=" %%P in ('where pi.exe 2^>nul') do if not defined PI_BIN set "PI_BIN=%%P"
if not defined PI_BIN for /f "delims=" %%P in ('where pi.bat 2^>nul') do if not defined PI_BIN set "PI_BIN=%%P"
if not defined PI_BIN for /f "delims=" %%P in ('where pi 2^>nul') do if not defined PI_BIN set "PI_BIN=%%P"
if not defined PI_BIN if exist "%APPDATA%\npm\pi.cmd" set "PI_BIN=%APPDATA%\npm\pi.cmd"
if not defined PI_BIN if exist "%LOCALAPPDATA%\npm\pi.cmd" set "PI_BIN=%LOCALAPPDATA%\npm\pi.cmd"
if not defined PI_BIN if exist "%ProgramFiles%\nodejs\pi.cmd" set "PI_BIN=%ProgramFiles%\nodejs\pi.cmd"
goto :eof

REM One .env line: _K = raw key, _V = raw value (delayed expansion is off, "!" is safe).
REM Double quotes are dropped before any if-comparison: a quote there is a syntax error that
REM aborts the whole script.
:setkv
if not defined _K goto :eof
set "_KEY="
set "_KREST="
for /f "tokens=1,*" %%k in ("%_K%") do (
  set "_KEY=%%k"
  set "_KREST=%%l"
)
if defined _KREST goto :eof
if not defined _KEY goto :eof
set "_KEY=%_KEY:"=%"
if not defined _KEY goto :eof
if "%_KEY:~0,1%"=="#" goto :eof
if not defined _V goto :eof
set "_V=%_V:"=%"
call :trimv
if not defined _V goto :eof
if not "%_V:~1%"=="" if "%_V:~0,1%"=="'" if "%_V:~-1%"=="'" (
  set "_V=%_V:~1,-1%"
  call :trimv
)
if not defined _V goto :eof
set "%_KEY%=%_V%"
goto :eof

REM Trim leading and trailing spaces of _V (it may end up undefined).
:trimv
if not defined _V goto :eof
if "%_V:~0,1%"==" " (
  set "_V=%_V:~1%"
  goto trimv
)
:trimv_end
if not defined _V goto :eof
if "%_V:~-1%"==" " (
  set "_V=%_V:~0,-1%"
  goto trimv_end
)
goto :eof
