# DescargarVideoYoutube
🇪🇸 Descarga videos de youtube copiando y pegando este codigo javascript en la consola del navegador!
🇺🇸 Download YouTube videos by copying and pasting this JavaScript code into your browser's console!
🇵🇹 Descarrega vídeos do YouTube copiando e colando este código JavaScript na consola do navegador!
🇷🇺 Скачивайте видео с YouTube, скопировав и вставив этот код JavaScript в консоль браузера!
🇨🇳 將這段 JavaScript 程式碼複製並貼上至瀏覽器控制台，即可下載 YouTube 影片！

# youtube-download

Descarga, desde la consola del navegador, el video de YouTube que estás viendo: entero o el tramo exacto que elijas, en MP4, WebM/MKV o MP3, y con su transcripción si la tiene.

Es un solo archivo de JavaScript sin dependencias. Guarda lo mismo que el reproductor de YouTube recibe mientras reproduce, así que no descifra nada ni se salta ninguna protección.

## Qué hace

- **Completo o nada.** La captura solo termina cuando el video, o el tramo pedido, está grabado entero. Si falta algo (por ejemplo, lo que el reproductor cargó durante un anuncio), lo vuelve a pedir. Si YouTube no lo entrega, lo dice y no guarda un archivo a medias.
- **Rápido.** Tiene un turbo automático: lleva el cabezal hasta el final de lo que ya está guardado, nunca más allá, para que el reproductor pida segmentos sin pausa. Mide tres ritmos (turbo, turbo ligero a 2× y clásico a 16×) y se queda con el más rápido.
- **Varios formatos.**
  - MP4 compatible (H.264 + AAC) o de máxima calidad (VP9/AV1).
  - WebM/MKV tal cual lo entrega YouTube.
  - MP3 a 320 o 192 kbps, con un codificador propio.
  - Audio original sin pérdida.
- **Tramo exacto.** Los campos Desde y Hasta admiten `1:23`, `1:02:03` u `83` (segundos).
- **Transcripción** en SRT, VTT o texto, sola o junto a cada captura.
- **Cola de videos:** los videos de una lista o los enlaces que pegues se bajan uno tras otro.
- **Precaptura:** lo que reproduces con el panel abierto ya queda guardado, y «Capturar» solo pide lo que falte.
- **Cuidados:**
  - Pulsa «Saltar» en los anuncios que lo permiten y nunca guarda un anuncio.
  - Reanuda el video si aparece «¿Sigues viendo?».
  - Pausa unos segundos antes del final, así el autoplay de YouTube no cambia de video a mitad de la captura.
  - Pide confirmación si intentas cerrar o recargar la página con una captura en curso.
- **Panel flotante.** Se arrastra a cualquier parte, recuerda dónde lo dejaste y lo que escribes en él no activa los atajos de teclado de YouTube.

## Requisitos

