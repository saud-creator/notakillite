@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0release\Notakillite.exe" (
  echo Build Notakillite first with npm run build:exe.
  pause
  exit /b 1
)
start "" "%~dp0release\Notakillite.exe"
exit /b 0
