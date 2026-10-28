@echo off
REM pi-remote attach window (Windows wrapper). Node is probed explicitly so a missing
REM node gives one actionable error instead of cmd.exe's raw "not recognized" line.
setlocal EnableExtensions DisableDelayedExpansion
set "PI_REMOTE_NODE="
for %%N in (node.exe) do if not defined PI_REMOTE_NODE if exist "%%~$PATH:N" set "PI_REMOTE_NODE=%%~$PATH:N"
if not defined PI_REMOTE_NODE for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined PI_REMOTE_NODE set "PI_REMOTE_NODE=%%N"
if not defined PI_REMOTE_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "PI_REMOTE_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined PI_REMOTE_NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PI_REMOTE_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined PI_REMOTE_NODE if exist "%APPDATA%\npm\node.exe" set "PI_REMOTE_NODE=%APPDATA%\npm\node.exe"
if not defined PI_REMOTE_NODE if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "PI_REMOTE_NODE=%NVM_SYMLINK%\node.exe"
if not defined PI_REMOTE_NODE if defined NVM_HOME if exist "%NVM_HOME%\node.exe" set "PI_REMOTE_NODE=%NVM_HOME%\node.exe"
if not defined PI_REMOTE_NODE goto :pi_remote_no_node
"%PI_REMOTE_NODE%" "%~dp0attach.cjs" %*
exit /b %ERRORLEVEL%

:pi_remote_no_node
echo [error] Node.js not found: the pi-remote attach window needs Node.js 22.18 or newer.
echo [error] Install Node.js from https://nodejs.org/ (or fix PATH so node.exe is found),
echo [error] then close and reopen this terminal and run the command again.
exit /b 127
