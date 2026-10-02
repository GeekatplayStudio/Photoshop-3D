@echo off
rem Geekatplay 3D Layers - one-click installer for Windows.
rem Double-click this file. It runs install-windows.ps1 (next to it), which downloads the
rem latest release from GitHub, verifies it and installs it with Adobe's plugin installer.
rem Read install-windows.ps1 to see every step; nothing else is executed.
title Geekatplay 3D Layers installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
set EXITCODE=%ERRORLEVEL%
echo.
pause
exit /b %EXITCODE%
