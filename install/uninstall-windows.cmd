@echo off
rem ==========================================================================
rem  Geekatplay 3D Layers - uninstaller for Windows
rem
rem  Double-click to remove the plugin from Photoshop. Your models, settings and
rem  API keys in %APPDATA%\Geekatplay\3D Layers are kept. To delete them too, run
rem  this from a command prompt with:  uninstall-windows.cmd -RemoveData
rem  Works on its own (fetches install-windows.ps1 from GitHub if it is not here).
rem ==========================================================================
title Geekatplay 3D Layers - uninstaller
setlocal
set "GEEKATPLAY_INSTALLER=cmd"
set "SCRIPT=%~dp0install-windows.ps1"
set "URL=https://raw.githubusercontent.com/GeekatplayStudio/Photoshop-3D/main/install/install-windows.ps1"

if exist "%SCRIPT%" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Uninstall %*
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; try { $s = Invoke-RestMethod -UseBasicParsing '%URL%' } catch { Write-Host ('Could not download the uninstaller: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }; & ([scriptblock]::Create($s)) -Uninstall %*"
)
set EXITCODE=%ERRORLEVEL%
echo.
pause
exit /b %EXITCODE%
