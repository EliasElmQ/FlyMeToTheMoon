@echo off
setlocal
cd /d "%~dp0"

echo Starting local web server at http://localhost:8080 ...
echo Keep this window open while using the OpenSpace Piano web app.
echo.

start "" "http://localhost:8080/"

where py >nul 2>nul
if not errorlevel 1 (
    py -3 -m http.server 8080
    exit /b
)

python -m http.server 8080