- Un navegador de escritorio basado en Chromium (Chrome, Edge, Brave…). Solo está probado en Chromium.
- Para el MP3: WebCodecs (`AudioDecoder`), que traen las versiones actuales de Chrome y Edge.
- Para el MP4 compatible: que YouTube ofrezca H.264 para ese video, cosa que solo hace hasta 1080p.
- Memoria suficiente, porque el archivo se arma en la memoria de la pestaña (ver [Límites conocidos](#límites-conocidos)).

## Uso

1. Abre el video en youtube.com.
2. Abre la consola: <kbd>F12</kbd> o <kbd>Ctrl</kbd>+<kbd>Mayús</kbd>+<kbd>J</kbd> (en Mac, <kbd>Cmd</kbd>+<kbd>Opción</kbd>+<kbd>J</kbd>), pestaña «Consola».
3. Pega todo el contenido de `sifon.js` y pulsa <kbd>Enter</kbd>. La primera vez, Chrome puede bloquear el pegado y pedirte que escribas una frase de confirmación (en inglés, `allow pasting`). Escríbela, pulsa <kbd>Enter</kbd> y vuelve a pegar.
4. El panel aparece abajo a la derecha. Elige Calidad, Archivo y Formato. Deja Desde y Hasta vacíos para bajar el video entero.
5. Pulsa «Capturar». Cuando termina, el archivo se descarga solo.

Si vuelves a pegar el script, reemplaza al panel anterior. El botón ✕ lo cierra y deja la página como estaba: devuelve la velocidad y el sonido y retira todo lo que había instalado.

## El panel

| Control | Qué hace |
|---|---|
| **Calidad** | Resolución del video, entre las que ofrece YouTube. |
| **Archivo** | Video + audio, Solo audio o Solo video. En «Solo audio», el video va en la calidad mínima para no gastar red en imagen. |
| **Formato** | Contenedor y códecs del archivo (ver [Formatos](#formatos)). |
| **Desde / Hasta** | Tramo a capturar. «ahora» copia la posición actual del video. Vacíos = el video entero. |
| **Capturar / Recapturar** | Empieza la captura. |
| **Cancelar** | Descarta la captura en curso, sin guardar nada. Con la cola en marcha se llama «Detener cola». |
| **Descargar** | Vuelve a guardar la última captura completa con el archivo, el formato y el tramo elegidos, por ejemplo solo el audio. El tramo tiene que caer dentro de lo capturado. |
| **Transcripción** | Sección plegable: idioma, formato y descarga de la transcripción. |
| **Cola de videos** | Sección plegable: la lista de videos para bajar uno tras otro. |

Para mover el panel, arrástralo por la cabecera o usa las flechas del teclado con la cabecera enfocada: 16 px por pulsación, 80 px con <kbd>Mayús</kbd>. Doble clic en la cabecera o <kbd>Inicio</kbd> lo devuelven a la esquina. Si la ventana es baja, el panel se desplaza por dentro y la cabecera queda siempre visible.

## Formatos

| Archivo | Formato | Qué lleva | Dónde se abre |
|---|---|---|---|
| Video | **MP4 · compatible** | H.264 + AAC, hasta 1080p | En todas partes: iPhone, WhatsApp, Windows, editores |
| Video | **MP4 · máxima calidad** | VP9 o AV1, hasta 4K | PC, Android y VLC; no en iPhone ni QuickTime |
| Video | **WebM/MKV · original** | Tal cual lo entrega YouTube (`.webm`, o `.mkv` si los códecs no caben en WebM) | VLC, navegadores y editores con WebM |
| Audio | **MP3 · 320 kbps / 192 kbps** | Recodificado (YouTube no entrega MP3), con título y canal en etiquetas ID3 | Cualquier reproductor |
| Audio | **Original sin pérdida** | Sin recodificar: `.m4a` si YouTube da AAC; si no, WebM con Opus | La mayoría de reproductores |

- **MP4 compatible y calidad.** Con este formato, el reproductor elige H.264 + AAC al cargar el video, igual que hace la extensión h264ify. Si eliges más de 1080p, el panel cambia a «MP4 · máxima calidad», porque YouTube no da H.264 por encima. Si YouTube no entrega H.264 para un video, el MP4 sale con otros códecs y el panel lo avisa.
- **Metadatos.** El MP4 lleva el índice al principio, así se puede ver mientras se copia o se sube, y guarda el título y el canal.
- **Nombre del archivo.** Por ejemplo `Título.mp4`, `Título (audio).mp3`, `Título (sin audio).mp4` o, si es un tramo, `Título (0.32–1.12).mp4`.

### Tramo exacto

- **MP4 y MP3** cortan en el instante pedido. El MP4 usa una lista de edición desde el fotograma clave anterior, así se ve desde el instante exacto.
- **WebM/MKV** empieza en el fotograma clave anterior al instante pedido.

## Transcripción

En la sección «Transcripción»:

- **Idioma:** los subtítulos que ofrece el video, tanto los del autor como los automáticos. Si ninguno está en tu idioma, aparece también la traducción automática de YouTube. Por defecto elige tu idioma, o el que usaste la última vez.
- **Formato:**
  - SRT, para VLC y editores de video.
  - VTT, para la web.
  - Texto con tiempos, una línea por subtítulo como `[1:23] …`.
  - Texto corrido en párrafos.
- **Descargar transcripción** la baja al momento. El archivo se llama `Título.es.srt`, de modo que VLC y mpv la cargan solos si está junto al video.
- **«Bajarla también con cada captura (y en la cola)»** guarda la transcripción después de cada video.

Hoy YouTube devuelve vacíos muchos enlaces de subtítulos si no llevan un token que solo tiene su propio reproductor. Por eso prueba, en este orden:

1. **El enlace de la pista tal cual.** Sirve cuando YouTube no pide el token.
2. **El reproductor.** Activa un momento esos subtítulos, como si pulsaras «CC». El reproductor los descarga y lee lo que recibió; después deja los subtítulos como estaban.
3. **El panel «Mostrar transcripción».** Lo abre, lo lee y lo cierra. Solo sirve para el video de la página.

El mensaje final dice qué vía funcionó, por ejemplo «(vía el reproductor)».

Los subtítulos automáticos vienen en ventanas que se pisan. Los limpia para que cada palabra salga una sola vez y cada subtítulo dure hasta que empieza el siguiente.

Si sale «YouTube no entregó la transcripción», activa los subtítulos (CC) unos segundos y vuelve a pulsar. youtube-download aprovecha lo que el reproductor descarga.

## Cola de videos

**Añadir videos**

- **+ Este video:** el que estás viendo.
- **+ Lista:** la lista de reproducción que muestra la página, ya sea el panel de una lista o la página `/playlist`. YouTube solo pinta los videos que caben en pantalla (alrededor de un centenar), así que se añaden esos.
- **+ Enlaces…:** pega enlaces (`watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/`) o ids sueltos de 11 caracteres. Las palabras normales del texto se ignoran.

**Capturar la cola**

- Los baja uno tras otro y completos (no aplica Desde ni Hasta), con el archivo y el formato del panel. La calidad es la elegida o, si un video no la tiene, la más parecida sin pasarse.
- Abre cada video en el mismo reproductor, sin salir de la página, y va en silencio. Al terminar, el sonido vuelve a como estaba.
- Si un video falla (privado, eliminado, o con una parte que YouTube no vuelve a enviar), queda marcado con ✗ y el motivo en su fila, y la cola sigue con el siguiente.
- **Detener cola** descarta la captura en curso y deja ese video como pendiente.
- La cola, de hasta 500 videos, se guarda en el navegador: si recargas la página y vuelves a pegar el script, sigue ahí.

**A tener en cuenta**

- La primera vez, Chrome pregunta si el sitio puede descargar varios archivos. Acepta, o los siguientes no se guardarán.
- Deja abierta la pestaña de la cola. Mientras tanto puedes usar otras.
- Al terminar, el reproductor se queda en el último video aunque la página siga mostrando el original. Recargando la página vuelves a él.

## Precaptura

Con el panel abierto, lo que se reproduce queda guardado. «Capturar» solo pide lo que falte, y si el video ya se vio entero, lo guarda al instante.

- **Si pegas el script con el video ya empezado,** lo que el reproductor tenía cargado no se puede leer, porque su inicialización se entregó antes de que el script estuviera. La primera vez que llegan datos así, youtube-download recarga el video en el mismo punto, una sola vez, y desde ahí todo queda guardado.
- **Para que sirva,** tiene que estar en la calidad elegida. En MP4 compatible, además, tiene que estar en H.264 + AAC. El panel avisa si no es así.
- **Límite de memoria:** la precaptura se detiene al llegar a 1,5 GB.

## Cómo funciona

1. **Intercepción.** Parchea en sus prototipos `MediaSource.addSourceBuffer`/`endOfStream` y `SourceBuffer.appendBuffer`/`abort`/`changeType`. Siempre llama primero al método original, y un error propio nunca rompe el reproductor.
2. **Demultiplexado.** Lee fMP4 (ISOBMFF) y WebM (EBML) de forma incremental, con implementaciones propias, y los pasa a tablas de muestras por pista y calidad. Las pistas se distinguen por la huella de su configuración de códec.
3. **Cobertura.** Cada pista lleva un conjunto de intervalos con lo que de verdad se grabó. La captura solo termina cuando el tramo no tiene huecos. Cada hueco se pide de nuevo hasta 3 veces; si sigue faltando, se cancela sin guardar nada.
4. **Ritmo.** El turbo salta a fotogramas clave dentro de lo ya guardado y un gobernador elige el ritmo más rápido. A 8 s del final, el video se pausa y el reproductor descarga lo último en pausa.
5. **Exportación.**
   - **MP4 propio:** `moov` al principio, `stts`/`ctts`/`stss`/`stsc`/`stsz`/`stco`/`co64`, listas de edición y `vpcC`/`esds`/`dOps`.
   - **Matroska/WebM propio.**
   - **MP3:** se decodifica con WebCodecs y se recodifica con un codificador MPEG-1 Layer III CBR propio.
6. **Transcripción.** Escucha sin alterar nada las respuestas de subtítulos (parchea `XMLHttpRequest` y la lectura de `Response` en sus prototipos). Lee json3, srv3, srv1 y WebVTT, y escribe SRT, VTT y texto.

### Mapa del código

`sifon.js` está dividido en secciones numeradas:

| # | Sección | Contenido |
|---|---|---|
| 1 | Constantes | Ajustes de captura, turbo, precaptura y calidades |
| 2 | Utilidades binarias | Lectura y escritura de bytes, cola de bytes, huella FNV-1a |
| 3 | Modelo | Pistas, representaciones, tabla de muestras, cobertura |
| 4 | Demultiplexado | Interfaz común de los demuxers |
| 5 | ISOBMFF | Demuxer fMP4 |
| 6 | EBML | Demuxer WebM/Matroska |
| 7 | Captura | Intercepción de Media Source Extensions |
| 8 | Exportación | Selección de pistas y muxers MP4 y Matroska/WebM |
| 9 | MP3 | Codificador MPEG-1 Layer III |
| 10 | Reproductor | Adaptador de la API interna del reproductor de YouTube y filtro de códecs |
| 11 | Ritmo | Turbo, gobernador y medición de velocidad |
| 12 | Cola | Cola de videos persistente |
| 13 | Transcripción | Escucha, lectores, escritores y búsqueda de subtítulos |
| 14 | Interfaz | Panel en Shadow DOM, arrastrable, sin `innerHTML` |
| 15 | Utilidades | Guardado de archivos, nombres, tiempos |
| 16 | Orquestación | `App`: coordina captura, ritmo, cola, transcripción y panel |

## Límites conocidos

- **Velocidad.** Depende de la red y del reproductor de YouTube. No es una descarga instantánea: youtube-download solo guarda lo que el reproductor recibe.
- **DRM.** El contenido cifrado (algunas películas o eventos de pago) no se puede guardar; el panel lo detecta y lo dice.
- **Solo lo que puedas ver.** Los videos privados, eliminados o con restricciones que te impidan reproducirlos no funcionan.
- **Directos en curso:** no están probados.
- **Memoria.** Todo se arma en la memoria de la pestaña, así que un video muy largo en alta resolución puede ocupar varios GB.
- **APIs internas.** El reproductor de YouTube y su módulo de subtítulos son internos y pueden cambiar sin aviso.

## Privacidad y datos guardados

Todo ocurre en tu navegador y no se envía nada a servidores de terceros. Las únicas peticiones que youtube-download hace por su cuenta van a YouTube, por ejemplo el enlace de una pista de subtítulos.

Guarda tres datos en el `localStorage` de youtube.com:

| Clave | Contenido |
|---|---|
| `sifon:posicion-panel` | Dónde dejaste el panel |
| `sifon:cola` | La cola de videos |
| `sifon:transcripcion` | Idioma, formato y «también con cada captura» |

Para borrarlos, desde la consola:

```js
['sifon:posicion-panel', 'sifon:cola', 'sifon:transcripcion'].forEach((k) => localStorage.removeItem(k));
```

## Desarrollo

- Es JavaScript vanilla en un solo archivo, sin dependencias ni compilación, con `// @ts-check` y JSDoc.
- Comprobación de tipos en modo estricto (TypeScript solo como verificador):

  ```bash
  npx -p typescript tsc --noEmit --allowJs --checkJs --strict \
    --target es2022 --lib es2022,dom,dom.iterable --skipLibCheck sifon.js
  ```

- **Normas del código:**
  - Una responsabilidad por clase.
  - Nada de `innerHTML`, porque YouTube exige Trusted Types.
  - Los errores propios se capturan, para no afectar nunca al reproductor.
  - Al cerrar se restaura todo lo que se parcheó.
- Para depurar, la instancia en marcha queda en `window[Symbol.for('sifon.instance')]`.

## Uso responsable

youtube-download es para uso personal. Descarga solo videos que tengas derecho a guardar: tuyos, con una licencia que lo permita o con permiso de su autor. Respeta los Términos de servicio de YouTube y los derechos de autor; la transcripción también pertenece al autor del video. youtube-download no elude cifrados (DRM) ni otras protecciones.
