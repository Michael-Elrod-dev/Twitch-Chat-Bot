@echo off
NET SESSION >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    powershell -Command "Start-Process -Verb RunAs -FilePath '%0' -ArgumentList 'am_admin'"
    exit /b
)

if "%1"=="am_admin" (
    cd /d D:\Code\AlmostHadAI
    echo Killing node processes...
    taskkill /F /IM node.exe 2>NUL
    echo Stopping MySQL90...
    net stop MySQL90
    echo Done!
    cmd /k
)