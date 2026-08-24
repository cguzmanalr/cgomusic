@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "PORT=8000"
set "PY="

where py >nul 2>&1
if %errorlevel%==0 set "PY=py"
if not defined PY (
  where python >nul 2>&1
  if %errorlevel%==0 set "PY=python"
)

if defined PY (
  %PY% tools\check_youtube_catalog.py >nul 2>&1
  if errorlevel 1 (
    echo ================================================================
    echo  CGO Music detecto canciones sin URL estatica de YouTube.
    echo ================================================================
    echo.
    choice /C SN /N /M "Quieres completar/reparar las URLs ahora? [S/N]: "
    if errorlevel 2 goto :start_python_server
    call ACTUALIZAR_URLS_YOUTUBE.bat AUTO
  )

:start_python_server
  echo Iniciando CGO Music en http://localhost:%PORT%/
  start "CGO Music Server" cmd /k "cd /d ""%~dp0"" && %PY% -m http.server %PORT%"
  timeout /t 1 /nobreak >nul
  start "" "http://localhost:%PORT%/"
  exit /b
)

echo Python no fue encontrado. La aplicacion puede abrirse con el servidor PowerShell,
echo pero ACTUALIZAR_URLS_YOUTUBE.bat requiere Python para completar URLs faltantes.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\server.ps1" -Port %PORT%
