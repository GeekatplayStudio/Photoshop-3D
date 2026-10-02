@echo off
rem Geekatplay 3D Layers - uninstaller for Windows.
rem Removes the plugin from Photoshop. Your models, settings and API keys in
rem %APPDATA%\Geekatplay\3D Layers are kept; delete that folder to remove them too,
rem or run: install-windows.ps1 -Uninstall -RemoveData
title Geekatplay 3D Layers uninstaller
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" -Uninstall %*
set EXITCODE=%ERRORLEVEL%
echo.
pause
exit /b %EXITCODE%
