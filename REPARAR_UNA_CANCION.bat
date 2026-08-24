@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title CGO Music - Reparar una URL

echo Escribe el ID interno de la cancion que quieres volver a resolver.
echo Ejemplo: en-80s-001  o  es-90s-042
echo.
set /p "SONGID=ID: "
if "%SONGID%"=="" exit /b 1

where py >nul 2>&1
if %errorlevel%==0 (
  set "PY=py"
) else (
  where python >nul 2>&1
  if errorlevel 1 (
    echo ERROR: Python no esta instalado o no esta en PATH.
    pause
    exit /b 2
  )
  set "PY=python"
)

%PY% -m pip install --disable-pip-version-check --quiet --upgrade yt-dlp
if errorlevel 1 (
  echo ERROR: no se pudo instalar o actualizar yt-dlp.
  pause
  exit /b 2
)

%PY% tools\resolver_youtube.py --song-id "%SONGID%" --force
set "RC=%errorlevel%"
%PY% tools\auditar_catalogos.py

echo.
if "%RC%"=="0" (
  echo Cancion reparada y guardada en su JSON.
) else (
  echo No se pudo resolver esa cancion. Puedes reintentar mas tarde o editar su youtubeId/youtubeUrl manualmente.
)
pause
exit /b %RC%
