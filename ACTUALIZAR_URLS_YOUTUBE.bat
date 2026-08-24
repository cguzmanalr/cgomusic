@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title CGO Music - Actualizar URLs de YouTube
set "AUTO=%~1"

echo ================================================================
echo  CGO MUSIC - ACTUALIZADOR DE URLS DIRECTAS DE YOUTUBE
echo ================================================================
echo.

where py >nul 2>&1
if %errorlevel%==0 (
  set "PY=py"
  goto :python_ok
)

where python >nul 2>&1
if %errorlevel%==0 (
  set "PY=python"
  goto :python_ok
)

echo ERROR: Python no esta instalado o no esta en PATH.
echo Instala Python 3 y vuelve a ejecutar este archivo.
call :pause_if_needed
exit /b 2

:python_ok
echo [1/3] Actualizando yt-dlp...
%PY% -m pip install --disable-pip-version-check --quiet --upgrade yt-dlp
if errorlevel 1 (
  echo ERROR: no se pudo instalar o actualizar yt-dlp.
  call :pause_if_needed
  exit /b 2
)

echo [2/3] Resolviendo solo canciones que aun no tienen youtubeId...
%PY% tools\resolver_youtube.py
set "RC=%errorlevel%"

echo [3/3] Auditando catalogos...
%PY% tools\auditar_catalogos.py
set "AUDIT_RC=%errorlevel%"

echo.
if "%RC%"=="0" (
  echo LISTO: las 1.200 canciones tienen youtubeId + youtubeUrl guardados.
) else (
  echo Quedaron canciones pendientes. Ejecuta este mismo archivo otra vez;
  echo el resolvedor conserva lo completado y continua solo con las faltantes.
)
echo.
call :pause_if_needed
exit /b %RC%

:pause_if_needed
if /I not "%AUTO%"=="AUTO" pause
exit /b 0
