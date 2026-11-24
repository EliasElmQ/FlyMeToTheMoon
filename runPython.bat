@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if not errorlevel 1 (
    py -3 openspace_bridge.py
    exit /b
)

python openspace_bridge.py
