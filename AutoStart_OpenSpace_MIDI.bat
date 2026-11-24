@echo off
setlocal
cd /d "%~dp0"

rem Find SuperCollider's command-line interpreter.
set "SCLANG="
for /f "delims=" %%I in ('where sclang 2^>nul') do if not defined SCLANG set "SCLANG=%%I"
if not defined SCLANG (
    for /d %%D in ("%ProgramFiles%\SuperCollider-*") do (
        if exist "%%~fD\sclang.exe" set "SCLANG=%%~fD\sclang.exe"
    )
)
if not defined SCLANG (
    echo SuperCollider was not found. Install it, or add sclang.exe to PATH.
    pause
    exit /b 1
)
for %%I in ("%SCLANG%") do set "SCBIN=%%~dpI"
set "PATH=%SCBIN%;%PATH%"

rem Start the Python-to-OpenSpace bridge in its own visible console.
where py >nul 2>nul
if not errorlevel 1 (
    start "OpenSpace Piano Bridge" cmd /c "py -3 openspace_bridge.py"
) else (
    where python >nul 2>nul
    if errorlevel 1 (
        echo Python 3 was not found. Install Python, then run this file again.
        pause
        exit /b 1
    )
    start "OpenSpace Piano Bridge" cmd /c "python openspace_bridge.py"
)

rem Launch SuperCollider, evaluate the patch, and start FlyMeToTheMoon.score.
start "OpenSpace Piano" "%SCLANG%" "%~dp0piano_autorun.scd"

echo.
echo Starting FlyMeToTheMoon.score. Keep this project folder together.
timeout /t 4 /nobreak >nul
