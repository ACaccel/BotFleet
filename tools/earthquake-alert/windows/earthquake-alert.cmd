@echo off
rem Run by the EEW warning app when an alert meets its threshold. Forwards the
rem app's --name=value arguments to earthquake-alert.ps1 in this folder and
rem returns its exit code. Keep this file ASCII-only: cmd.exe reads it in the
rem console code page, while the folder path itself may contain any character.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0earthquake-alert.ps1" %*
exit /b %ERRORLEVEL%
