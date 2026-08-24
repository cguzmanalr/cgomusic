# CGO Music — catálogo 1.200 · reproducción YouTube estática

Versión consolidada del proyecto **CGO Music**.

## Qué contiene

La estructura incluye **12 listas de 100 canciones = 1.200 registros**:

- Inglés: 50s, 60s, 70s, 80s, 90s y 2000s.
- Español: 50s, 60s, 70s, 80s, 90s y 2000s.

La colección inglesa conserva la comprobación histórica Top 10/UK disponible en el proyecto. La colección en español se muestra como selección musical, sin presentar estados `Pendiente` en la interfaz.

## Cambio principal de esta versión

El reproductor **ya no busca videos mientras reproduce**.

La aplicación usa únicamente datos guardados en cada canción:

```json
"youtubeId": "XXXXXXXXXXX",
"youtubeUrl": "https://www.youtube.com/watch?v=XXXXXXXXXXX",
"youtubeAlternatives": ["YYYYYYYYYYY"]
```

`youtubeQuery` puede permanecer en los JSON, pero se usa solamente como pista de mantenimiento para el actualizador. `js/app.js` no consulta Invidious, no hace búsquedas de YouTube y no guarda resoluciones en `localStorage`.

Esto deja la aplicación publicada en GitHub Pages como un sitio estático: una vez generados y guardados los IDs, la reproducción utiliza directamente el YouTube IFrame Player.

## Primera preparación / completar URLs

Ejecuta:

```text
ACTUALIZAR_URLS_YOUTUBE.bat
```

El archivo:

1. instala o actualiza `yt-dlp`;
2. revisa los 12 JSON;
3. conserva todas las canciones que ya tienen un `youtubeId` válido;
4. busca solamente las que faltan;
5. elige preferentemente versiones oficiales / Topic / VEVO y penaliza karaoke, covers, reacciones, slowed/reverb y directos;
6. escribe físicamente `youtubeId` y `youtubeUrl` dentro de los JSON;
7. guarda hasta tres alternativas cuando están disponibles;
8. guarda el avance periódicamente, por lo que una segunda ejecución continúa sólo con lo pendiente.

El reporte de cada ejecución queda en:

```text
data/youtube_resolution_report.json
```

## Abrir CGO Music

Ejecuta:

```text
INICIAR_CGO_MUSIC.bat
```

Si detecta URLs pendientes y Python está disponible, ofrece ejecutar el actualizador antes de abrir la aplicación.

Después inicia un servidor local y abre:

```text
http://localhost:8000/
```

No se recomienda abrir `index.html` directamente con `file://`.

## Reparar una canción puntual

Si en el futuro un video es retirado, queda privado o bloquea la inserción, ejecuta:

```text
REPARAR_UNA_CANCION.bat
```

Escribe el ID interno de la canción, por ejemplo:

```text
en-80s-001
```

El script vuelve a resolver solamente ese registro y reemplaza su `youtubeId`, `youtubeUrl` y alternativas.

## Comportamiento del reproductor

- Reproducción en orden.
- Reproducción aleatoria.
- Siguiente y anterior.
- Pausa y Stop.
- Stop invalida cualquier avance programado y no vuelve a iniciar por sí solo.
- Repetición de lista opcional.
- Avance automático cuando termina una canción.
- Si un ID falla, prueba `youtubeAlternatives` y después salta a la siguiente canción.
- La barra de volumen permanece visible en escritorio, tablet y móvil y siempre se identifica como **Volumen**.
- El buscador funciona sobre el catálogo completo.

## Auditoría

Para revisar la integridad del proyecto:

```text
python tools/auditar_catalogos.py
```

Comprueba:

- 12 catálogos;
- exactamente 100 canciones por catálogo;
- 1.200 canciones totales;
- IDs internos sin duplicados;
- coherencia `youtubeId` ↔ `youtubeUrl`;
- cobertura de URLs estáticas por década;
- consistencia de los registros marcados como Top 10 verificados.

También puedes usar:

```text
python tools/check_youtube_catalog.py
```

Devuelve éxito únicamente cuando las 1.200 canciones tienen `youtubeId + youtubeUrl` estáticos.

## Publicación en GitHub Pages

Cuando `ACTUALIZAR_URLS_YOUTUBE.bat` termine, sube/commitea los JSON modificados junto con el resto del proyecto. GitHub Pages no necesita Python ni `yt-dlp`: esas herramientas son sólo para preparar o reparar el catálogo localmente.

## Estructura principal

```text
CGOMusic/
├── index.html
├── css/
│   └── styles.css
├── js/
│   └── app.js
├── data/
│   ├── catalogs.json
│   ├── ingles/
│   │   ├── 50s.json
│   │   ├── 60s.json
│   │   ├── 70s.json
│   │   ├── 80s.json
│   │   ├── 90s.json
│   │   └── 2000s.json
│   └── espanol/
│       ├── 50s.json
│       ├── 60s.json
│       ├── 70s.json
│       ├── 80s.json
│       ├── 90s.json
│       └── 2000s.json
├── tools/
│   ├── resolver_youtube.py
│   ├── auditar_catalogos.py
│   ├── check_youtube_catalog.py
│   └── server.ps1
├── ACTUALIZAR_URLS_YOUTUBE.bat
├── REPARAR_UNA_CANCION.bat
└── INICIAR_CGO_MUSIC.bat
```
