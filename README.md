# CGO Music — reproductor híbrido PWA

Esta versión mantiene el catálogo de **1.200 canciones** y añade un motor de reproducción híbrido pensado para iPhone y Android.

## Cómo elige el reproductor

Cada canción puede tener una fuente de audio directa:

```json
"audioUrl": "https://.../cancion.m4a"
```

Si `audioUrl` existe, CGO Music reproduce con el elemento HTML5 `<audio>`. Ese es el modo que puede continuar cuando el teléfono se bloquea y que se integra con Media Session.

Si `audioUrl` está vacío o no existe, la aplicación conserva el funcionamiento anterior y utiliza:

```json
"youtubeId": "XXXXXXXXXXX",
"youtubeUrl": "https://www.youtube.com/watch?v=XXXXXXXXXXX",
"youtubeAlternatives": []
```

En ese caso la canción se reproduce con YouTube IFrame. En iPhone, YouTube puede detenerse cuando la pantalla se bloquea.

## Comportamiento de respaldo

El orden es:

1. `audioUrl` directo.
2. Si el audio directo falla, `youtubeId`.
3. Si ese video falla, `youtubeAlternatives`.
4. Si ninguna fuente funciona, pasa automáticamente a la canción siguiente.

Nunca deben sonar al mismo tiempo `<audio>` y YouTube: al cambiar de motor, la aplicación detiene el otro reproductor.

## Pantalla bloqueada

Cuando se usa `audioUrl`, Media Session publica al sistema:

- título;
- artista;
- carátula cuando existe `artworkUrl`;
- play y pausa;
- anterior y siguiente;
- avance/retroceso y posición cuando el sistema los admite.

La prueba previa realizada con audio HTML5 confirmó que el iPhone puede mantener la reproducción después de bloquear la pantalla.

## Campos nuevos por canción

Puedes añadir estos campos sin eliminar los de YouTube:

```json
{
  "title": "Nombre de la canción",
  "artist": "Nombre del artista",
  "audioUrl": "https://tu-servidor.example/audio/cancion.m4a",
  "artworkUrl": "https://tu-servidor.example/caratulas/cancion.jpg",
  "youtubeId": "ID11CARACT",
  "youtubeUrl": "https://www.youtube.com/watch?v=ID11CARACT"
}
```

`artworkUrl` es opcional. Si no existe, CGO Music intenta utilizar la miniatura disponible de YouTube para la interfaz y Media Session.

## Recomendación para audio

Para máxima compatibilidad móvil, utiliza archivos servidos por **HTTPS** y preferentemente formatos ampliamente soportados como AAC/M4A o MP3. La aplicación no extrae audio de YouTube.

GitHub Pages puede alojar archivos de audio, pero una colección de 1.200 canciones puede superar rápidamente los límites prácticos de un repositorio. Para una biblioteca grande conviene utilizar almacenamiento/CDN autorizado y guardar sólo las URLs en los JSON.

## PWA

La versión incluye:

- `manifest.webmanifest`;
- `sw.js`;
- iconos para iOS/Android;
- instalación en pantalla de inicio;
- Media Session;
- Service Worker preparado para no interceptar/cachar peticiones Range de audio.

Los archivos de audio se solicitan directamente a la red para evitar problemas con streaming y peticiones parciales en Safari/Chrome móvil.

## Publicar en GitHub Pages

Para actualizar un repositorio existente basta con reemplazar:

```text
index.html
css/styles.css
js/app.js
manifest.webmanifest
sw.js
```

No es necesario reemplazar `data/` para instalar el motor híbrido.

Después de subirlos, espera el despliegue de GitHub Pages. Si el iPhone conserva una versión PWA antigua, abre la web en Safari una vez y vuelve a cargarla; el Service Worker nuevo usa el caché `cgo-music-pwa-v2-hybrid`.

## Estado actual de los catálogos

Los 1.200 registros existentes siguen intactos. Ninguno recibe un `audioUrl` inventado automáticamente. A medida que agregues fuentes de audio autorizadas, esas canciones comenzarán a usar el modo de segundo plano sin necesidad de modificar de nuevo `app.js`.
