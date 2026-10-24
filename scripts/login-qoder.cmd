@echo off
setlocal
cd /d "%~dp0.."
node "%~dp0..\data\runtime\qoder\node_modules\@qoder-ai\qodercli\bundle\qodercli.js" login
pause
