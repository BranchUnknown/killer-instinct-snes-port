@echo off
rem Starts the local web server for the port and opens it in your browser. Close the window to stop.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
