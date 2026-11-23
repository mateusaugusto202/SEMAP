@echo off
rem ---------------------------------------------------------------
rem  SEMAP - inicia o servidor local (Windows)
rem  Dê dois cliques neste arquivo. Para encerrar, feche a janela.
rem ---------------------------------------------------------------
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale a versao LTS em https://nodejs.org e tente de novo.
  pause
  exit /b 1
)

rem Abre o navegador depois de 2 segundos, dando tempo ao servidor de subir
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"

node server.js
pause
