@echo off
setlocal
pushd "%~dp0" || exit /b 1

py -3 -c "import sys; sys.exit(sys.version_info < (3, 11))" >nul 2>&1
if not errorlevel 1 goto use_py

python -c "import sys; sys.exit(sys.version_info < (3, 11))" >nul 2>&1
if not errorlevel 1 goto use_python

echo LaWa needs Python 3.11 or newer. Install it from https://www.python.org/downloads/ and try again.
set "LAWA_EXIT=1"
goto finish

:use_py
py -3 scripts\bootstrap.py --open %*
set "LAWA_EXIT=%ERRORLEVEL%"
goto finish

:use_python
python scripts\bootstrap.py --open %*
set "LAWA_EXIT=%ERRORLEVEL%"

:finish
popd
if not "%LAWA_EXIT%"=="0" pause
exit /b %LAWA_EXIT%
