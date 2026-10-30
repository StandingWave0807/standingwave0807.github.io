@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if not errorlevel 1 (
  py -3 server.py
  goto check
)
where python >nul 2>nul
if not errorlevel 1 (
  python server.py
  goto check
)

echo.
echo  No Python 3 found on PATH.
echo  Install it from https://www.python.org/downloads/ and tick
echo  "Add python.exe to PATH", then run this file again.
echo  (Python is what actually runs your answers. Reading the
echo   problems and the notes does not need any of this.)
echo.
pause
exit /b 1

:check
if not errorlevel 1 exit /b 0
echo.
echo  The judge stopped with an error. Read the text above,
echo  then press a key to close this window.
pause >nul
exit /b 1
