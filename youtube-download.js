// @ts-check
/**
 * Sifón — descarga desde la consola el video de YouTube que estás viendo.
 *
 * Cómo funciona
 *   1. Intercepta lo que el propio reproductor entrega a Media Source Extensions
 *      (MediaSource.addSourceBuffer y SourceBuffer.appendBuffer/abort/changeType).
 *   2. Demultiplexa esos bytes —fMP4 y WebM, implementados desde cero— en tablas
 *      de muestras por pista y calidad.
 *   3. Elige la mejor pista de video y de audio y las remultiplexa, sin
 *      recodificar, en MP4 (ISOBMFF con el índice al principio) o WebM/MKV.
 *      «MP4 compatible» hace que el reproductor elija H.264 + AAC (como
 *      h264ify) para que el archivo se abra en cualquier dispositivo.
 *      «Solo audio» sale en MP3 (decodificado con WebCodecs y recodificado
 *      con un codificador MPEG-1 Layer III propio) o en el original sin
 *      pérdida (M4A/WebM).
 *   4. Completo o nada: cada pista lleva la cuenta exacta de los tramos que
 *      de verdad se grabaron. La captura solo termina cuando el video entero
 *      (o el tramo Desde/Hasta) está grabado; si falta algo —p. ej. lo que el
 *      reproductor cargó durante un anuncio— lo vuelve a pedir, y si YouTube
 *      no lo entrega lo dice sin guardar nada. Cancelar descarta lo grabado.
 *   5. Tramo exacto: MP4 y MP3 cortan en el instante pedido (MP4 con una
 *      lista de edición desde el fotograma clave anterior); WebM/MKV empieza
 *      en ese fotograma clave.
 *   6. Turbo automático: en vez de esperar a que la reproducción avance (Chrome
 *      no pasa de 16×), lleva el cabezal al final de lo YA GUARDADO —nunca
 *      salta sobre nada sin guardar—, así el reproductor pide segmentos sin
 *      pausa y la captura la limita la red. Los saltos caen en fotogramas
 *      clave y un gobernador mide turbo, turbo ligero (2×) y clásico (16×) y
 *      se queda con el más rápido. Unos segundos antes del final el video se
 *      pausa: el reproductor descarga lo último en pausa, así el video nunca
 *      termina y el autoplay de YouTube no salta al siguiente.
 *   7. Precaptura: con el script pegado, lo que se reproduce queda guardado y
 *      «Capturar» solo pide lo que falte (si ya está completo, descarga al
 *      instante). Si se pega con el video ya empezado, lo que el reproductor
 *      tenía cargado no se puede leer (su inicialización se entregó antes):
 *      la primera vez que llega algo así, el video se recarga en el mismo
 *      punto y desde ahí todo queda guardado.
 *   8. Cola de videos: este video, la lista de reproducción de la página o
 *      enlaces pegados; se capturan uno tras otro, completos, con la calidad,
 *      el archivo y el formato elegidos, abriendo cada uno en el reproductor.
 *      La cola se recuerda entre recargas y un fallo no la detiene.
 *   9. Transcripción: los subtítulos que YouTube ofrece (del autor, automáticos
 *      o su traducción automática) en SRT, VTT o texto, sueltos o con cada
 *      captura. Se toman del enlace de la pista; si llega vacío (hoy muchas
 *      piden un token que solo tiene el reproductor), se activan un momento
 *      esos subtítulos en el reproductor, que los descarga como al pulsar
 *      «CC», y se lee su respuesta; si no, del panel «Mostrar transcripción».
 *   Además: pulsa «Saltar» en los anuncios que lo permiten, usa la calidad de
 *   video mínima en «Solo audio», reanuda pausas («¿Sigues viendo?»), vuelve
 *   al video si el autoplay de YouTube salta al siguiente antes de terminar,
 *   empuja al reproductor si se atasca y sigue avanzando con los eventos del
 *   <video> aunque el navegador frene los temporizadores. Con una captura o un
 *   guardado en curso, recargar o cerrar la página pide confirmación. El panel
 *   se arrastra a cualquier parte de la pantalla y recuerda dónde lo dejaste.
 *
 * No descifra nada: si el contenido viene cifrado (DRM) lo detecta y lo dice.
 * Uso: abre el video, pega este archivo en la consola (F12) y pulsa «Capturar».
 */
(() => {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Constantes
  // ═══════════════════════════════════════════════════════════════════════

  const APP_NAME = 'Sifón';
  const INSTANCE_KEY = Symbol.for('sifon.instance');
  /** Velocidad de reproducción durante la captura (el máximo que admite Chrome). */
  const CAPTURE_RATE = 16;
  /** Periodo del bucle de supervisión (ms). */
  const TICK_MS = 500;
  /** Si tras este tiempo capturando no llegó ni un byte, se avisa (ms). */
  const NO_DATA_WARNING_MS = 8000;

  /** Turbo: periodo con el que se revisa el cabezal (ms). */
  const PACE_MS = 100;
  /** Turbo: se salta cuando hay al menos esto cargado por delante del cabezal (s)… */
  const LEAP_TRIGGER_S = 4;
  /** …y el cabezal queda a esta distancia del final de lo cargado (s). */
  const LEAP_KEEP_S = 1;
  /** Ventana con la que se mide la velocidad (la del panel) y se juzga, una vez por captura, si el turbo rinde (ms). */
  const TURBO_PROBE_MS = 8000;
  /** Si en esa ventana el turbo no supera esta velocidad (×), se prueba el modo clásico. */
  const TURBO_MIN_SPEED = 12;
  /** Un modo sustituye al mejor medido solo si lo supera en este factor (evita vaivenes por ruido). */
  const MODE_SWITCH_MARGIN = 1.15;
  /** Turbo: un salto a fotograma clave debe adelantar el cabezal al menos esto (s). */
  const KEY_MIN_ADVANCE_S = 1;
  /** Velocidad de reproducción del turbo «ligero», para cuando decodificar a 16× es el freno. */
  const LIGHT_DECODE_RATE = 2;
  /** Proporción de fotogramas descartados a partir de la cual el decodificador no da abasto. */
  const DROPPED_FRAMES_LIMIT = 0.3;
  /**
   * Al capturar hasta el final, el video se detiene esto antes de terminar (s): si llegara al final,
   * YouTube pasaría al siguiente video (autoplay) y podría recargar la página. Lo que falta lo
   * descarga el reproductor estando en pausa; a 16× el cabezal avanza ~4 s entre eventos, así que
   * el margen debe superarlo.
   */
  const END_HOLD_S = 8;
  /** Si en pausa no llega el final en este tiempo, se avanza a 1× para que el reproductor lo pida (ms). */
  const HOLD_PATIENCE_MS = 3000;
  /** Separación mínima entre intentos de reanudar un video pausado (ms). */
  const RESUME_GAP_MS = 2000;
  /** Si lo grabado no crece durante este tiempo se empuja al reproductor; el doble, se vuelve a pedir lo que falta (ms). */
  const STALL_NUDGE_MS = 6000;
  /** Tope de memoria de la precaptura pasiva (bytes). */
  const PREARM_LIMIT_BYTES = 1.5 * 2 ** 30;
  /**
   * Bytes seguidos sin inicialización a partir de los cuales un SourceBuffer se
   * da por «ciego» (una inicialización de YouTube ocupa unos pocos KB).
   */
  const BLIND_SINK_BYTES = 64 * 1024;
  /** Si quedan menos de estos segundos de video, no merece la pena recargarlo para precapturar (s). */
  const RESYNC_MIN_LEFT_S = 15;
  /** Periodo con el que el panel informa de la precaptura cuando no se captura (ms). */
  const IDLE_REFRESH_MS = 2000;
  /** Eventos del <video> que avisan de datos nuevos o de avance; siguen llegando aunque el navegador frene los temporizadores. */
  const MEDIA_EVENTS = ['timeupdate', 'progress', 'waiting', 'seeked', 'ended'];
  /** Botón «Saltar» que YouTube muestra en los anuncios que se pueden saltar. */
  const SKIP_AD_SELECTOR = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern';

  /** Bits de SampleTable.flags. Los bits 1-2 conservan el «lacing» del bloque original. */
  const F_KEY = 0x01;
  const F_LACING = 0x06;
  const F_INVISIBLE = 0x08;
  const F_DISCARDABLE = 0x10;

  /** IDs EBML/Matroska (incluyen sus bits marcadores). */
  const EB = Object.freeze({
    EBML: 0x1a45dfa3, EBML_VERSION: 0x4286, EBML_READ_VERSION: 0x42f7, EBML_MAX_ID_LENGTH: 0x42f2,
    EBML_MAX_SIZE_LENGTH: 0x42f3, DOC_TYPE: 0x4282, DOC_TYPE_VERSION: 0x4287, DOC_TYPE_READ_VERSION: 0x4285,
    SEGMENT: 0x18538067, SEEK_HEAD: 0x114d9b74, SEEK: 0x4dbb, SEEK_ID: 0x53ab, SEEK_POSITION: 0x53ac,
    INFO: 0x1549a966, TIMECODE_SCALE: 0x2ad7b1, DURATION: 0x4489, TITLE: 0x7ba9,
    MUXING_APP: 0x4d80, WRITING_APP: 0x5741,
    TRACKS: 0x1654ae6b, TRACK_ENTRY: 0xae, TRACK_NUMBER: 0xd7, TRACK_UID: 0x73c5, TRACK_TYPE: 0x83,
    FLAG_LACING: 0x9c, LANGUAGE: 0x22b59c, CODEC_ID: 0x86, CODEC_PRIVATE: 0x63a2, CODEC_DELAY: 0x56aa,
    SEEK_PRE_ROLL: 0x56bb, VIDEO: 0xe0, PIXEL_WIDTH: 0xb0, PIXEL_HEIGHT: 0xba, COLOUR: 0x55b0,
    AUDIO: 0xe1, SAMPLING_FREQUENCY: 0xb5, CHANNELS: 0x9f, BIT_DEPTH: 0x6264,
    CONTENT_ENCODINGS: 0x6d80, CONTENT_ENCRYPTION: 0x5035,
    CLUSTER: 0x1f43b675, TIMECODE: 0xe7, SIMPLE_BLOCK: 0xa3, BLOCK_GROUP: 0xa0, BLOCK: 0xa1,
    BLOCK_DURATION: 0x9b, REFERENCE_BLOCK: 0xfb,
    CUES: 0x1c53bb6b, CUE_POINT: 0xbb, CUE_TIME: 0xb3, CUE_TRACK_POSITIONS: 0xb7, CUE_TRACK: 0xf7,
    CUE_CLUSTER_POSITION: 0xf1,
  });

  /** Códecs admitidos por el perfil WebM: si todas las pistas lo son, se escribe .webm. */
  const WEBM_CODECS = new Set(['V_VP8', 'V_VP9', 'V_AV1', 'A_OPUS', 'A_VORBIS']);

  /** CodecID de Matroska → nombre legible. */
  const CODEC_NAMES = /** @type {Readonly<Record<string, string>>} */ ({
    V_VP8: 'VP8', V_VP9: 'VP9', V_AV1: 'AV1', 'V_MPEG4/ISO/AVC': 'H.264', 'V_MPEGH/ISO/HEVC': 'H.265',
    A_OPUS: 'Opus', A_VORBIS: 'Vorbis', A_AAC: 'AAC', 'A_MPEG/L3': 'MP3', A_AC3: 'AC-3', A_EAC3: 'E-AC-3',
  });

  /** fourcc de ISOBMFF → CodecID de Matroska. */
  const MP4_CODECS = /** @type {Readonly<Record<string, string>>} */ ({
    avc1: 'V_MPEG4/ISO/AVC', avc3: 'V_MPEG4/ISO/AVC', hvc1: 'V_MPEGH/ISO/HEVC', hev1: 'V_MPEGH/ISO/HEVC',
    av01: 'V_AV1', vp09: 'V_VP9', vp08: 'V_VP8', mp4a: 'A_AAC', Opus: 'A_OPUS', 'ac-3': 'A_AC3', 'ec-3': 'A_EAC3',
  });

  /** Caja de configuración ISOBMFF cuyo contenido es, tal cual, el CodecPrivate de Matroska. */
  const MP4_CONFIG_BOX = /** @type {Readonly<Record<string, string>>} */ ({
    avc1: 'avcC', avc3: 'avcC', hvc1: 'hvcC', hev1: 'hvcC', av01: 'av1C',
  });

  /** Cajas de nivel superior que se procesan; el resto se salta sin acumularlo. */
  const MP4_WANTED = new Set(['moov', 'moof', 'mdat']);
  /** Cajas con las que puede empezar un segmento MSE (para resincronizar). */
  const MP4_SEGMENT_STARTS = new Set(['ftyp', 'styp', 'moov', 'moof', 'sidx', 'emsg', 'prft']);
  const MAX_MP4_BOX = 2 ** 30;
  const MAX_EBML_SKIP = 2 ** 28;

  /** Altura en píxeles de cada clave de calidad de YouTube. */
  const QUALITY_HEIGHTS = /** @type {Readonly<Record<string, number>>} */ ({
    tiny: 144, small: 240, medium: 360, large: 480, hd720: 720, hd1080: 1080,
    hd1440: 1440, hd2160: 2160, hd2880: 2880, highres: 4320,
  });
  /** YouTube ofrece H.264 hasta esta altura; por encima solo VP9/AV1. */
  const H264_MAX_HEIGHT = 1080;

  /** Claves de calidad de YouTube → etiqueta, por si la API no trae la suya. */
  const QUALITY_LABELS = /** @type {Readonly<Record<string, string>>} */ ({
    tiny: '144p', small: '240p', medium: '360p', large: '480p', hd720: '720p', hd1080: '1080p',
    hd1440: '1440p', hd2160: '2160p (4K)', hd2880: '2880p (5K)', highres: '4320p (8K)',
  });

  /** Identificador de un video de YouTube: 11 caracteres de [A-Za-z0-9_-]. */
  const VIDEO_ID_PATTERN = /^[\w-]{11}$/;

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Utilidades binarias
  // ═══════════════════════════════════════════════════════════════════════

  const utf8Encoder = new TextEncoder();
  const utf8Decoder = new TextDecoder();

  /** @param {Uint8Array} b @param {number} o */
  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  /** @param {Uint8Array} b @param {number} o */
  const i16 = (b, o) => ((b[o] << 24) >> 16) | b[o + 1];
  /** @param {Uint8Array} b @param {number} o */
  const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  /** @param {Uint8Array} b @param {number} o */
  const u32 = (b, o) => b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  /** @param {Uint8Array} b @param {number} o */
  const i32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  /** @param {Uint8Array} b @param {number} o */
  const u64 = (b, o) => u32(b, o) * 0x100000000 + u32(b, o + 4);
  /** @param {Uint8Array} b @param {number} o */
  const i64 = (b, o) => i32(b, o) * 0x100000000 + u32(b, o + 4);
  /** @param {Uint8Array} b @param {number} o */
  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  /** ¿Son imprimibles los 4 bytes de un tipo de caja? @param {Uint8Array} b @param {number} o */
  function isPrintable4(b, o) {
    for (let k = 0; k < 4; k++) {
      const c = b[o + k];
      if (c < 0x20 || c > 0x7e) return false;
    }
    return true;
  }

  /** @param {readonly Uint8Array[]} parts */
  function concatBytes(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  /** Hash FNV-1a de 32 bits: huella barata de una configuración de códec. @param {Uint8Array} bytes */
  function fnv1a(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
    return (h >>> 0).toString(36);
  }

  /**
   * Copia lo que recibe appendBuffer: el reproductor es dueño de su búfer.
   * @param {unknown} data
   * @returns {Uint8Array | null}
   */
  function copyBufferSource(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    return null;
  }

  /**
   * Cola de bytes tipo «rope»: guarda los fragmentos tal como llegan y solo
   * copia cuando lo pedido cruza la frontera entre dos de ellos.
   */
  class ByteQueue {
    constructor() {
      /** @type {Uint8Array[]} */
      this.chunks = [];
      /** Índice del primer fragmento vivo. */
      this.first = 0;
      /** Bytes ya consumidos del primer fragmento vivo. */
      this.offset = 0;
      /** Bytes pendientes. */
      this.length = 0;
      /** Posición absoluta, dentro del flujo, del primer byte pendiente. */
      this.position = 0;
    }

    /** @param {Uint8Array} bytes */
    push(bytes) {
      if (bytes.length === 0) return;
      this.chunks.push(bytes);
      this.length += bytes.length;
    }

    /**
     * Devuelve `n` bytes desde `at` sin consumirlos (vista si caben en un
     * fragmento, copia si no). Requiere at + n <= length.
     * @param {number} at @param {number} n
     */
    peek(at, n) {
      if (n === 0) return new Uint8Array(0);
      let i = this.first;
      let off = this.offset + at;
      while (off >= this.chunks[i].length) off -= this.chunks[i++].length;
      const head = this.chunks[i];
      if (off + n <= head.length) return head.subarray(off, off + n);
      const out = new Uint8Array(n);
      for (let written = 0; written < n; i++, off = 0) {
        const chunk = this.chunks[i];
        const take = Math.min(n - written, chunk.length - off);
        out.set(chunk.subarray(off, off + take), written);
        written += take;
      }
      return out;
    }

    /** Consume `n` bytes y los devuelve contiguos. @param {number} n */
    take(n) {
      const out = this.peek(0, n);
      this.skip(n);
      return out;
    }

    /** Descarta `n` bytes (n <= length). @param {number} n */
    skip(n) {
      if (n <= 0) return;
      this.length -= n;
      this.position += n;
      let off = this.offset + n;
      while (this.first < this.chunks.length && off >= this.chunks[this.first].length) {
        off -= this.chunks[this.first++].length;
      }
      this.offset = off;
      if (this.first === this.chunks.length) {
        this.chunks.length = 0;
        this.first = 0;
        this.offset = 0;
      } else if (this.first >= 32) {
        this.chunks.splice(0, this.first);
        this.first = 0;
      }
    }

    /** Descarta hasta `n` bytes. @param {number} n @returns {number} bytes descartados */
    skipUpTo(n) {
      const k = Math.min(n, this.length);
      this.skip(k);
      return k;
    }

    clear() {
      this.position += this.length;
      this.chunks.length = 0;
      this.first = 0;
      this.offset = 0;
      this.length = 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Modelo: pistas, representaciones y tabla de muestras
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Descripción de una pista, ya traducida a términos de Matroska.
   * @typedef {Object} TrackInfo
   * @property {'video'|'audio'} kind
   * @property {string} codecId             CodecID de Matroska (p. ej. «V_VP9»)
   * @property {string} codecName           nombre legible (p. ej. «VP9»)
   * @property {Uint8Array|null} codecPrivate
   * @property {number} width
   * @property {number} height
   * @property {number} sampleRate
   * @property {number} channels
   * @property {number} bitDepth
   * @property {number} codecDelayNs
   * @property {number} seekPreRollNs
   * @property {number} msPerTick           conversión de la base de tiempo de origen a ms
   * @property {Uint8Array|null} colour     elemento Colour de origen (WebM), copiado tal cual
   * @property {Uint8Array|null} contentEncodings  elemento ContentEncodings de origen, copiado tal cual
   * @property {Uint8Array|null} vpcc  configuración vpcC de VP9 si la fuente es MP4 (para escribir MP4)
   * @property {boolean} encrypted
   * @property {string} unsupported         motivo si no se puede remultiplexar; '' si se puede
   */

  /** @param {'video'|'audio'} kind @returns {TrackInfo} */
  function blankTrackInfo(kind) {
    return {
      kind, codecId: '', codecName: '', codecPrivate: null, width: 0, height: 0, sampleRate: 0,
      channels: 0, bitDepth: 0, codecDelayNs: 0, seekPreRollNs: 0, msPerTick: 1, colour: null,
      contentEncodings: null, vpcc: null, encrypted: false, unsupported: '',
    };
  }

  /** @template {Float64Array | Uint8Array} T @param {T} src @param {number} capacity @returns {T} */
  function resized(src, capacity) {
    const out = new (/** @type {any} */ (src.constructor))(capacity);
    out.set(src);
    return out;
  }

  /**
   * Tabla de muestras en formato «struct of arrays»: tiempos y banderas en
   * arreglos tipados que crecen por duplicación; los datos, como vistas
   * (sin copiar) sobre los fragmentos capturados.
   */
  class SampleTable {
    constructor() {
      this.length = 0;
      this.bytes = 0;
      this.dts = new Float64Array(1024);
      this.pts = new Float64Array(1024);
      this.dur = new Float64Array(1024);
      this.flags = new Uint8Array(1024);
      /** @type {Uint8Array[]} */
      this.data = [];
    }

    /**
     * @param {number} dts @param {number} pts @param {number} dur ticks de la pista de origen
     * @param {number} flags bits F_* @param {Uint8Array} data
     */
    push(dts, pts, dur, flags, data) {
      if (this.length === this.flags.length) this.#grow();
      const i = this.length++;
      this.dts[i] = dts;
      this.pts[i] = pts;
      this.dur[i] = dur;
      this.flags[i] = flags;
      this.data.push(data);
      this.bytes += data.length;
    }

    /**
     * Índices en orden de decodificación y sin duplicados (mismo dts = misma
     * muestra recibida dos veces). Si ya llegaron en orden, es O(n).
     * @returns {Uint32Array}
     */
    ordered() {
      const n = this.length;
      const dts = this.dts;
      const idx = new Uint32Array(n);
      let sorted = true;
      for (let i = 0; i < n; i++) {
        idx[i] = i;
        if (i > 0 && dts[i] < dts[i - 1]) sorted = false;
      }
      if (!sorted) idx.sort((a, b) => dts[a] - dts[b] || a - b);
      let w = 0;
      for (let r = 0; r < n; r++) {
        const i = idx[r];
        if (w > 0 && dts[i] === dts[idx[w - 1]]) continue;
        idx[w++] = i;
      }
      return idx.subarray(0, w);
    }

    #grow() {
      const capacity = this.flags.length * 2;
      this.dts = resized(this.dts, capacity);
      this.pts = resized(this.pts, capacity);
      this.dur = resized(this.dur, capacity);
      this.flags = resized(this.flags, capacity);
    }
  }

  /** Huecos menores que esto (s) son redondeo de marcas de tiempo, no faltantes. */
  const COVERAGE_TOLERANCE_S = 0.002;
  /** Entre segmentos consecutivos se admite esta separación extra sobre el paso típico (s). */
  const SEGMENT_JOIN_S = 0.1;
  /** Dentro de un segmento, una muestra nunca dura más que esto (s; cota de cordura). */
  const MAX_SAMPLE_SPAN_S = 10;
  /** Holgura al inicio de un tramo: el primer fotograma puede llegar algo después (B-frames). */
  const RANGE_START_SLACK_S = 0.3;
  /** Holgura al final: la duración que informa YouTube se redondea. */
  const RANGE_END_SLACK_S = 0.6;

  /**
   * Intervalos [inicio, fin] (s) fusionados: lo que de verdad se ha capturado
   * de una pista. Es la fuente de verdad para saber si una descarga está
   * completa. Las muestras llegan casi siempre en orden, así que el caso
   * común (alargar el último intervalo) es O(1); el resto, búsqueda binaria.
   */
  class IntervalSet {
    constructor() {
      /** @type {number[]} */
      this.starts = [];
      /** @type {number[]} */
      this.ends = [];
      /** Segundos cubiertos en total. */
      this.total = 0;
    }

    /** @param {number} a @param {number} b */
    add(a, b) {
      const tol = COVERAGE_TOLERANCE_S;
      const { starts, ends } = this;
      const n = starts.length;
      if (n && a >= starts[n - 1] - tol && a <= ends[n - 1] + tol && a >= (n > 1 ? ends[n - 2] + tol : -Infinity)) {
        if (b > ends[n - 1]) {
          this.total += b - ends[n - 1];
          ends[n - 1] = b;
        }
        if (a < starts[n - 1]) {
          this.total += starts[n - 1] - a;
          starts[n - 1] = a;
        }
        return;
      }
      // Primer intervalo que puede tocar [a, b] y último que lo toca.
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ends[mid] + tol < a) lo = mid + 1;
        else hi = mid;
      }
      let j = lo;
      while (j < n && starts[j] - tol <= b) j++;
      if (j === lo) {
        starts.splice(lo, 0, a);
        ends.splice(lo, 0, b);
        this.total += b - a;
        return;
      }
      const s = Math.min(a, starts[lo]);
      const e = Math.max(b, ends[j - 1]);
      for (let k = lo; k < j; k++) this.total -= ends[k] - starts[k];
      starts.splice(lo, j - lo, s);
      ends.splice(lo, j - lo, e);
      this.total += e - s;
    }

    /** Fin del tramo continuo que contiene t; NaN si t no está cubierto. @param {number} t */
    endAt(t) {
      const tol = COVERAGE_TOLERANCE_S;
      let lo = 0;
      let hi = this.starts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.ends[mid] + tol < t) lo = mid + 1;
        else hi = mid;
      }
      return lo < this.starts.length && this.starts[lo] - tol <= t ? this.ends[lo] : NaN;
    }

    /** Huecos dentro de [a, b]. @param {number} a @param {number} b @returns {Array<[number, number]>} */
    gaps(a, b) {
      /** @type {Array<[number, number]>} */
      const out = [];
      let at = a;
      for (let k = 0; k < this.starts.length && at < b; k++) {
        if (this.ends[k] < at) continue;
        if (this.starts[k] > at + COVERAGE_TOLERANCE_S) out.push([at, Math.min(b, this.starts[k])]);
        at = Math.max(at, this.ends[k]);
      }
      if (at < b - COVERAGE_TOLERANCE_S) out.push([at, b]);
      return out;
    }

    /** Segundos cubiertos dentro de [a, b]. @param {number} a @param {number} b */
    coveredIn(a, b) {
      let sum = 0;
      for (let k = 0; k < this.starts.length; k++) sum += Math.max(0, Math.min(b, this.ends[k]) - Math.max(a, this.starts[k]));
      return sum;
    }

    /** Fin del último intervalo (0 si no hay nada). */
    get last() {
      return this.ends.length ? this.ends[this.ends.length - 1] : 0;
    }
  }

  /** Una pista concreta (códec + resolución + configuración) con sus muestras. */
  class Representation {
    /** @param {string} key @param {TrackInfo} info */
    constructor(key, info) {
      this.key = key;
      this.info = info;
      this.samples = new SampleTable();
      /** Tramos capturados en segundos (tiempo de presentación). */
      this.coverage = new IntervalSet();
    }

    /** «VP9 1920×1080» o «Opus 48 kHz 2 ch». */
    get label() {
      const i = this.info;
      return i.kind === 'video'
        ? `${i.codecName} ${i.width}×${i.height}`
        : `${i.codecName} ${Math.round(i.sampleRate / 100) / 10} kHz ${i.channels} ch`;
    }

    /** Métrica de calidad para desempatar entre representaciones. */
    get quality() {
      const i = this.info;
      return i.kind === 'video' ? i.width * i.height : i.sampleRate * i.channels;
    }
  }

  /**
   * Registro de representaciones por huella. Dos inicializaciones idénticas
   * (p. ej. el reproductor recrea el MediaSource tras un anuncio) comparten
   * representación, así sus muestras se unen en una sola línea temporal.
   */
  class TrackRegistry {
    constructor() {
      /** @type {Map<string, Representation>} */
      this.map = new Map();
    }

    /** @param {TrackInfo} info */
    resolve(info) {
      const key = [
        info.kind, info.codecId, info.width, info.height, info.sampleRate, info.channels, info.msPerTick,
        info.codecPrivate ? fnv1a(info.codecPrivate) : '-', info.encrypted ? 'enc' : '',
      ].join('|');
      let rep = this.map.get(key);
      if (!rep) {
        rep = new Representation(key, info);
        this.map.set(key, rep);
      }
      return rep;
    }

    /** @param {'video'|'audio'} kind @returns {Representation[]} */
    list(kind) {
      return [...this.map.values()].filter((r) => r.info.kind === kind && r.samples.length > 0);
    }

    /** @returns {Representation[]} */
    withData() {
      return [...this.map.values()].filter((r) => r.samples.length > 0);
    }

    get hasData() {
      for (const r of this.map.values()) if (r.samples.length > 0) return true;
      return false;
    }

    /** Bytes de muestras guardados. */
    get bytes() {
      let n = 0;
      for (const r of this.map.values()) n += r.samples.bytes;
      return n;
    }

    /**
     * Mueve lo capturado a un registro nuevo y deja este vacío, sin romper las
     * rutas de los SourceBuffer vivos (siguen apuntando a estas representaciones).
     * @returns {TrackRegistry}
     */
    detach() {
      const out = new TrackRegistry();
      for (const [key, rep] of this.map) {
        if (rep.samples.length === 0) continue;
        const copy = new Representation(key, rep.info);
        copy.samples = rep.samples;
        copy.coverage = rep.coverage;
        out.map.set(key, copy);
      }
      this.resetSamples();
      return out;
    }

    /** Vacía las muestras sin romper las rutas de los SourceBuffer vivos. */
    resetSamples() {
      for (const r of this.map.values()) {
        r.samples = new SampleTable();
        r.coverage = new IntervalSet();
      }
    }

    clear() {
      this.map.clear();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Demultiplexado: interfaz común
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * @typedef {Object} DemuxTrack
   * @property {number} id        número de pista dentro del flujo
   * @property {TrackInfo} info
   */

  /**
   * Destino de un demuxer. Los tiempos van en ticks de la pista de origen.
   * @typedef {Object} DemuxSink
   * @property {(tracks: DemuxTrack[]) => void} onInit
   * @property {(trackId: number, dts: number, pts: number, dur: number, flags: number, data: Uint8Array) => void} onSample
   */

  /**
   * Base de los demuxers incrementales: los bytes llegan en trozos arbitrarios
   * (el reproductor agrega mientras descarga), así que se acumulan en una
   * ByteQueue, se salta sin copiar lo que no interesa y, si algo no cuadra,
   * se espera al próximo inicio de segmento verosímil.
   */
  class IncrementalDemuxer {
    /** @param {DemuxSink} sink */
    constructor(sink) {
      this.sink = sink;
      this.queue = new ByteQueue();
      /** En modo pasivo solo se leen inicializaciones; los medios se saltan. */
      this.passive = false;
      /** Al nacer no se confía en el primer byte: puede llegar a mitad de flujo. */
      this.synced = false;
      this.skipLeft = 0;
      /** Número del segmento (Cluster o moof) en curso: las muestras de un mismo segmento son contiguas. */
      this.segment = 0;
    }

    /** @param {Uint8Array} bytes */
    push(bytes) {
      if (!this.synced) {
        if (!this.isSegmentStart(bytes)) return;
        this.synced = true;
      }
      this.queue.push(bytes);
      this.drain();
    }

    /** Equivale a SourceBuffer.abort(): lo que quedó a medias se descarta. */
    reset() {
      this.queue.clear();
      this.skipLeft = 0;
      this.synced = false;
      this.segment++;
      this.onReset();
    }

    /** Datos incoherentes: se descarta todo hasta un inicio de segmento. */
    desync() {
      this.reset();
    }

    /** Consume el salto pendiente. @returns {boolean} true si ya no queda nada por saltar */
    skipPending() {
      this.skipLeft -= this.queue.skipUpTo(this.skipLeft);
      return this.skipLeft === 0;
    }

    /** @param {Uint8Array} _bytes @returns {boolean} */
    isSegmentStart(_bytes) {
      return true;
    }

    drain() {}

    onReset() {}
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 5. ISOBMFF (fMP4)
  // ═══════════════════════════════════════════════════════════════════════

  /** @typedef {{type: string, start: number, body: number, end: number}} BoxRef */

  /**
   * Cajas contenidas en [from, to).
   * @param {Uint8Array} b @param {number} from @param {number} to
   * @returns {BoxRef[]}
   */
  function mp4Children(b, from, to) {
    /** @type {BoxRef[]} */
    const out = [];
    let o = from;
    while (o + 8 <= to) {
      let size = u32(b, o);
      let hs = 8;
      if (size === 1) {
        if (o + 16 > to) break;
        size = u64(b, o + 8);
        hs = 16;
      } else if (size === 0) {
        size = to - o;
      }
      if (size < hs || o + size > to) break;
      out.push({ type: fourcc(b, o + 4), start: o, body: o + hs, end: o + size });
      o += size;
    }
    return out;
  }

  /** @param {BoxRef[]} list @param {string} type */
  const firstBox = (list, type) => list.find((x) => x.type === type);

  /** ¿Empieza `b` como un segmento MSE de ISOBMFF? @param {Uint8Array} b */
  function looksLikeMp4(b) {
    if (b.length < 8) return false;
    const size = u32(b, 0);
    return (size === 1 || size >= 8) && MP4_SEGMENT_STARTS.has(fourcc(b, 4));
  }

  /**
   * Extrae objectTypeIndication y DecoderSpecificInfo de una caja esds.
   * @param {Uint8Array} b @param {number} from @param {number} to
   * @returns {{oti: number, dsi: Uint8Array | null} | null}
   */
  function parseEsds(b, from, to) {
    let p = from + 4; // versión y flags
    /** Lee etiqueta y longitud de un descriptor y deja `p` en su contenido. @returns {[number, number]} */
    const descriptor = () => {
      const tag = b[p++];
      let len = 0;
      for (let k = 0; k < 4 && p < to; k++) {
        const x = b[p++];
        len = (len << 7) | (x & 0x7f);
        if (!(x & 0x80)) break;
      }
      return [tag, len];
    };
    if (p >= to || descriptor()[0] !== 0x03) return null; // ES_Descriptor
    const flags = b[p + 2];
    p += 3;
    if (flags & 0x80) p += 2;
    if (flags & 0x40) p += 1 + b[p];
    if (flags & 0x20) p += 2;
    const [tag, len] = descriptor();
    if (tag !== 0x04) return null; // DecoderConfigDescriptor
    const end = Math.min(p + len, to);
    const oti = b[p];
    p += 13;
    let dsi = null;
    if (p < end) {
      const [innerTag, innerLen] = descriptor();
      if (innerTag === 0x05) dsi = b.slice(p, Math.min(p + innerLen, to));
    }
    return { oti, dsi };
  }

  /**
   * dOps (ISOBMFF, big-endian) → OpusHead, el CodecPrivate que espera
   * Matroska (little-endian y con firma).
   * @param {Uint8Array} b @param {number} from @param {number} to
   */
  function opusHeadFromDops(b, from, to) {
    const channels = b[from + 1];
    const preSkip = u16(b, from + 2);
    const rate = u32(b, from + 4);
    const gain = u16(b, from + 8);
    const family = b[from + 10];
    const mapping = family !== 0 ? b.subarray(from + 11, to) : new Uint8Array(0);
    const head = new Uint8Array(19 + mapping.length);
    const view = new DataView(head.buffer);
    head.set(utf8Encoder.encode('OpusHead'), 0);
    head[8] = 1;
    head[9] = channels;
    view.setUint16(10, preSkip, true);
    view.setUint32(12, rate, true);
    view.setUint16(16, gain, true);
    head[18] = family;
    head.set(mapping, 19);
    return { bytes: head, preSkip };
  }

  /**
   * Desplazamiento que impone la lista de edición, en ticks de la pista:
   * media_time del primer tramo útil menos la duración de los tramos vacíos.
   * @param {Uint8Array} b @param {BoxRef} edts @param {number} timescale @param {number} movieScale
   */
  function mp4EditShift(b, edts, timescale, movieScale) {
    const elst = firstBox(mp4Children(b, edts.body, edts.end), 'elst');
    if (!elst) return 0;
    const version = b[elst.body];
    const count = u32(b, elst.body + 4);
    let p = elst.body + 8;
    let empty = 0;
    for (let k = 0; k < count && p < elst.end; k++) {
      const segmentDuration = version === 1 ? u64(b, p) : u32(b, p);
      const mediaTime = version === 1 ? i64(b, p + 8) : i32(b, p + 4);
      p += version === 1 ? 20 : 12;
      if (mediaTime === -1) {
        empty += segmentDuration;
        continue;
      }
      return mediaTime - Math.round((empty * timescale) / movieScale);
    }
    return 0;
  }

  /**
   * Primera entrada de stsd → TrackInfo.
   * @param {Uint8Array} b @param {BoxRef} entry @param {'video'|'audio'} kind
   * @returns {TrackInfo}
   */
  function parseMp4SampleEntry(b, entry, kind) {
    const info = blankTrackInfo(kind);
    const p = entry.body;
    let childrenAt;
    if (kind === 'video') {
      info.width = u16(b, p + 24);
      info.height = u16(b, p + 26);
      childrenAt = p + 78;
    } else {
      const version = u16(b, p + 8); // QuickTime v1/v2 añaden campos
      info.channels = u16(b, p + 16);
      info.bitDepth = u16(b, p + 18);
      info.sampleRate = u32(b, p + 24) / 65536;
      childrenAt = p + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
    }
    const kids = childrenAt < entry.end ? mp4Children(b, childrenAt, entry.end) : [];
    let type = entry.type;
    const sinf = firstBox(kids, 'sinf');
    if (type === 'encv' || type === 'enca' || sinf) {
      info.encrypted = true;
      const frma = sinf && firstBox(mp4Children(b, sinf.body, sinf.end), 'frma');
      if (frma) type = fourcc(b, frma.body);
    }
    info.codecId = MP4_CODECS[type] ?? type;
    info.codecName = CODEC_NAMES[info.codecId] ?? type;
    if (!MP4_CODECS[type]) {
      info.unsupported = `el códec «${type}»`;
      return info;
    }
    if (type === 'vp09') {
      const vpcc = firstBox(kids, 'vpcC');
      if (vpcc) info.vpcc = b.slice(vpcc.body + 4, vpcc.end);
    }
    const configType = MP4_CONFIG_BOX[type];
    if (configType) {
      const box = firstBox(kids, configType);
      if (box) info.codecPrivate = b.slice(box.body, box.end);
      else info.unsupported = `${info.codecName} sin ${configType}`;
    } else if (type === 'mp4a') {
      const esds = firstBox(kids, 'esds');
      const es = esds ? parseEsds(b, esds.body, esds.end) : null;
      if (es && (es.oti === 0x6b || es.oti === 0x69)) {
        info.codecId = 'A_MPEG/L3';
        info.codecName = 'MP3';
      } else if (es && es.dsi) {
        info.codecPrivate = es.dsi;
      } else {
        info.unsupported = 'AAC sin configuración';
      }
    } else if (type === 'Opus') {
      const dops = firstBox(kids, 'dOps');
      if (dops) {
        const head = opusHeadFromDops(b, dops.body, dops.end);
        info.codecPrivate = head.bytes;
        info.codecDelayNs = Math.round((head.preSkip * 1e9) / 48000);
        info.seekPreRollNs = 80_000_000;
        info.sampleRate = 48000;
      } else {
        info.unsupported = 'Opus sin dOps';
      }
    }
    return info;
  }

  /**
   * Una caja trak del segmento de inicialización.
   * @param {Uint8Array} b @param {BoxRef} trak @param {number} movieScale
   * @returns {{id: number, info: TrackInfo, shift: number} | null}
   */
  function parseMp4Trak(b, trak, movieScale) {
    const kids = mp4Children(b, trak.body, trak.end);
    const tkhd = firstBox(kids, 'tkhd');
    const mdia = firstBox(kids, 'mdia');
    if (!tkhd || !mdia) return null;
    const id = u32(b, tkhd.body + (b[tkhd.body] === 1 ? 20 : 12));
    const mdiaKids = mp4Children(b, mdia.body, mdia.end);
    const mdhd = firstBox(mdiaKids, 'mdhd');
    const hdlr = firstBox(mdiaKids, 'hdlr');
    const minf = firstBox(mdiaKids, 'minf');
    if (!mdhd || !hdlr || !minf) return null;
    const handler = fourcc(b, hdlr.body + 8);
    const kind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : null;
    if (!kind) return null;
    const timescale = u32(b, mdhd.body + (b[mdhd.body] === 1 ? 20 : 12)) || 1;
    const stbl = firstBox(mp4Children(b, minf.body, minf.end), 'stbl');
    const stsd = stbl && firstBox(mp4Children(b, stbl.body, stbl.end), 'stsd');
    const entry = stsd && mp4Children(b, stsd.body + 8, stsd.end)[0];
    if (!entry) return null;
    const info = parseMp4SampleEntry(b, entry, kind);
    info.msPerTick = 1000 / timescale;
    const edts = firstBox(kids, 'edts');
    return { id, info, shift: edts ? mp4EditShift(b, edts, timescale, movieScale) : 0 };
  }

  /**
   * @typedef {Object} Mp4Track
   * @property {number} id
   * @property {'video'|'audio'} kind
   * @property {number} shift      ticks a restar (lista de edición)
   * @property {number} defDur     valores por defecto de trex
   * @property {number} defSize
   * @property {number} defFlags
   * @property {number} nextDts    para fragmentos sin tfdt
   */

  /** Demuxer de fMP4 (init = ftyp+moov; medios = moof+mdat). */
  class Mp4Demuxer extends IncrementalDemuxer {
    /** @param {DemuxSink} sink */
    constructor(sink) {
      super(sink);
      /** @type {{bytes: Uint8Array, pos: number} | null} */
      this.pendingMoof = null;
      /** @type {Map<number, Mp4Track>} */
      this.tracks = new Map();
      this.lostSamples = 0;
    }

    /** @param {Uint8Array} bytes */
    isSegmentStart(bytes) {
      return looksLikeMp4(bytes);
    }

    onReset() {
      this.pendingMoof = null;
    }

    drain() {
      const q = this.queue;
      while (this.skipPending() && q.length >= 8) {
        const head = q.peek(0, 8);
        if (!isPrintable4(head, 4)) return this.desync();
        const type = fourcc(head, 4);
        let size = u32(head, 0);
        let hs = 8;
        if (size === 1) {
          if (q.length < 16) return;
          size = u64(q.peek(8, 8), 0);
          hs = 16;
        }
        if (size < hs || size > MAX_MP4_BOX) return this.desync(); // size 0 («hasta el final») no existe en MSE
        const media = type === 'moof' || type === 'mdat';
        if (!MP4_WANTED.has(type) || (media && this.passive)) {
          if (media) this.pendingMoof = null;
          this.skipLeft = size;
          continue;
        }
        if (q.length < size) return;
        const pos = q.position;
        this.#onBox(type, q.take(size), pos, hs);
      }
    }

    /** @param {string} type @param {Uint8Array} box @param {number} pos @param {number} hs */
    #onBox(type, box, pos, hs) {
      if (type === 'moov') {
        this.pendingMoof = null;
        this.#parseMoov(box, hs);
      } else if (type === 'moof') {
        this.pendingMoof = { bytes: box, pos };
        this.segment++;
      } else if (this.pendingMoof) {
        this.#parseFragment(this.pendingMoof, box, pos, hs);
        this.pendingMoof = null;
      }
    }

    /** @param {Uint8Array} b @param {number} hs */
    #parseMoov(b, hs) {
      const top = mp4Children(b, hs, b.length);
      const mvhd = firstBox(top, 'mvhd');
      const movieScale = (mvhd && u32(b, mvhd.body + (b[mvhd.body] === 1 ? 20 : 12))) || 1000;
      /** @type {Map<number, [number, number, number]>} track_ID → [duración, tamaño, flags] */
      const trex = new Map();
      const mvex = firstBox(top, 'mvex');
      if (mvex) {
        for (const t of mp4Children(b, mvex.body, mvex.end)) {
          if (t.type === 'trex') trex.set(u32(b, t.body + 4), [u32(b, t.body + 12), u32(b, t.body + 16), u32(b, t.body + 20)]);
        }
      }
      this.tracks.clear();
      /** @type {DemuxTrack[]} */
      const out = [];
      for (const box of top) {
        if (box.type !== 'trak') continue;
        const trak = parseMp4Trak(b, box, movieScale);
        if (!trak) continue;
        const [defDur, defSize, defFlags] = trex.get(trak.id) ?? [0, 0, 0];
        this.tracks.set(trak.id, { id: trak.id, kind: trak.info.kind, shift: trak.shift, defDur, defSize, defFlags, nextDts: 0 });
        out.push({ id: trak.id, info: trak.info });
      }
      this.sink.onInit(out);
    }

    /**
     * Recorre moof + mdat y entrega cada muestra. Las posiciones de datos
     * son relativas al inicio del moof (MSE no admite bases absolutas).
     * @param {{bytes: Uint8Array, pos: number}} moof
     * @param {Uint8Array} mdat @param {number} mdatPos @param {number} mdatHs
     */
    #parseFragment(moof, mdat, mdatPos, mdatHs) {
      const b = moof.bytes;
      let previousEnd = moof.pos;
      let firstTraf = true;
      for (const traf of mp4Children(b, u32(b, 0) === 1 ? 16 : 8, b.length)) {
        if (traf.type !== 'traf') continue;
        const kids = mp4Children(b, traf.body, traf.end);
        const tfhd = firstBox(kids, 'tfhd');
        if (!tfhd) continue;
        const isFirst = firstTraf;
        firstTraf = false;
        const tf = u24(b, tfhd.body + 1);
        const track = this.tracks.get(u32(b, tfhd.body + 4));
        if (!track || tf & 0x000001) continue; // pista desconocida o base absoluta
        let defDur = track.defDur;
        let defSize = track.defSize;
        let defFlags = track.defFlags;
        let q = tfhd.body + 8;
        if (tf & 0x000002) q += 4;
        if (tf & 0x000008) { defDur = u32(b, q); q += 4; }
        if (tf & 0x000010) { defSize = u32(b, q); q += 4; }
        if (tf & 0x000020) defFlags = u32(b, q);
        const tfdt = firstBox(kids, 'tfdt');
        let dts = tfdt ? (b[tfdt.body] === 1 ? u64(b, tfdt.body + 4) : u32(b, tfdt.body + 4)) : track.nextDts;
        const base = (tf & 0x020000) !== 0 || isFirst ? moof.pos : previousEnd;
        let dataPos = base;
        for (const trun of kids) {
          if (trun.type !== 'trun') continue;
          const version = b[trun.body];
          const rf = u24(b, trun.body + 1);
          let r = trun.body + 8;
          if (rf & 0x001) { dataPos = base + i32(b, r); r += 4; }
          let firstFlags = -1;
          if (rf & 0x004) { firstFlags = u32(b, r); r += 4; }
          const fields = ((rf >> 8) & 1) + ((rf >> 9) & 1) + ((rf >> 10) & 1) + ((rf >> 11) & 1);
          const declared = u32(b, trun.body + 4);
          const count = fields ? Math.min(declared, Math.floor((trun.end - r) / (4 * fields))) : declared;
          for (let s = 0; s < count; s++) {
            let dur = defDur;
            let size = defSize;
            let sampleFlags = s === 0 && firstFlags >= 0 ? firstFlags : defFlags;
            let cto = 0;
            if (rf & 0x100) { dur = u32(b, r); r += 4; }
            if (rf & 0x200) { size = u32(b, r); r += 4; }
            if (rf & 0x400) { sampleFlags = u32(b, r); r += 4; }
            if (rf & 0x800) { cto = version === 0 ? u32(b, r) : i32(b, r); r += 4; }
            const rel = dataPos - mdatPos;
            if (rel >= mdatHs && rel + size <= mdat.length) {
              const key = track.kind === 'audio' || ((sampleFlags >>> 16) & 1) === 0;
              const t = dts - track.shift;
              this.sink.onSample(track.id, t, t + cto, dur, key ? F_KEY : 0, mdat.subarray(rel, rel + size));
            } else {
              this.lostSamples++;
            }
            dataPos += size;
            dts += dur;
          }
        }
        track.nextDts = dts;
        previousEnd = dataPos;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 6. EBML (WebM / Matroska)
  // ═══════════════════════════════════════════════════════════════════════

  /** @typedef {{id: number, size: number, len: number}} EbmlHeader  size = -1 si es desconocido; len = bytes de ID + tamaño */
  /** @typedef {{id: number, start: number, body: number, end: number}} EbmlRef */

  /** Longitud de un «vint» por los ceros iniciales de su primer byte (0 = inválido). @param {number} first */
  function vintLength(first) {
    for (let len = 1; len <= 8; len++) if (first & (0x80 >> (len - 1))) return len;
    return 0;
  }

  /**
   * Cabecera de un elemento EBML.
   * @param {Uint8Array} b @param {number} o @param {number} end
   * @returns {EbmlHeader | null | false} null = faltan bytes; false = no es EBML
   */
  function readEbmlHeader(b, o, end) {
    if (o >= end) return null;
    const idLen = vintLength(b[o]);
    if (idLen === 0 || idLen > 4) return false;
    if (o + idLen >= end) return null;
    let id = 0;
    for (let k = 0; k < idLen; k++) id = id * 256 + b[o + k];
    const s = o + idLen;
    const sizeLen = vintLength(b[s]);
    if (sizeLen === 0) return false;
    if (s + sizeLen > end) return null;
    const mask = 0xff >> sizeLen;
    let size = b[s] & mask;
    let allOnes = size === mask;
    for (let k = 1; k < sizeLen; k++) {
      const x = b[s + k];
      size = size * 256 + x;
      if (x !== 0xff) allOnes = false;
    }
    return { id, size: allOnes ? -1 : size, len: idLen + sizeLen };
  }

  /**
   * Elementos contenidos en [from, to) (de tamaño conocido).
   * @param {Uint8Array} b @param {number} from @param {number} to
   * @returns {EbmlRef[]}
   */
  function ebmlChildren(b, from, to) {
    /** @type {EbmlRef[]} */
    const out = [];
    let o = from;
    while (o < to) {
      const h = readEbmlHeader(b, o, to);
      if (!h || h.size < 0 || o + h.len + h.size > to) break;
      out.push({ id: h.id, start: o, body: o + h.len, end: o + h.len + h.size });
      o += h.len + h.size;
    }
    return out;
  }

  /** @param {Uint8Array} b @param {number} from @param {number} to */
  function readUint(b, from, to) {
    let v = 0;
    for (let i = from; i < to; i++) v = v * 256 + b[i];
    return v;
  }

  /** @param {Uint8Array} b @param {EbmlRef} e */
  const ebmlUint = (b, e) => readUint(b, e.body, e.end);

  /** @param {Uint8Array} b @param {EbmlRef} e */
  function ebmlFloat(b, e) {
    const len = e.end - e.body;
    const view = new DataView(b.buffer, b.byteOffset + e.body, len);
    return len === 4 ? view.getFloat32(0) : len === 8 ? view.getFloat64(0) : 0;
  }

  /** @param {Uint8Array} b @param {EbmlRef} e */
  const ebmlString = (b, e) => utf8Decoder.decode(b.subarray(e.body, e.end)).replace(/\0+$/, '');

  /** ¿Empieza `b` como un segmento MSE de WebM (cabecera EBML o Cluster)? @param {Uint8Array} b */
  function looksLikeWebm(b) {
    if (b.length < 4) return false;
    const id = u32(b, 0);
    return id === EB.EBML || id === EB.CLUSTER;
  }

  /**
   * Un TrackEntry → DemuxTrack (los campos de Matroska se copian tal cual).
   * @param {Uint8Array} b @param {EbmlRef} entry @param {number} timecodeScale
   * @returns {DemuxTrack | null}
   */
  function parseWebmTrackEntry(b, entry, timecodeScale) {
    let number = 0;
    let type = 0;
    const info = blankTrackInfo('video');
    for (const f of ebmlChildren(b, entry.body, entry.end)) {
      switch (f.id) {
        case EB.TRACK_NUMBER: number = ebmlUint(b, f); break;
        case EB.TRACK_TYPE: type = ebmlUint(b, f); break;
        case EB.CODEC_ID: info.codecId = ebmlString(b, f); break;
        case EB.CODEC_PRIVATE: info.codecPrivate = b.slice(f.body, f.end); break;
        case EB.CODEC_DELAY: info.codecDelayNs = ebmlUint(b, f); break;
        case EB.SEEK_PRE_ROLL: info.seekPreRollNs = ebmlUint(b, f); break;
        case EB.VIDEO:
          for (const v of ebmlChildren(b, f.body, f.end)) {
            if (v.id === EB.PIXEL_WIDTH) info.width = ebmlUint(b, v);
            else if (v.id === EB.PIXEL_HEIGHT) info.height = ebmlUint(b, v);
            else if (v.id === EB.COLOUR) info.colour = b.slice(v.start, v.end);
          }
          break;
        case EB.AUDIO:
          for (const a of ebmlChildren(b, f.body, f.end)) {
            if (a.id === EB.SAMPLING_FREQUENCY) info.sampleRate = ebmlFloat(b, a);
            else if (a.id === EB.CHANNELS) info.channels = ebmlUint(b, a);
            else if (a.id === EB.BIT_DEPTH) info.bitDepth = ebmlUint(b, a);
          }
          break;
        case EB.CONTENT_ENCODINGS:
          info.contentEncodings = b.slice(f.start, f.end);
          info.encrypted = ebmlChildren(b, f.body, f.end).some((enc) =>
            ebmlChildren(b, enc.body, enc.end).some((x) => x.id === EB.CONTENT_ENCRYPTION));
          break;
        default:
          break;
      }
    }
    if (type !== 1 && type !== 2) return null;
    info.kind = type === 1 ? 'video' : 'audio';
    if (info.kind === 'audio') {
      info.sampleRate ||= 8000; // valores por defecto de Matroska
      info.channels ||= 1;
    }
    info.codecName = CODEC_NAMES[info.codecId] ?? info.codecId;
    info.msPerTick = timecodeScale / 1e6;
    return { id: number, info };
  }

  /**
   * Demuxer de WebM. Segment y Cluster se «abren» sin esperar a que lleguen
   * completos (pueden medir cientos de MB o tener tamaño desconocido), así
   * que sus hijos se leen al mismo nivel a medida que llegan.
   */
  class WebmDemuxer extends IncrementalDemuxer {
    /** @param {DemuxSink} sink */
    constructor(sink) {
      super(sink);
      this.timecodeScale = 1e6;
      this.clusterTime = NaN;
      /** @type {Map<number, 'video'|'audio'>} */
      this.tracks = new Map();
    }

    /** @param {Uint8Array} bytes */
    isSegmentStart(bytes) {
      return looksLikeWebm(bytes);
    }

    onReset() {
      this.clusterTime = NaN;
    }

    drain() {
      const q = this.queue;
      while (this.skipPending() && q.length > 0) {
        const n = Math.min(12, q.length);
        const h = readEbmlHeader(q.peek(0, n), 0, n);
        if (h === null) return;
        if (h === false) return this.desync();
        if (h.id === EB.SEGMENT || h.id === EB.CLUSTER) {
          q.skip(h.len);
          if (h.id === EB.CLUSTER) {
            this.clusterTime = NaN;
            this.segment++;
          }
          continue;
        }
        if (h.size < 0 || h.size > MAX_EBML_SKIP) return this.desync();
        if (!this.#wants(h.id)) {
          q.skip(h.len);
          this.skipLeft = h.size;
          continue;
        }
        if (q.length < h.len + h.size) return;
        q.skip(h.len);
        this.#onElement(h.id, q.take(h.size));
      }
    }

    /** @param {number} id */
    #wants(id) {
      switch (id) {
        case EB.EBML: case EB.INFO: case EB.TRACKS: case EB.TIMECODE:
          return true;
        case EB.SIMPLE_BLOCK: case EB.BLOCK_GROUP:
          return !this.passive;
        default:
          return false;
      }
    }

    /** @param {number} id @param {Uint8Array} body */
    #onElement(id, body) {
      switch (id) {
        case EB.EBML:
          this.timecodeScale = 1e6;
          this.clusterTime = NaN;
          break;
        case EB.INFO:
          for (const e of ebmlChildren(body, 0, body.length)) {
            if (e.id === EB.TIMECODE_SCALE) this.timecodeScale = ebmlUint(body, e) || 1e6;
          }
          break;
        case EB.TRACKS:
          this.#parseTracks(body);
          break;
        case EB.TIMECODE:
          this.clusterTime = readUint(body, 0, body.length);
          break;
        case EB.SIMPLE_BLOCK:
          this.#block(body, null, 0);
          break;
        case EB.BLOCK_GROUP:
          this.#blockGroup(body);
          break;
        default:
          break;
      }
    }

    /** @param {Uint8Array} body */
    #parseTracks(body) {
      this.tracks.clear();
      /** @type {DemuxTrack[]} */
      const out = [];
      for (const entry of ebmlChildren(body, 0, body.length)) {
        if (entry.id !== EB.TRACK_ENTRY) continue;
        const track = parseWebmTrackEntry(body, entry, this.timecodeScale);
        if (!track) continue;
        this.tracks.set(track.id, track.info.kind);
        out.push(track);
      }
      this.sink.onInit(out);
    }

    /** @param {Uint8Array} body */
    #blockGroup(body) {
      let block = null;
      let hasReference = false;
      let duration = 0;
      for (const e of ebmlChildren(body, 0, body.length)) {
        if (e.id === EB.BLOCK) block = body.subarray(e.body, e.end);
        else if (e.id === EB.REFERENCE_BLOCK) hasReference = true;
        else if (e.id === EB.BLOCK_DURATION) duration = ebmlUint(body, e);
      }
      if (block) this.#block(block, !hasReference, duration);
    }

    /**
     * @param {Uint8Array} body contenido de un SimpleBlock o Block
     * @param {boolean | null} key null = la bandera la trae el propio SimpleBlock
     * @param {number} duration en ticks
     */
    #block(body, key, duration) {
      if (Number.isNaN(this.clusterTime) || body.length < 4) return;
      const tnLen = vintLength(body[0]);
      if (tnLen === 0 || tnLen + 3 > body.length) return;
      let track = body[0] & (0xff >> tnLen);
      for (let k = 1; k < tnLen; k++) track = track * 256 + body[k];
      const kind = this.tracks.get(track);
      if (!kind) return;
      const raw = body[tnLen + 2];
      const time = this.clusterTime + i16(body, tnLen);
      const isKey = kind === 'audio' || (key ?? (raw & 0x80) !== 0);
      const flags = (isKey ? F_KEY : 0) | (raw & F_LACING) | (raw & 0x08 ? F_INVISIBLE : 0)
        | (key === null && raw & 0x01 ? F_DISCARDABLE : 0);
      this.sink.onSample(track, time, time, duration, flags, body.subarray(tnLen + 3));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Captura vía Media Source Extensions
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Tiempos (s) de los últimos fotogramas clave de video capturados, en un
   * anillo fijo: el turbo los usa para saltar justo a uno y que el navegador
   * decodifique un fotograma en vez de un GOP entero.
   */
  class KeyframeLog {
    constructor() {
      this.times = new Float64Array(256);
      this.next = 0;
      this.count = 0;
    }

    /** @param {number} seconds */
    add(seconds) {
      this.times[this.next] = seconds;
      this.next = (this.next + 1) % this.times.length;
      if (this.count < this.times.length) this.count++;
    }

    /** El más tardío dentro de (after, atMost]; NaN si no hay. @param {number} after @param {number} atMost */
    latestBetween(after, atMost) {
      let best = NaN;
      for (let k = 0; k < this.count; k++) {
        const t = this.times[k];
        if (t > after && t <= atMost && !(t <= best)) best = t;
      }
      return best;
    }

    clear() {
      this.next = 0;
      this.count = 0;
    }
  }

  /**
   * Ruta de una pista del flujo a su representación.
   * @typedef {Object} SinkRoute
   * @property {Representation} rep
   * @property {number} ticksPerSec
   * @property {number} lastS     tiempo de la muestra anterior (NaN al principio)
   * @property {number} lastSeg   segmento del demuxer al que pertenecía
   * @property {boolean} lastOpen ¿la anterior llegó sin duración? (su final lo marca la siguiente)
   * @property {number} stepS     separación típica entre muestras (s)
   */

  /**
   * Sumidero de un SourceBuffer: elige el demuxer según el MIME (o
   * olfateando los bytes), enruta cada muestra a su representación y anota
   * el tramo que cubre.
   */
  class StreamSink {
    /**
     * @param {TrackRegistry} registry @param {string} mime
     * @param {string} videoId video que mostraba el reproductor al crear el SourceBuffer
     * @param {KeyframeLog | null} [keyframes] dónde anotar los fotogramas clave de video (para el turbo)
     */
    constructor(registry, mime, videoId, keyframes = null) {
      this.registry = registry;
      this.mime = mime;
      this.keyframes = keyframes;
      this.videoId = videoId;
      /** @type {Mp4Demuxer | WebmDemuxer | null} */
      this.demuxer = null;
      /** @type {Map<number, SinkRoute>} */
      this.routes = new Map();
      /** Bytes recibidos seguidos sin saber a qué pista van (sin inicialización vista). */
      this.unroutedBytes = 0;
    }

    /**
     * ¿Llegan datos sin poder leerse? Pasa con un SourceBuffer creado antes de
     * pegar el script: su inicialización ya se había entregado.
     */
    get blind() {
      return this.unroutedBytes >= BLIND_SINK_BYTES;
    }

    /**
     * Las marcas de tiempo se toman de los propios segmentos (tfdt / Timecode
     * del Cluster), que son el tiempo real del contenido; timestampOffset se
     * ignora a propósito porque con anuncios intercalados en el servidor el
     * reproductor lo usa para desplazar el contenido en su línea de tiempo.
     * @param {Uint8Array} bytes @param {boolean} active
     */
    feed(bytes, active) {
      this.demuxer ??= this.#createDemuxer(bytes);
      if (this.demuxer) {
        this.demuxer.passive = !active;
        this.demuxer.push(bytes);
      }
      this.unroutedBytes = this.routes.size ? 0 : this.unroutedBytes + bytes.length;
    }

    abort() {
      this.demuxer?.reset();
    }

    /** @param {string} mime */
    changeType(mime) {
      this.mime = mime;
      this.demuxer = null;
      this.routes.clear();
    }

    /** @param {DemuxTrack[]} tracks */
    onInit(tracks) {
      this.routes.clear();
      for (const t of tracks) {
        this.routes.set(t.id, {
          rep: this.registry.resolve(t.info), ticksPerSec: 1000 / t.info.msPerTick, lastS: NaN, lastSeg: -1, lastOpen: false, stepS: 0,
        });
      }
    }

    /**
     * @param {number} trackId @param {number} dts @param {number} pts @param {number} dur
     * @param {number} flags @param {Uint8Array} data
     */
    onSample(trackId, dts, pts, dur, flags, data) {
      const route = this.routes.get(trackId);
      if (!route) return;
      const rep = route.rep;
      rep.samples.push(dts, pts, dur, flags, data);
      const t = pts / route.ticksPerSec;
      // Los SimpleBlock de WebM no traen duración: la muestra anterior dura hasta esta. Dentro de
      // un segmento siempre son contiguas; entre segmentos, solo si la separación es la de
      // siempre (si no, falta un segmento entre medias y eso es un hueco).
      const seg = this.demuxer?.segment ?? 0;
      const delta = t - route.lastS;
      if (route.lastOpen && delta > 0) {
        const sameSegment = seg === route.lastSeg;
        if (sameSegment ? delta <= MAX_SAMPLE_SPAN_S : delta <= route.stepS + SEGMENT_JOIN_S) rep.coverage.add(route.lastS, t);
        if (sameSegment && delta <= 1) route.stepS = delta;
      }
      route.lastS = t;
      route.lastSeg = seg;
      route.lastOpen = dur <= 0;
      // Final provisional: con duración, exacto; sin ella, el paso típico (lo corrige la siguiente).
      rep.coverage.add(t, t + (dur > 0 ? dur / route.ticksPerSec : route.stepS));
      if (flags & F_KEY && rep.info.kind === 'video') this.keyframes?.add(t);
    }

    /** @param {Uint8Array} first */
    #createDemuxer(first) {
      const mime = this.mime.toLowerCase();
      if (mime.includes('webm') || mime.includes('matroska')) return new WebmDemuxer(this);
      if (mime.includes('mp4')) return new Mp4Demuxer(this);
      if (looksLikeWebm(first)) return new WebmDemuxer(this);
      if (looksLikeMp4(first)) return new Mp4Demuxer(this);
      return null;
    }
  }

  /**
   * Recibe los eventos de MSE, mantiene un sumidero por SourceBuffer y decide
   * qué se guarda: solo el video objetivo y nunca mientras se ve un anuncio.
   * Guarda al capturar y también en precaptura (lo que el usuario ve con el
   * script ya pegado); si no, solo lee inicializaciones por si el reproductor
   * reutiliza sus SourceBuffer.
   */
  class CaptureHub {
    /** @param {TrackRegistry} registry @param {YouTubePlayer} player */
    constructor(registry, player) {
      this.registry = registry;
      this.player = player;
      this.keyframes = new KeyframeLog();
      /** Último fin de flujo (endOfStream) del video objetivo: ya se entregó todo. @type {{id: string, duration: number} | null} */
      this.streamEnd = null;
      /** @type {(duration: number) => void} */
      this.onStreamEnd = () => {};
      /** @type {WeakMap<SourceBuffer, StreamSink>} */
      this.sinks = new WeakMap();
      this.capturing = false;
      this.prearm = false;
      this.targetId = '';
      this.capturedBytes = 0;
      /** @type {(sink: StreamSink) => void} */
      this.onSink = () => {};
      /** Llegan datos del video objetivo que no se pueden leer (SourceBuffer anterior al script). */
      this.onBlind = () => {};
    }

    /** @param {SourceBuffer} sb @param {string} mime */
    created(sb, mime) {
      this.onSink(this.#sinkFor(sb, mime));
    }

    /** @param {SourceBuffer} sb @param {unknown} data */
    appended(sb, data) {
      const sink = this.#sinkFor(sb, '');
      const bytes = copyBufferSource(data);
      if (!bytes || bytes.length === 0) return;
      // Se decide en cada append (no al crear el SourceBuffer): un búfer creado durante un anuncio
      // puede recibir después el contenido, y viceversa.
      const active = (this.capturing || this.prearm) && !this.player.isAdShowing() && this.player.videoId() === this.targetId;
      if (active) this.capturedBytes += bytes.length;
      sink.feed(bytes, active);
      if (active && sink.blind) this.onBlind();
    }

    /**
     * El reproductor llamó a endOfStream(): ya entregó todo lo que hay hasta el
     * final (MediaSource.duration pasa a ser el final real). Cuenta solo si es
     * el video objetivo y no un anuncio.
     * @param {MediaSource} ms
     */
    streamEnded(ms) {
      if (!(this.capturing || this.prearm) || this.player.isAdShowing() || this.player.videoId() !== this.targetId) return;
      const duration = ms.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      this.streamEnd = { id: this.targetId, duration };
      this.onStreamEnd(duration);
    }

    /** @param {SourceBuffer} sb */
    aborted(sb) {
      this.sinks.get(sb)?.abort();
    }

    /** @param {SourceBuffer} sb @param {string} mime */
    typeChanged(sb, mime) {
      this.sinks.get(sb)?.changeType(mime);
    }

    /** @param {SourceBuffer} sb @param {string} mime */
    #sinkFor(sb, mime) {
      let sink = this.sinks.get(sb);
      if (!sink) {
        sink = new StreamSink(this.registry, mime, this.player.videoId(), this.keyframes);
        this.sinks.set(sb, sink);
      }
      return sink;
    }
  }

  /** @returns {any} */
  function mediaSourceConstructor() {
    const g = /** @type {any} */ (globalThis);
    return g.MediaSource ?? g.ManagedMediaSource ?? null;
  }

  /**
   * Sustituye un método por un envoltorio y apunta cómo deshacerlo; al
   * deshacer, solo lo repone si nadie lo cambió después.
   * @param {any} target @param {string} name
   * @param {(original: Function) => Function} wrap
   * @param {Array<() => void>} restorers
   */
  function patchMethod(target, name, wrap, restorers) {
    const original = target?.[name];
    if (typeof original !== 'function') return;
    const wrapped = wrap(original);
    target[name] = wrapped;
    restorers.push(() => {
      if (target[name] === wrapped) target[name] = original;
    });
  }

  /**
   * Parchea MediaSource/SourceBuffer. Siempre llama primero al método
   * original: si este lanza (p. ej. búfer lleno), no se captura nada y el
   * reproductor reintentará sin generar duplicados.
   */
  class MseInterceptor {
    /** @param {CaptureHub} hub */
    constructor(hub) {
      this.hub = hub;
      /** @type {Array<() => void>} */
      this.restorers = [];
      this.warned = false;
    }

    static get supported() {
      return typeof SourceBuffer !== 'undefined' && mediaSourceConstructor() !== null;
    }

    install() {
      const hub = this.hub;
      /** @param {() => void} fn */
      const guard = (fn) => this.#guard(fn);
      this.#patch(mediaSourceConstructor().prototype, 'addSourceBuffer', (original) =>
        /** @this {MediaSource} @param {string} mime */
        function addSourceBuffer(mime) {
          const sb = original.call(this, mime);
          guard(() => hub.created(sb, String(mime)));
          return sb;
        });
      this.#patch(SourceBuffer.prototype, 'appendBuffer', (original) =>
        /** @this {SourceBuffer} @param {BufferSource} data */
        function appendBuffer(data) {
          const result = original.call(this, data);
          guard(() => hub.appended(this, data));
          return result;
        });
      this.#patch(mediaSourceConstructor().prototype, 'endOfStream', (original) =>
        /** @this {MediaSource} @param {EndOfStreamError} [error] */
        function endOfStream(error) {
          const result = error === undefined ? original.call(this) : original.call(this, error);
          if (error === undefined) guard(() => hub.streamEnded(this)); // con error no es el final
          return result;
        });
      this.#patch(SourceBuffer.prototype, 'abort', (original) =>
        /** @this {SourceBuffer} */
        function abort() {
          const result = original.call(this);
          guard(() => hub.aborted(this));
          return result;
        });
      if (typeof SourceBuffer.prototype.changeType === 'function') {
        this.#patch(SourceBuffer.prototype, 'changeType', (original) =>
          /** @this {SourceBuffer} @param {string} mime */
          function changeType(mime) {
            const result = original.call(this, mime);
            guard(() => hub.typeChanged(this, String(mime)));
            return result;
          });
      }
    }

    uninstall() {
      for (let restore = this.restorers.pop(); restore; restore = this.restorers.pop()) restore();
    }

    /** @param {any} target @param {string} name @param {(original: Function) => Function} wrap */
    #patch(target, name, wrap) {
      patchMethod(target, name, wrap, this.restorers);
    }

    /** Un error propio nunca debe romper el reproductor. @param {() => void} fn */
    #guard(fn) {
      try {
        fn();
      } catch (err) {
        if (!this.warned) {
          this.warned = true;
          console.warn(`[${APP_NAME}]`, err);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 8. Exportación: selección de pistas y muxers Matroska/WebM y MP4
  // ═══════════════════════════════════════════════════════════════════════

  /** @typedef {'av' | 'video' | 'audio'} ExportMode */

  /**
   * @typedef {Object} Coverage
   * @property {number} startMs
   * @property {number} endMs
   * @property {number} coveredMs
   * @property {number} gapMs
   * @property {number} stepMs     duración típica de una muestra
   */

  /**
   * @typedef {Object} TrackPick
   * @property {Representation} rep
   * @property {Uint32Array} order
   * @property {Coverage} coverage
   */

  /** @typedef {TrackPick & {number: number}} MuxTrack */

  /**
   * Mediana de los incrementos de dts de las primeras ~256 muestras (ms).
   * @param {Representation} rep @param {Uint32Array} order
   */
  function typicalStepMs(rep, order) {
    const { dts } = rep.samples;
    const k = rep.info.msPerTick;
    const m = Math.min(order.length - 1, 256);
    if (m <= 0) return 0;
    const deltas = new Float64Array(m);
    for (let j = 0; j < m; j++) deltas[j] = (dts[order[j + 1]] - dts[order[j]]) * k;
    deltas.sort();
    return deltas[m >> 1];
  }

  /**
   * Cuánto de la línea temporal cubre una representación. Un salto mayor que
   * 4 muestras típicas (y que 1 s) cuenta como hueco.
   * @param {Representation} rep @param {Uint32Array} order
   * @returns {Coverage}
   */
  function measureCoverage(rep, order) {
    const n = order.length;
    if (n === 0) return { startMs: 0, endMs: 0, coveredMs: 0, gapMs: 0, stepMs: 0 };
    const { dts } = rep.samples;
    const k = rep.info.msPerTick;
    const stepMs = typicalStepMs(rep, order);
    const tolerance = Math.max(1000, 4 * stepMs);
    let covered = stepMs;
    let gaps = 0;
    for (let j = 1; j < n; j++) {
      const delta = (dts[order[j]] - dts[order[j - 1]]) * k;
      if (delta > tolerance) gaps += delta;
      else covered += delta;
    }
    return { startMs: dts[order[0]] * k, endMs: dts[order[n - 1]] * k + stepMs, coveredMs: covered, gapMs: gaps, stepMs };
  }

  /** @param {number[]} a @param {number[]} b */
  function compareScores(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  }

  /**
   * Mejor representación de un tipo: la que más tiempo cubre (redondeado a
   * segundos), luego la de mayor resolución/frecuencia y, por último, la de
   * mayor tasa de bits.
   * @param {TrackRegistry} registry @param {'video'|'audio'} kind
   * @returns {TrackPick}
   */
  function pickTrack(registry, kind) {
    const all = registry.list(kind);
    if (!all.length) throw new Error(kind === 'video' ? 'No se capturó video.' : 'No se capturó audio.');
    const rep = mainRep(registry, kind);
    if (!rep) {
      const sample = all[0].info;
      throw new Error(sample.encrypted
        ? 'Este contenido está cifrado (DRM): no se puede guardar.'
        : `No puedo remultiplexar ${sample.unsupported}.`);
    }
    const order = rep.samples.ordered();
    return { rep, order, coverage: measureCoverage(rep, order) };
  }

  /**
   * La representación «del contenido» de un tipo: la utilizable que más
   * tiempo cubre (redondeado a segundos), luego la de más resolución y luego
   * la de más bytes. Barata: no ordena muestras, sirve en cada tic.
   * @param {TrackRegistry} registry @param {'video'|'audio'} kind
   * @returns {Representation | null}
   */
  function mainRep(registry, kind) {
    /** @type {Representation | null} */
    let best = null;
    /** @type {number[]} */
    let bestScore = [];
    for (const rep of registry.list(kind)) {
      if (rep.info.encrypted || rep.info.unsupported) continue;
      const score = [Math.round(rep.coverage.total), rep.quality, rep.samples.bytes];
      if (!best || compareScores(score, bestScore) > 0) {
        best = rep;
        bestScore = score;
      }
    }
    return best;
  }

  /** @param {ExportMode} mode @returns {Array<'video'|'audio'>} */
  function kindsFor(mode) {
    return mode === 'av' ? ['video', 'audio'] : [mode];
  }

  /**
   * Huecos de un tramo para todos los tipos pedidos (unión, ordenada). Un tipo
   * sin datos cuenta como hueco entero. Por omisión, los márgenes absorben el
   * retraso del primer fotograma (B-frames) y el redondeo de la duración.
   * @param {TrackRegistry} registry @param {ExportMode} mode @param {number} a @param {number} b
   * @param {number} [startSlack] @param {number} [endSlack]
   * @returns {Array<[number, number]>}
   */
  function missingIn(registry, mode, a, b, startSlack = RANGE_START_SLACK_S, endSlack = RANGE_END_SLACK_S) {
    /** @type {Array<[number, number]>} */
    const out = [];
    for (const kind of kindsFor(mode)) {
      const rep = mainRep(registry, kind);
      if (!rep) out.push([a, b]);
      else out.push(...rep.coverage.gaps(a + startSlack, b - endSlack));
    }
    return out.sort((x, y) => x[0] - y[0]);
  }

  /** Escritura de elementos EBML. */
  const Ebml = Object.freeze({
    /** @param {number} id */
    id(id) {
      const len = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
      const out = new Uint8Array(len);
      for (let i = len - 1, v = id; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v % 256;
      return out;
    },
    /** Tamaño como vint; `width` fija la longitud (8 = cabecera de ancho constante). @param {number} n @param {number} [width] */
    size(n, width = 0) {
      let len = width;
      if (!len) {
        len = 1;
        while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
      }
      const out = new Uint8Array(len);
      for (let i = len - 1, v = n; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v % 256;
      out[0] |= 0x80 >> (len - 1);
      return out;
    },
    /** @param {number} id @param {Uint8Array} payload */
    element(id, payload) {
      return concatBytes([Ebml.id(id), Ebml.size(payload.length), payload]);
    },
    /** @param {number} id @param {ReadonlyArray<Uint8Array | null>} children */
    master(id, children) {
      return Ebml.element(id, concatBytes(children.filter((c) => c !== null)));
    },
    /** @param {number} id @param {number} value @param {number} [width] */
    uint(id, value, width = 0) {
      let len = width;
      if (!len) {
        len = 1;
        while (len < 8 && value >= 2 ** (8 * len)) len++;
      }
      const out = new Uint8Array(len);
      for (let i = len - 1, v = value; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v % 256;
      return Ebml.element(id, out);
    },
    /** @param {number} id @param {number} value */
    float(id, value) {
      const out = new Uint8Array(8);
      new DataView(out.buffer).setFloat64(0, value);
      return Ebml.element(id, out);
    },
    /** @param {number} id @param {string} text */
    string(id, text) {
      return Ebml.element(id, utf8Encoder.encode(text));
    },
  });

  /**
   * Partes del Blob final. Agrupa lo pequeño (cabeceras, audio) en bloques
   * de 1 MiB y pasa lo grande por referencia: pocas partes y una sola copia.
   */
  class PartSink {
    constructor() {
      /** @type {Uint8Array[]} */
      this.parts = [];
      this.scratch = new Uint8Array(1 << 20);
      this.used = 0;
    }

    /** @param {Uint8Array} bytes */
    write(bytes) {
      if (bytes.length >= 1 << 16) {
        this.#flush();
        this.parts.push(bytes);
        return;
      }
      if (this.used + bytes.length > this.scratch.length) this.#flush();
      this.scratch.set(bytes, this.used);
      this.used += bytes.length;
    }

    /** @returns {Uint8Array[]} */
    finish() {
      this.#flush();
      return this.parts;
    }

    #flush() {
      if (this.used === 0) return;
      this.parts.push(this.scratch.slice(0, this.used));
      this.used = 0;
    }
  }

  /** @param {number} flags bits F_* @returns {number} byte de banderas de SimpleBlock */
  function simpleBlockFlags(flags) {
    return (flags & F_KEY ? 0x80 : 0) | (flags & F_LACING) | (flags & F_INVISIBLE ? 0x08 : 0) | (flags & F_DISCARDABLE ? 0x01 : 0);
  }

  /** Cluster en construcción: sus bloques esperan hasta conocer el tamaño total. */
  class ClusterDraft {
    /** @param {number} timeMs */
    constructor(timeMs) {
      this.timeMs = timeMs;
      /** @type {Uint8Array[]} */
      this.parts = [];
      this.size = 0;
      /** Tiempo del primer punto de acceso (para Cues); -1 si no hay. */
      this.cueMs = -1;
    }

    /** ¿Cabe este tiempo como desplazamiento int16 relativo al Cluster? @param {number} ptsMs */
    accepts(ptsMs) {
      const rel = ptsMs - this.timeMs;
      return rel >= -32768 && rel <= 32767;
    }

    /** @param {number} track @param {number} ptsMs @param {number} flags @param {Uint8Array} data */
    add(track, ptsMs, flags, data) {
      const trackVint = Ebml.size(track);
      const rel = ptsMs - this.timeMs;
      const head = concatBytes([
        Ebml.id(EB.SIMPLE_BLOCK), Ebml.size(trackVint.length + 3 + data.length), trackVint,
        Uint8Array.of((rel >> 8) & 0xff, rel & 0xff, simpleBlockFlags(flags)),
      ]);
      this.parts.push(head, data);
      this.size += head.length + data.length;
    }

    /** @param {PartSink} sink @returns {number} bytes escritos */
    writeTo(sink) {
      const timecode = Ebml.uint(EB.TIMECODE, this.timeMs);
      const head = concatBytes([Ebml.id(EB.CLUSTER), Ebml.size(timecode.length + this.size, 8)]);
      sink.write(head);
      sink.write(timecode);
      for (const p of this.parts) sink.write(p);
      return head.length + timecode.length + this.size;
    }
  }

  /** Escribe los Clusters en orden y anota dónde empieza cada uno (para Cues). */
  class ClusterWriter {
    constructor() {
      this.sink = new PartSink();
      /** @type {ClusterDraft | null} */
      this.current = null;
      /** Bytes de Clusters ya escritos. */
      this.size = 0;
      /** @type {Array<{timeMs: number, offset: number}>} offset relativo al primer Cluster */
      this.cues = [];
    }

    /** Cierra el Cluster actual y abre otro en `timeMs`. @param {number} timeMs */
    open(timeMs) {
      this.close();
      this.current = new ClusterDraft(timeMs);
      return this.current;
    }

    close() {
      const cluster = this.current;
      if (!cluster) return;
      if (cluster.cueMs >= 0) this.cues.push({ timeMs: cluster.cueMs, offset: this.size });
      this.size += cluster.writeTo(this.sink);
      this.current = null;
    }
  }

  /**
   * Muxer Matroska/WebM: intercala por tiempo de decodificación, abre un
   * Cluster en cada fotograma clave tras ≥1 s, indexa cada Cluster en Cues y
   * escribe un SeekHead de ancho fijo para conocer todo el diseño en una pasada.
   */
  class MatroskaMuxer {
    /**
     * @param {MuxTrack[]} tracks @param {string} title
     * @param {number} [originMs] instante que pasa a ser el 0 del archivo (para tramos)
     * @returns {{parts: Uint8Array[], mime: string, ext: string}}
     */
    static mux(tracks, title, originMs) {
      const webm = tracks.every((t) => WEBM_CODECS.has(t.rep.info.codecId) && !t.rep.info.contentEncodings);
      const hasVideo = tracks.some((t) => t.rep.info.kind === 'video');
      const timelines = tracks.map((t) => MatroskaMuxer.#timeline(t));
      const minPts = Math.min(...timelines.map((tl) => tl.minPts));
      const shift = originMs === undefined ? Math.max(0, -minPts) : -Math.min(originMs, minPts);
      const cueTrack = (tracks.find((t) => t.rep.info.kind === 'video') ?? tracks[0]).number;

      const writer = new ClusterWriter();
      const cursor = new Uint32Array(tracks.length);
      for (;;) {
        let ti = -1;
        let nextDts = Infinity;
        for (let j = 0; j < tracks.length; j++) {
          const k = cursor[j];
          if (k < timelines[j].dts.length && timelines[j].dts[k] < nextDts) {
            nextDts = timelines[j].dts[k];
            ti = j;
          }
        }
        if (ti < 0) break;
        const k = cursor[ti]++;
        const track = tracks[ti];
        const i = track.order[k];
        const flags = track.rep.samples.flags[i];
        const pts = timelines[ti].pts[k] + shift;
        const isVideo = track.rep.info.kind === 'video';
        const isKey = (flags & F_KEY) !== 0;
        const open = writer.current;
        const span = open ? pts - open.timeMs : 0;
        const split = !open || !open.accepts(pts) || (isVideo && isKey && span >= 1000)
          || (!hasVideo && span >= 2000) || open.size >= 32 << 20;
        const cluster = split || !open ? writer.open(pts) : open;
        if (cluster.cueMs < 0 && (hasVideo ? isVideo && isKey : true)) cluster.cueMs = pts;
        cluster.add(track.number, pts, flags, track.rep.samples.data[i]);
      }
      writer.close();
      const clustersSize = writer.size;

      let durationMs = 0;
      tracks.forEach((t, j) => {
        if (timelines[j].pts.length) durationMs = Math.max(durationMs, timelines[j].maxPts + shift + t.coverage.stepMs);
      });

      const info = Ebml.master(EB.INFO, [
        Ebml.uint(EB.TIMECODE_SCALE, 1e6),
        Ebml.float(EB.DURATION, durationMs),
        Ebml.string(EB.MUXING_APP, APP_NAME),
        Ebml.string(EB.WRITING_APP, APP_NAME),
        title ? Ebml.string(EB.TITLE, title) : null,
      ]);
      const tracksElement = Ebml.master(EB.TRACKS, tracks.map((t) => MatroskaMuxer.#trackEntry(t)));
      const seekHeadSize = MatroskaMuxer.#seekHead(0, 0, 0).length;
      const infoPos = seekHeadSize;
      const tracksPos = infoPos + info.length;
      const clustersPos = tracksPos + tracksElement.length;
      const cuesPos = clustersPos + clustersSize;
      const cuesElement = Ebml.master(EB.CUES, writer.cues.map((c) => Ebml.master(EB.CUE_POINT, [
        Ebml.uint(EB.CUE_TIME, c.timeMs),
        Ebml.master(EB.CUE_TRACK_POSITIONS, [
          Ebml.uint(EB.CUE_TRACK, cueTrack),
          Ebml.uint(EB.CUE_CLUSTER_POSITION, clustersPos + c.offset),
        ]),
      ])));
      const seekHead = MatroskaMuxer.#seekHead(infoPos, tracksPos, cuesPos);
      const segmentSize = seekHead.length + info.length + tracksElement.length + clustersSize + cuesElement.length;
      const ebmlHeader = Ebml.master(EB.EBML, [
        Ebml.uint(EB.EBML_VERSION, 1),
        Ebml.uint(EB.EBML_READ_VERSION, 1),
        Ebml.uint(EB.EBML_MAX_ID_LENGTH, 4),
        Ebml.uint(EB.EBML_MAX_SIZE_LENGTH, 8),
        Ebml.string(EB.DOC_TYPE, webm ? 'webm' : 'matroska'),
        Ebml.uint(EB.DOC_TYPE_VERSION, 4),
        Ebml.uint(EB.DOC_TYPE_READ_VERSION, 2),
      ]);
      const segmentHeader = concatBytes([Ebml.id(EB.SEGMENT), Ebml.size(segmentSize, 8)]);

      /** @type {Uint8Array[]} */
      const parts = [ebmlHeader, segmentHeader, seekHead, info, tracksElement];
      for (const p of writer.sink.finish()) parts.push(p);
      parts.push(cuesElement);
      const container = webm ? 'webm' : 'x-matroska';
      return {
        parts,
        mime: `${hasVideo ? 'video' : 'audio'}/${container}`,
        ext: webm ? 'webm' : hasVideo ? 'mkv' : 'mka',
      };
    }

    /**
     * Tiempos de salida (ms) en el orden elegido.
     * @param {MuxTrack} t
     */
    static #timeline(t) {
      const { dts, pts } = t.rep.samples;
      const k = t.rep.info.msPerTick;
      const n = t.order.length;
      const outDts = new Float64Array(n);
      const outPts = new Float64Array(n);
      let minPts = Infinity;
      let maxPts = -Infinity;
      for (let j = 0; j < n; j++) {
        const i = t.order[j];
        outDts[j] = Math.round(dts[i] * k);
        outPts[j] = Math.round(pts[i] * k);
        if (outPts[j] < minPts) minPts = outPts[j];
        if (outPts[j] > maxPts) maxPts = outPts[j];
      }
      return { dts: outDts, pts: outPts, minPts: n ? minPts : 0, maxPts: n ? maxPts : 0 };
    }

    /** @param {MuxTrack} t */
    static #trackEntry(t) {
      const i = t.rep.info;
      const flags = t.rep.samples.flags;
      let laced = false;
      for (const s of t.order) {
        if (flags[s] & F_LACING) {
          laced = true;
          break;
        }
      }
      const media = i.kind === 'video'
        ? Ebml.master(EB.VIDEO, [Ebml.uint(EB.PIXEL_WIDTH, i.width || 1), Ebml.uint(EB.PIXEL_HEIGHT, i.height || 1), i.colour])
        : Ebml.master(EB.AUDIO, [
          Ebml.float(EB.SAMPLING_FREQUENCY, i.sampleRate),
          Ebml.uint(EB.CHANNELS, i.channels || 1),
          i.bitDepth ? Ebml.uint(EB.BIT_DEPTH, i.bitDepth) : null,
        ]);
      return Ebml.master(EB.TRACK_ENTRY, [
        Ebml.uint(EB.TRACK_NUMBER, t.number),
        Ebml.uint(EB.TRACK_UID, crypto.getRandomValues(new Uint32Array(1))[0] || 1),
        Ebml.uint(EB.TRACK_TYPE, i.kind === 'video' ? 1 : 2),
        Ebml.uint(EB.FLAG_LACING, laced ? 1 : 0),
        Ebml.string(EB.LANGUAGE, 'und'),
        Ebml.string(EB.CODEC_ID, i.codecId),
        i.codecPrivate ? Ebml.element(EB.CODEC_PRIVATE, i.codecPrivate) : null,
        i.codecDelayNs > 0 ? Ebml.uint(EB.CODEC_DELAY, i.codecDelayNs) : null,
        i.seekPreRollNs > 0 ? Ebml.uint(EB.SEEK_PRE_ROLL, i.seekPreRollNs) : null,
        media,
        i.contentEncodings,
      ]);
    }

    /** Posiciones con ancho fijo (8 bytes): su tamaño no depende de los valores. @param {number} info @param {number} tracks @param {number} cues */
    static #seekHead(info, tracks, cues) {
      /** @param {number} id @param {number} pos */
      const seek = (id, pos) => Ebml.master(EB.SEEK, [Ebml.element(EB.SEEK_ID, Ebml.id(id)), Ebml.uint(EB.SEEK_POSITION, pos, 8)]);
      return Ebml.master(EB.SEEK_HEAD, [seek(EB.INFO, info), seek(EB.TRACKS, tracks), seek(EB.CUES, cues)]);
    }
  }

  /** Escritor binario big-endian que crece solo: base de las cajas ISOBMFF. */
  class ByteWriter {
    constructor(capacity = 256) {
      this.buf = new Uint8Array(capacity);
      this.view = new DataView(this.buf.buffer);
      this.length = 0;
    }

    /** @param {number} n */
    #room(n) {
      if (this.length + n <= this.buf.length) return;
      const grown = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
      grown.set(this.buf.subarray(0, this.length));
      this.buf = grown;
      this.view = new DataView(grown.buffer);
    }

    /** @param {number} v */
    u8(v) { this.#room(1); this.view.setUint8(this.length, v); this.length += 1; return this; }
    /** @param {number} v */
    u16(v) { this.#room(2); this.view.setUint16(this.length, v); this.length += 2; return this; }
    /** @param {number} v */
    u24(v) { return this.u8((v >>> 16) & 0xff).u16(v & 0xffff); }
    /** @param {number} v */
    u32(v) { this.#room(4); this.view.setUint32(this.length, v >>> 0); this.length += 4; return this; }
    /** @param {number} v */
    i32(v) { this.#room(4); this.view.setInt32(this.length, v); this.length += 4; return this; }
    /** @param {number} v */
    u64(v) { return this.u32(Math.floor(v / 0x100000000)).u32(v % 0x100000000); }
    /** @param {string} s cuatro caracteres ASCII */
    str(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); return this; }
    /** @param {ArrayLike<number>} b */
    bytes(b) { this.#room(b.length); this.buf.set(b, this.length); this.length += b.length; return this; }
    /** @param {number} n */
    zeros(n) { this.#room(n); this.buf.fill(0, this.length, this.length + n); this.length += n; return this; }

    done() {
      return this.buf.slice(0, this.length);
    }
  }

  /** @param {string} type @param {ReadonlyArray<Uint8Array | null>} parts */
  function mp4Box(type, parts) {
    let size = 8;
    for (const p of parts) if (p) size += p.length;
    const head = new ByteWriter(8).u32(size).str(type).done();
    return concatBytes([head, ...parts.filter((p) => p !== null)]);
  }

  /** @param {string} type @param {number} version @param {number} flags @param {ReadonlyArray<Uint8Array | null>} parts */
  function mp4FullBox(type, version, flags, parts) {
    return mp4Box(type, [new ByteWriter(4).u8(version).u24(flags).done(), ...parts]);
  }

  /** Matriz identidad de mvhd/tkhd. */
  const MP4_MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

  /** Lee los hijos simples (enteros sin signo) de un elemento EBML ya extraído. @param {Uint8Array | null} element */
  function ebmlUintChildren(element) {
    /** @type {Map<number, number>} */
    const out = new Map();
    if (!element) return out;
    const h = readEbmlHeader(element, 0, element.length);
    if (!h) return out;
    for (const c of ebmlChildren(element, h.len, element.length)) out.set(c.id, readUint(element, c.body, c.end));
    return out;
  }

  /**
   * Configuración vpcC de VP9 a partir de la cabecera del primer fotograma
   * clave y del elemento Colour de WebM (si lo hay).
   * @param {TrackInfo} info @param {Uint8Array} keyframe @param {number} fps
   */
  function vp9Config(info, keyframe, fps) {
    // Cabecera sin comprimir de VP9: marco(2) perfil(2) [reservado] show_existing(1) tipo(1) show(1) error_res(1) sync(24) color…
    const r = { pos: 0 };
    /** @param {number} n */
    const bits = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++, r.pos++) v = (v << 1) | ((keyframe[r.pos >> 3] >> (7 - (r.pos & 7))) & 1);
      return v;
    };
    let profile = 0;
    let bitDepth = 8;
    let subsampling = 0; // 4:2:0
    let fullRange = 0;
    let matrix = 2; // no especificado
    if (keyframe.length > 10 && bits(2) === 2) {
      const lo = bits(1);
      profile = (bits(1) << 1) | lo;
      if (profile === 3) bits(1);
      if (!bits(1) && !bits(1)) { // ni show_existing_frame, y frame_type = 0 (clave)
        bits(2);
        if (bits(24) === 0x498342) {
          if (profile >= 2) bitDepth = bits(1) ? 12 : 10;
          const space = bits(3);
          matrix = [2, 6, 1, 6, 7, 9, 2, 0][space];
          if (space !== 7) {
            fullRange = bits(1);
            if (profile === 1 || profile === 3) {
              const sx = bits(1);
              const sy = bits(1);
              subsampling = sx && sy ? 0 : sx ? 2 : 3;
            }
          } else {
            fullRange = 1;
            subsampling = 3;
          }
        }
      }
    }
    const colour = ebmlUintChildren(info.colour);
    const primaries = colour.get(0x55bb) ?? (matrix === 1 ? 1 : 2);
    const transfer = colour.get(0x55ba) ?? (matrix === 1 ? 1 : 2);
    matrix = colour.get(0x55b1) ?? matrix;
    if (colour.get(0x55b9) === 2) fullRange = 1;
    // Nivel según tamaño de imagen y tasa de muestras de luma (tabla de niveles de VP9).
    const size = info.width * info.height;
    const rate = size * fps;
    const LEVELS = [[10, 36864, 829440], [11, 73728, 2764800], [20, 122880, 4608000], [21, 245760, 9216000],
      [30, 552960, 20736000], [31, 983040, 36864000], [40, 2228224, 83558400], [41, 2228224, 160432128],
      [50, 8912896, 311951360], [51, 8912896, 588251136], [52, 8912896, 1176502272], [60, 35651584, 1176502272],
      [61, 35651584, 2353004544], [62, 35651584, 4706009088]];
    const level = (LEVELS.find(([, s, l]) => size <= s && rate <= l) ?? LEVELS[LEVELS.length - 1])[0];
    return new ByteWriter(8)
      .u8(profile).u8(level).u8((bitDepth << 4) | (subsampling << 1) | fullRange)
      .u8(primaries).u8(transfer).u8(matrix).u16(0)
      .done();
  }

  /** OpusHead (Matroska/Ogg, little-endian) → dOps (ISOBMFF, big-endian). @param {Uint8Array} head */
  function opusDops(head) {
    const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const channels = head[9];
    const family = head[18];
    const w = new ByteWriter(16).u8(0).u8(channels).u16(v.getUint16(10, true)).u32(v.getUint32(12, true))
      .u16(v.getInt16(16, true) & 0xffff).u8(family);
    if (family !== 0) w.bytes(head.subarray(19, 21 + channels));
    return w.done();
  }

  /** esds con la configuración AAC (o MP3 si `asc` es null). @param {Uint8Array | null} asc @param {number} trackId */
  function mp4Esds(asc, trackId) {
    /** @param {number} tag @param {Uint8Array} body */
    const desc = (tag, body) => {
      const w = new ByteWriter(body.length + 5).u8(tag);
      w.u8(0x80 | ((body.length >>> 21) & 0x7f)).u8(0x80 | ((body.length >>> 14) & 0x7f))
        .u8(0x80 | ((body.length >>> 7) & 0x7f)).u8(body.length & 0x7f);
      return w.bytes(body).done();
    };
    const dsi = asc ? desc(0x05, asc) : new Uint8Array(0);
    const dcd = desc(0x04, concatBytes([
      new ByteWriter(13).u8(asc ? 0x40 : 0x6b).u8(0x15).u24(0).u32(0).u32(0).done(), dsi,
    ]));
    const es = desc(0x03, concatBytes([new ByteWriter(3).u16(trackId).u8(0).done(), dcd, desc(0x06, Uint8Array.of(0x02))]));
    return mp4FullBox('esds', 0, 0, [es]);
  }

  /**
   * Pista preparada para MP4: tiempos ya en la escala de salida y desde 0.
   * @typedef {Object} Mp4OutTrack
   * @property {MuxTrack} src
   * @property {number} id
   * @property {number} n
   * @property {number} timescale
   * @property {number} dts0      dts absoluto de la primera muestra (ticks)
   * @property {Float64Array} dts
   * @property {Int32Array} cto
   * @property {Uint32Array} durations
   * @property {Uint32Array} sizes
   * @property {Uint32Array} syncs
   * @property {number} total     duración de los medios (ticks)
   * @property {number} mediaTime inicio de la presentación dentro de los medios (ticks)
   * @property {number} presentTicks duración presentada (ticks): la lista de edición recorta el sobrante
   * @property {number} startS    instante de la línea de tiempo común en que empieza a sonar/verse (s)
   * @property {number} emptyS    hueco inicial respecto del origen común (s)
   * @property {Uint8Array} entry caja de descripción de muestras
   * @property {number[]} chunkOffsets
   * @property {number[]} chunkCounts
   */

  /**
   * Muxer MP4 (ISOBMFF) progresivo con el moov al principio («faststart»):
   * se reproduce mientras se descarga y lo aceptan editores y móviles.
   * Remultiplexa sin recodificar: H.264, H.265, AV1, VP9, AAC, MP3 y Opus.
   */
  class Mp4Muxer {
    /**
     * @param {MuxTrack[]} tracks @param {string} title @param {string} artist
     * @param {TimeWindow} [window] tramo exacto a presentar (lista de edición); si falta, todo
     * @returns {{parts: Uint8Array[], mime: string, ext: string}}
     */
    static mux(tracks, title, artist, window) {
      const prepared = tracks.map((t, i) => Mp4Muxer.#prepare(t, i + 1, window));
      const origin = Math.min(...prepared.map((p) => p.startS));
      for (const p of prepared) p.emptyS = Math.max(0, p.startS - origin);
      const chunks = Mp4Muxer.#interleave(prepared);
      let dataSize = 0;
      for (const c of chunks) dataSize += c.bytes;
      const co64 = dataSize + (64 << 20) > 0xffffffff;
      const audioOnly = prepared.every((p) => p.src.rep.info.kind === 'audio');
      const codecs = new Set(prepared.map((p) => p.src.rep.info.codecId));
      const ftyp = mp4Box('ftyp', [new ByteWriter(32)
        .str(audioOnly ? 'M4A ' : 'isom').u32(0x200)
        .str(audioOnly ? 'M4A ' : 'isom').str('isom').str('iso2')
        .str(codecs.has('V_MPEG4/ISO/AVC') ? 'avc1' : 'iso6').str(codecs.has('V_AV1') ? 'av01' : 'mp41')
        .done()]);
      const large = dataSize + 8 > 0xffffffff;
      const mdatHead = large
        ? new ByteWriter(16).u32(1).str('mdat').u64(dataSize + 16).done()
        : new ByteWriter(8).u32(dataSize + 8).str('mdat').done();
      // Primero con desplazamientos provisionales: el tamaño del moov no depende de sus valores.
      Mp4Muxer.#assignOffsets(prepared, chunks, 0);
      const moovSize = Mp4Muxer.#moov(prepared, co64, title, artist).length;
      Mp4Muxer.#assignOffsets(prepared, chunks, ftyp.length + moovSize + mdatHead.length);
      const moov = Mp4Muxer.#moov(prepared, co64, title, artist);
      const sink = new PartSink();
      sink.write(ftyp);
      sink.write(moov);
      sink.write(mdatHead);
      for (const c of chunks) {
        const p = prepared[c.track];
        for (let j = c.first; j < c.first + c.count; j++) sink.write(p.src.rep.samples.data[p.src.order[j]]);
      }
      return { parts: sink.finish(), mime: audioOnly ? 'audio/mp4' : 'video/mp4', ext: audioOnly ? 'm4a' : 'mp4' };
    }

    /** @param {MuxTrack} t @param {number} id @param {TimeWindow} [window] @returns {Mp4OutTrack} */
    static #prepare(t, id, window) {
      const info = t.rep.info;
      const s = t.rep.samples;
      const order = t.order;
      const n = order.length;
      const k = info.msPerTick;
      let timescale;
      if (info.kind === 'audio') {
        timescale = Math.round(info.sampleRate) || 48000;
      } else {
        const ts = 1000 / k;
        timescale = ts >= 1 && Math.abs(ts - Math.round(ts)) < 1e-9 ? Math.round(ts) : 90000;
      }
      /** @param {number} ticks */
      const conv = (ticks) => Math.round((ticks * k * timescale) / 1000);
      const dts = new Float64Array(n);
      const cto = new Int32Array(n);
      const sizes = new Uint32Array(n);
      /** @type {number[]} */
      const syncs = [];
      let allSync = true;
      let minPts = Infinity;
      for (let j = 0; j < n; j++) {
        const i = order[j];
        let d = conv(s.dts[i]);
        if (j > 0 && d <= dts[j - 1]) d = dts[j - 1] + 1; // estrictamente creciente
        dts[j] = d;
        const p = conv(s.pts[i]);
        cto[j] = p - d;
        if (p < minPts) minPts = p;
        sizes[j] = s.data[i].length;
        if (s.flags[i] & F_KEY) syncs.push(j + 1);
        else allSync = false;
      }
      const dts0 = dts[0];
      for (let j = 0; j < n; j++) dts[j] -= dts0;
      const durations = new Uint32Array(n);
      for (let j = 0; j + 1 < n; j++) durations[j] = dts[j + 1] - dts[j];
      durations[n - 1] = Math.max(1, Math.round((t.coverage.stepMs * timescale) / 1000));
      let preSkip = 0;
      if (info.codecId === 'A_OPUS') {
        const cp = info.codecPrivate;
        preSkip = cp && cp.length >= 12 ? cp[10] | (cp[11] << 8) : Math.round((info.codecDelayNs * 48000) / 1e9);
      }
      // Inicio de la presentación: el del tramo pedido o el primer fotograma. En Opus las marcas
      // van adelantadas el pre-skip respecto del audio real, así que se suma.
      const startS = window ? window.startS : minPts / timescale;
      const total = dts[n - 1] + durations[n - 1];
      const mediaTime = Math.max(0, Math.round(startS * timescale) + preSkip - dts0);
      const presentTicks = Math.max(1, Math.min(total - mediaTime,
        window ? Math.round((window.endS - window.startS) * timescale) : Infinity));
      return {
        src: t, id, n, timescale, dts0, dts, cto, durations, sizes,
        syncs: allSync ? new Uint32Array(0) : Uint32Array.from(syncs),
        total,
        mediaTime,
        presentTicks,
        startS,
        emptyS: 0,
        entry: Mp4Muxer.#sampleEntry(t, id),
        chunkOffsets: [],
        chunkCounts: [],
      };
    }

    /** @param {MuxTrack} t @param {number} id */
    static #sampleEntry(t, id) {
      const info = t.rep.info;
      const cp = info.codecPrivate;
      const need = () => {
        if (!cp) throw new Error(`${info.codecName} sin configuración: no se puede escribir en MP4.`);
        return cp;
      };
      switch (info.codecId) {
        case 'V_MPEG4/ISO/AVC': return Mp4Muxer.#visual('avc1', info, [mp4Box('avcC', [need()])]);
        case 'V_MPEGH/ISO/HEVC': return Mp4Muxer.#visual('hvc1', info, [mp4Box('hvcC', [need()])]);
        case 'V_AV1': return Mp4Muxer.#visual('av01', info, [mp4Box('av1C', [need()])]);
        case 'V_VP9': {
          const s = t.rep.samples;
          const first = t.order.find((i) => (s.flags[i] & F_KEY) !== 0) ?? t.order[0];
          const fps = t.coverage.stepMs > 0 ? 1000 / t.coverage.stepMs : 30;
          const config = info.vpcc ?? vp9Config(info, s.data[first], fps);
          return Mp4Muxer.#visual('vp09', info, [mp4FullBox('vpcC', 1, 0, [config])]);
        }
        case 'A_AAC': return Mp4Muxer.#audio('mp4a', info, info.channels, [mp4Esds(need(), id)]);
        case 'A_MPEG/L3': return Mp4Muxer.#audio('mp4a', info, info.channels, [mp4Esds(null, id)]);
        case 'A_OPUS': {
          const head = need();
          return Mp4Muxer.#audio('Opus', { ...info, sampleRate: 48000 }, head[9], [mp4Box('dOps', [opusDops(head)])]);
        }
        default:
          throw new Error(`MP4 no admite ${info.codecName}.`);
      }
    }

    /** @param {string} type @param {TrackInfo} info @param {Uint8Array[]} config */
    static #visual(type, info, config) {
      const w = new ByteWriter(78).zeros(6).u16(1).u16(0).u16(0).zeros(12)
        .u16(info.width).u16(info.height).u32(0x480000).u32(0x480000).u32(0).u16(1)
        .zeros(32).u16(0x18).u16(0xffff);
      return mp4Box(type, [w.done(), ...config]);
    }

    /** @param {string} type @param {TrackInfo} info @param {number} channels @param {Uint8Array[]} config */
    static #audio(type, info, channels, config) {
      const rate = Math.round(info.sampleRate);
      const w = new ByteWriter(28).zeros(6).u16(1).zeros(8).u16(channels || 2).u16(16).u16(0).u16(0)
        .u32(rate <= 0xffff ? rate * 0x10000 : 0);
      return mp4Box(type, [w.done(), ...config]);
    }

    /**
     * Intercala por tiempo de decodificación en fragmentos de ≤ 0,5 s o 1 MiB.
     * @param {Mp4OutTrack[]} tracks
     * @returns {Array<{track: number, first: number, count: number, bytes: number}>}
     */
    static #interleave(tracks) {
      const cursor = new Uint32Array(tracks.length);
      /** @type {Array<{track: number, first: number, count: number, bytes: number, startS: number}>} */
      const chunks = [];
      /** @type {{track: number, first: number, count: number, bytes: number, startS: number} | null} */
      let cur = null;
      for (;;) {
        let ti = -1;
        let best = Infinity;
        for (let j = 0; j < tracks.length; j++) {
          const p = tracks[j];
          if (cursor[j] >= p.n) continue;
          const at = (p.dts[cursor[j]] + p.dts0) / p.timescale;
          if (at < best) {
            best = at;
            ti = j;
          }
        }
        if (ti < 0) break;
        const p = tracks[ti];
        const c = cursor[ti]++;
        if (!cur || cur.track !== ti || cur.bytes >= 1 << 20 || best - cur.startS >= 0.5) {
          cur = { track: ti, first: c, count: 0, bytes: 0, startS: best };
          chunks.push(cur);
        }
        cur.count++;
        cur.bytes += p.sizes[c];
      }
      return chunks;
    }

    /** @param {Mp4OutTrack[]} tracks @param {Array<{track: number, count: number, bytes: number}>} chunks @param {number} base */
    static #assignOffsets(tracks, chunks, base) {
      for (const p of tracks) {
        p.chunkOffsets = [];
        p.chunkCounts = [];
      }
      let at = base;
      for (const c of chunks) {
        tracks[c.track].chunkOffsets.push(at);
        tracks[c.track].chunkCounts.push(c.count);
        at += c.bytes;
      }
    }

    /** @param {Mp4OutTrack[]} tracks @param {boolean} co64 @param {string} title @param {string} artist */
    static #moov(tracks, co64, title, artist) {
      const durMs = (/** @type {Mp4OutTrack} */ p) => p.emptyS * 1000 + (p.presentTicks / p.timescale) * 1000;
      const movieMs = Math.max(...tracks.map(durMs));
      const mvhd = new ByteWriter(100).u32(0).u32(0).u32(1000).u32(Math.round(movieMs)).u32(0x10000).u16(0x100).zeros(10);
      for (const m of MP4_MATRIX) mvhd.u32(m);
      mvhd.zeros(24).u32(tracks.length + 1);
      return mp4Box('moov', [
        mp4FullBox('mvhd', 0, 0, [mvhd.done()]),
        ...tracks.map((p) => Mp4Muxer.#trak(p, co64, durMs(p))),
        Mp4Muxer.#udta(title, artist),
      ]);
    }

    /** @param {Mp4OutTrack} p @param {boolean} co64 @param {number} durMs */
    static #trak(p, co64, durMs) {
      const info = p.src.rep.info;
      const video = info.kind === 'video';
      const tkhd = new ByteWriter(84).u32(0).u32(0).u32(p.id).u32(0).u32(Math.round(durMs)).zeros(8)
        .u16(0).u16(0).u16(video ? 0 : 0x100).u16(0);
      for (const m of MP4_MATRIX) tkhd.u32(m);
      tkhd.u32(video ? info.width * 0x10000 : 0).u32(video ? info.height * 0x10000 : 0);
      const elst = new ByteWriter(28);
      const empty = Math.round(p.emptyS * 1000);
      elst.u32(empty > 0 ? 2 : 1);
      if (empty > 0) elst.u32(empty).i32(-1).u16(1).u16(0);
      elst.u32(Math.round((p.presentTicks / p.timescale) * 1000)).i32(p.mediaTime).u16(1).u16(0);
      const long = p.total > 0xffffffff;
      const mdhd = long
        ? new ByteWriter(32).u64(0).u64(0).u32(p.timescale).u64(p.total).u16(0x55c4).u16(0)
        : new ByteWriter(20).u32(0).u32(0).u32(p.timescale).u32(p.total).u16(0x55c4).u16(0);
      const hdlr = new ByteWriter(32).u32(0).str(video ? 'vide' : 'soun').zeros(12).str(video ? 'Video' : 'Audio').u8(0);
      const media = video
        ? mp4FullBox('vmhd', 0, 1, [new ByteWriter(8).zeros(8).done()])
        : mp4FullBox('smhd', 0, 0, [new ByteWriter(4).zeros(4).done()]);
      const dinf = mp4Box('dinf', [mp4FullBox('dref', 0, 0, [new ByteWriter(4).u32(1).done(), mp4FullBox('url ', 0, 1, [])])]);
      return mp4Box('trak', [
        mp4FullBox('tkhd', 0, 3, [tkhd.done()]),
        mp4Box('edts', [mp4FullBox('elst', 0, 0, [elst.done()])]),
        mp4Box('mdia', [
          mp4FullBox('mdhd', long ? 1 : 0, 0, [mdhd.done()]),
          mp4FullBox('hdlr', 0, 0, [hdlr.done()]),
          mp4Box('minf', [media, dinf, Mp4Muxer.#stbl(p, co64)]),
        ]),
      ]);
    }

    /** Tablas de muestras. @param {Mp4OutTrack} p @param {boolean} co64 */
    static #stbl(p, co64) {
      const stsd = new ByteWriter(8).u32(1).done();
      // stts: duraciones en tramos iguales
      const stts = new ByteWriter(64);
      let runs = 0;
      const sttsBody = new ByteWriter(64);
      for (let j = 0; j < p.n;) {
        let k = j + 1;
        while (k < p.n && p.durations[k] === p.durations[j]) k++;
        sttsBody.u32(k - j).u32(p.durations[j]);
        runs++;
        j = k;
      }
      stts.u32(runs).bytes(sttsBody.done());
      // ctts: desfases de composición (con signo si hace falta)
      let anyCto = false;
      let negative = false;
      for (let j = 0; j < p.n; j++) {
        if (p.cto[j] !== 0) anyCto = true;
        if (p.cto[j] < 0) negative = true;
      }
      let ctts = null;
      if (anyCto) {
        const body = new ByteWriter(64);
        let count = 0;
        for (let j = 0; j < p.n;) {
          let k = j + 1;
          while (k < p.n && p.cto[k] === p.cto[j]) k++;
          body.u32(k - j).i32(p.cto[j]);
          count++;
          j = k;
        }
        ctts = mp4FullBox('ctts', negative ? 1 : 0, 0, [new ByteWriter(4).u32(count).done(), body.done()]);
      }
      let stss = null;
      if (p.syncs.length) {
        const w = new ByteWriter(4 + p.syncs.length * 4).u32(p.syncs.length);
        for (const s of p.syncs) w.u32(s);
        stss = mp4FullBox('stss', 0, 0, [w.done()]);
      }
      const stsc = new ByteWriter(64);
      let entries = 0;
      const stscBody = new ByteWriter(64);
      for (let c = 0; c < p.chunkCounts.length; c++) {
        if (c > 0 && p.chunkCounts[c] === p.chunkCounts[c - 1]) continue;
        stscBody.u32(c + 1).u32(p.chunkCounts[c]).u32(1);
        entries++;
      }
      stsc.u32(entries).bytes(stscBody.done());
      const stsz = new ByteWriter(8 + p.n * 4).u32(0).u32(p.n);
      for (let j = 0; j < p.n; j++) stsz.u32(p.sizes[j]);
      const offsets = new ByteWriter(4 + p.chunkOffsets.length * (co64 ? 8 : 4)).u32(p.chunkOffsets.length);
      for (const o of p.chunkOffsets) {
        if (co64) offsets.u64(o);
        else offsets.u32(o);
      }
      return mp4Box('stbl', [
        mp4FullBox('stsd', 0, 0, [stsd, p.entry]),
        mp4FullBox('stts', 0, 0, [stts.done()]),
        ctts,
        stss,
        mp4FullBox('stsc', 0, 0, [stsc.done()]),
        mp4FullBox('stsz', 0, 0, [stsz.done()]),
        mp4FullBox(co64 ? 'co64' : 'stco', 0, 0, [offsets.done()]),
      ]);
    }

    /** Título y autor al estilo iTunes (los leen QuickTime, Windows, VLC y los móviles). @param {string} title @param {string} artist */
    static #udta(title, artist) {
      /** @param {string} tag @param {string} text */
      const item = (tag, text) => mp4Box(tag, [mp4Box('data', [new ByteWriter(8).u32(1).u32(0).done(), utf8Encoder.encode(text)])]);
      const hdlr = mp4FullBox('hdlr', 0, 0, [new ByteWriter(21).u32(0).str('mdir').str('appl').zeros(9).done()]);
      const ilst = mp4Box('ilst', [title ? item('©nam', title) : null, artist ? item('©ART', artist) : null]);
      return mp4Box('udta', [mp4FullBox('meta', 0, 0, [hdlr, ilst])]);
    }
  }

  /**
   * Formato de salida:
   * mp4c = MP4 con H.264 + AAC (se abre en todas partes), mp4 = MP4 con lo
   * que entregue YouTube, mkv = WebM/MKV original, mp3/mp3s = MP3 a 320/192
   * kbps (recodificado), orig = audio original sin pérdida (M4A o WebM).
   * @typedef {'mp4c'|'mp4'|'mkv'|'mp3'|'mp3s'|'orig'} OutputFormat
   */

  /** @typedef {{title: string, artist: string}} MediaMeta */

  /** ¿Abre este MP4 cualquier reproductor (iPhone, QuickTime, WhatsApp, editores)? @param {TrackPick[]} picks */
  function isUniversalMp4(picks) {
    return picks.every((p) => p.rep.info.codecId === 'V_MPEG4/ISO/AVC' || p.rep.info.codecId === 'A_AAC');
  }

  /** Tramo de tiempo en segundos (tiempo de presentación del contenido). @typedef {{startS: number, endS: number}} TimeWindow */

  /** Margen previo de audio para que el decodificador se asiente antes del corte (Opus pide 80 ms). */
  const AUDIO_PREROLL_S = 0.1;

  /**
   * Recorta una pista a un tramo. Video: desde el último fotograma clave ≤
   * inicio (sin él no se puede decodificar) hasta la última muestra que se
   * decodifica antes del final. Audio: desde `audioFrom` hasta el final.
   * @param {TrackPick} pick @param {number} videoFrom @param {number} audioFrom @param {number} to
   * @returns {TrackPick}
   */
  function trimPick(pick, videoFrom, audioFrom, to) {
    const { rep, order } = pick;
    const s = rep.samples;
    const k = rep.info.msPerTick / 1000;
    let first = 0;
    let last = order.length - 1;
    if (rep.info.kind === 'video') {
      for (let j = 0; j < order.length && s.dts[order[j]] * k <= videoFrom + 1e-6; j++) {
        if (s.flags[order[j]] & F_KEY && s.pts[order[j]] * k <= videoFrom + 1e-6) first = j;
      }
      while (last > first && s.dts[order[last]] * k >= to) last--;
    } else {
      while (first < last && s.pts[order[first + 1]] * k <= audioFrom) first++;
      while (last > first && s.pts[order[last]] * k >= to) last--;
    }
    const sub = order.slice(first, last + 1);
    return { rep, order: sub, coverage: measureCoverage(rep, sub) };
  }

  /** Elige pistas, exige que el tramo esté completo y construye el archivo en el formato pedido. */
  class Exporter {
    /**
     * @param {TrackRegistry} registry @param {ExportMode} mode @param {OutputFormat} format
     * @param {MediaMeta} meta @param {TimeWindow} window tramo a guardar
     * @param {(ratio: number) => void} onProgress avance de las conversiones lentas (MP3)
     * @returns {Promise<{blob: Blob, ext: string, notes: string[], summary: string[]}>}
     */
    async build(registry, mode, format, meta, window, onProgress) {
      const missing = missingIn(registry, mode, window.startS, window.endS);
      if (missing.length) {
        const [a, b] = missing[0];
        throw new Error(`Falta ${formatTime(a * 1000)}–${formatTime(b * 1000)}: no guardo archivos incompletos. Pulsa «Capturar».`);
      }
      /** @type {string[]} */
      const notes = [];
      const full = kindsFor(mode).map((kind) => pickTrack(registry, kind));
      const summary = full.map((p) => `${p.rep.info.kind === 'video' ? 'Video' : 'Audio'}: ${p.rep.label}`);
      const { startS, endS } = window;
      const mp3 = mode === 'audio' && (format === 'mp3' || format === 'mp3s');
      const mp4 = !mp3 && (mode === 'audio' ? full[0].rep.info.codecId === 'A_AAC' : format === 'mp4' || format === 'mp4c');
      if (mp3) {
        const kbps = format === 'mp3' ? 320 : 192;
        const pick = trimPick(full[0], startS, startS - AUDIO_PREROLL_S, endS);
        const parts = await transcodeToMp3(pick, kbps, meta, window, onProgress);
        summary.push(`Convertido a MP3 ${kbps} kbps`);
        return { blob: new Blob(/** @type {BlobPart[]} */ (/** @type {unknown} */ (parts)), { type: 'audio/mpeg' }), ext: 'mp3', notes, summary };
      }
      /** @type {{parts: Uint8Array[], mime: string, ext: string} | null} */
      let out = null;
      if (mp4) {
        // MP4 corta exacto: el video arranca en el fotograma clave anterior y la lista de edición oculta el sobrante.
        const tracks = full.map((p, j) => ({ ...trimPick(p, startS, startS - AUDIO_PREROLL_S, endS), number: j + 1 }));
        try {
          out = Mp4Muxer.mux(tracks, meta.title, meta.artist, window);
          if (format === 'mp4c' && !isUniversalMp4(full)) {
            notes.push('YouTube no entregó H.264 + AAC para este video: el MP4 lleva otros códecs y no se abrirá en iPhone, QuickTime ni WhatsApp (sí en PC, Android y VLC).');
          }
        } catch (err) {
          notes.push(`${err instanceof Error ? err.message : String(err)} Lo guardé como WebM/MKV.`);
        }
      }
      if (!out) {
        // WebM/MKV no tiene listas de edición fiables: empieza en el fotograma clave ≤ inicio.
        const video = full.find((p) => p.rep.info.kind === 'video');
        const keyS = video ? keyframeAtOrBefore(video, startS) : startS;
        const tracks = full.map((p, j) => ({ ...trimPick(p, startS, keyS, endS), number: j + 1 }));
        if (startS - keyS > 0.05) notes.push(`WebM/MKV empieza en el fotograma clave anterior (${(startS - keyS).toFixed(1)} s antes de lo pedido); para un corte exacto usa MP4.`);
        out = MatroskaMuxer.mux(tracks, meta.title, Math.round(keyS * 1000));
      }
      const blob = new Blob(/** @type {BlobPart[]} */ (/** @type {unknown} */ (out.parts)), { type: out.mime });
      return { blob, ext: out.ext, notes, summary };
    }
  }

  /** Tiempo (s) del último fotograma clave ≤ t. @param {TrackPick} pick @param {number} t */
  function keyframeAtOrBefore(pick, t) {
    const s = pick.rep.samples;
    const k = pick.rep.info.msPerTick / 1000;
    let best = 0;
    for (const i of pick.order) {
      const pts = s.pts[i] * k;
      if (s.flags[i] & F_KEY && pts <= t + 1e-6 && pts > best) best = pts;
    }
    return best;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 9. Codificador MP3 (MPEG-1 Layer III, CBR) desde cero
  // ═══════════════════════════════════════════════════════════════════════

  /** Códigos Huffman de ISO 11172-3 como (longitud << 20) | código: tablas 1–13, 15, 16, 24 y count1 A. */
  const MP3_HUFF_BLOB =
    'AQAQAAEAMAABACAAAAAwAAEAEAACADAAAQBgAAMAMAABADAAAQBQAAMAUAACAFAAAABgAAMAIAACACAAAQBgAAEAMAABACAAAQBQ' +
    'AAMAUAACAFAAAABgAAEAEAACADAABgBgAAUAcAADADAAAQAwAAQAYAAEAHAABwBgAAUAYAAHAHAAAQCAAAYAcAABAGAAAQBwAAAA' +
    'gAAHADAAAwAwAAUAUAABAHAABgAwAAIAIAADAEAAAgBQAAUAQAAEAEAABABQAAEAYAADAGAAAwBQAAIAYAAAAHAAAQAQAAIAMAAK' +
    'AGAAEwCAABAAgAAKAJAAAwAwAAMAQAAHAGAACgBwAAUAcAADAIAACwBgAAQAUAANAHAAEQCAAAgAgAAEAJAADABwAAsAcAASAIAA' +
    'DwCQAAsAkAACAJAABwBwAAYAcAAJAIAADgCQAAMAkAABAKAABgCAAAQAgAAFAJAAAwCgAAIAoAAAAKAAAwAgAAQAMAAGAGAAEgCA' +
    'AAwAgAAFAJAABQAwAAEAIAACAEAAEACAAAkAgAADAIAABwBgAAMAQAAFAGAADgCAAAcAgAADAJAAEwCAABEAgAAPAIAADQCQAAoA' +
    'kAAEAKAADQCAAAUAcAAIAIAACwCQAAUAoAABAKAADACQAAQAgAAEAJAAAQCQAAEAsAAAALAABwAwAAUAMAAJAFAADgBgAA8AgAAH' +
    'AJAABgAwAAQAMAAFAEAABQBQAAYAYAAHAIAABwBAAAYAQAAIAFAACABgAAgAcAAFAIAADwBgAAYAUAAJAGAACgBwAAUAcAABAIAA' +
    'CwBwAAcAYAAJAHAABgBwAAQAgAABAJAADgCAAAQAcAAGAIAAAgCAAAYAkAAAAJAAAQAQAAIAMAAKAGAAFwCAACMAkAAeAJAADACQ' +
    'ABEAoAADADAAAwBAAAgAYAAMAHAAEgCAABUAkAAMAIAABwCAAAsAYAAJAGAADwBwABUAgAAgAJAAKACgABMAkAAGAJAADgBwAA0A' +
    'cAAWAIAAIgCQAC4AoAAXAKAAEgCQAAcAoAAUAIAAEwCAACEAkAAvAKAAGwCgABYAoAAJAKAAAwCgAB8AkAAWAJAAKQCgABoAoAAV' +
    'ALAAFACwAAUAoAADALAADgCAAA0AgAAKAJAACwCgABAAoAAGAKAABQCwAAEAsAAJAJAACACAAAcAkAAIAKAABACgAAQAsAACALAA' +
    'AACwAAMAIAAEADAACgBQABgAcAAiAIAAIQCQABUAgAAPAJAABQAwAAMAMAAEAEAACgBgACAAgAARAIAACwBwAAoAgAALAFAABwBQ' +
    'AA0AYAASAHAAHgCAAB8AkAAUAIAABQCAABkAcAALAGAAEwBwADsAkAAbAIAAEgCgAAwAgAAFAJAAIwCAACEAgAAfAIAAOgCQAB4A' +
    'kAAQAKAABwCQAAUAoAAcAIAAGgCAACAAkAATAKAAEQCgAA8AsAAIAKAADgCwAA4AgAAMAHAACQBwAA0AgAAOAJAACQCgAAQAoAAB' +
    'AKAACwCAAAQAcAAGAIAABgCQAAYAoAADAKAAAgCgAAAAoAAJAEAABgAwABAAUAAhAHAAKQCAACcAkAAmAJAAGgCQAAcAMAAFADAA' +
    'BgBAAAkAUAAXAHAAEABwABoAgAALAIAAEQBQAAcAQAALAFAADgBgABUAcAAeAIAACgBwAAcAgAARAGAACgBQAA8AYAAMAGAAEgBw' +
    'ABwAgAAOAIAABQCAACAAcAANAGAAFgBwABMAcAASAIAAEACAAAkAgAAFAJAAKACAABEAcAAfAIAAHQCAABEAgAANAJAABACAAAIA' +
    'kAAbAIAADABwAAsAcAAPAIAACgCAAAcAkAAEAJAAAQCgABsAkAAMAIAACACAAAwAkAAGAJAAAwCQAAEAkAAAAKAAAQAQAAUAQAAO' +
    'AGAAFQBwACIAgAAzAJAALgCQAEcAoAAqAJAANACgAEQAsAA0ALAAQwDAACwAwAArANAAEwDQAAMAMAAEAEAADABgABMAcAAfAIAA' +
    'GgCAACwAkAAhAJAAHwCQABgAkAAgAKAAGACgAB8AsAAjAMAAFgDAAA4AwAAPAGAADQBgABcAcAAkAIAAOwCQADEAkABNAKAAQQCg' +
    'AB0AkAAoAKAAHgCgACgAsAAbALAAIQDAACoA0AAQANAAFgBwABQAcAAlAIAAPQCQADgAkABPAKAASQCgAEAAoAArAKAATACwADgA' +
    'sAAlALAAGgCwAB8AwAAZANAADgDQACMAgAAQAHAAPACQADkAkABhAKAASwCgAHIAsABbALAANgCgAEkAsAA3ALAAKQDAADAAwAA1' +
    'ANAAFwDQABgA4AA6AJAAGwCAADIAkABgAKAATACgAEYAoABdALAAVACwAE0AsAA6ALAATwDAAB0AsABKANAAMQDQACkA4AARAOAA' +
    'LwCQAC0AkABOAKAASgCgAHMAsABeALAAWgCwAE8AsABFALAAUwDAAEcAwAAyAMAAOwDQACYA0AAkAOAADwDgAEgAoAAiAJAAOACg' +
    'AF8AsABcALAAVQCwAFsAwABaAMAAVgDAAEkAwABNANAAQQDQADMA0AAsAOAAKwAAASoAAAErAJAAFACAAB4AkAAsAKAANwCgAE4A' +
    'sABIALAAVwDAAE4AwAA9AMAALgDAADYA0AAlANAAHgDgABQA8AAQAPAANQCgABkAkAApAKAAJQCgACwAsAA7ALAANgCwAFEA0ABC' +
    'AMAATADQADkA0AA2AOAAJQDgABIA4AAnAAABCwDwACMAoAAhAKAAHwCgADkAsAAqALAAUgDAAEgAwABQANAALwDAADoA0AA3AOAA' +
    'FQDQABYA4AAaAPAAJgAAARYAEAE1ALAAGQCgABcAoAAmALAARgDAADwAwAAzAMAAJADAADcA0AAaANAAIgDQABcA4AAbAPAADgDw' +
    'AAkA8AAHAAABIgCwACAAsAAcALAAJwDAADEAwABLANAAHgDAADQA0AAwAOAAKADgADQA8AAcAPAAEgDwABEAAAEJAAABBQAAAS0A' +
    'wAAVALAAIgDAAEAA0AA4ANAAMgDQADEA4AAtAOAAHwDgABMA4AAMAOAADwDwAAoAAAEHAPAABgAAAQMAAAEwANAAFwDAABQAwAAn' +
    'ANAAJADQACMA0AA1APAAFQDgABAA4AAXABABDQDwAAoA8AAGAPAAAQAQAQQAAAECAAABEADAAA8AwAARANAAGwDgABkA4AAUAOAA' +
    'HQDwAAsA4AARAPAADADwABAAAAEIAAABAQAwAQEAIAEAADABAQAAAQcAMAAMAEAAEgBQADUAcAAvAHAATACAAHwAkABsAJAAWQCQ' +
    'AHsAoABsAKAAdwCwAGsAsABRALAAegDAAD8A0AANAEAABQAwABAAUAAbAGAALgBwACQAcAA9AIAAMwCAACoAgABGAJAANACQAFMA' +
    'oABBAKAAKQCgADsAsAAkALAAEwBQABEAUAAPAFAAGABgACkAcAAiAHAAOwCAADAAgAAoAIAAQACQADIAkABOAKAAPgCgAFAAsAA4' +
    'ALAAIQCwAB0AYAAcAGAAGQBgACsAcAAnAHAAPwCAADcAgABdAJAATACQADsAkABdAKAASACgADYAoABLALAAMgCwAB0AsAA0AHAA' +
    'FgBgACoAcAAoAHAAQwCAADkAgABfAJAATwCQAEgAkAA5AJAAWQCgAEUAoAAxAKAAQgCwAC4AsAAbALAATQCAACUAcAAjAHAAQgCA' +
    'ADoAgAA0AIAAWwCQAEoAkAA+AJAAMACQAE8AoAA/AKAAWgCwAD4AsAAoALAAJgDAAH0AkAAgAHAAPACAADgAgAAyAIAAXACQAE4A' +
    'kABBAJAANwCQAFcAoABHAKAAMwCgAEkAsAAzALAARgDAAB4AwABtAJAANQCAADEAgABeAJAAWACQAEsAkABCAJAAegCgAFsAoABJ' +
    'AKAAOACgACoAoABAALAALACwABUAsAAZAMAAWgCQACsAgAApAIAATQCQAEkAkAA/AJAAOACQAFwAoABNAKAAQgCgAC8AoABDALAA' +
    'MACwADUAwAAkAMAAFADAAEcAkAAiAIAAQwCQADwAkAA6AJAAMQCQAFgAoABMAKAAQwCgAGoAsABHALAANgCwACYAsAAnAMAAFwDA' +
    'AA8AwABtAKAANQCQADMAkAAvAJAAWgCgAFIAoAA6AKAAOQCgADAAoABIALAAOQCwACkAsAAXALAAGwDAAD4A0AAJAMAAVgCgACoA' +
    'kAAoAJAAJQCQAEYAoABAAKAANACgACsAoABGALAANwCwACoAsAAZALAAHQDAABIAwAALAMAACwDQAHYAsABEAKAAHgCQADcAoAAy' +
    'AKAALgCgAEoAsABBALAAMQCwACcAsAAYALAAEACwABYAwAANAMAADgDQAAcA0ABbALAALACgACcAoAAmAKAAIgCgAD8AsAA0ALAA' +
    'LQCwAB8AsAA0AMAAHADAABMAwAAOAMAACADAAAkA0AADANAAewDAADwAsAA6ALAANQCwAC8AsAArALAAIACwABYAsAAlAMAAGADA' +
    'ABEAwAAMAMAADwDQAAoA0AACAMAAAQDQAEcAwAAlALAAIgCwAB4AsAAcALAAFACwABEAsAAaAMAAFQDAABAAwAAKAMAABgDAAAgA' +
    '0AAGANAAAgDQAAAA0AABABAABQBAAA4AYAAsAIAASgCQAD8AkABuAKAAXQCgAKwAsACVALAAigCwAPIAwADhAMAAwwDAAHgB0AAR' +
    'AJAAAwAwAAQAQAAMAGAAFABwACMAgAA+AJAANQCQAC8AkABTAKAASwCgAEQAoAB3ALAAyQDAAGsAsADPAMAACQCAAA8AYAANAGAA' +
    'FwBwACYAgABDAJAAOgCQAGcAoABaAKAAoQCwAEgAoAB/ALAAdQCwAG4AsADRAMAAzgDAABAAkAAtAIAAFQBwACcAgABFAJAAQACQ' +
    'AHIAoABjAKAAVwCgAJ4AsACMALAA/ADAANQAwADHAMAAgwHQAG0B0AAaAKAASwCQACQAgABEAJAAQQCQAHMAoABlAKAAswCwAKQA' +
    'sACbALAACAHAAPYAwADiAMAAiwHQAH4B0ABqAdAACQCQAEIAkAAeAIAAOwCQADgAkABmAKAAuQCwAK0AsAAJAcAAjgCwAP0AwADo' +
    'AMAAkAHQAIQB0AB6AdAAvQHgABAAoABvAKAANgCQADQAkABkAKAAuACwALIAsACgALAAhQCwAAEBwAD0AMAA5ADAANkAwACBAdAA' +
    'bgHQAMsC4AAKAKAAYgCgADAAkABbAKAAWACgAKUAsACdALAAlACwAAUBwAD4AMAAlwHQAI0B0AB0AdAAfAHQAHkD8AB0A/AACACg' +
    'AFUAoABUAKAAUQCgAJ8AsACcALAAjwCwAAQBwAD5AMAAqwHQAJEB0ACIAdAAfwHQANcC4ADJAuAAxALgAAcAoACaALAATACgAEkA' +
    'oACNALAAgwCwAAABwAD1AMAAqgHQAJYB0ACKAdAAgAHQAN8C4ABnAdAAxgLgAGAB0AALALAAiwCwAIEAsABDAKAAfQCwAPcAwADp' +
    'AMAA5QDAANsAwACJAdAA5wLgAOEC4ADQAuAAdQPwAHID8AC3AeAABACgAPMAwAB4ALAAdgCwAHMAsADjAMAA3wDAAIwB0ADqAuAA' +
    '5gLgAOAC4ADRAuAAyALgAMIC4ADfANAAtAHgAAYAsADKAMAA4ADAAN4AwADaAMAA2ADAAIUB0ACCAdAAfQHQAGwB0AB4A/AAuwHg' +
    'AMMC4AC4AeAAtQHgAMAGAAEEALAA6wLgANMAwADSAMAA0ADAAHIB0AB7AdAA3gLgANMC4ADKAuAAxwYAAXMD8ABtA/AAbAPwAIMN' +
    'EAFhA/AAAgCwAHkB0ABxAdAAZgCwALsAwADWAuAA0gLgAGYB0ADHAuAAxQLgAGID8ADGBgABZwPwAIINEAFmA/AAsgHgAAAAsAAM' +
    'AJAACgCAAAcAgAALAJAACgCQABEAoAALAKAACQCgAA0AsAAMALAACgCwAAcAsAAFALAAAwCwAAEAsAADAIAADwBAAA0AQAAuAGAA' +
    'UABwAJIAgAAGAZAA+ACQALIBoACqAaAAnQKwAI0CsACJArAAbQKwAAUCsAAIBMAAWACQAA4AQAAMAEAAFQBQACYAYABHAHAAggCA' +
    'AHoAgADYAJAA0QCQAMYAkABHAaAAWQGgAD8BoAApAaAAFwGgACoAgAAvAGAAFgBQACkAYABKAHAARABwAIAAgAB4AIAA3QCQAM8A' +
    'kADCAJAAtgCQAFQBoAA7AaAAJwGgAB0CsAASAHAAUQBwACcAYABLAHAARgBwAIYAgAB9AIAAdACAANwAkADMAJAAvgCQALIAkABF' +
    'AaAANwGgACUBoAAPAaAAEABwAJMAgABIAHAARQBwAIcAgAB/AIAAdgCAAHAAgADSAJAAyACQALwAkABgAaAAQwGgADIBoAAdAaAA' +
    'HAKwAA4AcAAHAZAAQgBwAIEAgAB+AIAAdwCAAHIAgADWAJAAygCQAMAAkAC0AJAAVQGgAD0BoAAtAaAAGQGgAAYBoAAMAHAA+QCQ' +
    'AHsAgAB5AIAAdQCAAHEAgADXAJAAzgCQAMMAkAC5AJAAWwGgAEoBoAA0AaAAIwGgABABoAAIArAACgBwALMBoABzAIAAbwCAAG0A' +
    'gADTAJAAywCQAMQAkAC7AJAAYQGgAEwBoAA5AaAAKgGgABsBoAATArAAfQGwABEAgACrAaAA1ACQANAAkADNAJAAyQCQAMEAkAC6' +
    'AJAAsQCQAKkAkABAAaAALwGgAB4BoAAMAaAAAgKwAHkBsAAQAIAATwGgAMcAkADFAJAAvwCQAL0AkAC1AJAArgCQAE0BoABBAaAA' +
    'MQGgACEBoAATAaAACQKwAHsBsABzAbAACwCAAJwCsAC4AJAAtwCQALMAkACvAJAAWAGgAEsBoAA6AaAAMAGgACIBoAAVAaAAEgKw' +
    'AH8BsAB1AbAAbgGwAAoAgACMArAAWgGgAKsAkACoAJAApACQAD4BoAA1AaAAKwGgAB8BoAAUAaAABwGgAAECsAB3AbAAcAGwAGoB' +
    'sAAGAIAAiAKwAEIBoAA8AaAAOAGgADMBoAAuAaAAJAGgABwBoAANAaAABQGgAAACsAB4AbAAcgGwAGwBsABnAbAABACAAGwCsAAs' +
    'AaAAKAGgACYBoAAgAaAAGgGgABEBoAAKAaAAAwKwAHwBsAB2AbAAcQGwAG0BsABpAbAAZQGwAAIAgAAJBMAAGAGgABYBoAASAaAA' +
    'CwGgAAgBoAADAaAAfgGwAHoBsAB0AbAAbwGwAGsBsABoAbAAZgGwAGQBsAAAAIAAKwCAABQAcAATAHAAEQBwAA8AcAANAHAACwBw' +
    'AAkAcAAHAHAABgBwAAQAcAAHAIAABQCAAAMAgAABAIAAAwBAAAEAEAAFAEAABABAAAUAUAAGAEAABQBgAAQAUAAEAGAABwBAAAMA' +
    'UAAGAFAAAABgAAcAUAACAGAAAwBgAAEAYAA=';
  /** Ventana de síntesis D[i] × 65536 de ISO 11172-3; la de análisis es C[i] = D[i] / 32. */
  const MP3_WINDOW_BLOB =
    'AAAAAP////////////////////////////////7////+/////v////7////9/////f////z////8////+/////v////6////+f//' +
    '//n////4////9/////b////1////8/////L////w////7////+3////r////6P///+b////j////4f///93////a////1////9P/' +
    '///P////y////8b////B////vP///7f///+x////q////6X///+f////mP///5H///+L////g////3z///91////bf///2b///9f' +
    '////V////1D///9J////Qv///zz///82////MP///9UAAADaAAAA3gAAAOEAAADjAAAA5AAAAOQAAADjAAAA4AAAAN0AAADXAAAA' +
    '0AAAAMgAAAC9AAAAsQAAAKMAAACSAAAAfwAAAGoAAABTAAAAOQAAAB0AAAD+////3P///7j///+R////Z////zv///8M////2v7/' +
    '/6X+//9v/v//Nf7///n9//+7/f//e/3//zn9///1/P//sPz//2n8//8h/P//2Pv//4/7//9G+////fr//7T6//9s+v//Jvr//+H5' +
    '//+e+f//Xvn//yH5///n+P//svj//4H4//9W+P//L/j//xD4///39///5ff//9v3///Z9///4Pf///H3///1BwAA0AcAAKAHAABl' +
    'BwAAHgcAAMsGAABsBgAA/wUAAIYFAAAABQAAawQAAMoDAAAaAwAAXQIAAJIBAAC5AAAA0////+D+///f/f//0vz//7n7//+U+v//' +
    'ZPn//yr4///m9v//mfX//0T0///p8v//h/H//yHw//+37v//TO3//9/r//9z6v//Cen//6Pn//9D5v//6eT//5nj//9T4v//GuH/' +
    '/+/f///V3v//zd3//9rc///92///ONv//4/a//8B2v//ktn//0TZ//8Z2f//Etn//zHZ//952f//6tn//4ja//9T2///Tdz//3jd' +
    '///U3v//ZOD//yji//8i5P//rhkAAEcXAACoFAAA0REAAMAOAAB3CwAA9QcAADoEAABGAAAAGvz//7b3//8c8///S+7//0bp//8O' +
    '5P//pN7//wnZ//9B0///TM3//yzH///lwP//ebr//+qz//87rf//b6b//4qf//+OmP//f5H//2CK//81g///AXz//8h0//+Pbf//' +
    'WGb//yhf//8CWP//61D//+dJ///6Qv//Jzz//3M1///iLv//dij//zYi//8jHP//Qhb//5cQ//8kC///7QX///YA//9C/P7/0/f+' +
    '/6zz/v/R7/7/Quz+/wTp/v8X5v7/feP+/znh/v9M3/7/t93+/3rc/v+Y2/7/ENv+/x4lAQDwJAEAaCQBAIYjAQBJIgEAtCABAMce' +
    'AQCDHAEA6RkBAPwWAQC+EwEALxABAFQMAQAtCAEAvgMBAAr/AAAT+gAA3PQAAGnvAAC+6QAA3eMAAMrdAACK1wAAHtEAAI3KAADZ' +
    'wwAABr0AABm2AAAVrwAA/qcAANigAAComQAAcZIAADiLAAD/gwAAy3wAAKB1AACBbgAAcmcAAHZgAACRWQAAxVIAABZMAACHRQAA' +
    'Gz8AANQ4AAC0MgAAvywAAPcmAABcIQAA8hsAALoWAAC1EQAA5AwAAEoIAADmAwAAuv///8b7//8L+P//ifT//0Dx//8v7v//WOv/' +
    '/7no//+uGQAA3hsAANgdAACcHwAALCEAAIgiAACzIwAArSQAAHglAAAWJgAAhyYAAM8mAADuJgAA5yYAALwmAABuJgAA/yUAAHEl' +
    'AADIJAAAAyQAACYjAAAzIgAAKyEAABEgAADmHgAArR0AAGccAAAXGwAAvRkAAF0YAAD3FgAAjRUAACEUAAC0EgAASREAAN8PAAB5' +
    'DgAAFw0AALwLAABnCgAAGgkAANYHAACcBgAAbAUAAEcEAAAuAwAAIQIAACABAAAtAAAAR////27+//+j/f//5vz//zb8//+V+///' +
    'APv//3r6//8B+v//lPn//zX5///i+P//m/j//2D4//8w+P//9QcAAA8IAAAgCAAAJwgAACUIAAAbCAAACQgAAPAHAADRBwAAqgcA' +
    'AH8HAABOBwAAGQcAAN8GAACiBgAAYgYAAB8GAADaBQAAlAUAAEwFAAADBQAAugQAAHEEAAAoBAAA3wMAAJcDAABQAwAACwMAAMcC' +
    'AACFAgAARQIAAAcCAADLAQAAkQEAAFsBAAAmAQAA9AAAAMUAAACZAAAAbwAAAEgAAAAkAAAAAgAAAOP////H////rf///5b///+B' +
    '////bv///13///9P////Q////zj///8w////Kf///yP///8g////Hf///xz///8c////Hf///x////8i////Jv///9UAAADQAAAA' +
    'ygAAAMQAAAC+AAAAtwAAALAAAACpAAAAoQAAAJoAAACTAAAAiwAAAIQAAAB9AAAAdQAAAG8AAABoAAAAYQAAAFsAAABVAAAATwAA' +
    'AEkAAABEAAAAPwAAADoAAAA1AAAAMQAAAC0AAAApAAAAJgAAACMAAAAfAAAAHQAAABoAAAAYAAAAFQAAABMAAAARAAAAEAAAAA4A' +
    'AAANAAAACwAAAAoAAAAJAAAACAAAAAcAAAAHAAAABgAAAAUAAAAFAAAABAAAAAQAAAADAAAAAwAAAAIAAAACAAAAAgAAAAIAAAAB' +
    'AAAAAQAAAAEAAAABAAAAAQAAAAEAAAA=';
  /** Potencia por gránulo de una senoidal a fondo de escala tras el análisis (calibrada). */
  const MP3_FULL_SCALE_POWER = 1;

  const MP3_RATES = [44100, 48000, 32000];
  const MP3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  /** Límites de las bandas de factores de escala (bloques largos) por frecuencia de muestreo. */
  const MP3_SFB_LONG = [
    [0, 4, 8, 12, 16, 20, 24, 30, 36, 44, 52, 62, 74, 90, 110, 134, 162, 196, 238, 288, 342, 418, 576],
    [0, 4, 8, 12, 16, 20, 24, 30, 36, 42, 50, 60, 72, 88, 106, 128, 156, 190, 230, 276, 330, 384, 576],
    [0, 4, 8, 12, 16, 20, 24, 30, 36, 44, 54, 66, 82, 102, 126, 156, 194, 240, 296, 364, 448, 550, 576],
  ];
  /** (slen1, slen2) por scalefac_compress. */
  const MP3_SLEN = [[0, 0], [0, 1], [0, 2], [0, 3], [3, 0], [1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3], [3, 1], [3, 2], [3, 3], [4, 2], [4, 3]];
  /** Orden de las tablas dentro de MP3_HUFF_BLOB. */
  const MP3_BLOB_TABLES = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 24];
  /** Lado de cada tabla de pares (0 = no existe). */
  const MP3_TABLE_SIZE = [0, 2, 3, 3, 0, 4, 4, 6, 6, 6, 8, 8, 8, 16, 0, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16];
  const MP3_LINBITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 6, 8, 10, 13, 4, 5, 6, 7, 8, 9, 11, 13];
  /** Tablas candidatas según el valor máximo de una región (sin escape). */
  const MP3_CANDIDATES = [[0], [1], [2, 3], [5, 6], [7, 8, 9], [7, 8, 9], [10, 11, 12], [10, 11, 12], [13, 15]];
  /** Valor cuantizado máximo codificable: 15 + (2^13 − 1). */
  const MP3_MAX_IX = 8206;
  /** Coeficientes de la reducción de alias (ISO 11172-3). */
  const MP3_ALIAS_C = [-0.6, -0.535, -0.33, -0.185, -0.095, -0.041, -0.0142, -0.0037];
  /** Escala de la MDCT para que el decodificador estándar devuelva la amplitud original (calibrada con ffmpeg). */
  const MP3_MDCT_SCALE = 1 / 9;
  /** Margen de enmascaramiento: el ruido permitido por banda queda este número de dB bajo su energía. */
  const MP3_SMR_DB = 18;
  /** Iteraciones máximas del lazo externo (moldeado del ruido con factores de escala). */
  const MP3_MAX_OUTER = 5;

  /** @param {string} b64 */
  function base64Bytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Tablas precalculadas del codificador, compartidas y creadas una sola vez. */
  class Mp3Tables {
    /** @type {Mp3Tables | null} */
    static #instance = null;

    static get() {
      return (Mp3Tables.#instance ??= new Mp3Tables());
    }

    constructor() {
      const words = new Uint32Array(base64Bytes(MP3_HUFF_BLOB).buffer);
      /** Por tabla (0–31): código y longitud de cada par, en el índice x·16 + y. @type {Uint32Array[]} */
      this.codes = [];
      /** @type {Uint8Array[]} */
      this.lens = [];
      let p = 0;
      for (const t of MP3_BLOB_TABLES) {
        const n = MP3_TABLE_SIZE[t];
        const codes = new Uint32Array(256);
        const lens = new Uint8Array(256);
        for (let x = 0; x < n; x++) {
          for (let y = 0; y < n; y++) {
            const w = words[p++];
            codes[x * 16 + y] = w & 0xfffff;
            lens[x * 16 + y] = w >>> 20;
          }
        }
        this.codes[t] = codes;
        this.lens[t] = lens;
      }
      for (let t = 17; t < 32; t++) {
        const base = t < 24 ? 16 : 24;
        this.codes[t] = this.codes[base];
        this.lens[t] = this.lens[base];
      }
      this.quadCodes = new Uint32Array(16);
      this.quadLens = new Uint8Array(16);
      for (let v = 0; v < 16; v++) {
        const w = words[p++];
        this.quadCodes[v] = w & 0xfffff;
        this.quadLens[v] = w >>> 20;
      }
      const d = new Int32Array(base64Bytes(MP3_WINDOW_BLOB).buffer);
      /** Ventana de análisis C[i]. */
      this.window = new Float64Array(512);
      for (let i = 0; i < 512; i++) this.window[i] = d[i] / 65536 / 32;
      /**
       * Matrizado plegado: cos((2k+1)(i−16)π/64) es par en torno a i = 16 e
       * impar en torno a i = 48, así que las 64 sumas parciales se pliegan en
       * 32 y basta una matriz de 32×32 = cos((2k+1)jπ/64).
       */
      this.dct32 = new Float64Array(32 * 32);
      for (let k = 0; k < 32; k++) {
        for (let j = 0; j < 32; j++) this.dct32[k * 32 + j] = Math.cos(((2 * k + 1) * j * Math.PI) / 64);
      }
      /** Ventana senoidal de bloque largo. */
      this.sine36 = Float64Array.from({ length: 36 }, (_, n) => Math.sin((Math.PI / 36) * (n + 0.5)));
      /** La MDCT de 36 → 18 equivale a plegar (TDAC) y aplicar una DCT-IV de 18 puntos (con la escala ya incluida). */
      this.dct4 = new Float64Array(18 * 18);
      for (let k = 0; k < 18; k++) {
        for (let n = 0; n < 18; n++) this.dct4[k * 18 + n] = Math.cos((Math.PI / 18) * (n + 0.5) * (k + 0.5)) * MP3_MDCT_SCALE;
      }
      this.cs = Float64Array.from(MP3_ALIAS_C, (c) => 1 / Math.sqrt(1 + c * c));
      this.ca = Float64Array.from(MP3_ALIAS_C, (c) => c / Math.sqrt(1 + c * c));
      /** ix^(4/3) para medir la distorsión. */
      this.pow43 = new Float64Array(MP3_MAX_IX + 1);
      for (let i = 0; i <= MP3_MAX_IX; i++) this.pow43[i] = i ** (4 / 3);
    }
  }

  /** Escritor de bits (MSB primero) sobre un búfer de tamaño fijo. */
  class BitWriter {
    /** @param {Uint8Array} bytes */
    constructor(bytes) {
      this.bytes = bytes;
      /** Posición en bits. */
      this.pos = 0;
    }

    /** @param {number} value @param {number} n bits (≤ 31) */
    put(value, n) {
      while (n > 0) {
        const free = 8 - (this.pos & 7);
        const take = free < n ? free : n;
        const bits = (value >>> (n - take)) & ((1 << take) - 1);
        this.bytes[this.pos >> 3] |= bits << (free - take);
        this.pos += take;
        n -= take;
      }
    }
  }

  /**
   * Etiqueta ID3v2.3 con título y autor (UTF-16 con BOM, la variante que
   * leen todos los reproductores).
   * @param {string} title @param {string} artist
   */
  function id3v23(title, artist) {
    /** @type {Uint8Array[]} */
    const frames = [];
    for (const [id, text] of [['TIT2', title], ['TPE1', artist]]) {
      if (!text) continue;
      const payload = new Uint8Array(3 + text.length * 2);
      payload.set([1, 0xff, 0xfe]);
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        payload[3 + i * 2] = c & 0xff;
        payload[4 + i * 2] = c >>> 8;
      }
      const head = new Uint8Array(10);
      head.set(utf8Encoder.encode(id));
      new DataView(head.buffer).setUint32(4, payload.length);
      frames.push(head, payload);
    }
    const body = concatBytes(frames);
    const size = body.length;
    const header = Uint8Array.of(0x49, 0x44, 0x33, 3, 0, 0,
      (size >>> 21) & 0x7f, (size >>> 14) & 0x7f, (size >>> 7) & 0x7f, size & 0x7f);
    return concatBytes([header, body]);
  }

  /**
   * Un gránulo de un canal, cuantizado y listo para escribir.
   * Se reutilizan (pool) para no crear basura en cada trama.
   */
  class Mp3Granule {
    constructor() {
      this.ix = new Int32Array(576);
      /** 1 si el coeficiente es negativo. */
      this.neg = new Uint8Array(576);
      /** Factores de escala de las bandas 0–20. */
      this.sf = new Uint8Array(21);
      this.gain = 210;
      this.compress = 0;
      this.part2 = 0;
      this.part3 = 0;
      this.bigValues = 0;
      this.count1End = 0;
      this.count1Table = 0;
      this.tables = [0, 0, 0];
      this.region0 = 0;
      this.region1 = 0;
    }

    /** @param {Mp3Granule} o */
    copyFrom(o) {
      this.ix.set(o.ix);
      this.sf.set(o.sf);
      this.gain = o.gain;
      this.compress = o.compress;
      this.part2 = o.part2;
      this.part3 = o.part3;
      this.bigValues = o.bigValues;
      this.count1End = o.count1End;
      this.count1Table = o.count1Table;
      this.tables[0] = o.tables[0];
      this.tables[1] = o.tables[1];
      this.tables[2] = o.tables[2];
      this.region0 = o.region0;
      this.region1 = o.region1;
    }
  }

  /** Umbral absoluto de audición (Terhardt), en dB SPL. @param {number} hz */
  function athDb(hz) {
    const f = Math.max(hz, 20) / 1000;
    return 3.64 * f ** -0.8 - 6.5 * Math.exp(-0.6 * (f - 3.3) ** 2) + 0.001 * f ** 4;
  }

  /**
   * Codificador MPEG-1 Layer III de tasa constante. Bloques largos,
   * moldeado del ruido con factores de escala (lazo interno de ganancia y
   * lazo externo de enmascaramiento simple + umbral absoluto) y reparto de
   * bits entre los gránulos y canales de cada trama.
   */
  class Mp3Encoder {
    /** @param {number} sampleRate 32000, 44100 o 48000 @param {number} channels 1 o 2 @param {number} kbps */
    constructor(sampleRate, channels, kbps) {
      this.rateIndex = MP3_RATES.indexOf(sampleRate);
      this.kbpsIndex = MP3_KBPS.indexOf(kbps);
      if (this.rateIndex < 0 || this.kbpsIndex <= 0 || (channels !== 1 && channels !== 2)) {
        throw new Error(`MP3 no admite ${sampleRate} Hz / ${channels} canales / ${kbps} kbps.`);
      }
      this.sampleRate = sampleRate;
      this.channels = channels;
      this.kbps = kbps;
      this.t = Mp3Tables.get();
      this.sfb = MP3_SFB_LONG[this.rateIndex];
      this.fifo = Array.from({ length: channels }, () => new Float64Array(1024));
      this.fifoPos = new Int32Array(channels);
      this.prevSub = Array.from({ length: channels }, () => new Float64Array(576));
      /** @type {Float32Array[]} */
      this.pending = Array.from({ length: channels }, () => new Float32Array(1152 * 8));
      this.pendingLen = 0;
      this.slotRest = 0;
      const cutoffHz = kbps >= 320 ? 20500 : kbps >= 256 ? 19500 : kbps >= 192 ? 18500 : 16500;
      this.cutoff = Math.min(576, Math.round((cutoffHz / (sampleRate / 2)) * 576));
      this.maskRatio = 10 ** (-MP3_SMR_DB / 10);
      this.athFloor = new Float64Array(22);
      for (let b = 0; b < 22; b++) {
        for (let i = this.sfb[b]; i < this.sfb[b + 1]; i++) {
          this.athFloor[b] += MP3_FULL_SCALE_POWER * 10 ** ((athDb(((i + 0.5) * sampleRate) / 1152) - 96) / 10);
        }
      }
      this.sub = new Float64Array(576);
      this.y64 = new Float64Array(64);
      this.a32 = new Float64Array(32);
      this.z36 = new Float64Array(36);
      this.u18 = new Float64Array(18);
      this.xr = new Float64Array(576);
      this.absXr = new Float64Array(576);
      this.xr34 = new Float64Array(576);
      this.ampl = new Float64Array(576);
      this.xmin = new Float64Array(22);
      this.over = new Uint8Array(22);
      this.work = new Mp3Granule();
      this.best = new Mp3Granule();
      /** Ganancia del gránulo anterior por canal: punto de partida de la búsqueda. */
      this.lastGain = new Int32Array(channels).fill(170);
      /** @type {Mp3Granule[][]} */
      this.pool = [0, 1].map(() => Array.from({ length: channels }, () => new Mp3Granule()));
    }

    /**
     * Añade PCM (Float32 en −1…1, un arreglo por canal) y devuelve las tramas completas.
     * @param {Float32Array[]} planar
     */
    encode(planar) {
      const n = planar[0].length;
      if (this.pendingLen + n > this.pending[0].length) {
        const cap = Math.max(this.pending[0].length * 2, this.pendingLen + n);
        this.pending = this.pending.map((old) => {
          const grown = new Float32Array(cap);
          grown.set(old.subarray(0, this.pendingLen));
          return grown;
        });
      }
      for (let c = 0; c < this.channels; c++) this.pending[c].set(planar[Math.min(c, planar.length - 1)], this.pendingLen);
      this.pendingLen += n;
      /** @type {Uint8Array[]} */
      const frames = [];
      let off = 0;
      for (; this.pendingLen - off >= 1152; off += 1152) frames.push(this.#frame(off));
      if (off) {
        for (const p of this.pending) p.copyWithin(0, off, this.pendingLen);
        this.pendingLen -= off;
      }
      return frames;
    }

    /** Completa con silencio y vacía el retardo del banco de filtros. */
    flush() {
      const pad = ((1152 - (this.pendingLen % 1152)) % 1152) + 1152;
      return this.encode(Array.from({ length: this.channels }, () => new Float32Array(pad)));
    }

    /** @param {number} off */
    #frame(off) {
      const num = 144000 * this.kbps;
      let size = Math.floor(num / this.sampleRate);
      this.slotRest += num % this.sampleRate;
      let padding = 0;
      if (this.slotRest >= this.sampleRate) {
        padding = 1;
        this.slotRest -= this.sampleRate;
      }
      size += padding;
      let available = size * 8 - 32 - (this.channels === 2 ? 256 : 136);
      let units = 2 * this.channels;
      for (let gr = 0; gr < 2; gr++) {
        for (let ch = 0; ch < this.channels; ch++) {
          this.#analyze(ch, off + gr * 576);
          const g = this.pool[gr][ch];
          this.#quantize(g, Math.min(4095, Math.floor(available / units)), ch);
          available -= g.part2 + g.part3;
          units--;
        }
      }
      return this.#write(size, padding);
    }

    /** Banco de filtros polifásico + MDCT + reducción de alias de un gránulo. @param {number} ch @param {number} start */
    #analyze(ch, start) {
      const t = this.t;
      const input = this.pending[ch];
      const fifo = this.fifo[ch]; // 1024: cada muestra va duplicada para leer la ventana sin módulo
      const win = t.window;
      const dct32 = t.dct32;
      const { sub, y64: y, a32: a } = this;
      let pos = this.fifoPos[ch];
      for (let slot = 0; slot < 18; slot++) {
        pos = (pos - 32) & 511;
        const base = start + slot * 32;
        for (let j = 0; j < 32; j++) {
          const at = (pos + 31 - j) & 511;
          fifo[at] = fifo[at + 512] = input[base + j];
        }
        for (let i = 0; i < 64; i++) {
          let s = 0;
          for (let m = i; m < 512; m += 64) s += win[m] * fifo[pos + m];
          y[i] = s;
        }
        a[0] = y[16];
        for (let j = 1; j <= 16; j++) a[j] = y[16 + j] + y[16 - j];
        for (let j = 17; j < 32; j++) a[j] = y[16 + j] - y[80 - j];
        for (let k = 0; k < 32; k++) {
          const row = k * 32;
          let s = 0;
          for (let j = 0; j < 32; j++) s += dct32[row + j] * a[j];
          sub[k * 18 + slot] = k & slot & 1 ? -s : s; // inversión de frecuencia
        }
      }
      this.fifoPos[ch] = pos;
      const prev = this.prevSub[ch];
      const { xr, z36: z, u18: u } = this;
      const sine = t.sine36;
      const dct4 = t.dct4;
      for (let sb = 0; sb < 32; sb++) {
        const o = sb * 18;
        for (let n = 0; n < 18; n++) {
          z[n] = sine[n] * prev[o + n];
          z[18 + n] = sine[18 + n] * sub[o + n];
        }
        for (let n = 0; n < 9; n++) {
          u[n] = -z[26 - n] - z[27 + n];
          u[9 + n] = z[n] - z[17 - n];
        }
        for (let k = 0; k < 18; k++) {
          const row = k * 18;
          let s = 0;
          for (let n = 0; n < 18; n++) s += dct4[row + n] * u[n];
          xr[o + k] = s;
        }
      }
      prev.set(sub);
      for (let sb = 1; sb < 32; sb++) {
        const o = sb * 18;
        for (let i = 0; i < 8; i++) {
          const a = xr[o - 1 - i];
          const b = xr[o + i];
          xr[o - 1 - i] = a * t.cs[i] + b * t.ca[i];
          xr[o + i] = b * t.cs[i] - a * t.ca[i];
        }
      }
    }

    /**
     * Lazo externo: moldea el ruido con factores de escala dentro del presupuesto.
     * @param {Mp3Granule} g @param {number} budget @param {number} ch
     */
    #quantize(g, budget, ch) {
      const { xr, absXr, xr34, sfb } = this;
      let silent = true;
      for (let i = 0; i < 576; i++) {
        const v = i < this.cutoff ? xr[i] : 0;
        const a = Math.abs(v);
        absXr[i] = a;
        xr34[i] = Math.sqrt(a * Math.sqrt(a));
        g.neg[i] = v < 0 ? 1 : 0;
        if (a > 1e-12) silent = false;
      }
      const w = this.work;
      w.sf.fill(0);
      if (silent || budget <= 0) {
        w.ix.fill(0);
        w.gain = 210;
        w.compress = 0;
        w.part2 = 0;
        this.#countBits(w);
        g.copyFrom(w);
        return;
      }
      for (let b = 0; b < 22; b++) {
        let e = 0;
        for (let i = sfb[b]; i < sfb[b + 1]; i++) e += absXr[i] * absXr[i];
        this.xmin[b] = Math.max(e * this.maskRatio, this.athFloor[b]);
      }
      let bestScore = Infinity;
      for (let iter = 0; iter < MP3_MAX_OUTER; iter++) {
        const compress = this.#compress(w.sf);
        if (compress < 0) break;
        const [s1, s2] = MP3_SLEN[compress];
        w.compress = compress;
        w.part2 = 11 * s1 + 10 * s2;
        this.#setAmplification(w.sf);
        if (!this.#innerLoop(w, budget - w.part2, iter ? w.gain : this.lastGain[ch])) break;
        const score = this.#measureNoise(w);
        if (score < bestScore) {
          bestScore = score;
          this.best.copyFrom(w);
        }
        if (score === 0) break;
        let grew = false;
        let overflow = false;
        for (let b = 0; b < 21; b++) {
          if (!this.over[b]) continue;
          w.sf[b]++;
          grew = true;
          if (w.sf[b] > (b < 11 ? 15 : 7)) overflow = true;
        }
        if (!grew || overflow) break;
      }
      if (bestScore === Infinity) {
        // Ni sin factores de escala cupo: ganancia máxima.
        w.sf.fill(0);
        w.compress = 0;
        w.part2 = 0;
        this.#setAmplification(w.sf);
        this.#tryGain(w, 255);
        this.best.copyFrom(w);
      }
      g.copyFrom(this.best);
      this.lastGain[ch] = g.gain;
    }

    /** @param {Uint8Array} sf */
    #setAmplification(sf) {
      for (let b = 0; b < 22; b++) {
        const a = b < 21 ? 2 ** (0.375 * sf[b]) : 1;
        for (let i = this.sfb[b]; i < this.sfb[b + 1]; i++) this.ampl[i] = a;
      }
    }

    /**
     * La menor ganancia (cuantización más fina) cuyo coste cabe. Búsqueda
     * galopante desde `hint` (la ganancia cambia poco entre gránulos) y luego
     * binaria: unas 3–4 cuantizaciones en vez de 9.
     * @param {Mp3Granule} g @param {number} avail @param {number} hint
     */
    #innerLoop(g, avail, hint) {
      if (avail < 0) return false;
      let last = -1;
      /** @param {number} gain */
      const fits = (gain) => {
        last = gain;
        const bits = this.#tryGain(g, gain);
        return bits >= 0 && bits <= avail;
      };
      let lo = 0;
      let hi = 0;
      let step = 1;
      if (fits(hint)) {
        hi = hint;
        while (hi - step >= 0 && fits(hi - step)) {
          hi -= step;
          step *= 2;
        }
        lo = Math.max(0, hi - step + 1);
      } else {
        // `hint` no cabe: se sube galopando hasta la primera que quepa.
        lo = hint + 1;
        hi = -1;
        while (lo <= 255) {
          const probe = Math.min(255, lo + step - 1);
          if (fits(probe)) {
            hi = probe;
            break;
          }
          lo = probe + 1;
          step *= 2;
        }
        if (hi < 0) return false;
      }
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (fits(mid)) hi = mid;
        else lo = mid + 1;
      }
      if (last !== hi && !fits(hi)) return false;
      return true;
    }

    /** Cuantiza con `gain` y cuenta bits (−1 si algún valor no es codificable). @param {Mp3Granule} g @param {number} gain */
    #tryGain(g, gain) {
      const scale = 2 ** (-0.1875 * (gain - 210));
      const { xr34, ampl } = this;
      const ix = g.ix;
      for (let i = 0; i < 576; i++) {
        const v = Math.floor(xr34[i] * ampl[i] * scale + 0.4054);
        if (v > MP3_MAX_IX) return -1;
        ix[i] = v;
      }
      g.gain = gain;
      return this.#countBits(g);
    }

    /** Puntuación del ruido que excede lo permitido (0 = todo enmascarado); marca las bandas excedidas. @param {Mp3Granule} g */
    #measureNoise(g) {
      const step = 2 ** (0.25 * (g.gain - 210));
      const { absXr, sfb } = this;
      const pow43 = this.t.pow43;
      let score = 0;
      for (let b = 0; b < 22; b++) {
        const lin = b < 21 ? step * 2 ** (-0.5 * g.sf[b]) : step;
        let dist = 0;
        for (let i = sfb[b]; i < sfb[b + 1]; i++) {
          const d = absXr[i] - pow43[g.ix[i]] * lin;
          dist += d * d;
        }
        const over = dist > this.xmin[b];
        this.over[b] = over ? 1 : 0;
        if (over) score += Math.log10(dist / this.xmin[b]);
      }
      return score;
    }

    /** scalefac_compress más barato que admite los factores (−1 si ninguno). @param {Uint8Array} sf */
    #compress(sf) {
      let m1 = 0;
      let m2 = 0;
      for (let b = 0; b < 11; b++) if (sf[b] > m1) m1 = sf[b];
      for (let b = 11; b < 21; b++) if (sf[b] > m2) m2 = sf[b];
      let best = -1;
      let bestBits = Infinity;
      for (let c = 0; c < 16; c++) {
        const [s1, s2] = MP3_SLEN[c];
        if (m1 >= 1 << s1 || m2 >= 1 << s2) continue;
        const bits = 11 * s1 + 10 * s2;
        if (bits < bestBits) {
          bestBits = bits;
          best = c;
        }
      }
      return best;
    }

    /** Divide en big_values y count1, elige tablas y devuelve los bits Huffman. @param {Mp3Granule} g */
    #countBits(g) {
      const ix = g.ix;
      const t = this.t;
      const sfb = this.sfb;
      let end = 576;
      while (end > 0 && ix[end - 1] === 0) end--;
      if (end & 1) end++;
      let c1 = end;
      while (c1 >= 4 && ix[c1 - 1] <= 1 && ix[c1 - 2] <= 1 && ix[c1 - 3] <= 1 && ix[c1 - 4] <= 1) c1 -= 4;
      let bitsA = 0;
      let bitsB = 0;
      for (let i = c1; i < end; i += 4) {
        const signs = ix[i] + ix[i + 1] + ix[i + 2] + ix[i + 3];
        bitsA += t.quadLens[(ix[i] << 3) | (ix[i + 1] << 2) | (ix[i + 2] << 1) | ix[i + 3]] + signs;
        bitsB += 4 + signs;
      }
      g.count1End = end;
      g.count1Table = bitsB < bitsA ? 1 : 0;
      g.bigValues = c1 >> 1;
      let n = 0;
      while (n < 21 && sfb[n + 1] < c1) n++;
      const r0 = Math.min(15, n >> 2);
      const r1 = Math.min(7, 20 - r0, Math.floor(n / 3));
      g.region0 = r0;
      g.region1 = r1;
      const a1 = Math.min(c1, sfb[r0 + 1]);
      const a2 = Math.min(c1, sfb[r0 + r1 + 2]);
      g.part3 = Math.min(bitsA, bitsB) + this.#region(g, 0, a1, 0) + this.#region(g, a1, a2, 1) + this.#region(g, a2, c1, 2);
      return g.part3;
    }

    /** Mejor tabla para la región [s, e) y su coste en bits. @param {Mp3Granule} g @param {number} s @param {number} e @param {number} r */
    #region(g, s, e, r) {
      const ix = g.ix;
      let max = 0;
      for (let i = s; i < e; i++) if (ix[i] > max) max = ix[i];
      g.tables[r] = 0;
      if (max === 0) return 0;
      let bestBits = Infinity;
      if (max <= 15) {
        for (const tab of MP3_CANDIDATES[max < 8 ? max : 8]) {
          const bits = this.#pairBits(ix, s, e, tab, 0);
          if (bits < bestBits) {
            bestBits = bits;
            g.tables[r] = tab;
          }
        }
        return bestBits;
      }
      const need = 32 - Math.clz32(max - 15);
      for (const base of [16, 24]) {
        let tab = base;
        while (tab < base + 8 && MP3_LINBITS[tab] < need) tab++;
        if (tab === base + 8) continue;
        const bits = this.#pairBits(ix, s, e, tab, MP3_LINBITS[tab]);
        if (bits < bestBits) {
          bestBits = bits;
          g.tables[r] = tab;
        }
      }
      return bestBits;
    }

    /** @param {Int32Array} ix @param {number} s @param {number} e @param {number} tab @param {number} linbits */
    #pairBits(ix, s, e, tab, linbits) {
      const lens = this.t.lens[tab];
      let bits = 0;
      for (let i = s; i < e; i += 2) {
        let x = ix[i];
        let y = ix[i + 1];
        bits += (x ? 1 : 0) + (y ? 1 : 0);
        if (linbits) {
          if (x >= 15) {
            x = 15;
            bits += linbits;
          }
          if (y >= 15) {
            y = 15;
            bits += linbits;
          }
        }
        bits += lens[x * 16 + y];
      }
      return bits;
    }

    /** @param {number} size @param {number} padding */
    #write(size, padding) {
      const out = new Uint8Array(size);
      const w = new BitWriter(out);
      const stereo = this.channels === 2;
      w.put(0xfff, 12);
      w.put(1, 1); // MPEG-1
      w.put(1, 2); // Layer III
      w.put(1, 1); // sin CRC
      w.put(this.kbpsIndex, 4);
      w.put(this.rateIndex, 2);
      w.put(padding, 1);
      w.put(0, 1);
      w.put(stereo ? 0 : 3, 2); // estéreo o mono
      w.put(0, 2);
      w.put(0, 1);
      w.put(1, 1); // original
      w.put(0, 2);
      w.put(0, 9); // main_data_begin: sin depósito de bits
      w.put(0, stereo ? 3 : 5);
      for (let ch = 0; ch < this.channels; ch++) w.put(0, 4); // scfsi
      for (let gr = 0; gr < 2; gr++) {
        for (let ch = 0; ch < this.channels; ch++) {
          const g = this.pool[gr][ch];
          w.put(g.part2 + g.part3, 12);
          w.put(g.bigValues, 9);
          w.put(g.gain, 8);
          w.put(g.compress, 4);
          w.put(0, 1); // sin cambio de ventana
          for (let r = 0; r < 3; r++) w.put(g.tables[r], 5);
          w.put(g.region0, 4);
          w.put(g.region1, 3);
          w.put(0, 1); // preflag
          w.put(0, 1); // scalefac_scale
          w.put(g.count1Table, 1);
        }
      }
      for (let gr = 0; gr < 2; gr++) for (let ch = 0; ch < this.channels; ch++) this.#writeMain(w, this.pool[gr][ch]);
      return out;
    }

    /** @param {BitWriter} w @param {Mp3Granule} g */
    #writeMain(w, g) {
      const [s1, s2] = MP3_SLEN[g.compress];
      for (let b = 0; b < 11; b++) w.put(g.sf[b], s1);
      for (let b = 11; b < 21; b++) w.put(g.sf[b], s2);
      const c1 = g.bigValues * 2;
      const a1 = Math.min(c1, this.sfb[g.region0 + 1]);
      const a2 = Math.min(c1, this.sfb[g.region0 + g.region1 + 2]);
      this.#writePairs(w, g, 0, a1, g.tables[0]);
      this.#writePairs(w, g, a1, a2, g.tables[1]);
      this.#writePairs(w, g, a2, c1, g.tables[2]);
      const t = this.t;
      const ix = g.ix;
      for (let i = c1; i < g.count1End; i += 4) {
        const q = (ix[i] << 3) | (ix[i + 1] << 2) | (ix[i + 2] << 1) | ix[i + 3];
        if (g.count1Table === 0) w.put(t.quadCodes[q], t.quadLens[q]);
        else w.put(15 - q, 4);
        for (let k = 0; k < 4; k++) if (ix[i + k]) w.put(g.neg[i + k], 1);
      }
    }

    /** @param {BitWriter} w @param {Mp3Granule} g @param {number} s @param {number} e @param {number} tab */
    #writePairs(w, g, s, e, tab) {
      if (tab === 0) return;
      const codes = this.t.codes[tab];
      const lens = this.t.lens[tab];
      const lb = MP3_LINBITS[tab];
      for (let i = s; i < e; i += 2) {
        const x = g.ix[i];
        const y = g.ix[i + 1];
        const cx = lb && x >= 15 ? 15 : x;
        const cy = lb && y >= 15 ? 15 : y;
        w.put(codes[cx * 16 + cy], lens[cx * 16 + cy]);
        if (lb && x >= 15) w.put(x - 15, lb);
        if (x) w.put(g.neg[i], 1);
        if (lb && y >= 15) w.put(y - 15, lb);
        if (y) w.put(g.neg[i + 1], 1);
      }
    }
  }

  /** Cadena de códec WebCodecs para AAC según su AudioSpecificConfig. @param {Uint8Array | null} asc */
  function aacCodecString(asc) {
    const aot = asc && asc.length ? asc[0] >> 3 : 2;
    return `mp4a.40.${aot || 2}`;
  }

  /**
   * Muestras (a 48 kHz) que produce un paquete Opus según su byte TOC (RFC 6716 §3.1).
   * @param {Uint8Array} packet
   */
  function opusPacketSamples(packet) {
    if (!packet.length) return 0;
    const config = packet[0] >> 3;
    const ms = config < 12 ? [10, 20, 40, 60][config & 3] : config < 16 ? [10, 20][config & 1] : [2.5, 5, 10, 20][config & 3];
    const code = packet[0] & 3;
    const frames = code === 0 ? 1 : code < 3 ? 2 : (packet[1] ?? 0) & 0x3f;
    return Math.round(ms * 48 * frames);
  }

  /** Remuestreo lineal (solo para frecuencias que MP3 no admite; YouTube casi nunca las usa). @param {Float32Array} input @param {number} from @param {number} to */
  function resampleLinear(input, from, to) {
    const n = Math.floor((input.length * to) / from);
    const out = new Float32Array(n);
    const step = from / to;
    for (let i = 0; i < n; i++) {
      const x = i * step;
      const k = Math.floor(x);
      const f = x - k;
      out[i] = input[k] * (1 - f) + (input[Math.min(k + 1, input.length - 1)] ?? 0) * f;
    }
    return out;
  }

  /**
   * Decodifica una pista de audio con WebCodecs (nativo del navegador) y la
   * recodifica a MP3 con el codificador propio. Coloca cada bloque según su
   * marca de tiempo: descarta el pre-skip de Opus y el cebado de AAC y rellena
   * con silencio si faltara algún trozo, así el MP3 queda sincronizado.
   * Corta muestra a muestra al tramo pedido.
   * @param {TrackPick} pick @param {number} kbps @param {MediaMeta} meta @param {TimeWindow} window
   * @param {(ratio: number) => void} onProgress
   * @returns {Promise<Uint8Array[]>}
   */
  async function transcodeToMp3(pick, kbps, meta, window, onProgress) {
    const info = pick.rep.info;
    if (typeof AudioDecoder === 'undefined') throw new Error('Este navegador no tiene WebCodecs: no puedo convertir a MP3.');
    const codec = { A_OPUS: 'opus', A_AAC: aacCodecString(info.codecPrivate), A_VORBIS: 'vorbis', 'A_MPEG/L3': 'mp3' }[info.codecId];
    if (!codec) throw new Error(`No sé convertir ${info.codecName} a MP3.`);
    /** @type {AudioDecoderConfig} */
    const config = { codec, sampleRate: Math.round(info.sampleRate), numberOfChannels: info.channels || 2 };
    if (info.codecPrivate) config.description = info.codecPrivate;
    if (!(await AudioDecoder.isConfigSupported(config)).supported) throw new Error(`Este navegador no decodifica ${info.codecName}.`);
    const isOpus = info.codecId === 'A_OPUS';
    const preSkipS = isOpus && info.codecPrivate ? (info.codecPrivate[10] | (info.codecPrivate[11] << 8)) / 48000 : 0;
    const { order } = pick;
    const s = pick.rep.samples;
    const usPerTick = info.msPerTick * 1000;
    const firstUs = order.length ? Math.round(s.pts[order[0]] * usPerTick) : 0;
    const firstNominal = isOpus && order.length ? opusPacketSamples(s.data[order[0]]) : 0;
    /** Desfase a restar a las marcas de tiempo; se decide con el primer bloque decodificado. */
    let delayS = NaN;
    /** @type {Uint8Array[]} */
    const out = [id3v23(meta.title, meta.artist)];
    /** @type {AudioData[]} */
    const ready = [];
    /** @type {Error | null} */
    let failure = null;
    const decoder = new AudioDecoder({ output: (d) => ready.push(d), error: (e) => { failure = e; } });
    decoder.configure(config);
    /** @type {Mp3Encoder | null} */
    let encoder = null;
    let outRate = 0;
    let written = 0; // muestras ya enviadas al codificador (0 = inicio del tramo)
    let limit = Infinity; // muestras que caben en el tramo
    const drain = () => {
      for (let d = ready.shift(); d; d = ready.shift()) {
        const channels = Math.min(2, d.numberOfChannels);
        if (!encoder) {
          outRate = MP3_RATES.includes(d.sampleRate) ? d.sampleRate : 48000;
          encoder = new Mp3Encoder(outRate, channels, kbps);
          limit = Math.round((window.endS - window.startS) * outRate);
          // Algunos decodificadores (Chrome con la cabecera OpusHead) ya descartan el pre-skip:
          // entonces el primer bloque trae menos muestras de las nominales y no hay que recortarlo otra vez.
          const trimmed = isOpus && firstNominal > 0 && d.numberOfFrames < firstNominal;
          delayS = trimmed ? (d.timestamp - firstUs) / 1e6 : preSkipS;
        }
        /** @type {Float32Array[]} */
        let planes = [];
        for (let c = 0; c < encoder.channels; c++) {
          const plane = new Float32Array(d.numberOfFrames);
          d.copyTo(plane, { planeIndex: Math.min(c, channels - 1), format: 'f32-planar' });
          planes.push(d.sampleRate === outRate ? plane : resampleLinear(plane, d.sampleRate, outRate));
        }
        const start = Math.round((d.timestamp / 1e6 - delayS - window.startS) * outRate);
        d.close();
        if (written >= limit) continue;
        const end = Math.min(start + planes[0].length, limit);
        if (start > written) { // hueco: silencio
          const fill = Math.min(start, limit) - written;
          out.push(...encoder.encode(Array.from({ length: encoder.channels }, () => new Float32Array(fill))));
          written += fill;
        }
        const skip = written - start; // solape o tramo anterior al inicio
        if (skip >= end - start) continue;
        planes = planes.map((p) => p.subarray(skip, end - start));
        out.push(...encoder.encode(planes));
        written = end;
      }
    };
    let lastYield = performance.now();
    for (let j = 0; j < order.length; j++) {
      const i = order[j];
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(s.pts[i] * usPerTick), data: s.data[i] }));
      if (decoder.decodeQueueSize > 32) await new Promise((r) => decoder.addEventListener('dequeue', r, { once: true }));
      drain();
      if (failure) throw failure;
      if (performance.now() - lastYield > 60) { // deja respirar a la página y avisa del avance
        onProgress(j / order.length);
        await yieldToPage();
        lastYield = performance.now();
      }
    }
    await decoder.flush();
    drain();
    decoder.close();
    if (failure) throw failure;
    if (!encoder) throw new Error('El audio no produjo muestras.');
    out.push(.../** @type {Mp3Encoder} */ (encoder).flush());
    onProgress(1);
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 10. Reproductor de YouTube
  // ═══════════════════════════════════════════════════════════════════════

  /** Texto de YouTube: entero o en trozos. @typedef {{simpleText?: string, runs?: Array<{text?: string}>}} YtText */
  /** Pista de subtítulos tal cual la anuncia YouTube. @typedef {{baseUrl?: string, name?: YtText, languageCode?: string, kind?: string, isTranslatable?: boolean}} RawCaptionTrack */
  /** Idioma de traducción tal cual lo anuncia YouTube. @typedef {{languageCode?: string, languageName?: YtText}} RawCaptionLanguage */

  /**
   * API interna del reproductor (#movie_player). Es privada y puede cambiar:
   * cada método se comprueba antes de usarse.
   * @typedef {HTMLElement & Partial<{
   *   getVideoData: () => ({video_id?: string, title?: string, author?: string} | undefined),
   *   getPlayerResponse: () => ({
   *     videoDetails?: {lengthSeconds?: string},
   *     captions?: {playerCaptionsTracklistRenderer?: {captionTracks?: RawCaptionTrack[], translationLanguages?: RawCaptionLanguage[]}},
   *   } | undefined),
   *   loadModule: (name: string) => void,
   *   unloadModule: (name: string) => void,
   *   getOption: (module: string, option: string, params?: unknown) => unknown,
   *   setOption: (module: string, option: string, value: unknown) => void,
   *   getDuration: () => number,
   *   getAvailableQualityLevels: () => string[],
   *   getAvailableQualityData: () => Array<{quality: string, qualityLabel?: string}>,
   *   setPlaybackQualityRange: (min: string, max?: string) => void,
   *   setPlaybackQuality: (quality: string) => void,
   *   getPlaybackQuality: () => string,
   *   loadVideoById: (id: string, startSeconds?: number) => void,
   *   seekTo: (seconds: number, allowSeekAhead?: boolean) => void,
   *   playVideo: () => void,
   *   pauseVideo: () => void,
   *   mute: () => void,
   *   unMute: () => void,
   *   isMuted: () => boolean,
   * }>} YtPlayerElement
   */

  /**
   * Modo compatible: responde «no admitido» a VP8, VP9, AV1 y Opus en las
   * consultas de capacidad del navegador (como la extensión h264ify), así el
   * reproductor elige H.264 + AAC. Solo cambia lo que el reproductor elige;
   * no toca ninguna protección.
   */
  class CodecGate {
    constructor() {
      /** @type {Array<() => void>} */
      this.restorers = [];
    }

    get active() {
      return this.restorers.length > 0;
    }

    install() {
      if (this.active) return;
      /** @param {unknown} type */
      const blocked = (type) => /vp0?8|vp0?9|av01|opus/i.test(String(type));
      const g = /** @type {any} */ (globalThis);
      for (const ctor of [g.MediaSource, g.ManagedMediaSource]) {
        if (typeof ctor?.isTypeSupported !== 'function') continue;
        this.#patch(ctor, 'isTypeSupported', (original) =>
          /** @param {string} type */ (type) => !blocked(type) && original.call(ctor, type));
      }
      this.#patch(HTMLMediaElement.prototype, 'canPlayType', (original) =>
        /** @this {HTMLMediaElement} @param {string} type */ function canPlayType(type) {
          return blocked(type) ? '' : original.call(this, type);
        });
      const caps = navigator.mediaCapabilities;
      if (typeof caps?.decodingInfo === 'function') {
        this.#patch(caps, 'decodingInfo', (original) =>
          /** @param {MediaDecodingConfiguration} config */ (config) => {
            const type = `${config.video?.contentType ?? ''} ${config.audio?.contentType ?? ''}`;
            if (blocked(type)) return Promise.resolve({ supported: false, smooth: false, powerEfficient: false, configuration: config });
            return original.call(caps, config);
          });
      }
    }

    uninstall() {
      for (let restore = this.restorers.pop(); restore; restore = this.restorers.pop()) restore();
    }

    /** @param {any} target @param {string} name @param {(original: Function) => Function} wrap */
    #patch(target, name, wrap) {
      patchMethod(target, name, wrap, this.restorers);
    }
  }

  /** @param {YtText | undefined} t @returns {string} */
  function ytText(t) {
    if (typeof t?.simpleText === 'string') return t.simpleText;
    return Array.isArray(t?.runs) ? t.runs.map((r) => r?.text ?? '').join('') : '';
  }

  /** Adaptador sobre el reproductor y su elemento <video>. */
  class YouTubePlayer {
    /** @returns {YtPlayerElement | null} */
    get element() {
      const shorts = location.pathname.startsWith('/shorts/');
      return /** @type {YtPlayerElement | null} */ (
        document.querySelector(shorts ? '#shorts-player' : '#movie_player') ?? document.querySelector('#movie_player'));
    }

    /** @returns {HTMLVideoElement | null} */
    get video() {
      return this.element?.querySelector('video') ?? document.querySelector('video');
    }

    videoId() {
      return this.element?.getVideoData?.()?.video_id || this.pageVideoId();
    }

    /**
     * Video que indica la dirección de la página ('' si no indica ninguno).
     * Uno abierto con loadVideoById (la cola) no cambia la página.
     */
    pageVideoId() {
      const fromQuery = new URLSearchParams(location.search).get('v');
      if (fromQuery) return fromQuery;
      const shorts = /^\/shorts\/([\w-]+)/.exec(location.pathname);
      return shorts ? shorts[1] : '';
    }

    /**
     * Título del video. El de la pestaña solo vale si la página es de este video.
     * @param {string} [fallback] si no se conoce
     */
    title(fallback = 'video') {
      const fromApi = (this.element?.getVideoData?.()?.title ?? '').trim();
      if (fromApi) return fromApi;
      const fromPage = document.title.replace(/\s*-\s*YouTube.*$/i, '').trim();
      return fromPage && this.pageVideoId() === this.videoId() ? fromPage : fallback;
    }

    /** Pistas de subtítulos y traducciones que YouTube anuncia para el video del reproductor. @returns {CaptionInfo} */
    captionInfo() {
      const list = this.element?.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer;
      /** @type {CaptionTrack[]} */
      const tracks = [];
      for (const t of Array.isArray(list?.captionTracks) ? list.captionTracks : []) {
        const code = typeof t?.languageCode === 'string' ? t.languageCode : '';
        if (!code) continue;
        const asr = t.kind === 'asr';
        tracks.push({
          languageCode: code, asr, label: ytText(t.name).trim() || `${code}${asr ? ' (automática)' : ''}`,
          baseUrl: typeof t.baseUrl === 'string' ? t.baseUrl : '', translatable: t.isTranslatable === true,
        });
      }
      /** @type {CaptionLanguage[]} */
      const translations = [];
      for (const l of Array.isArray(list?.translationLanguages) ? list.translationLanguages : []) {
        if (typeof l?.languageCode === 'string' && l.languageCode) translations.push({ code: l.languageCode, name: ytText(l.languageName).trim() || l.languageCode });
      }
      return { tracks, translations };
    }

    /** ¿Expone el reproductor su módulo de subtítulos? */
    hasCaptionModule() {
      const el = this.element;
      return typeof el?.setOption === 'function' && typeof el?.getOption === 'function';
    }

    /**
     * Carga el módulo de subtítulos; con `fresh`, antes lo descarga (así
     * olvida las pistas que ya tenía y las vuelve a pedir).
     * @param {boolean} [fresh]
     */
    loadCaptionModule(fresh = false) {
      const el = this.element;
      try {
        if (fresh) el?.unloadModule?.('captions');
        el?.loadModule?.('captions');
      } catch {
        // sin módulo: se probará otra vía
      }
    }

    /** Pistas que conoce el módulo de subtítulos (vacío si aún no cargó). @returns {Array<Record<string, unknown>>} */
    captionModuleTracks() {
      try {
        // includeAsr: sin él, algunas versiones no listan los automáticos.
        const list = this.element?.getOption?.('captions', 'tracklist', { includeAsr: true });
        return Array.isArray(list) ? list.filter((t) => t !== null && typeof t === 'object') : [];
      } catch {
        return [];
      }
    }

    /** Subtítulos que muestra ahora (null = ninguno). @returns {Record<string, unknown> | null} */
    captionTrack() {
      try {
        const t = /** @type {Record<string, unknown> | null | undefined} */ (this.element?.getOption?.('captions', 'track'));
        return t && typeof t === 'object' && typeof t.languageCode === 'string' && t.languageCode ? t : null;
      } catch {
        return null;
      }
    }

    /** Muestra esos subtítulos (null = ninguno). @param {Record<string, unknown> | null} track */
    setCaptionTrack(track) {
      try {
        this.element?.setOption?.('captions', 'track', track ?? {});
      } catch {
        // ídem
      }
    }

    /** Nombre del canal ('' si no se conoce). */
    author() {
      return (this.element?.getVideoData?.()?.author ?? '').trim();
    }

    /** Duración en segundos (0 si aún no se conoce). Durante un anuncio es la del anuncio. */
    duration() {
      const d = this.element?.getDuration?.() || this.video?.duration || 0;
      return Number.isFinite(d) ? d : 0;
    }

    /** Duración del video según su ficha (segundos enteros; 0 si el reproductor no la expone). Nunca es la de un anuncio. */
    listedLength() {
      const n = Number(this.element?.getPlayerResponse?.()?.videoDetails?.lengthSeconds);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    currentTime() {
      return this.video?.currentTime ?? 0;
    }

    ended() {
      return this.video?.ended === true;
    }

    isAdShowing() {
      const el = this.element;
      return !!el && (el.classList.contains('ad-showing') || el.classList.contains('ad-interrupting'));
    }

    /** @param {number} seconds */
    seek(seconds) {
      const el = this.element;
      if (typeof el?.seekTo === 'function') el.seekTo(seconds, true);
      else if (this.video) this.video.currentTime = seconds;
    }

    /** ¿Se está reproduciendo ahora? */
    isPlaying() {
      const v = this.video;
      return !!v && !v.paused && !v.ended;
    }

    /** ¿Pausado sin haber terminado? (p. ej. por el aviso «¿Sigues viendo?»). */
    isPaused() {
      const v = this.video;
      return !!v && v.paused && !v.ended;
    }

    pause() {
      const el = this.element;
      if (typeof el?.pauseVideo === 'function') el.pauseVideo();
      else this.video?.pause();
    }

    resume() {
      const el = this.element;
      // play() se rechaza si una recarga lo interrumpe: es normal y no debe ensuciar la consola.
      if (typeof el?.playVideo === 'function') void Promise.resolve(el.playVideo()).catch(() => {});
      else void this.video?.play().catch(() => {});
    }

    /** Contadores acumulados de fotogramas del <video> (0 si el navegador no los da). */
    frames() {
      const q = this.video?.getVideoPlaybackQuality?.();
      return { dropped: q?.droppedVideoFrames ?? 0, total: q?.totalVideoFrames ?? 0 };
    }

    /** Pulsa «Saltar» si YouTube lo ofrece en el anuncio actual. @returns {boolean} */
    skipAd() {
      const root = this.element ?? document;
      for (const node of root.querySelectorAll(SKIP_AD_SELECTOR)) {
        const button = /** @type {HTMLElement} */ (node);
        if (button.offsetParent === null) continue; // aún oculto
        button.click();
        return true;
      }
      return false;
    }

    /** Clave de la calidad que el reproductor usa ahora ('' si no se sabe). */
    currentQuality() {
      return this.element?.getPlaybackQuality?.() ?? '';
    }

    /** La calidad más baja disponible: para «Solo audio», así no se gasta red en imagen. */
    lowestQuality() {
      const list = this.qualities();
      return list.length ? list[list.length - 1].key : '';
    }

    /** @param {string} key */
    qualityLabel(key) {
      return this.qualities().find((q) => q.key === key)?.label ?? QUALITY_LABELS[key] ?? key;
    }

    /** Calidades disponibles, de mejor a peor. @returns {{key: string, label: string}[]} */
    qualities() {
      const el = this.element;
      const data = el?.getAvailableQualityData?.() ?? [];
      const levels = el?.getAvailableQualityLevels?.() ?? data.map((d) => d.quality);
      const labels = new Map(data.map((d) => [d.quality, d.qualityLabel]));
      const seen = new Set();
      /** @type {{key: string, label: string}[]} */
      const out = [];
      for (const key of levels) {
        if (!key || key === 'auto' || seen.has(key)) continue;
        seen.add(key);
        out.push({ key, label: labels.get(key) || QUALITY_LABELS[key] || key });
      }
      return out;
    }

    /** @param {string} key */
    lockQuality(key) {
      const el = this.element;
      if (!el || !key) return;
      el.setPlaybackQualityRange?.(key, key);
      el.setPlaybackQuality?.(key);
    }

    /**
     * Recarga el video desde `startS` para que el reproductor vuelva a entregar la
     * inicialización y todos los segmentos.
     * @param {string} id @param {number} [startS] @returns {boolean} false si solo pudo rebobinar
     */
    restart(id, startS = 0) {
      const el = this.element;
      if (typeof el?.loadVideoById === 'function') {
        el.loadVideoById(id, startS);
        return true;
      }
      const v = this.video;
      if (v) v.currentTime = startS;
      return false;
    }

    /** ¿Está el instante t en el búfer del reproductor? @param {number} t */
    isBuffered(t) {
      const r = this.video?.buffered;
      if (!r) return false;
      for (let i = 0; i < r.length; i++) if (r.start(i) - 0.1 <= t && t < r.end(i)) return true;
      return false;
    }

    /** Silencia y devuelve si ya estaba silenciado. */
    mute() {
      const el = this.element;
      const v = this.video;
      const wasMuted = el?.isMuted?.() ?? v?.muted ?? false;
      el?.mute?.();
      if (v) v.muted = true;
      return wasMuted;
    }

    unmute() {
      this.element?.unMute?.();
      const v = this.video;
      if (v) v.muted = false;
    }

    /** Aplica la velocidad (o la mayor aceptada). @param {number} rate @returns {number} */
    setRate(rate) {
      const v = this.video;
      if (!v) return 1;
      for (const r of [rate, 8, 4, 2, 1]) {
        try {
          if (v.playbackRate !== r) v.playbackRate = r;
          return r;
        } catch {
          // fuera del rango de este navegador: se prueba la siguiente
        }
      }
      return v.playbackRate;
    }
  }

  /**
   * Videos de la lista de reproducción que muestra la página (el panel de
   * una lista en reproducción o la página /playlist), en orden y sin repetir.
   * YouTube solo pinta los que caben en pantalla (un centenar): se toman los que haya.
   * @returns {{id: string, title: string}[]}
   */
  function playlistEntries() {
    /** @type {{id: string, title: string}[]} */
    const out = [];
    const seen = new Set();
    for (const node of document.querySelectorAll('ytd-playlist-panel-video-renderer a#wc-endpoint, ytd-playlist-video-renderer a#video-title')) {
      const link = /** @type {HTMLAnchorElement} */ (node);
      const id = parseVideoIds(link.href)[0];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const label = link.querySelector('#video-title') ?? link;
      out.push({ id, title: (label.getAttribute('title') || label.textContent || '').trim() });
    }
    return out;
  }

  /**
   * Calidad a usar de una lista (de mejor a peor): la preferida si existe; si
   * no, la mejor que no la supere; si todas la superan, la más baja.
   * @param {{key: string}[]} list @param {string} preferred @returns {string}
   */
  function pickQuality(list, preferred) {
    if (!list.length) return '';
    if (!preferred) return list[0].key;
    if (list.some((q) => q.key === preferred)) return preferred;
    const cap = QUALITY_HEIGHTS[preferred] ?? Infinity;
    return (list.find((q) => (QUALITY_HEIGHTS[q.key] ?? 0) <= cap) ?? list[list.length - 1]).key;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 11. Ritmo de captura: turbo y medición de velocidad
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Velocidad de captura (segundos de video por segundo real) en una ventana
   * deslizante. Las muestras viven en un anillo de tamaño fijo.
   */
  class RateMeter {
    /** @param {number} windowMs */
    constructor(windowMs) {
      this.windowMs = windowMs;
      this.wall = new Float64Array(128);
      this.media = new Float64Array(128);
      /** Índice de la muestra más antigua. */
      this.head = 0;
      this.count = 0;
    }

    reset() {
      this.head = 0;
      this.count = 0;
    }

    /** @param {number} wallMs @param {number} mediaS */
    add(wallMs, mediaS) {
      const cap = this.wall.length;
      if (this.count === cap) this.#dropOldest();
      const i = (this.head + this.count) % cap;
      this.wall[i] = wallMs;
      this.media[i] = mediaS;
      this.count++;
      // Conserva una única muestra anterior a la ventana para que el tramo la cubra entera.
      while (this.count > 2 && wallMs - this.wall[(this.head + 1) % cap] >= this.windowMs) this.#dropOldest();
    }

    /** Tiempo real que abarcan las muestras (ms). */
    get spanMs() {
      return this.count < 2 ? 0 : this.wall[this.#newest()] - this.wall[this.head];
    }

    /** Segundos de video por segundo real; NaN si aún no hay datos. */
    get speed() {
      const span = this.spanMs;
      return span > 0 ? ((this.media[this.#newest()] - this.media[this.head]) * 1000) / span : NaN;
    }

    #newest() {
      return (this.head + this.count - 1) % this.wall.length;
    }

    #dropOldest() {
      this.head = (this.head + 1) % this.wall.length;
      this.count--;
    }
  }

  /**
   * Turbo: mantiene el cabezal cerca del final de lo YA GUARDADO. Así el
   * reproductor nunca alcanza su meta de lectura adelantada y pide segmentos
   * sin pausa. Solo salta sobre lo que Sifón ya grabó, nunca sobre algo sin
   * guardar, de modo que no se pierde nada (y además se verifica al final).
   */
  class Pacer {
    /**
     * @param {YouTubePlayer} player @param {KeyframeLog} keyframes
     * @param {(t: number) => number} capturedEnd fin de lo ya grabado sin huecos desde t (NaN si t no lo está)
     */
    constructor(player, keyframes, capturedEnd) {
      this.player = player;
      this.keyframes = keyframes;
      this.capturedEnd = capturedEnd;
      this.enabled = false;
      this.leaps = 0;
      this.keyLeaps = 0;
      /** Final de lo cargado en el último salto: no se vuelve a saltar hasta que lleguen datos nuevos. */
      this.lastEnd = -Infinity;
    }

    /** @param {boolean} enabled */
    reset(enabled) {
      this.enabled = enabled;
      this.leaps = 0;
      this.keyLeaps = 0;
      this.lastEnd = -Infinity;
    }

    step() {
      const p = this.player;
      if (!this.enabled || p.isAdShowing()) return;
      const t = p.currentTime();
      // Se salta solo sobre lo que Sifón YA grabó, nunca sobre lo que el reproductor tenga en su
      // búfer sin haber pasado por la captura. Si lo grabado llega más allá del búfer, el salto
      // además evita volver a descargar lo que ya se tiene.
      const end = this.capturedEnd(t);
      if (!(end - t >= LEAP_TRIGGER_S) || end <= this.lastEnd) return; // también descarta NaN
      const target = end - LEAP_KEEP_S;
      // Caer en un fotograma clave ahorra decodificar el GOP: el navegador solo decodifica ese fotograma.
      const key = this.keyframes.latestBetween(t + KEY_MIN_ADVANCE_S, target);
      const onKey = !Number.isNaN(key);
      // Sin uno a mano, mejor esperar a que llegue más (el reproductor sigue pidiendo), salvo que lo grabado ya vaya muy por delante.
      if (!onKey && end - t < LEAP_TRIGGER_S * 2) return;
      p.seek(onKey ? key : target);
      this.lastEnd = end;
      this.leaps++;
      if (onKey) this.keyLeaps++;
    }
  }

  /**
   * @typedef {Object} PaceMode
   * @property {boolean} turbo  ¿salta el cabezal?
   * @property {number} rate    velocidad de reproducción
   * @property {string} label
   */

  /** Candidatos, en orden de preferencia ante un empate. */
  const PACE_MODES = Object.freeze({
    turbo: /** @type {PaceMode} */ ({ turbo: true, rate: CAPTURE_RATE, label: 'turbo' }),
    light: /** @type {PaceMode} */ ({ turbo: true, rate: LIGHT_DECODE_RATE, label: 'turbo ligero' }),
    classic: /** @type {PaceMode} */ ({ turbo: false, rate: CAPTURE_RATE, label: 'clásico (16×)' }),
  });

  /**
   * Elige el modo midiendo en vez de suponer: cada candidato corre una
   * ventana y gana el más rápido. «Ligero» solo se prueba si el decodificador
   * descarta fotogramas a 16×; «clásico», solo si el turbo no pasa de
   * TURBO_MIN_SPEED (tope de la red o un reproductor que no colabora).
   */
  class PaceGovernor {
    constructor() {
      /** @type {PaceMode} */
      this.mode = PACE_MODES.classic;
      this.locked = true;
      /** @type {Map<PaceMode, number>} */
      this.speeds = new Map();
      this.dropped0 = 0;
      this.total0 = 0;
    }

    /** @param {boolean} turbo @param {{dropped: number, total: number}} frames */
    reset(turbo, frames) {
      this.mode = turbo ? PACE_MODES.turbo : PACE_MODES.classic;
      this.locked = !turbo;
      this.speeds.clear();
      this.#mark(frames);
    }

    /**
     * Cierra la ventana del modo actual.
     * @param {number} speed segundos de video por segundo real
     * @param {{dropped: number, total: number}} frames contadores acumulados del <video>
     * @returns {boolean} true si cambió de modo (el medidor debe reiniciarse)
     */
    evaluate(speed, frames) {
      if (this.locked) return false;
      const decoded = frames.total - this.total0;
      const droppedRatio = decoded > 0 ? (frames.dropped - this.dropped0) / decoded : 0;
      this.speeds.set(this.mode, speed);
      /** @type {PaceMode | null} */
      let next = null;
      if (this.mode === PACE_MODES.turbo && droppedRatio >= DROPPED_FRAMES_LIMIT) next = PACE_MODES.light;
      if ((!next || this.speeds.has(next)) && speed < TURBO_MIN_SPEED) next = PACE_MODES.classic;
      if (!next || this.speeds.has(next)) {
        next = this.#best();
        this.locked = true;
      }
      const changed = next !== this.mode;
      this.mode = next;
      this.#mark(frames);
      return changed;
    }

    /** «turbo ×30 · turbo ligero ×45» */
    summary() {
      return [...this.speeds].map(([m, s]) => `${m.label} ×${s >= 10 ? Math.round(s) : s.toFixed(1)}`).join(' · ');
    }

    #best() {
      /** @type {PaceMode | null} */
      let best = null;
      let bestSpeed = 0;
      for (const mode of Object.values(PACE_MODES)) {
        const s = this.speeds.get(mode);
        if (s === undefined) continue;
        if (!best || s > bestSpeed * MODE_SWITCH_MARGIN) {
          best = mode;
          bestSpeed = s;
        }
      }
      return best ?? this.mode;
    }

    /** @param {{dropped: number, total: number}} frames */
    #mark(frames) {
      this.dropped0 = frames.dropped;
      this.total0 = frames.total;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 12. Cola de videos
  // ═══════════════════════════════════════════════════════════════════════

  /** Clave con la que la cola se recuerda entre recargas (localStorage de la página). */
  const QUEUE_KEY = 'sifon:cola';
  /** Tope de videos en la cola. */
  const QUEUE_MAX = 500;
  /** Tiempo máximo para que abra un video de la cola, sin contar sus anuncios (ms). */
  const QUEUE_LOAD_TIMEOUT_MS = 60_000;
  /** Cada cuánto se mira si ya abrió (además, cada evento del <video> lo mira al momento) (ms). */
  const QUEUE_POLL_MS = 300;
  /** Pausa entre un video y el siguiente para que se vea el resultado; con la pestaña oculta no se espera (ms). */
  const QUEUE_GAP_MS = 1200;

  /** @typedef {'pending'|'active'|'done'|'error'} QueueStatus */
  /** @typedef {{id: string, title: string, status: QueueStatus, note: string}} QueueItem */

  /**
   * Videos por capturar, en orden, con su estado. Se guarda en el navegador:
   * si la página se recarga, al volver a pegar el script la cola sigue ahí
   * (lo que se estaba capturando vuelve a quedar pendiente).
   */
  class CaptureQueue {
    /** @param {string} storageKey */
    constructor(storageKey) {
      this.storageKey = storageKey;
      /** @type {QueueItem[]} */
      this.items = this.#load();
    }

    /**
     * Añade al final. Un video ya terminado vuelve a quedar pendiente; uno
     * pendiente no se repite.
     * @param {{id: string, title?: string}[]} entries @returns {number} cuántos quedaron añadidos
     */
    add(entries) {
      let added = 0;
      for (const { id, title = '' } of entries) {
        if (!VIDEO_ID_PATTERN.test(id)) continue;
        const k = this.items.findIndex((it) => it.id === id);
        let previous = '';
        if (k >= 0) {
          const old = this.items[k];
          if (old.status === 'pending' || old.status === 'active') continue;
          previous = old.title;
          this.items.splice(k, 1);
        }
        if (this.items.length >= QUEUE_MAX) break;
        this.items.push({ id, title: title || previous, status: 'pending', note: '' });
        added++;
      }
      if (added) this.#save();
      return added;
    }

    /** Quita un video (salvo el que se está capturando). @param {string} id */
    remove(id) {
      const before = this.items.length;
      this.items = this.items.filter((it) => it.id !== id || it.status === 'active');
      if (this.items.length !== before) this.#save();
    }

    /** Quita los terminados (guardados o con error). */
    clearFinished() {
      this.items = this.items.filter((it) => it.status === 'pending' || it.status === 'active');
      this.#save();
    }

    /** @returns {QueueItem | null} el primero pendiente */
    next() {
      return this.items.find((it) => it.status === 'pending') ?? null;
    }

    /** @param {string} id @param {Partial<Omit<QueueItem, 'id'>>} patch */
    update(id, patch) {
      const item = this.items.find((it) => it.id === id);
      if (!item) return;
      Object.assign(item, patch);
      this.#save();
    }

    /** @returns {Record<QueueStatus, number>} */
    counts() {
      const c = { pending: 0, active: 0, done: 0, error: 0 };
      for (const it of this.items) c[it.status]++;
      return c;
    }

    /** @returns {QueueItem[]} */
    #load() {
      try {
        const raw = JSON.parse(localStorage.getItem(this.storageKey) ?? '[]');
        if (!Array.isArray(raw)) return [];
        return raw.filter((it) => it && typeof it.id === 'string' && VIDEO_ID_PATTERN.test(it.id)).slice(0, QUEUE_MAX).map((it) => ({
          id: it.id,
          title: typeof it.title === 'string' ? it.title : '',
          status: /** @type {QueueStatus} */ (it.status === 'done' || it.status === 'error' ? it.status : 'pending'),
          note: typeof it.note === 'string' ? it.note : '',
        }));
      } catch {
        return []; // sin almacenamiento o dato dañado: cola vacía
      }
    }

    #save() {
      try {
        localStorage.setItem(this.storageKey, JSON.stringify(this.items));
      } catch {
        // sin almacenamiento: la cola dura mientras el panel esté abierto
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 13. Transcripción: los subtítulos que YouTube ofrece para el video
  // ═══════════════════════════════════════════════════════════════════════

  /** Un subtítulo y su intervalo (ms). @typedef {{startMs: number, endMs: number, text: string}} Cue */

  /**
   * Pista de subtítulos que YouTube anuncia para el video.
   * @typedef {Object} CaptionTrack
   * @property {string} languageCode  p. ej. 'es', 'en', 'pt-BR'
   * @property {string} label         nombre que le da YouTube («Español», «Inglés (generados automáticamente)»)
   * @property {boolean} asr          ¿automática (reconocimiento de voz)?
   * @property {string} baseUrl       dirección de la pista ('' si no la da)
   * @property {boolean} translatable ¿YouTube la traduce a otros idiomas?
   */

  /** Idioma al que YouTube puede traducir. @typedef {{code: string, name: string}} CaptionLanguage */
  /** Pistas y traducciones de un video. @typedef {{tracks: CaptionTrack[], translations: CaptionLanguage[]}} CaptionInfo */

  /**
   * Qué transcripción se quiere: una pista, tal cual o traducida por YouTube.
   * @typedef {{track: CaptionTrack, translateTo: string, translateName: string}} TranscriptChoice translateTo '' = sin traducir
   */

  /** Opción del selector de idioma. @typedef {{value: string, label: string, choice: TranscriptChoice}} TranscriptOption */
  /** @typedef {'srt'|'vtt'|'txt'|'txtplain'} TranscriptFormat */
  /** De dónde salió: ya recibida, el enlace de la pista, el reproductor o el panel de la página. @typedef {'memoria'|'enlace'|'reproductor'|'panel'} TranscriptVia */
  /** Lo que se recuerda entre visitas. @typedef {{lang: string, format: TranscriptFormat, withCapture: boolean}} TranscriptPrefs */

  /** @type {ReadonlyArray<[TranscriptFormat, string]>} */
  const TRANSCRIPT_FORMATS = [
    ['srt', 'SRT (subtítulos)'],
    ['vtt', 'VTT (web)'],
    ['txt', 'TXT con tiempos'],
    ['txtplain', 'TXT solo texto'],
  ];
  /** @type {Readonly<Record<TranscriptVia, string>>} */
  const TRANSCRIPT_VIA_LABEL = Object.freeze({
    memoria: 'ya recibida', enlace: 'enlace de YouTube', reproductor: 'vía el reproductor', panel: 'panel «Mostrar transcripción»',
  });
  /** Cuánto se espera a que el reproductor descargue la pista pedida (ms; en el segundo intento, el doble). */
  const CAPTION_WAIT_MS = 4000;
  /** Cuánto se espera a que el módulo de subtítulos del reproductor esté listo (ms). */
  const CAPTION_MODULE_WAIT_MS = 2500;
  /** Cuánto se espera a que el panel «Mostrar transcripción» pinte sus fragmentos (ms). */
  const TRANSCRIPT_PANEL_WAIT_MS = 4000;
  /** Transcripciones recordadas en memoria (las últimas). */
  const TRANSCRIPT_CACHE_MAX = 24;
  /** En el texto corrido, una pausa así entre subtítulos abre párrafo (ms). */
  const PARAGRAPH_GAP_MS = 2500;
  /** …y un punto final con el párrafo ya así de largo también (caracteres; con el doble, aunque no haya punto). */
  const PARAGRAPH_CHARS = 450;
  /** Duración que se le supone a un subtítulo que no trae la suya (ms). */
  const CUE_FALLBACK_MS = 2000;
  /** Dónde se recuerdan idioma, formato y «también con cada captura». */
  const TRANSCRIPT_PREFS_KEY = 'sifon:transcripcion';
  /** Respuestas que se escuchan: subtítulos (timedtext) y el panel de transcripción (InnerTube). */
  const TIMEDTEXT_URL = /\/api\/timedtext(?:[?#]|$)/;
  const TRANSCRIPT_PANEL_URL = /\/youtubei\/v1\/get_(?:transcript|panel)(?:[?#]|$)/;
  /** Botón «Mostrar transcripción» de la descripción. */
  const TRANSCRIPT_BUTTON_SELECTOR = 'ytd-video-description-transcript-section-renderer button, button[aria-label="Show transcript"], button[aria-label="Mostrar transcripción"]';
  /** Fragmentos del panel: diseño nuevo y anterior. */
  const TRANSCRIPT_SEGMENT_SELECTOR = 'transcript-segment-view-model, ytd-transcript-segment-renderer';
  const TRANSCRIPT_PANEL_SELECTOR = 'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
  /** @type {Readonly<Record<string, string>>} */
  const NAMED_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });

  /** ¿Es una respuesta de subtítulos o del panel de transcripción? @param {string} url */
  function isTranscriptUrl(url) {
    return TIMEDTEXT_URL.test(url) || TRANSCRIPT_PANEL_URL.test(url);
  }

  /**
   * Clave de una transcripción: video, idioma, si es automática y a qué se tradujo.
   * @param {string} videoId @param {string} lang @param {boolean} asr @param {string} translateTo
   */
  function captionKey(videoId, lang, asr, translateTo) {
    return `${videoId}|${lang.toLowerCase()}|${asr ? 'asr' : ''}|${translateTo.toLowerCase()}`;
  }

  /** Clave de lo que mostró el panel «Mostrar transcripción» de un video. @param {string} videoId */
  function panelKey(videoId) {
    return `${videoId}|panel`;
  }

  /** Idioma base («es-419» → «es»). @param {string} code */
  function languageBase(code) {
    return code.toLowerCase().split(/[-_]/)[0];
  }

  // ── Lectura de los formatos de YouTube ──────────────────────────────────

  /** Entidades XML/HTML (&amp; &lt; &#39; &#x27;…) → caracteres. @param {string} s */
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
      if (entity[0] !== '#') return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
  }

  /** Atributos de una etiqueta XML («t="10" d="20"»). @param {string} tag @returns {Record<string, string>} */
  function xmlAttributes(tag) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeEntities(m[2]);
    return out;
  }

  /**
   * Subtítulos de una respuesta de timedtext en cualquiera de sus formatos
   * (json3, srv3, srv1 o WebVTT), en bruto: sin ordenar ni limpiar.
   * @param {string} body @returns {Cue[]}
   */
  function parseTimedText(body) {
    const text = body.replace(/^﻿/, '').trimStart();
    if (text.startsWith('{')) return parseJson3(text);
    if (text.startsWith('WEBVTT')) return parseVtt(text);
    if (/<timedtext[\s>]/.test(text)) return parseSrv3(text);
    if (/<transcript[\s>]/.test(text)) return parseSrv1(text);
    return [];
  }

  /**
   * json3 (el que usa el reproductor): eventos con tStartMs/dDurationMs y
   * trozos utf8. En los automáticos, los eventos que solo añaden un salto de
   * línea no traen texto y se descartan.
   * @param {string} text @returns {Cue[]}
   */
  function parseJson3(text) {
    /** @type {any} */
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return [];
    }
    /** @type {Cue[]} */
    const out = [];
    for (const e of Array.isArray(data?.events) ? data.events : []) {
      if (!Array.isArray(e?.segs)) continue;
      const words = e.segs.map((/** @type {any} */ s) => (typeof s?.utf8 === 'string' ? s.utf8 : '')).join('');
      const start = Number(e.tStartMs);
      if (!words.trim() || !Number.isFinite(start)) continue;
      const dur = Number(e.dDurationMs);
      out.push({ startMs: start, endMs: start + (dur > 0 ? dur : 0), text: words });
    }
    return out;
  }

  /** srv3: <p t="ms" d="ms">texto<s t="ms">palabra</s></p>. @param {string} text @returns {Cue[]} */
  function parseSrv3(text) {
    /** @type {Cue[]} */
    const out = [];
    for (const m of text.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
      const a = xmlAttributes(m[1]);
      const start = Number(a.t);
      const inner = decodeEntities(m[2].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
      if (!inner.trim() || !Number.isFinite(start)) continue;
      const dur = Number(a.d ?? 5000); // sin «d», un párrafo dura 5 s
      out.push({ startMs: start, endMs: start + (dur > 0 ? dur : 0), text: inner });
    }
    return out;
  }

  /** srv1: <text start="s" dur="s">texto</text>; el texto a veces viene escapado dos veces. @param {string} text @returns {Cue[]} */
  function parseSrv1(text) {
    /** @type {Cue[]} */
    const out = [];
    for (const m of text.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
      const a = xmlAttributes(m[1]);
      const start = Number(a.start) * 1000;
      let inner = decodeEntities(m[2]);
      if (/&(#x?[0-9a-f]+|[a-z]+);/i.test(inner)) inner = decodeEntities(inner);
      inner = inner.replace(/<[^>]*>/g, '');
      if (!inner.trim() || !Number.isFinite(start)) continue;
      const dur = Number(a.dur) * 1000;
      out.push({ startMs: start, endMs: start + (dur > 0 ? dur : 0), text: inner });
    }
    return out;
  }

  /** WebVTT: «00:00:01.000 --> 00:00:03.500» y el texto hasta la línea en blanco. @param {string} text @returns {Cue[]} */
  function parseVtt(text) {
    /** @type {Cue[]} */
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{3})/.exec(lines[i]);
      if (!m) continue;
      /** @type {string[]} */
      const body = [];
      for (i++; i < lines.length && lines[i].trim(); i++) body.push(lines[i]);
      const words = decodeEntities(body.join('\n').replace(/<[^>]*>/g, ''));
      if (words.trim()) out.push({ startMs: vttMs(m[1]), endMs: vttMs(m[2]), text: words });
    }
    return out;
  }

  /** «01:02:03.456» o «02:03.456» → ms. @param {string} clock */
  function vttMs(clock) {
    let seconds = 0;
    for (const part of clock.replace(',', '.').split(':')) seconds = seconds * 60 + Number(part);
    return Math.round(seconds * 1000);
  }

  /**
   * Fragmentos de la respuesta del panel de transcripción (InnerTube
   * get_transcript): objetos transcriptSegmentRenderer con startMs/endMs. Se
   * buscan a cualquier profundidad: lo de alrededor cambia a menudo.
   * @param {unknown} root @returns {Cue[]}
   */
  function parseTranscriptPanelJson(root) {
    /** @type {Cue[]} */
    const out = [];
    /** @type {unknown[]} */
    const stack = [root];
    for (let visited = 0; stack.length && visited < 500_000; visited++) {
      const node = /** @type {any} */ (stack.pop());
      if (!node || typeof node !== 'object') continue;
      const seg = node.transcriptSegmentRenderer;
      if (seg && typeof seg === 'object') {
        const start = Number(seg.startMs);
        const end = Number(seg.endMs);
        const words = ytText(seg.snippet);
        if (Number.isFinite(start) && words.trim()) out.push({ startMs: start, endMs: Number.isFinite(end) ? end : start, text: words });
        continue;
      }
      for (const value of Array.isArray(node) ? node : Object.values(node)) if (value && typeof value === 'object') stack.push(value);
    }
    return out;
  }

  /** Espacios normalizados en cada línea y sin líneas vacías; los saltos de línea se conservan. @param {string} text */
  function cleanCueText(text) {
    return text.replace(/ /g, ' ').replace(/[​‎‏﻿]/g, '').split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  }

  /**
   * Ordena y limpia: sin vacíos ni repetidos seguidos; los que empiezan a la
   * vez se juntan; y cada subtítulo dura como mucho hasta que empieza el
   * siguiente (los automáticos de YouTube se muestran en ventanas que se pisan).
   * @param {Cue[]} cues @returns {Cue[]}
   */
  function normalizeCues(cues) {
    const sorted = cues
      .map((c) => ({ startMs: Math.max(0, Math.round(c.startMs)), endMs: Math.round(c.endMs), text: cleanCueText(c.text) }))
      .filter((c) => c.text)
      .sort((a, b) => a.startMs - b.startMs);
    /** @type {Cue[]} */
    const out = [];
    for (const c of sorted) {
      const prev = out[out.length - 1];
      if (prev && prev.text === c.text && c.startMs <= prev.endMs + 50) {
        prev.endMs = Math.max(prev.endMs, c.endMs);
      } else if (prev && prev.startMs === c.startMs) {
        prev.text += `\n${c.text}`;
        prev.endMs = Math.max(prev.endMs, c.endMs);
      } else {
        out.push(c);
      }
    }
    for (let k = 0; k < out.length; k++) {
      const cue = out[k];
      const next = out[k + 1];
      if (cue.endMs <= cue.startMs) cue.endMs = cue.startMs + CUE_FALLBACK_MS;
      if (next && cue.endMs > next.startMs) cue.endMs = next.startMs;
    }
    return out;
  }

  // ── Escritura: SRT, WebVTT y texto ──────────────────────────────────────

  /** ms → «HH:MM:SS,mmm» (SRT) o «HH:MM:SS.mmm» (WebVTT). @param {number} ms @param {',' | '.'} sep */
  function cueClock(ms, sep) {
    const t = Math.max(0, Math.round(ms));
    const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
    return `${two(Math.floor(t / 3_600_000))}:${two(Math.floor(t / 60_000) % 60)}:${two(Math.floor(t / 1000) % 60)}${sep}${String(t % 1000).padStart(3, '0')}`;
  }

  /** @param {Cue[]} cues */
  function formatSrt(cues) {
    return cues.map((c, k) => `${k + 1}\n${cueClock(c.startMs, ',')} --> ${cueClock(c.endMs, ',')}\n${c.text}\n`).join('\n');
  }

  /** @param {Cue[]} cues */
  function formatVtt(cues) {
    // En WebVTT el texto admite etiquetas: &, < y > van escapados (así tampoco aparece «-->»).
    const escape = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `WEBVTT\n\n${cues.map((c) => `${cueClock(c.startMs, '.')} --> ${cueClock(c.endMs, '.')}\n${escape(c.text)}\n`).join('\n')}`;
  }

  /** Texto con tiempos: una línea por subtítulo, «[m:ss] texto», como el panel de YouTube. @param {Cue[]} cues @param {string[]} header */
  function formatTranscriptLines(cues, header) {
    const lines = cues.map((c) => `[${formatTime(Math.floor(c.startMs / 1000) * 1000)}] ${c.text.replace(/\n/g, ' ')}`);
    return `${header.join('\n')}\n\n${lines.join('\n')}\n`;
  }

  /**
   * Texto corrido en párrafos: una pausa larga, o un punto final con el
   * párrafo ya largo, abre uno nuevo.
   * @param {Cue[]} cues @param {string[]} header
   */
  function formatTranscriptParagraphs(cues, header) {
    /** @type {string[][]} */
    const paragraphs = [];
    /** @type {string[]} */
    let current = [];
    let length = 0;
    let lastEnd = -Infinity;
    for (const c of cues) {
      const words = c.text.replace(/\n/g, ' ');
      const sentenceDone = /[.!?…]["»”')\]]*$/.test(current[current.length - 1] ?? '');
      if (!current.length || c.startMs - lastEnd >= PARAGRAPH_GAP_MS || (sentenceDone && length >= PARAGRAPH_CHARS) || length >= PARAGRAPH_CHARS * 2) {
        current = [];
        paragraphs.push(current);
        length = 0;
      }
      current.push(words);
      length += words.length + 1;
      lastEnd = c.endMs;
    }
    return `${header.join('\n')}\n\n${paragraphs.map((p) => p.join(' ')).join('\n\n')}\n`;
  }

  /**
   * Archivo de transcripción listo para guardar. El nombre lleva el idioma
   * («Título.es.srt»), así VLC y mpv lo cargan solos junto al video.
   * @param {Cue[]} cues @param {TranscriptFormat} format
   * @param {{title: string, videoId: string, choice: TranscriptChoice, via: TranscriptVia}} meta
   * @returns {{blob: Blob, name: string}}
   */
  function buildTranscriptFile(cues, format, meta) {
    const { choice } = meta;
    // El panel muestra el idioma que tenga elegido: el nombre no lo afirma.
    const lang = meta.via === 'panel' ? 'transcripcion' : choice.translateTo || choice.track.languageCode;
    const source = meta.via === 'panel' ? 'Panel «Mostrar transcripción» de YouTube'
      : choice.translateTo ? `Traducción automática de YouTube (${choice.translateName || choice.translateTo}) de «${choice.track.label}»`
        : `Subtítulos «${choice.track.label}»${choice.track.asr ? ' (generados automáticamente por YouTube)' : ''}`;
    const header = [meta.title, `https://www.youtube.com/watch?v=${meta.videoId}`, source];
    /** @type {[string, string, string]} contenido, extensión, tipo */
    const [body, ext, type] = format === 'srt' ? [formatSrt(cues), 'srt', 'application/x-subrip']
      : format === 'vtt' ? [formatVtt(cues), 'vtt', 'text/vtt']
        : [format === 'txt' ? formatTranscriptLines(cues, header) : formatTranscriptParagraphs(cues, header), 'txt', 'text/plain'];
    // Con BOM, el Bloc de notas y los reproductores antiguos de Windows reconocen el UTF-8.
    return { blob: new Blob(['﻿', body], { type: `${type};charset=utf-8` }), name: fileName(meta.title, '', `${lang}.${ext}`) };
  }

  // ── Elección de idioma ──────────────────────────────────────────────────

  /**
   * Opciones para elegir: cada pista tal cual y, si ninguna está en el
   * idioma preferido, su traducción automática desde la mejor pista traducible.
   * @param {CaptionInfo} info @param {string} preferred código de idioma ('es')
   * @returns {TranscriptOption[]}
   */
  function transcriptOptions(info, preferred) {
    /** @type {TranscriptOption[]} */
    const out = info.tracks.map((track, k) => ({ value: `t${k}`, label: track.label, choice: { track, translateTo: '', translateName: '' } }));
    const base = languageBase(preferred);
    const target = info.translations.find((l) => languageBase(l.code) === base);
    const source = info.tracks.find((t) => t.translatable && !t.asr) ?? info.tracks.find((t) => t.translatable);
    if (target && source && !info.tracks.some((t) => languageBase(t.languageCode) === base)) {
      out.push({
        value: `x${info.tracks.indexOf(source)}`, label: `${target.name} (traducción automática de YouTube)`,
        choice: { track: source, translateTo: target.code, translateName: target.name },
      });
    }
    return out;
  }

  /**
   * La opción por defecto: en el idioma preferido (la del autor antes que la
   * automática; la original antes que la traducida); si no hay, la del
   * autor; si no, la primera.
   * @param {TranscriptOption[]} options @param {string} preferred @returns {TranscriptOption | null}
   */
  function defaultTranscriptOption(options, preferred) {
    const base = languageBase(preferred);
    const inLanguage = (/** @type {TranscriptOption} */ o) => languageBase(o.choice.translateTo || o.choice.track.languageCode) === base;
    return options.find((o) => inLanguage(o) && !o.choice.translateTo && !o.choice.track.asr)
      ?? options.find((o) => inLanguage(o) && !o.choice.translateTo)
      ?? options.find(inLanguage)
      ?? options.find((o) => !o.choice.track.asr)
      ?? options[0] ?? null;
  }

  /** @returns {TranscriptPrefs} */
  function loadTranscriptPrefs() {
    /** @type {TranscriptPrefs} */
    const fallback = { lang: languageBase(navigator.language || 'es'), format: 'srt', withCapture: false };
    try {
      const p = JSON.parse(localStorage.getItem(TRANSCRIPT_PREFS_KEY) ?? 'null');
      return {
        lang: typeof p?.lang === 'string' && p.lang ? p.lang : fallback.lang,
        format: TRANSCRIPT_FORMATS.some(([f]) => f === p?.format) ? p.format : fallback.format,
        withCapture: p?.withCapture === true,
      };
    } catch {
      return fallback; // sin almacenamiento o dato dañado
    }
  }

  /** @param {TranscriptPrefs} prefs */
  function saveTranscriptPrefs(prefs) {
    try {
      localStorage.setItem(TRANSCRIPT_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // sin almacenamiento: dura mientras el panel esté abierto
    }
  }

  // ── El panel «Mostrar transcripción» de la página ───────────────────────

  /** Fragmentos que pinta el panel (diseño nuevo y anterior); cada uno dura hasta el siguiente. @returns {Cue[]} */
  function readTranscriptSegments() {
    /** @type {Cue[]} */
    const out = [];
    for (const node of document.querySelectorAll(TRANSCRIPT_SEGMENT_SELECTOR)) {
      const time = node.querySelector('.ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp')?.textContent ?? '';
      const words = node.querySelector('span[role="text"], .segment-text')?.textContent ?? '';
      const s = parseClock(time.trim());
      if (s === null || Number.isNaN(s) || !words.trim()) continue;
      out.push({ startMs: s * 1000, endMs: 0, text: words });
    }
    for (let k = 0; k < out.length; k++) out[k].endMs = out[k + 1]?.startMs ?? out[k].startMs + CUE_FALLBACK_MS * 2;
    return out;
  }

  /** @returns {HTMLElement | null} */
  function findTranscriptButton() {
    const direct = document.querySelector(TRANSCRIPT_BUTTON_SELECTOR);
    if (direct instanceof HTMLElement) return direct;
    // Con la interfaz en otro idioma: un botón de la descripción que hable de la transcripción.
    for (const b of document.querySelectorAll('#description button, ytd-structured-description-content-renderer button')) {
      if (/transcri/i.test(`${b.textContent} ${b.getAttribute('aria-label') ?? ''}`)) return /** @type {HTMLElement} */ (b);
    }
    return null;
  }

  function closeTranscriptPanel() {
    const panel = document.querySelector(TRANSCRIPT_PANEL_SELECTOR);
    if (!panel) return;
    const close = panel.querySelector('#visibility-button button, button[aria-label*="Close" i], button[aria-label*="Cerrar" i]');
    if (close instanceof HTMLElement) close.click();
    else panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
  }

  /**
   * Repite `probe` hasta que dé algo (ni null ni una lista vacía) o pase `ms`.
   * @template T @param {() => T | null | undefined} probe @param {number} ms @returns {Promise<T | null>}
   */
  function waitFor(probe, ms) {
    const deadline = performance.now() + ms;
    return new Promise((resolve) => {
      const check = () => {
        /** @type {T | null} */
        let value = null;
        try {
          value = probe() ?? null;
        } catch {
          value = null;
        }
        if (value !== null && !(Array.isArray(value) && value.length === 0)) resolve(value);
        else if (performance.now() >= deadline) resolve(null);
        else setTimeout(check, 100);
      };
      check();
    });
  }

  // ── Escucha, memoria y búsqueda ─────────────────────────────────────────

  /**
   * Escucha, sin alterar nada, las respuestas de subtítulos que pide el propio
   * reproductor (o la página, al abrir el panel de transcripción). Parchea
   * XMLHttpRequest y la lectura de Response en sus prototipos: así ve también
   * las peticiones de quien guardó su propia referencia a fetch.
   */
  class TimedTextTap {
    /** @param {(url: string, body: string) => void} onBody */
    constructor(onBody) {
      this.onBody = onBody;
      /** @type {Array<() => void>} */
      this.restorers = [];
      /** @type {WeakMap<XMLHttpRequest, string>} */
      this.urls = new WeakMap();
    }

    install() {
      if (this.restorers.length) return;
      const tap = this;
      patchMethod(XMLHttpRequest.prototype, 'open', (original) =>
        /** @this {XMLHttpRequest} @param {string} method @param {string | URL} url @param {...unknown} rest */
        function open(method, url, ...rest) {
          tap.urls.set(this, String(url));
          return original.call(this, method, url, ...rest);
        }, this.restorers);
      patchMethod(XMLHttpRequest.prototype, 'send', (original) =>
        /** @this {XMLHttpRequest} @param {...unknown} args */
        function send(...args) {
          const url = tap.urls.get(this) ?? '';
          if (isTranscriptUrl(url)) this.addEventListener('load', () => tap.#fromXhr(this, url), { once: true });
          return original.apply(this, args);
        }, this.restorers);
      for (const name of ['text', 'json', 'arrayBuffer']) {
        patchMethod(Response.prototype, name, (original) =>
          /** @this {Response} @param {...unknown} args */
          function read(...args) {
            const pending = original.apply(this, args);
            const url = this.url;
            if (isTranscriptUrl(url)) pending.then((/** @type {unknown} */ value) => tap.#deliver(url, value), () => {});
            return pending;
          }, this.restorers);
      }
    }

    uninstall() {
      for (let restore = this.restorers.pop(); restore; restore = this.restorers.pop()) restore();
    }

    /** @param {XMLHttpRequest} req @param {string} url */
    #fromXhr(req, url) {
      try {
        if (req.status < 200 || req.status >= 300) return;
        const type = req.responseType;
        if (type === '' || type === 'text') this.#deliver(url, req.responseText);
        else if (type === 'json' || type === 'arraybuffer') this.#deliver(url, req.response);
        else if (type === 'blob' && req.response instanceof Blob) void req.response.text().then((t) => this.#deliver(url, t));
      } catch {
        // una respuesta rara no debe molestar al reproductor
      }
    }

    /** @param {string} url @param {unknown} value */
    #deliver(url, value) {
      try {
        const body = typeof value === 'string' ? value : value instanceof ArrayBuffer ? new TextDecoder().decode(value) : JSON.stringify(value);
        if (body) this.onBody(url, body);
      } catch {
        // ídem
      }
    }
  }

  /** Transcripciones ya recibidas (las últimas) y quien espera alguna. */
  class TranscriptStore {
    constructor() {
      /** @type {Map<string, Cue[]>} */
      this.entries = new Map();
      /** @type {Set<{key: string, resolve: (cues: Cue[]) => void}>} */
      this.waiters = new Set();
    }

    /** @param {string} key @returns {Cue[] | null} */
    get(key) {
      return this.entries.get(key) ?? null;
    }

    /** @param {string} key @param {Cue[]} cues */
    put(key, cues) {
      if (!cues.length) return; // una respuesta vacía (p. ej. sin el token del reproductor) no cuenta
      this.entries.delete(key);
      this.entries.set(key, cues);
      while (this.entries.size > TRANSCRIPT_CACHE_MAX) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.key !== key) continue;
        this.waiters.delete(waiter);
        waiter.resolve(cues);
      }
    }

    /**
     * Guarda una respuesta escuchada: subtítulos (la clave sale de su
     * dirección) o el panel de transcripción (es del video de la página).
     * @param {string} url @param {string} body @param {string} playerId @param {string} pageId
     */
    ingest(url, body, playerId, pageId) {
      if (TRANSCRIPT_PANEL_URL.test(url)) {
        let data = null;
        try {
          data = JSON.parse(body);
        } catch {
          return;
        }
        if (pageId) this.put(panelKey(pageId), normalizeCues(parseTranscriptPanelJson(data)));
        return;
      }
      let params;
      try {
        params = new URL(url, location.href).searchParams;
      } catch {
        return;
      }
      const id = params.get('v') || playerId;
      const lang = params.get('lang') ?? '';
      if (!id || !lang) return;
      this.put(captionKey(id, lang, params.get('kind') === 'asr', params.get('tlang') ?? ''), normalizeCues(parseTimedText(body)));
    }

    /** Espera a que llegue `key` (o a que pase `ms`). @param {string} key @param {number} ms @returns {Promise<Cue[] | null>} */
    wait(key, ms) {
      const ready = this.get(key);
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve) => {
        const waiter = {
          key,
          resolve: (/** @type {Cue[]} */ cues) => {
            clearTimeout(timer);
            resolve(cues);
          },
        };
        const timer = setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(null);
        }, ms);
        this.waiters.add(waiter);
      });
    }
  }

  /**
   * Consigue la transcripción de un video por la primera vía que funcione,
   * sin tocar ninguna protección:
   *   1. lo ya recibido (si el reproductor ya la descargó con el script pegado);
   *   2. el enlace de la pista tal cual lo da YouTube (hoy muchas piden un
   *      token del reproductor y llegan vacías: entonces se pasa a la siguiente);
   *   3. pedírsela al reproductor activando esos subtítulos, como al pulsar
   *      «CC»: la descarga él y aquí se lee su respuesta; después los
   *      subtítulos quedan como estaban;
   *   4. el panel «Mostrar transcripción» de la página (solo el video de la
   *      página y en el idioma que tenga elegido).
   */
  class TranscriptSource {
    /** @param {YouTubePlayer} player @param {TranscriptStore} store */
    constructor(player, store) {
      this.player = player;
      this.store = store;
    }

    /** @param {string} videoId @param {TranscriptChoice} choice @returns {Promise<{cues: Cue[], via: TranscriptVia | ''}>} */
    async load(videoId, choice) {
      const key = captionKey(videoId, choice.track.languageCode, choice.track.asr, choice.translateTo);
      const known = this.store.get(key);
      if (known) return { cues: known, via: 'memoria' };
      const linked = await this.#viaLink(choice);
      if (linked) return { cues: linked, via: 'enlace' };
      const played = await this.#viaPlayer(videoId, choice, key);
      if (played) return { cues: played, via: 'reproductor' };
      const panel = choice.translateTo ? null : await this.#viaPanel(videoId);
      if (panel) return { cues: panel, via: 'panel' };
      return { cues: [], via: '' };
    }

    /** @param {TranscriptChoice} choice @returns {Promise<Cue[] | null>} */
    async #viaLink(choice) {
      if (!choice.track.baseUrl) return null;
      try {
        const url = new URL(choice.track.baseUrl, location.href);
        url.searchParams.set('fmt', 'json3');
        if (choice.translateTo) url.searchParams.set('tlang', choice.translateTo);
        const response = await fetch(url.href, { credentials: 'same-origin' });
        if (!response.ok) return null;
        const cues = normalizeCues(parseTimedText(await response.text()));
        return cues.length ? cues : null;
      } catch {
        return null;
      }
    }

    /** @param {string} videoId @param {TranscriptChoice} choice @param {string} key @returns {Promise<Cue[] | null>} */
    async #viaPlayer(videoId, choice, key) {
      const p = this.player;
      if (!p.hasCaptionModule() || p.videoId() !== videoId) return null;
      const before = p.captionTrack();
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          // Si ya la tenía de antes de pegar el script, no la vuelve a pedir: el segundo intento reinicia su módulo.
          p.loadCaptionModule(attempt > 0);
          const tracks = (await waitFor(() => p.captionModuleTracks(), CAPTION_MODULE_WAIT_MS)) ?? [];
          const wanted = tracks.find((t) => t.languageCode === choice.track.languageCode && (t.kind === 'asr') === choice.track.asr)
            ?? { languageCode: choice.track.languageCode, ...(choice.track.asr ? { kind: 'asr' } : {}) };
          const translation = { languageCode: choice.translateTo, languageName: choice.translateName || choice.translateTo };
          p.setCaptionTrack(choice.translateTo ? { ...wanted, translationLanguage: translation } : wanted);
          const cues = await this.store.wait(key, CAPTION_WAIT_MS * (attempt + 1));
          if (cues) return cues;
        }
        return null;
      } finally {
        p.setCaptionTrack(before); // como estaban: los mismos subtítulos, o ninguno
      }
    }

    /** @param {string} videoId @returns {Promise<Cue[] | null>} */
    async #viaPanel(videoId) {
      if (this.player.pageVideoId() !== videoId) return null; // el panel es del video de la página
      const key = panelKey(videoId);
      let segments = this.store.get(key) ?? readTranscriptSegments();
      let opened = false;
      if (!segments.length) {
        const button = findTranscriptButton();
        if (!button) return null;
        button.click();
        opened = true;
        segments = (await waitFor(() => this.store.get(key) ?? readTranscriptSegments(), TRANSCRIPT_PANEL_WAIT_MS)) ?? [];
      }
      // Si la página pidió los fragmentos (get_transcript), sus tiempos son exactos; los del panel, al segundo.
      const exact = this.store.get(key);
      if (opened) {
        // Los datos pueden llegar antes de que el panel se pinte: se espera a verlo para poder cerrarlo.
        await waitFor(() => readTranscriptSegments(), TRANSCRIPT_PANEL_WAIT_MS);
        closeTranscriptPanel();
      }
      const cues = exact ?? normalizeCues(segments);
      return cues.length ? cues : null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 14. Interfaz (panel flotante en Shadow DOM, sin innerHTML: Trusted Types)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * @typedef {Object} PanelActions
   * @property {() => void} start
   * @property {() => void} stop
   * @property {(mode: ExportMode) => void} save
   * @property {() => void} close
   * @property {() => void} formatChanged  cambió el contenido o el formato elegido
   * @property {() => number} now  posición actual del video (s), para los botones «ahora»
   * @property {QueueActions} queue
   * @property {TranscriptActions} transcript
   */

  const THEME = Object.freeze({
    bg: '#0f0f0f', surface: '#272727', fg: '#f1f1f1', muted: '#aaaaaa', line: '#3a3a3a',
    accent: '#3ea6ff', ok: '#4cc764', warn: '#f2b705', error: '#ff6b61',
  });

  /** @type {Partial<CSSStyleDeclaration>} */
  const CONTROL_STYLE = {
    boxSizing: 'border-box', width: '100%', padding: '6px 8px', border: `1px solid ${THEME.line}`,
    borderRadius: '8px', background: THEME.surface, color: THEME.fg, font: 'inherit',
  };

  /** @type {ReadonlyArray<[ExportMode, string]>} */
  const MODE_OPTIONS = [['av', 'Video + audio'], ['audio', 'Solo audio'], ['video', 'Solo video']];

  /** @type {ReadonlyArray<[OutputFormat, string, string]>} formato, etiqueta, explicación */
  const VIDEO_FORMATS = [
    ['mp4c', 'MP4 · compatible (H.264 + AAC)', 'Se abre en todas partes: iPhone, WhatsApp, Windows, editores. Hasta 1080p.'],
    ['mp4', 'MP4 · máxima calidad (VP9/AV1)', 'Hasta 4K. Se abre en PC, Android y VLC; no en iPhone ni QuickTime.'],
    ['mkv', 'WebM/MKV · original de YouTube', 'Tal cual llega de YouTube: máxima calidad y menor tamaño.'],
  ];
  /** @type {ReadonlyArray<[OutputFormat, string, string]>} */
  const AUDIO_FORMATS = [
    ['mp3', 'MP3 · 320 kbps', 'Se recodifica (YouTube no entrega MP3): tarda unos segundos por canción.'],
    ['mp3s', 'MP3 · 192 kbps (más liviano)', 'Se recodifica: archivo un 40 % más pequeño.'],
    ['orig', 'Original sin pérdida (M4A/WebM)', 'Sin recodificar: M4A si YouTube da AAC; si no, WebM con Opus.'],
  ];

  /**
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag @param {Partial<CSSStyleDeclaration>} [style] @param {string} [text]
   * @returns {HTMLElementTagNameMap[K]}
   */
  function el(tag, style = {}, text = '') {
    const node = document.createElement(tag);
    Object.assign(node.style, style);
    if (text) node.textContent = text;
    return node;
  }

  /** @param {string} value @param {string} text */
  function option(value, text) {
    const node = el('option', {}, text);
    node.value = value;
    return node;
  }

  /** @param {string} text @param {HTMLElement} control */
  function field(text, control) {
    const label = el('label', { display: 'grid', gap: '4px', color: THEME.muted, fontSize: '12px' }, text);
    label.append(control);
    return label;
  }

  /** @param {HTMLButtonElement | HTMLSelectElement | HTMLInputElement} node @param {boolean} enabled */
  function setEnabled(node, enabled) {
    node.disabled = !enabled;
    node.style.opacity = enabled ? '1' : '0.45';
    node.style.cursor = enabled ? 'pointer' : 'default';
  }

  /**
   * @param {string} text @param {() => void} onClick
   * @param {Partial<CSSStyleDeclaration>} [style] @param {string} [ariaLabel]
   */
  function makeButton(text, onClick, style = {}, ariaLabel = '') {
    const node = el('button', { ...CONTROL_STYLE, cursor: 'pointer', ...style }, text);
    node.type = 'button';
    if (ariaLabel) node.setAttribute('aria-label', ariaLabel);
    node.addEventListener('click', onClick);
    return node;
  }

  /** ¿Es un control (botón, campo…) que debe recibir el clic en vez de iniciar un arrastre? @param {EventTarget | null} target */
  function isControl(target) {
    return target instanceof Element && target.closest('button, input, select, textarea, a') !== null;
  }

  /** @param {number} value @param {number} min @param {number} max si queda por debajo de min, manda min */
  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  /** Clave con la que el panel recuerda su posición (localStorage de la página; si no se puede, se ignora). */
  const PANEL_POSITION_KEY = 'sifon:posicion-panel';
  /** Separación mínima entre el panel y el borde de la ventana (px). */
  const PANEL_EDGE_GAP = 8;
  /** Paso al moverlo con las flechas (px; con Mayús, cinco veces más). */
  const PANEL_KEY_STEP = 16;

  /**
   * Posición de un elemento fijo anclada, en cada eje, al borde más cercano:
   * si el panel crece (más líneas de estado), crece hacia dentro de la
   * pantalla en vez de salirse.
   * @typedef {{side: 'left'|'right', x: number, edge: 'top'|'bottom', y: number}} DockPosition
   */

  /** Posición inicial: esquina inferior derecha. @type {Readonly<DockPosition>} */
  const PANEL_HOME = Object.freeze({ side: 'right', x: 16, edge: 'bottom', y: 16 });

  /**
   * Hace arrastrable un elemento con position: fixed usando otro como asa:
   * ratón, táctil o lápiz (Pointer Events) y flechas del teclado. Lo mantiene
   * entero dentro de la ventana —también si esta cambia de tamaño o el
   * elemento crece— y recuerda dónde se dejó. Doble clic en el asa (o Inicio
   * con el teclado) lo devuelve a la esquina.
   */
  class Draggable {
    /**
     * @param {HTMLElement} target elemento que se mueve (position: fixed)
     * @param {HTMLElement} handle zona por la que se agarra
     * @param {string} storageKey clave para recordar la posición
     */
    constructor(target, handle, storageKey) {
      this.target = target;
      this.handle = handle;
      this.storageKey = storageKey;
      /** @type {DockPosition} */
      this.position = { ...PANEL_HOME };
      /** Puntero que arrastra y desde qué punto del elemento lo agarró. @type {{pointerId: number, dx: number, dy: number} | null} */
      this.grab = null;
      this.listeners = new AbortController();
      const signal = this.listeners.signal;
      handle.addEventListener('pointerdown', (e) => this.#onDown(e), { signal });
      handle.addEventListener('pointermove', (e) => this.#onMove(e), { signal });
      handle.addEventListener('pointerup', (e) => this.#onUp(e), { signal });
      handle.addEventListener('pointercancel', (e) => this.#onUp(e), { signal });
      handle.addEventListener('dblclick', (e) => { if (!isControl(e.target)) this.reset(); }, { signal });
      handle.addEventListener('keydown', (e) => this.#onKey(e), { signal });
      window.addEventListener('resize', () => this.#keepInside(), { signal });
      // También al crecer el propio elemento (y una vez al pintarse por primera vez).
      this.observer = new ResizeObserver(() => this.#keepInside());
      this.observer.observe(target);
      this.#apply(this.#load() ?? PANEL_HOME);
    }

    /** Vuelve a la esquina inicial y olvida la posición guardada. */
    reset() {
      this.#apply(PANEL_HOME);
      this.#keepInside();
      try {
        localStorage.removeItem(this.storageKey);
      } catch {
        // sin almacenamiento: no había nada guardado
      }
    }

    destroy() {
      this.listeners.abort();
      this.observer.disconnect();
    }

    /** @param {PointerEvent} e */
    #onDown(e) {
      if (e.button !== 0 || isControl(e.target)) return;
      const r = this.target.getBoundingClientRect();
      this.grab = { pointerId: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top };
      this.handle.setPointerCapture(e.pointerId); // sigue llegando aunque el puntero salga del asa
      this.handle.style.cursor = 'grabbing';
      e.preventDefault(); // que no seleccione texto mientras arrastra
    }

    /** @param {PointerEvent} e */
    #onMove(e) {
      if (!this.grab || this.grab.pointerId !== e.pointerId) return;
      this.#dock(e.clientX - this.grab.dx, e.clientY - this.grab.dy);
    }

    /** @param {PointerEvent} e */
    #onUp(e) {
      if (!this.grab || this.grab.pointerId !== e.pointerId) return;
      this.grab = null;
      this.handle.style.cursor = 'grab';
      if (this.handle.hasPointerCapture(e.pointerId)) this.handle.releasePointerCapture(e.pointerId);
      this.#save();
    }

    /** @param {KeyboardEvent} e */
    #onKey(e) {
      if (e.target !== this.handle) return; // las teclas del botón de cerrar son suyas
      if (e.key === 'Home') {
        e.preventDefault();
        this.reset();
        return;
      }
      const step = PANEL_KEY_STEP * (e.shiftKey ? 5 : 1);
      /** @type {Record<string, [number, number]>} */
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const move = moves[e.key];
      if (!move) return;
      e.preventDefault();
      const r = this.target.getBoundingClientRect();
      this.#dock(r.left + move[0], r.top + move[1]);
      this.#save();
    }

    /** Recoloca donde está ahora, por si la ventana o el elemento cambiaron de tamaño. */
    #keepInside() {
      const r = this.target.getBoundingClientRect();
      if (r.width > 0) this.#dock(r.left, r.top);
    }

    /**
     * Pone la esquina superior izquierda en (left, top), dentro de la ventana,
     * y la ancla a los bordes más cercanos.
     * @param {number} left @param {number} top
     */
    #dock(left, top) {
      const { width, height } = this.target.getBoundingClientRect();
      // clientWidth/Height excluyen las barras de desplazamiento, como el posicionamiento fijo.
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      const x = clamp(left, PANEL_EDGE_GAP, vw - width - PANEL_EDGE_GAP);
      const y = clamp(top, PANEL_EDGE_GAP, vh - height - PANEL_EDGE_GAP);
      const right = vw - width - x;
      const bottom = vh - height - y;
      this.#apply({
        side: x <= right ? 'left' : 'right', x: Math.round(Math.max(0, Math.min(x, right))),
        edge: y <= bottom ? 'top' : 'bottom', y: Math.round(Math.max(0, Math.min(y, bottom))),
      });
    }

    /** @param {DockPosition} pos */
    #apply(pos) {
      this.position = { side: pos.side, x: pos.x, edge: pos.edge, y: pos.y };
      const s = this.target.style;
      s.left = pos.side === 'left' ? `${pos.x}px` : 'auto';
      s.right = pos.side === 'right' ? `${pos.x}px` : 'auto';
      s.top = pos.edge === 'top' ? `${pos.y}px` : 'auto';
      s.bottom = pos.edge === 'bottom' ? `${pos.y}px` : 'auto';
    }

    /** @returns {DockPosition | null} */
    #load() {
      try {
        const p = JSON.parse(localStorage.getItem(this.storageKey) ?? 'null');
        const valid = p && (p.side === 'left' || p.side === 'right') && (p.edge === 'top' || p.edge === 'bottom')
          && Number.isFinite(p.x) && Number.isFinite(p.y);
        return valid ? p : null;
      } catch {
        return null; // sin almacenamiento o dato dañado: esquina inicial
      }
    }

    #save() {
      try {
        localStorage.setItem(this.storageKey, JSON.stringify(this.position));
      } catch {
        // sin almacenamiento: la posición solo dura mientras el panel esté abierto
      }
    }
  }

  /**
   * @typedef {Object} QueueActions
   * @property {() => void} addCurrent   añade el video abierto
   * @property {() => void} addPlaylist  añade la lista de reproducción que muestra la página
   * @property {(text: string) => boolean} addText  añade los enlaces o ids del texto; false si no había ninguno
   * @property {(id: string) => void} remove
   * @property {() => void} start
   * @property {() => void} clearFinished
   */

  /** Marca, color y nombre de cada estado de la cola. @type {Readonly<Record<QueueStatus, [string, string, string]>>} */
  const QUEUE_LOOK = Object.freeze({
    pending: ['○', THEME.muted, 'pendiente'],
    active: ['●', THEME.accent, 'capturando'],
    done: ['✓', THEME.ok, 'guardado'],
    error: ['✗', THEME.error, 'no se pudo'],
  });

  /** Sección plegable de la cola: videos con su estado y botones para añadir y arrancar. Solo presenta y emite acciones. */
  class QueueView {
    /** @param {QueueActions} actions */
    constructor(actions) {
      this.actions = actions;
      this.element = el('details', { marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${THEME.line}` });
      this.summary = el('summary', { cursor: 'pointer', fontWeight: '600', userSelect: 'none' }, 'Cola de videos');
      /** @type {Partial<CSSStyleDeclaration>} */
      const small = { width: 'auto', padding: '5px 8px', fontSize: '12px' };
      const adders = el('div', { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' });
      adders.append(
        makeButton('+ Este video', actions.addCurrent, small, 'Añadir a la cola el video abierto'),
        makeButton('+ Lista', actions.addPlaylist, small, 'Añadir a la cola los videos de la lista de reproducción'),
        makeButton('+ Enlaces…', () => this.#togglePaste(), small, 'Pegar enlaces o ids de videos'),
      );
      this.pasteArea = el('textarea', { ...CONTROL_STYLE, height: '64px', resize: 'vertical', fontSize: '12px' });
      this.pasteArea.placeholder = 'Un enlace o id por línea: youtube.com/watch?v=…, youtu.be/…, /shorts/…';
      this.pasteArea.spellcheck = false;
      this.pasteBox = el('div', { display: 'none', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', marginTop: '6px' });
      this.pasteBox.append(this.pasteArea, makeButton('Añadir', () => {
        if (!actions.addText(this.pasteArea.value)) return;
        this.pasteArea.value = '';
        this.#togglePaste(false);
      }, small));
      this.list = el('div', { maxHeight: '150px', overflowY: 'auto', marginTop: '8px', fontSize: '12px' });
      this.startButton = makeButton('Capturar la cola', actions.start, { background: THEME.accent, borderColor: THEME.accent, color: '#0f0f0f', fontWeight: '600' });
      this.clearButton = makeButton('Quitar terminados', actions.clearFinished, { width: 'auto', padding: '6px 8px' });
      const footer = el('div', { display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', marginTop: '8px' });
      footer.append(this.startButton, this.clearButton);
      const note = el('div', { marginTop: '6px', color: THEME.muted, fontSize: '11px' },
        'Se bajan uno tras otro, completos, con la calidad, el archivo y el formato de arriba. Deja esta pestaña abierta (puedes usar otras mientras tanto). Si Chrome pregunta si el sitio puede descargar varios archivos, acepta.');
      this.element.append(this.summary, adders, this.pasteBox, this.list, footer, note);
      /** @type {QueueItem[]} */
      this.items = [];
      this.flags = { running: false, locked: false };
    }

    /** Vuelve a pintar la lista. @param {QueueItem[]} items */
    render(items) {
      this.items = items;
      const left = items.filter((it) => it.status === 'pending' || it.status === 'active').length;
      this.summary.textContent = items.length ? `Cola de videos (${left} por bajar de ${items.length})` : 'Cola de videos';
      this.list.replaceChildren(...(items.length
        ? items.map((item) => this.#row(item))
        : [el('div', { color: THEME.muted }, 'Vacía: añade videos con los botones de arriba.')]));
      this.setFlags(this.flags);
    }

    /** @param {{running: boolean, locked: boolean}} flags running: la cola está en marcha; locked: hay otra captura o un guardado */
    setFlags(flags) {
      this.flags = flags;
      setEnabled(this.startButton, !flags.running && !flags.locked && this.items.some((it) => it.status === 'pending'));
      this.startButton.textContent = flags.running ? 'Capturando la cola…' : 'Capturar la cola';
      setEnabled(this.clearButton, this.items.some((it) => it.status === 'done' || it.status === 'error'));
    }

    /** @param {QueueItem} item */
    #row(item) {
      const [glyph, color, label] = QUEUE_LOOK[item.status];
      const row = el('div', { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0', borderBottom: `1px solid ${THEME.line}` });
      const mark = el('span', { flex: 'none', width: '14px', textAlign: 'center', color }, glyph);
      mark.title = label;
      /** @type {Partial<CSSStyleDeclaration>} */
      const oneLine = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
      const text = el('div', { flex: '1', minWidth: '0' });
      text.append(el('div', oneLine, item.title || item.id));
      // El motivo de un fallo se ve en la propia fila (en pantallas táctiles no hay «pasar el ratón»).
      if (item.note) text.append(el('div', { ...oneLine, color: item.status === 'error' ? THEME.error : THEME.muted, fontSize: '11px' }, item.note));
      text.title = [item.title || item.id, label, item.note].filter(Boolean).join(' · ');
      const remove = makeButton('✕', () => this.actions.remove(item.id),
        { flex: 'none', width: '22px', height: '22px', padding: '0', fontSize: '11px' }, `Quitar de la cola: ${item.title || item.id}`);
      setEnabled(remove, item.status !== 'active');
      row.append(mark, text, remove);
      return row;
    }

    /** @param {boolean} [show] por omisión, alterna */
    #togglePaste(show = this.pasteBox.style.display === 'none') {
      this.pasteBox.style.display = show ? 'flex' : 'none';
      if (show) this.pasteArea.focus();
    }
  }

  /**
   * @typedef {Object} TranscriptActions
   * @property {() => void} download
   * @property {() => void} changed  cambió idioma, formato o «también con cada captura» (para recordarlo)
   */

  /**
   * Sección plegable «Transcripción»: idioma, formato, descarga y si va
   * también con cada captura. Solo presenta y emite acciones.
   */
  class TranscriptView {
    /** @param {TranscriptActions} actions */
    constructor(actions) {
      this.element = el('details', { marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${THEME.line}` });
      this.summary = el('summary', { cursor: 'pointer', fontWeight: '600', userSelect: 'none' }, 'Transcripción');
      this.language = el('select', CONTROL_STYLE);
      this.format = el('select', CONTROL_STYLE);
      for (const [value, text] of TRANSCRIPT_FORMATS) this.format.append(option(value, text));
      const fields = el('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' });
      fields.append(field('Idioma', this.language), field('Formato', this.format));
      this.downloadButton = makeButton('Descargar transcripción', actions.download, { marginTop: '8px' });
      this.withCapture = el('input', { margin: '0', accentColor: THEME.accent, cursor: 'pointer' });
      this.withCapture.type = 'checkbox';
      const check = el('label', { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', fontSize: '12px', cursor: 'pointer' });
      check.append(this.withCapture, document.createTextNode('Bajarla también con cada captura (y en la cola)'));
      const note = el('div', { marginTop: '6px', color: THEME.muted, fontSize: '11px' },
        'Sale de los subtítulos que YouTube ofrece para el video: los del autor, los automáticos o su traducción automática.');
      this.element.append(this.summary, fields, this.downloadButton, check, note);
      for (const node of [this.language, this.format, this.withCapture]) node.addEventListener('change', () => actions.changed());
      this.available = false;
      this.busy = false;
      this.#sync();
    }

    /** @param {Array<{value: string, label: string}>} options @param {string} selected */
    setOptions(options, selected) {
      this.available = options.length > 0;
      this.language.replaceChildren(...(options.length ? options.map((o) => option(o.value, o.label)) : [option('', 'No hay')]));
      if (selected) this.language.value = selected;
      this.summary.textContent = options.length ? 'Transcripción (disponible)' : 'Transcripción (este video no tiene)';
      this.#sync();
    }

    get selectedValue() {
      return this.language.value;
    }

    /** @returns {TranscriptFormat} */
    get selectedFormat() {
      return /** @type {TranscriptFormat} */ (this.format.value);
    }

    get alsoOnCapture() {
      return this.withCapture.checked;
    }

    /** @param {TranscriptPrefs} prefs */
    applyPrefs(prefs) {
      this.format.value = prefs.format;
      this.withCapture.checked = prefs.withCapture;
    }

    /** @param {boolean} busy */
    setBusy(busy) {
      this.busy = busy;
      this.downloadButton.textContent = busy ? 'Buscando la transcripción…' : 'Descargar transcripción';
      this.#sync();
    }

    #sync() {
      setEnabled(this.downloadButton, this.available && !this.busy);
      setEnabled(this.language, this.available && !this.busy);
    }
  }

  /** Panel flotante: solo presenta estado y emite acciones. */
  class Panel {
    /** @param {PanelActions} actions */
    constructor(actions) {
      this.actions = actions;
      this.host = el('div');
      const shadow = this.host.attachShadow({ mode: 'open' });
      const root = el('section', {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647', width: '330px',
        boxSizing: 'border-box', padding: '12px 14px', background: THEME.bg, color: THEME.fg,
        border: `1px solid ${THEME.line}`, borderRadius: '12px', boxShadow: '0 10px 30px rgba(0,0,0,.55)',
        font: '13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        // Nunca más alto que la ventana: con la cola desplegada en una pantalla baja, se desplaza por dentro.
        maxHeight: `calc(100vh - ${2 * PANEL_EDGE_GAP}px)`, overflowY: 'auto', overscrollBehavior: 'contain',
      });
      root.setAttribute('aria-label', APP_NAME);

      // La cabecera es el asa para mover el panel por la pantalla.
      const header = el('div', {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
        margin: '-12px -14px 10px', padding: '12px 14px 0', borderRadius: '12px 12px 0 0', outlineOffset: '-2px',
        // Fija arriba al desplazar el panel por dentro: el asa y el ✕ siempre a mano.
        position: 'sticky', top: '-12px', zIndex: '1', background: THEME.bg,
      });
      header.title = 'Arrastra para mover el panel · doble clic: volver a la esquina';
      header.setAttribute('aria-label', 'Mover el panel: flechas del teclado; Inicio vuelve a la esquina');
      const title = el('strong', { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' });
      const grip = el('span', { color: THEME.muted, fontSize: '15px', lineHeight: '1' }, '⠿');
      grip.setAttribute('aria-hidden', 'true');
      title.append(grip, document.createTextNode(`${APP_NAME} · descarga de YouTube`));
      header.append(title, makeButton('✕', actions.close, { width: '28px', height: '28px', padding: '0', flex: 'none' }, 'Cerrar'));
      Object.assign(header.style, { cursor: 'grab', userSelect: 'none', touchAction: 'none' });
      header.tabIndex = 0;

      this.quality = el('select', CONTROL_STYLE);
      this.mode = el('select', CONTROL_STYLE);
      for (const [value, text] of MODE_OPTIONS) this.mode.append(option(value, text));
      this.format = el('select', CONTROL_STYLE);
      this.formatNote = el('div', { gridColumn: '1 / -1', marginTop: '-2px', color: THEME.muted, fontSize: '11px' });
      const formatField = field('Formato', this.format);
      formatField.style.gridColumn = '1 / -1';
      const fields = el('div', { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' });
      fields.append(field('Calidad', this.quality), field('Archivo', this.mode), formatField, this.formatNote);
      this.mode.addEventListener('change', () => this.#fillFormats());
      this.quality.addEventListener('change', () => this.#reconcile('quality'));
      this.format.addEventListener('change', () => this.#reconcile('format'));
      this.#fillFormats();

      this.fromInput = this.#clockInput('0:00');
      this.toInput = this.#clockInput('final');
      this.nowButtons = [this.#nowButton(this.fromInput), this.#nowButton(this.toInput)];
      fields.append(
        field('Desde', this.#inline(this.fromInput, this.nowButtons[0])),
        field('Hasta', this.#inline(this.toInput, this.nowButtons[1])),
        el('div', { gridColumn: '1 / -1', marginTop: '-2px', color: THEME.muted, fontSize: '11px' },
          'Vacíos = el video completo. Se escribe 1:23, 1:02:03 o 83 (segundos).'),
      );

      this.startButton = makeButton('Capturar', actions.start, { background: THEME.accent, borderColor: THEME.accent, color: '#0f0f0f', fontWeight: '600' });
      this.stopButton = makeButton('Cancelar', actions.stop);
      this.saveButton = makeButton('Descargar', () => actions.save(this.selectedMode));
      const buttons = el('div', { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginTop: '10px' });
      buttons.append(this.startButton, this.stopButton, this.saveButton);

      this.fill = el('div', { width: '0%', height: '100%', background: THEME.accent, transition: 'width .3s linear' });
      const bar = el('div', { height: '6px', margin: '12px 0 8px', background: THEME.surface, borderRadius: '3px', overflow: 'hidden' });
      bar.append(this.fill);

      this.status = el('div', { minHeight: '19px' });
      this.status.setAttribute('aria-live', 'polite');
      this.details = el('div', { marginTop: '6px', color: THEME.muted, fontSize: '12px', whiteSpace: 'pre-line' });
      this.hint = el('div', { marginTop: '6px', color: THEME.accent, fontSize: '12px' });

      this.transcriptView = new TranscriptView(actions.transcript);
      this.queueView = new QueueView(actions.queue);
      root.append(header, fields, buttons, bar, this.status, this.details, this.hint, this.transcriptView.element, this.queueView.element);
      // Lo que se teclea en el panel no debe llegar a los atajos de YouTube («1» salta al 10 %, «k» pausa…).
      for (const type of ['keydown', 'keypress', 'keyup']) root.addEventListener(type, (e) => e.stopPropagation());
      this.drag = new Draggable(root, header, PANEL_POSITION_KEY);
      shadow.append(root);
      document.body.append(this.host);
    }

    /** @param {{key: string, label: string}[]} list */
    setQualities(list) {
      this.quality.replaceChildren(...(list.length ? list.map((q) => option(q.key, q.label)) : [option('', 'Automática')]));
      // Por defecto, la mejor que admita el formato elegido (MP4 compatible: hasta 1080p).
      if (this.selectedFormat === 'mp4c') this.#capQuality();
      this.#describe('');
    }

    /** @returns {OutputFormat} */
    get selectedFormat() {
      return /** @type {OutputFormat} */ (this.format.value);
    }

    /** Opciones de formato según el contenido (video o audio), conservando la elección si sigue valiendo. */
    #fillFormats() {
      const list = this.selectedMode === 'audio' ? AUDIO_FORMATS : VIDEO_FORMATS;
      const keep = this.format.value;
      this.format.replaceChildren(...list.map(([value, text]) => option(value, text)));
      if (list.some(([value]) => value === keep)) this.format.value = keep;
      this.#reconcile('format');
    }

    /**
     * Mantiene coherentes calidad y formato: H.264 no pasa de 1080p.
     * @param {'quality'|'format'} trigger qué cambió el usuario
     */
    #reconcile(trigger) {
      const height = QUALITY_HEIGHTS[this.quality.value] ?? 0;
      let note = '';
      if (this.selectedMode !== 'audio' && this.selectedFormat === 'mp4c' && height > H264_MAX_HEIGHT) {
        if (trigger === 'quality') {
          this.format.value = 'mp4';
          note = 'Pasé a «MP4 · máxima calidad»: YouTube no da H.264 por encima de 1080p.';
        } else if (this.#capQuality()) {
          note = 'Bajé la calidad a 1080p: es el máximo de H.264 en YouTube.';
        }
      }
      this.#describe(note);
      this.actions.formatChanged();
    }

    /** Elige la mejor calidad ≤ 1080p; false si no hay ninguna. */
    #capQuality() {
      const fit = [...this.quality.options].find((o) => (QUALITY_HEIGHTS[o.value] ?? 0) <= H264_MAX_HEIGHT && o.value);
      if (!fit) return false;
      this.quality.value = fit.value;
      return true;
    }

    /** @param {string} note aviso de un ajuste automático (prioritario) */
    #describe(note) {
      const list = this.selectedMode === 'audio' ? AUDIO_FORMATS : VIDEO_FORMATS;
      this.formatNote.textContent = note || (list.find(([value]) => value === this.selectedFormat)?.[2] ?? '');
      this.formatNote.style.color = note ? THEME.warn : THEME.muted;
    }

    get selectedQuality() {
      return this.quality.value;
    }

    /** @returns {ExportMode} */
    get selectedMode() {
      return /** @type {ExportMode} */ (this.mode.value);
    }

    /**
     * Tramo pedido en segundos; null = campo vacío (desde el principio / hasta
     * el final). Lanza si el texto no es un tiempo.
     * @returns {{startS: number | null, endS: number | null}}
     */
    get range() {
      const from = parseClock(this.fromInput.value);
      const to = parseClock(this.toInput.value);
      if (Number.isNaN(from)) throw new Error('«Desde» no es un tiempo válido: usa 1:23, 1:02:03 o 83.');
      if (Number.isNaN(to)) throw new Error('«Hasta» no es un tiempo válido: usa 1:23, 1:02:03 o 83.');
      return { startS: from, endS: to };
    }

    /** @param {string} placeholder */
    #clockInput(placeholder) {
      const input = el('input', { ...CONTROL_STYLE, minWidth: '0' });
      input.type = 'text';
      input.placeholder = placeholder;
      input.spellcheck = false;
      input.autocomplete = 'off';
      return input;
    }

    /** Botón que copia la posición actual del video en el campo. @param {HTMLInputElement} input */
    #nowButton(input) {
      return makeButton('ahora', () => { input.value = formatClock(this.actions.now()); },
        { width: 'auto', padding: '6px 8px', fontSize: '11px' }, 'Usar la posición actual del video');
    }

    /** @param {HTMLElement} a @param {HTMLElement} b */
    #inline(a, b) {
      const row = el('div', { display: 'flex', gap: '4px' });
      row.append(a, b);
      return row;
    }

    /**
     * @param {'idle'|'capturing'|'done'} state
     * @param {{canSave: boolean, busy: boolean, queueRunning: boolean}} flags
     */
    setState(state, { canSave, busy, queueRunning }) {
      const capturing = state === 'capturing';
      const locked = capturing || busy || queueRunning;
      setEnabled(this.startButton, !locked);
      this.startButton.textContent = state === 'done' ? 'Recapturar' : 'Capturar';
      setEnabled(this.stopButton, capturing || queueRunning);
      this.stopButton.textContent = queueRunning ? 'Detener cola' : 'Cancelar';
      for (const node of [this.fromInput, this.toInput, ...this.nowButtons]) setEnabled(node, !locked);
      setEnabled(this.saveButton, canSave && !busy && !queueRunning);
      setEnabled(this.quality, !locked && this.quality.value !== '');
      setEnabled(this.format, !locked);
      setEnabled(this.mode, !busy && !queueRunning);
      this.queueView.setFlags({ running: queueRunning, locked: capturing || busy });
    }

    /** Elige una calidad de la lista, si está. @param {string} key */
    selectQuality(key) {
      if (!key || ![...this.quality.options].some((o) => o.value === key)) return;
      this.quality.value = key;
      this.#describe('');
    }

    /** Texto del estado actual (para anotarlo en la cola). */
    get statusText() {
      return this.status.textContent ?? '';
    }

    /** @param {number} ratio 0..1 */
    setProgress(ratio) {
      this.fill.style.width = `${(Math.min(1, Math.max(0, ratio)) * 100).toFixed(1)}%`;
    }

    /** @param {string} text @param {'info'|'ok'|'warn'|'error'} [tone] */
    setStatus(text, tone = 'info') {
      this.status.textContent = text;
      this.status.style.color = tone === 'info' ? THEME.fg : THEME[tone];
    }

    /** @param {string[]} lines */
    setDetails(lines) {
      this.details.textContent = lines.join('\n');
    }

    /** Añade una línea a los detalles. @param {string} line */
    appendDetail(line) {
      this.details.textContent = this.details.textContent ? `${this.details.textContent}\n${line}` : line;
    }

    /** Aviso breve sobre la precaptura ('' lo oculta). @param {string} text */
    setHint(text) {
      this.hint.textContent = text;
      this.hint.style.display = text ? 'block' : 'none';
    }

    destroy() {
      this.drag.destroy();
      this.host.remove();
    }

  }

  // ═══════════════════════════════════════════════════════════════════════
  // 15. Utilidades de navegador y formato
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Cede el hilo a la página (pintar, eventos) sin temporizadores: con la
   * pestaña oculta, Chrome espacia los setTimeout encadenados hasta 1 s (o
   * 1 min) y una conversión larga se eternizaría. Los mensajes de un
   * MessageChannel no se frenan.
   * @type {() => Promise<void>}
   */
  const yieldToPage = (() => {
    /** @type {Array<() => void>} */
    const waiting = [];
    /** @type {MessageChannel | null} */
    let channel = null;
    return () => new Promise((resolve) => {
      if (!channel) {
        channel = new MessageChannel();
        channel.port1.onmessage = () => waiting.shift()?.();
      }
      waiting.push(resolve);
      channel.port2.postMessage(0);
    });
  })();

  /** @param {Blob} blob @param {string} name */
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  }

  /** @param {string} title @param {string} suffix @param {string} ext */
  function fileName(title, suffix, ext) {
    // eslint-disable-next-line no-control-regex
    const clean = title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'video';
    return `${clean}${suffix ? ` (${suffix})` : ''}.${ext}`;
  }

  /**
   * Identificadores de video de un texto con enlaces o ids sueltos
   * (watch?v=, youtu.be/, /shorts/, /embed/, /live/), en orden y sin repetir.
   * Un id suelto tiene 11 caracteres de base64url; una palabra normal de 11
   * letras («programando») no cuenta: un id real casi nunca es así.
   * @param {string} text @returns {string[]}
   */
  function parseVideoIds(text) {
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    for (const token of text.split(/[\s,;]+/)) {
      if (!token) continue;
      const m = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})(?![\w-])/.exec(token);
      const bare = token.replace(/^[("'«“]+|[)"'»”.:!?]+$/g, '');
      const plainWord = /^(?:[A-Za-z][a-z]{10}|[A-Z]{11})$/.test(bare);
      const id = m ? m[1] : VIDEO_ID_PATTERN.test(bare) && !plainWord ? bare : '';
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }

  /**
   * «1:23», «1:02:03», «83» o «1:23.5» → segundos; null si está vacío; NaN si no es válido.
   * @param {string} text
   */
  function parseClock(text) {
    const t = text.trim().replace(',', '.');
    if (!t) return null;
    const m = /^(\d+(?::\d+){0,2})(?:\.(\d+))?$/.exec(t);
    if (!m) return NaN;
    const parts = m[1].split(':').map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return NaN;
    let s = 0;
    for (const p of parts) s = s * 60 + p;
    return s + (m[2] ? Number(`0.${m[2]}`) : 0);
  }

  /** Segundos → «1:23» o «1:02:03», con décimas si las hay. @param {number} seconds */
  function formatClock(seconds) {
    const tenths = Math.round(Math.max(0, seconds) * 10);
    const base = formatTime(Math.floor(tenths / 10) * 1000);
    return tenths % 10 ? `${base}.${tenths % 10}` : base;
  }

  /** @param {number} bytes */
  function formatBytes(bytes) {
    return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(2)} GB` : `${(bytes / 2 ** 20).toFixed(1)} MB`;
  }

  /** @param {number} ms */
  function formatTime(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 16. Orquestación
  // ═══════════════════════════════════════════════════════════════════════

  /** Intentos de recuperar un mismo hueco antes de rendirse (sin guardar nada incompleto). */
  const MAX_HOLE_ATTEMPTS = 3;
  /** Se pide un poco antes del hueco para tener su fotograma clave. */
  const HOLE_LEAD_S = 1;
  /** Tras recolocar el reproductor, se espera esto antes de volver a decidir (ms). */
  const REPOSITION_COOLDOWN_MS = 2500;
  /** Al final de un tramo, si lo grabado deja de crecer este tiempo, lo que falte ya no llegará solo (ms). */
  const END_GRACE_MS = 1500;
  /** Un «ended» solo cuenta como final real de los medios si cae así de cerca de la duración (s; o el 1 % si es más). */
  const MEDIA_END_TOLERANCE_S = 2;
  /** Tras el «ended» (ya se entregó todo), una pista puede acabar hasta esto antes que la otra (s). */
  const MEDIA_END_TAIL_S = 0.5;
  /** Tramo mínimo que se puede pedir (s). */
  const MIN_RANGE_S = 1;
  /** Si el video cambia estando a menos de esto del final, es el autoplay de YouTube, no el usuario (s). */
  const AUTOPLAY_NEAR_END_S = 10;

  /**
   * Plan de la captura en curso (segundos del contenido).
   * @typedef {Object} CapturePlan
   * @property {string} id
   * @property {string} title
   * @property {string} artist
   * @property {ExportMode} mode
   * @property {number} startS
   * @property {number | null} requestedEndS «Hasta» tal como se pidió (null = hasta el final)
   * @property {number} endS       fin del tramo (≤ duración; Infinity mientras no se sepa la duración)
   * @property {number} durationS  duración del video (0 hasta saberla, p. ej. si se empezó durante un anuncio)
   * @property {number} mediaEndS  fin real de los medios si terminan antes de la duración (Infinity hasta saberlo)
   */

  /**
   * Cola en marcha.
   * @typedef {Object} QueueRun
   * @property {string} quality     calidad preferida (la del panel al arrancar; '' = la mejor)
   * @property {QueueItem | null} item  video que se atiende (null entre uno y otro)
   * @property {boolean} loaded     ¿se abrió con loadVideoById? Entonces se esperan sus datos: hasta que
   *                                lleguen, duración y título pueden ser aún los del video anterior
   * @property {boolean} qualitySet ¿ya se pidió su calidad?
   * @property {number} deadline    límite para que abra (performance.now; los anuncios lo alargan)
   * @property {number} timer
   * @property {number} done        guardados en esta tanda
   * @property {number} failed      fallidos en esta tanda
   * @property {boolean} wasMuted   ¿estaba silenciado antes de la cola?
   */

  /**
   * Fin del tramo: a menos de la holgura del final (la duración de YouTube va
   * redondeada) equivale a «hasta el final».
   * @param {number | null} requested @param {number} durationS
   */
  function rangeEnd(requested, durationS) {
    return requested === null || requested >= durationS - RANGE_END_SLACK_S ? durationS : requested;
  }

  /**
   * Coordina reproductor, captura, ritmo, exportación y panel. La captura se
   * guía por lo realmente grabado, no por el cabezal: solo termina cuando el
   * tramo pedido está entero y, si falta algo, lo vuelve a pedir. Nunca guarda
   * un archivo incompleto.
   */
  class App {
    constructor() {
      this.player = new YouTubePlayer();
      /** Lo que se va guardando del video actual (captura o precaptura). */
      this.live = new TrackRegistry();
      /** Última captura completa, lista para descargar. */
      this.result = new TrackRegistry();
      /** Tramo verificado de `result`. @type {TimeWindow | null} */
      this.resultWindow = null;
      /** Duración del video capturado (s). */
      this.resultDurationS = 0;
      /** @type {ExportMode} */
      this.resultMode = 'av';
      /** @type {MediaMeta} */
      this.resultMeta = { title: '', artist: '' };
      this.hub = new CaptureHub(this.live, this.player);
      this.mse = new MseInterceptor(this.hub);
      this.exporter = new Exporter();
      // El turbo salta solo hasta lo ya guardado y nunca más allá del punto de parada final.
      this.pacer = new Pacer(this.player, this.hub.keyframes, (t) => Math.min(this.#capturedEnd(t), this.#holdAt()));
      this.governor = new PaceGovernor();
      this.meter = new RateMeter(TURBO_PROBE_MS);
      this.gate = new CodecGate();
      /** @type {'idle'|'capturing'|'done'} */
      this.state = 'idle';
      this.busy = false;
      this.timer = 0;
      this.paceTimer = 0;
      this.idleTimer = 0;
      this.rate = CAPTURE_RATE;
      /**
       * Fase del final: «run» captura normal; «hold» en pausa antes del final mientras el
       * reproductor descarga lo que queda; «approach» avanza a 1× si en pausa no lo descargaba.
       * @type {'run'|'hold'|'approach'}
       */
      this.endPhase = 'run';
      this.holdSince = 0;
      this.unloadGuarded = false;
      /** Pide confirmación si algo intenta recargar o cerrar la página con una captura en curso. @param {BeforeUnloadEvent} e */
      this.onBeforeUnload = (e) => {
        e.preventDefault();
        e.returnValue = '';
      };
      this.startedAt = 0;
      this.lastTickAt = 0;
      this.captureMs = 0;
      this.lastResumeAt = 0;
      this.repositionUntil = 0;
      /** Último crecimiento de lo grabado dentro del tramo (para detectar atascos). */
      this.growth = { covered: -1, at: 0, nudges: 0 };
      /** Última posición vista del video capturado, fuera de anuncios (cerca del final, un cambio de video es el autoplay). */
      this.lastT = 0;
      this.refilling = false;
      this.adsSkipped = 0;
      this.refills = 0;
      /** @type {Map<number, number>} intentos por hueco (clave: segundo de inicio) */
      this.attempts = new Map();
      this.prearmOverflow = false;
      /** Video que ya se recargó para que la precaptura pudiera leerlo (una sola vez por video). */
      this.resyncedId = '';
      /** Avisos de la captura en curso (se muestran en el panel). @type {string[]} */
      this.notes = [];
      /** @type {CapturePlan} */
      this.plan = { id: '', title: '', artist: '', mode: 'av', startS: 0, requestedEndS: null, endS: 0, durationS: 0, mediaEndS: Infinity };
      this.wasMuted = false;
      this.previousRate = 1;
      this.quality = '';
      this.qualityReasserted = false;
      this.queue = new CaptureQueue(QUEUE_KEY);
      /** @type {QueueRun | null} */
      this.queueRun = null;
      this.transcripts = new TranscriptStore();
      // Lo que el reproductor descargue de subtítulos queda a mano (p. ej. si el usuario activa «CC»).
      this.timedText = new TimedTextTap((url, body) => this.transcripts.ingest(url, body, this.player.videoId(), this.player.pageVideoId()));
      this.transcriptSource = new TranscriptSource(this.player, this.transcripts);
      this.transcriptPrefs = loadTranscriptPrefs();
      /** Opciones de transcripción del video actual. @type {TranscriptOption[]} */
      this.transcriptChoices = [];
      this.transcriptBusy = false;
      this.transcriptTimer = 0;
      this.onNavigate = () => this.#onNavigate();
      this.onMediaEvent = (/** @type {Event} */ e) => this.#onMediaEvent(e);
      this.panel = new Panel({
        start: () => this.start(),
        stop: () => this.#userCancel(),
        save: (mode) => void this.save(mode),
        close: () => this.dispose(),
        formatChanged: () => this.#syncGate(),
        now: () => this.player.currentTime(),
        queue: {
          addCurrent: () => this.#queueAddCurrent(),
          addPlaylist: () => this.#queueAddPlaylist(),
          addText: (text) => this.#queueAddText(text),
          remove: (id) => {
            this.queue.remove(id);
            this.#renderQueue();
          },
          start: () => this.#queueStart(),
          clearFinished: () => {
            this.queue.clearFinished();
            this.#renderQueue();
          },
        },
        transcript: {
          download: () => void this.#downloadTranscript(),
          changed: () => this.#transcriptChanged(),
        },
      });
      this.panel.transcriptView.applyPrefs(this.transcriptPrefs);
    }

    boot() {
      const g = /** @type {any} */ (window);
      g[INSTANCE_KEY]?.dispose?.();
      g[INSTANCE_KEY] = this;
      if (!MseInterceptor.supported) {
        this.panel.setStatus('Este navegador no expone Media Source Extensions.', 'error');
        this.#render();
        return;
      }
      this.mse.install();
      this.timedText.install();
      this.hub.onSink = (sink) => this.#onSink(sink);
      this.hub.onStreamEnd = (duration) => this.#onStreamEnd(duration);
      // Nunca dentro del appendBuffer del reproductor: recargar ahí lo dejaría a medias.
      this.hub.onBlind = () => void setTimeout(() => this.#onBlind(), 0);
      // YouTube navega sin recargar la página: el panel sobrevive y sirve para el siguiente video.
      document.addEventListener('yt-navigate-finish', this.onNavigate);
      for (const type of MEDIA_EVENTS) document.addEventListener(type, this.onMediaEvent, true);
      // Precaptura desde ya, vaya por donde vaya el video: lo que se reproduzca queda guardado y
      // «Capturar» solo pedirá lo que falte (lo cargado antes de pegar el script se vuelve a pedir).
      const id = this.player.videoId();
      if (id) this.#armPrecapture(id);
      this.#loadQualities();
      this.#refreshTranscript();
      this.panel.setStatus(id ? 'Listo. Elige calidad y pulsa «Capturar».' : 'Abre un video: lo que reproduzcas queda guardado.', 'info');
      this.panel.setDetails([
        'Descarga el video entero (o el tramo Desde/Hasta) y comprueba que no falte nada antes de guardar.',
        'Lo que reproduzcas con el panel abierto ya queda guardado: «Capturar» solo pide lo que falte.',
        'Para bajar varios, añádelos a la «Cola de videos» (abajo).',
      ]);
      this.#renderQueue();
      this.panel.setHint('');
      this.#syncGate();
      this.idleTimer = window.setInterval(() => this.#idleRefresh(), IDLE_REFRESH_MS);
      this.#render();
    }

    /**
     * @param {{whole?: boolean, fallbackTitle?: string}} [options] whole: el video completo, sin
     * mirar Desde/Hasta (la cola); fallbackTitle: título si el reproductor aún no lo da
     */
    start({ whole = false, fallbackTitle = 'video' } = {}) {
      const id = this.player.videoId();
      if (!id) {
        this.panel.setStatus('No encuentro el video en esta página.', 'error');
        return;
      }
      /** @type {{startS: number | null, endS: number | null}} */
      let range = { startS: null, endS: null };
      try {
        if (!whole) range = this.panel.range;
      } catch (err) {
        this.panel.setStatus(err instanceof Error ? err.message : String(err), 'error');
        return;
      }
      // Durante un anuncio, getDuration() da la del anuncio: la del video se toma cuando lleguen sus datos.
      const reported = this.player.isAdShowing() ? 0 : this.player.duration();
      const durationS = this.#plausibleDuration(reported) ? reported : 0;
      const startS = range.startS ?? 0;
      const endS = durationS > 0 ? rangeEnd(range.endS, durationS) : range.endS ?? Infinity;
      if (durationS > 0 && startS >= durationS) {
        this.panel.setStatus(`«Desde» queda después del final: el video dura ${formatClock(durationS)}.`, 'error');
        return;
      }
      if (endS - startS < MIN_RANGE_S) {
        this.panel.setStatus('«Hasta» debe quedar al menos 1 s después de «Desde».', 'error');
        return;
      }
      const mode = this.panel.selectedMode;
      const audioOnly = mode === 'audio';
      const compat = !audioOnly && this.panel.selectedFormat === 'mp4c';
      const wanted = audioOnly ? this.player.lowestQuality() : this.panel.selectedQuality;
      const reuse = this.#precaptureFits(id, audioOnly, wanted, compat);
      if (!reuse) this.#armPrecapture(id); // lo precapturado no sirve: se descarta
      this.plan = { id, title: this.player.title(fallbackTitle), artist: this.player.author(), mode, startS, requestedEndS: range.endS, endS, durationS, mediaEndS: Infinity };
      // Si lo precapturado ya llegó al final del flujo, su final real ya se sabe.
      const ended = this.hub.streamEnd;
      if (reuse && ended && ended.id === id) this.#acceptMediaEnd(ended.duration);
      this.hub.targetId = id;
      this.hub.capturedBytes = this.live.bytes;
      this.hub.capturing = true;
      this.attempts.clear();
      this.refills = 0;
      this.refilling = false;
      this.lastT = this.player.currentTime();
      this.notes = [];
      this.adsSkipped = 0;
      this.repositionUntil = 0;
      this.growth = { covered: -1, at: performance.now(), nudges: 0 };
      this.endPhase = 'run';
      this.governor.reset(true, this.player.frames());
      this.pacer.reset(true);
      this.#applyMode();
      this.meter.reset();
      this.quality = wanted;
      this.qualityReasserted = false;
      this.previousRate = this.player.video?.playbackRate || 1;
      this.wasMuted = this.player.mute();
      if (compat) this.gate.install(); // el reproductor elegirá H.264 + AAC al recargar
      this.player.lockQuality(wanted);
      this.state = 'capturing';
      this.startedAt = performance.now();
      this.lastTickAt = this.startedAt;
      if (audioOnly) this.notes.push('Solo audio: el video va en la calidad mínima para no gastar red en imagen.');
      if (reuse) this.notes.push('Se aprovecha lo precapturado.');
      this.panel.setProgress(0);
      this.panel.setHint('');
      this.panel.setStatus('Capturando…');
      this.#render();
      clearInterval(this.timer);
      clearInterval(this.paceTimer);
      this.timer = window.setInterval(() => this.#tick(), TICK_MS);
      this.paceTimer = window.setInterval(() => this.#pace(), PACE_MS);
      this.#fillNextHole(true);
    }

    /**
     * Guarda la última captura completa. Sin `win`, guarda el tramo del panel,
     * que debe caer dentro de lo capturado.
     * @param {ExportMode} mode @param {TimeWindow} [win]
     * @returns {Promise<boolean>} si el archivo se guardó
     */
    async save(mode, win) {
      if (this.busy) return false;
      const captured = this.resultWindow;
      if (!captured || !this.result.hasData) {
        this.panel.setStatus('Todavía no hay una captura completa: pulsa «Capturar».', 'error');
        return false;
      }
      let w = win;
      if (!w) {
        // Campos vacíos = toda la captura; si no, el tramo pedido debe caer dentro de ella.
        /** @type {{startS: number | null, endS: number | null}} */
        let r;
        try {
          r = this.panel.range;
        } catch (err) {
          this.panel.setStatus(err instanceof Error ? err.message : String(err), 'error');
          return false;
        }
        const startS = r.startS ?? captured.startS;
        const endS = r.endS ?? captured.endS;
        const reachesEnd = captured.endS >= this.resultDurationS - RANGE_END_SLACK_S;
        if (startS < captured.startS - 0.05 || startS >= captured.endS || (endS > captured.endS + 0.05 && !reachesEnd)) {
          this.panel.setStatus(`Ese tramo no está capturado (la captura va de ${formatClock(captured.startS)} a ${formatClock(captured.endS)}): pulsa «Recapturar».`, 'error');
          return false;
        }
        w = { startS: Math.max(startS, captured.startS), endS: Math.min(endS, captured.endS) };
        if (w.endS - w.startS < MIN_RANGE_S) {
          this.panel.setStatus('«Hasta» debe quedar al menos 1 s después de «Desde».', 'error');
          return false;
        }
      }
      this.busy = true;
      this.#render();
      this.panel.setStatus('Construyendo el archivo…');
      // Deja pintar el panel; con la pestaña oculta no hay nada que pintar (y el temporizador iría lento).
      if (!document.hidden) await new Promise((resolve) => setTimeout(resolve, 30));
      try {
        const result = await this.exporter.build(this.result, mode, this.panel.selectedFormat, this.resultMeta, w,
          (ratio) => this.panel.setStatus(`Convirtiendo a MP3… ${Math.round(ratio * 100)} %`));
        const whole = w.startS <= 0.05 && w.endS >= this.resultDurationS - RANGE_END_SLACK_S;
        const clock = (/** @type {number} */ s) => formatClock(s).replace(/:/g, '.');
        const suffix = [mode === 'audio' ? 'audio' : mode === 'video' ? 'sin audio' : '', whole ? '' : `${clock(w.startS)}–${clock(w.endS)}`]
          .filter(Boolean).join(', ');
        const name = fileName(this.resultMeta.title, suffix, result.ext);
        saveBlob(result.blob, name);
        if (mode !== 'audio' && this.resultMode === 'audio') {
          result.notes.push('El video se capturó en calidad mínima (modo «Solo audio»): recaptura en «Video + audio» para tenerlo bien.');
        }
        this.panel.setStatus(`Descargado: ${name} · ${formatBytes(result.blob.size)} · ${formatTime((w.endS - w.startS) * 1000)}`, result.notes.length ? 'warn' : 'ok');
        this.panel.setDetails([...result.summary, this.#captureLine(), ...this.notes, ...result.notes]);
        return true;
      } catch (err) {
        this.panel.setStatus(err instanceof Error ? err.message : String(err), 'error');
        return false;
      } finally {
        this.busy = false;
        this.#render();
      }
    }

    dispose() {
      this.#queueStop();
      this.#cancel('');
      window.removeEventListener('beforeunload', this.onBeforeUnload);
      this.unloadGuarded = false;
      this.gate.uninstall();
      clearInterval(this.idleTimer);
      document.removeEventListener('yt-navigate-finish', this.onNavigate);
      for (const type of MEDIA_EVENTS) document.removeEventListener(type, this.onMediaEvent, true);
      this.mse.uninstall();
      this.timedText.uninstall();
      clearTimeout(this.transcriptTimer);
      this.panel.destroy();
      this.live.clear();
      this.result.clear();
      const g = /** @type {any} */ (window);
      if (g[INSTANCE_KEY] === this) delete g[INSTANCE_KEY];
    }

    #tick() {
      if (this.state !== 'capturing') return;
      const p = this.player;
      const now = performance.now();
      this.lastTickAt = now;
      const ad = p.isAdShowing();
      const settling = now < this.repositionUntil;
      if (!ad && p.videoId() !== this.plan.id) {
        if (settling) return;
        // Si el video capturado iba por su final, el cambio es el autoplay de YouTube, no el usuario.
        const nearEnd = this.plan.durationS > 0 && this.lastT >= Math.min(this.plan.durationS, this.plan.mediaEndS) - AUTOPLAY_NEAR_END_S;
        if (nearEnd && this.#missing().length) {
          // El autoplay de YouTube pasó al siguiente video con huecos aún por rellenar.
          this.notes.push('YouTube pasó a otro video: vuelvo a este para completarlo.');
          this.#fillNextHole(false);
        } else {
          this.#cancel('Cambió el video: captura cancelada, no se guardó nada.');
        }
        return;
      }
      const t = p.currentTime();
      if (ad) {
        if (p.skipAd()) this.adsSkipped++;
        this.growth.at = now; // un anuncio no es un atasco
      } else {
        this.lastT = t;
        if (this.endPhase !== 'hold') {
          p.setRate(this.endPhase === 'approach' ? 1 : this.rate);
          this.#keepPlaying(now);
        }
        if (!this.plan.durationS) this.#learnDuration();
        if (this.state !== 'capturing') return; // el tramo resultó imposible para esta duración
        if (this.plan.durationS) this.#observeMediaEnd(t);
      }
      const covered = this.#coveredSeconds();
      if (covered > this.growth.covered + 0.05) this.growth = { covered, at: now, nudges: 0 };
      if (ad || covered <= 0) this.meter.reset();
      else this.meter.add(now, covered);
      if (this.endPhase === 'run' && this.meter.spanMs >= TURBO_PROBE_MS && this.governor.evaluate(this.meter.speed, p.frames())) {
        this.#applyMode();
        this.meter.reset();
      }
      const span = this.#planEnd() - this.plan.startS;
      this.panel.setProgress(span > 0 ? covered / span : 0);
      this.panel.setDetails([...this.#trackLines(), ...this.notes]);
      if (ad) {
        this.panel.setStatus('Anuncio en curso: espero al video (lo salto si YouTube lo permite)…');
      } else if (this.hub.capturedBytes === 0 && now - this.startedAt > NO_DATA_WARNING_MS) {
        this.panel.setStatus('No llegan datos del reproductor: puede que YouTube haya cambiado cómo carga el video.', 'warn');
      } else {
        this.panel.setStatus(this.#progressLine(covered, span));
      }
      this.#render();
      if (ad) return;
      // Solo se termina cuando el tramo entero está grabado.
      if (!this.#missing().length) {
        void this.#finish();
        return;
      }
      if (settling) return;
      const idleMs = now - this.growth.at;
      const ended = p.ended() && this.plan.mediaEndS !== Infinity;
      if (ended || this.endPhase !== 'run' || t >= this.#planEnd() - 0.3) {
        if (!ended) {
          // En pausa antes del final, el reproductor sigue descargando lo que queda: se espera.
          // Si no lo hace, se avanza a 1× (se para en cuanto esté completo, antes de terminar).
          const holdAt = this.#holdAt();
          const tailOnly = this.#toMediaEnd() && this.#missing().every(([a]) => a >= holdAt - HOLE_LEAD_S);
          if (this.endPhase === 'hold' && tailOnly) {
            if (idleMs >= HOLD_PATIENCE_MS) this.#approach();
            return;
          }
          if (this.endPhase === 'approach' && tailOnly && idleMs < STALL_NUDGE_MS * 2) return; // si ni así llega, se vuelve a pedir
          if (idleMs < END_GRACE_MS) return; // por si aún llega el último segmento
        }
        // Lo que falte ya no llegará solo: se vuelve a pedir.
        this.#fillNextHole(false);
        return;
      }
      // Atasco a mitad: un empujón y, si sigue sin crecer, se pide de nuevo el primer hueco.
      if (idleMs < STALL_NUDGE_MS * (this.growth.nudges + 1)) return;
      this.growth.nudges++;
      if (this.growth.nudges === 1) {
        p.resume();
        p.seek(t + 0.1);
        this.notes.push('El reproductor se atascó: le di un empujón.');
      } else {
        this.#fillNextHole(false);
      }
    }

    /**
     * Lleva el reproductor al primer tramo que falte; si no falta nada, termina.
     * @param {boolean} first arranque de la captura (no cuenta como reintento)
     */
    #fillNextHole(first) {
      const holes = this.#missing();
      if (!holes.length) {
        void this.#finish();
        return;
      }
      const at = Math.max(this.plan.startS, holes[0][0]);
      if (first) {
        // Si lo precapturado llega justo hasta el cabezal, se sigue sin recargar.
        const e = this.#capturedEnd(this.player.currentTime());
        if (Number.isFinite(e) && Math.abs(e - at) < 2) {
          this.player.resume();
          return;
        }
      }
      this.#reposition(at, !first);
    }

    /**
     * Vuelve a pedir desde `at`. Lo que ya está en el búfer del reproductor no
     * se descarga otra vez con un salto (por eso se perdía lo cargado durante
     * un anuncio): en ese caso, o si un salto ya falló, se recarga el video ahí.
     * @param {number} at @param {boolean} refill ¿rellena un hueco? (cuenta intentos)
     */
    #reposition(at, refill) {
      const p = this.player;
      let tries = 0;
      if (refill) {
        const key = Math.round(at);
        tries = (this.attempts.get(key) ?? 0) + 1;
        this.attempts.set(key, tries);
        if (tries > MAX_HOLE_ATTEMPTS) {
          this.#fail(at);
          return;
        }
        this.refills++;
        this.refilling = true;
        this.notes.push(`Falta ${formatClock(at)}: lo pido de nuevo${tries > 1 ? ` (intento ${tries})` : ''}.`);
      }
      const target = Math.max(0, at - HOLE_LEAD_S);
      const wasHeld = this.endPhase !== 'run';
      this.endPhase = 'run';
      // Recargar si el reproductor muestra otro video, si el tramo ya está en su búfer o si un salto ya falló.
      if (!refill || tries > 1 || p.videoId() !== this.plan.id || p.isBuffered(at)) {
        p.lockQuality(this.quality);
        this.qualityReasserted = false;
        p.restart(this.plan.id, target);
      } else {
        p.seek(target);
        if (wasHeld) p.resume(); // estaba en pausa antes del final
      }
      // La velocidad la repone #tick fuera de anuncios: tocarla aquí aceleraría un anuncio que arranque con la recarga.
      this.pacer.lastEnd = -Infinity;
      this.growth = { covered: this.growth.covered, at: performance.now(), nudges: 0 };
      this.repositionUntil = performance.now() + REPOSITION_COOLDOWN_MS;
    }

    /** Se rinde con un hueco: cancela sin guardar y explica por qué. @param {number} at */
    #fail(at) {
      const elsewhere = kindsFor(this.plan.mode).some((kind) => {
        const main = mainRep(this.live, kind);
        return this.live.list(kind).some((r) => r !== main && !Number.isNaN(r.coverage.endAt(at + 0.5)));
      });
      this.#cancel(`No pude completar desde ${formatClock(at)} tras ${MAX_HOLE_ATTEMPTS} intentos: YouTube no volvió a enviar esa parte`
        + `${elsewhere ? ' en la calidad elegida' : ''}. No guardé un archivo incompleto; pulsa «Capturar» para reintentar`
        + `${elsewhere ? ' o elige una calidad menor' : ''}.`, 'error');
    }

    /** Termina una captura completa, la guarda como resultado y la descarga. */
    async #finish() {
      if (this.state !== 'capturing') return;
      // Hasta el final del video: entra todo lo grabado (la última muestra puede pasar un poco de la duración).
      const reachesEnd = this.#planEnd() >= Math.min(this.plan.durationS, this.plan.mediaEndS) - RANGE_END_SLACK_S;
      const win = { startS: this.plan.startS, endS: reachesEnd ? Math.max(this.#planEnd(), this.#capturedTail()) : this.#planEnd() };
      // Se descarga lo elegido en el panel si cabe en lo capturado (p. ej. «Solo audio» de una captura completa).
      const chosen = this.panel.selectedMode;
      const kinds = kindsFor(this.plan.mode);
      const mode = kindsFor(chosen).every((k) => kinds.includes(k)) ? chosen : this.plan.mode;
      // En pausa: si el video llegara al final, el autoplay de YouTube podría recargar la página a mitad del guardado.
      this.player.pause();
      this.#endCapture();
      this.result = this.live.detach();
      this.resultWindow = win;
      this.resultMode = this.plan.mode;
      this.resultDurationS = Math.min(this.plan.durationS, this.plan.mediaEndS);
      this.resultMeta = { title: this.plan.title, artist: this.plan.artist };
      this.state = 'done';
      this.panel.setProgress(1);
      this.panel.setStatus('Captura completa y verificada.', 'ok');
      this.#render();
      const item = this.queueRun?.item ?? null;
      const saved = await this.save(mode, win);
      const failure = saved ? '' : this.panel.statusText;
      // Con «también con cada captura», su transcripción va detrás (el reproductor sigue en este video).
      const transcriptNote = saved && this.panel.transcriptView.alsoOnCapture ? await this.#transcriptAfterCapture() : '';
      if (!item) return;
      if (this.queueRun?.item === item) {
        this.#queueItemEnded(item, saved, saved ? transcriptNote : failure);
      } else if (saved) {
        // La cola se detuvo mientras se guardaba: este ya quedó bajado.
        this.queue.update(item.id, { status: 'done', note: transcriptNote });
        this.#renderQueue();
      }
    }

    /**
     * Cancela la captura en curso y descarta lo grabado: no hay descargas parciales.
     * @param {string} message @param {'info'|'error'} [tone]
     */
    #cancel(message, tone = 'info') {
      if (this.state !== 'capturing') return;
      this.#endCapture();
      this.live.resetSamples();
      this.state = this.resultWindow ? 'done' : 'idle';
      this.panel.setProgress(0);
      if (message) this.panel.setStatus(message, tone);
      this.#render();
      const item = this.queueRun?.item;
      if (item) this.#queueItemEnded(item, false, message);
    }

    /** «Cancelar»: descarta la captura en curso y, si la hay, detiene la cola. */
    #userCancel() {
      const queued = this.#queueStop();
      if (this.state === 'capturing') {
        this.#cancel(queued ? 'Cola detenida: la captura en curso se descartó.' : 'Captura cancelada: no se guardó nada.');
      } else if (queued) {
        this.panel.setStatus('Cola detenida.');
        this.#render();
      }
    }

    /** Lo común a terminar o cancelar: relojes, velocidad, sonido y filtro de códecs. */
    #endCapture() {
      this.hub.capturing = false;
      this.hub.prearm = false;
      this.captureMs = performance.now() - this.startedAt;
      clearInterval(this.timer);
      clearInterval(this.paceTimer);
      this.hub.keyframes.clear();
      this.endPhase = 'run';
      this.state = 'done';
      this.#syncGate(); // el filtro sigue solo si continúa elegido «MP4 compatible»
      this.player.setRate(this.previousRate);
      if (!this.wasMuted) this.player.unmute();
    }

    /** Fin efectivo del tramo: el pedido o, si los medios acaban antes, su final real. */
    #planEnd() {
      return Math.min(this.plan.endS, this.plan.mediaEndS);
    }

    /**
     * Lo que falta del tramo, exigido hasta sus bordes. Solo al inicio del
     * video se tolera que el primer fotograma llegue algo tarde (B-frames). Al
     * final se exige hasta la duración, así no se termina sin el último
     * segmento (puede durar unos milisegundos); si los medios acaban antes,
     * vale su final real, que avisa el propio reproductor (endOfStream o «ended»).
     * @returns {Array<[number, number]>}
     */
    #missing() {
      const { startS, mode, mediaEndS } = this.plan;
      if (!this.plan.durationS) return [[startS, Infinity]]; // sin duración no se puede dar por completo
      const endS = this.#planEnd();
      const startSlack = startS <= RANGE_START_SLACK_S ? RANGE_START_SLACK_S : 0;
      const endSlack = mediaEndS !== Infinity && endS >= mediaEndS - RANGE_END_SLACK_S ? MEDIA_END_TAIL_S : 0;
      return missingIn(this.live, mode, startS, endS, startSlack, endSlack);
    }

    /**
     * Si se empezó sin conocer la duración (durante un anuncio o con el video
     * aún cargando), se toma cuando ya llegan datos de este video: entonces
     * getDuration() es la suya y no la de un anuncio. Una duración menor que
     * lo ya grabado es un valor viejo y se ignora.
     */
    #learnDuration() {
      const p = this.player;
      const d = p.duration();
      if (!this.#plausibleDuration(d) || this.#coveredSeconds() <= 0 || d < this.#capturedTail() - 1) return;
      const { startS, requestedEndS } = this.plan;
      if (startS >= d) {
        this.#cancel(`«Desde» queda después del final: el video dura ${formatClock(d)}. No se guardó nada.`, 'error');
        return;
      }
      const endS = rangeEnd(requestedEndS, d);
      if (endS - startS < MIN_RANGE_S) {
        this.#cancel('«Hasta» debe quedar al menos 1 s después de «Desde». No se guardó nada.', 'error');
        return;
      }
      Object.assign(this.plan, { durationS: d, endS, title: p.title(this.plan.title), artist: p.author() });
      const ended = this.hub.streamEnd;
      if (ended && ended.id === this.plan.id) this.#acceptMediaEnd(ended.duration);
    }

    /**
     * ¿Puede ser `d` la duración de este video? Si la ficha del video la da,
     * no puede quedarse corta (la de un anuncio o un valor viejo lo haría).
     * @param {number} d
     */
    #plausibleDuration(d) {
      const listed = this.player.listedLength();
      return d > 0 && (!listed || d >= listed - MEDIA_END_TOLERANCE_S);
    }

    /**
     * El reproductor terminó: ya entregó todo y ese es el final real de los
     * medios. Solo cuenta si es este video (no un anuncio ni otro video) y cae
     * cerca de la duración.
     * @param {number} t
     */
    #observeMediaEnd(t) {
      if (this.player.ended()) this.#acceptMediaEnd(t);
    }

    /** El reproductor entregó todo (endOfStream): MediaSource.duration es el final real. @param {number} duration */
    #onStreamEnd(duration) {
      if (this.state === 'capturing') this.#acceptMediaEnd(duration);
    }

    /** Acepta `end` como final real de los medios si cae cerca de la duración del video. @param {number} end */
    #acceptMediaEnd(end) {
      const d = this.plan.durationS;
      if (!(d > 0) || !Number.isFinite(end)) return;
      if (Math.abs(end - d) <= Math.max(MEDIA_END_TOLERANCE_S, d * 0.01)) this.plan.mediaEndS = Math.min(this.plan.mediaEndS, end);
    }

    /** ¿El tramo llega hasta el final del video? */
    #toMediaEnd() {
      return this.plan.durationS > 0 && this.#planEnd() >= Math.min(this.plan.durationS, this.plan.mediaEndS) - RANGE_END_SLACK_S;
    }

    /**
     * Dónde se detiene el video al capturar: si el tramo llega al final, unos
     * segundos antes (el reproductor descarga el resto en pausa y el video
     * nunca termina, así que el autoplay no salta); si no, al final del tramo.
     */
    #holdAt() {
      if (!this.plan.durationS) return Infinity;
      const end = this.#planEnd();
      return this.#toMediaEnd() ? Math.max(this.plan.startS, end - END_HOLD_S) : end;
    }

    /** Turbo y parada antes del final. Lo llaman su temporizador y los eventos del <video>. */
    #pace() {
      if (this.state !== 'capturing') return;
      this.#enforceHold();
      if (this.endPhase === 'run') this.pacer.step();
    }

    /** Al llegar al punto de parada, pausa; mientras dure la parada, no deja que nada lo reanude. */
    #enforceHold() {
      const p = this.player;
      if (p.isAdShowing() || p.videoId() !== this.plan.id) return;
      if (this.endPhase === 'hold') {
        if (p.isPlaying()) p.pause(); // p. ej. una recarga que arranca sola
        return;
      }
      if (this.endPhase === 'run' && p.currentTime() >= this.#holdAt()) {
        p.pause();
        this.endPhase = 'hold';
        this.growth.at = performance.now(); // la espera en pausa no es un atasco
      }
    }

    /** En pausa el reproductor no descargó lo último: se avanza a 1× para que lo pida (y se para al completar). */
    #approach() {
      this.endPhase = 'approach';
      this.growth.at = performance.now();
      this.player.setRate(1);
      this.player.resume();
      this.notes.push('Avanzo despacio hasta el final para que YouTube entregue lo último.');
    }

    /** Fin de lo grabado sin huecos desde t en todos los tipos pedidos; NaN si t no está grabado. @param {number} t */
    #capturedEnd(t) {
      let end = Infinity;
      for (const kind of kindsFor(this.plan.mode)) {
        const rep = mainRep(this.live, kind);
        const e = rep ? rep.coverage.endAt(t) : NaN;
        if (Number.isNaN(e)) return NaN;
        end = Math.min(end, e);
      }
      return Math.min(end, this.#planEnd());
    }

    /** Segundos del tramo ya grabados (manda el tipo más rezagado). */
    #coveredSeconds() {
      const endS = this.#planEnd();
      let covered = Infinity;
      for (const kind of kindsFor(this.plan.mode)) {
        const rep = mainRep(this.live, kind);
        covered = Math.min(covered, rep ? rep.coverage.coveredIn(this.plan.startS, endS) : 0);
      }
      return Number.isFinite(covered) ? covered : 0;
    }

    /** Fin de lo último grabado (s) en los tipos pedidos. */
    #capturedTail() {
      let end = 0;
      for (const kind of kindsFor(this.plan.mode)) {
        const rep = mainRep(this.live, kind);
        if (rep) end = Math.max(end, rep.coverage.last);
      }
      return end;
    }

    /** Segundos ya guardados en la precaptura (video y audio; manda el que menos tenga). */
    #precapturedSeconds() {
      let saved = Infinity;
      for (const kind of /** @type {Array<'video'|'audio'>} */ (['video', 'audio'])) {
        saved = Math.min(saved, mainRep(this.live, kind)?.coverage.total ?? 0);
      }
      return Number.isFinite(saved) ? saved : 0;
    }

    /** Aplica el modo del gobernador (saltos y velocidad de reproducción). */
    #applyMode() {
      const mode = this.governor.mode;
      this.pacer.enabled = mode.turbo;
      this.rate = mode.rate;
      if (this.state === 'capturing' && this.endPhase === 'run' && !this.player.isAdShowing()) this.player.setRate(this.rate);
      if (this.governor.locked && this.governor.speeds.size > 1) {
        this.notes.push(`Modo elegido: ${mode.label} (medido: ${this.governor.summary()}).`);
      }
    }

    /**
     * El filtro de códecs sigue al formato: con «MP4 compatible» lo que se
     * cargue desde ahora llega en H.264 + AAC (así la precaptura también sirve);
     * con cualquier otro formato el reproductor vuelve a sus códecs.
     */
    #syncGate() {
      if (!this.panel) return; // aún construyéndose
      const want = this.panel.selectedMode !== 'audio' && this.panel.selectedFormat === 'mp4c';
      if (want) this.gate.install();
      else if (this.state !== 'capturing') this.gate.uninstall();
      if (this.state !== 'capturing') this.panel.setHint(this.#prearmLine());
    }

    /** Los eventos del <video> siguen llegando aunque el navegador frene los temporizadores. @param {Event} e */
    #onMediaEvent(e) {
      if (e.target !== this.player.video) return;
      if (this.state !== 'capturing') {
        if (this.queueRun?.item && !this.busy) this.#queuePoll(); // la cola espera a que abra su video
        return;
      }
      if (!this.player.isAdShowing() && this.player.videoId() === this.plan.id) this.lastT = this.player.currentTime();
      this.#pace();
      // «ended» se atiende al instante: antes de que el autoplay de YouTube cambie de video.
      if (e.type === 'ended' || performance.now() - this.lastTickAt >= TICK_MS) this.#tick();
    }

    /** Si algo pausó el video a mitad (p. ej. «¿Sigues viendo?»), lo reanuda. @param {number} now */
    #keepPlaying(now) {
      if (!this.player.isPaused() || now - this.lastResumeAt < RESUME_GAP_MS) return;
      this.lastResumeAt = now;
      this.player.resume();
    }

    /**
     * Con el script pegado a mitad del video, el reproductor sigue llenando
     * SourceBuffers cuya inicialización se entregó antes: lo que llega no se
     * puede leer y la precaptura no guardaría nada. Fuera de captura (que ya
     * recarga por su cuenta), se recarga el video en el mismo punto, una vez:
     * desde ahí, lo que se vea queda guardado.
     */
    #onBlind() {
      const p = this.player;
      const id = this.hub.targetId;
      if (this.state === 'capturing' || this.busy || this.queueRun || !this.hub.prearm || !id || this.resyncedId === id) return;
      if (p.isAdShowing() || p.videoId() !== id || !p.isPlaying()) return; // en pausa, se espera a que siga
      const t = p.currentTime();
      const d = p.duration();
      if (d > 0 && d - t < RESYNC_MIN_LEFT_S) return;
      this.resyncedId = id;
      p.restart(id, t);
      this.panel.setStatus('Recargué el video en este punto: lo que ya tenía cargado al pegar el script no se puede leer. Desde aquí, lo que veas queda guardado.');
    }

    /** Empieza a guardar en pasivo lo que reproduzca el video `id`. @param {string} id */
    #armPrecapture(id) {
      this.live.resetSamples();
      this.hub.targetId = id;
      this.hub.prearm = id !== '';
      this.prearmOverflow = false;
    }

    /**
     * ¿Sirve lo precapturado? Debe ser de este video, en la calidad pedida
     * (cambiarla crearía otra pista) y, para «MP4 compatible», en H.264 + AAC.
     * No hace falta que empiece en 0 ni que esté entero: los huecos se piden.
     * @param {string} id @param {boolean} audioOnly @param {string} wanted '' = cualquiera
     * @param {boolean} compat
     */
    #precaptureFits(id, audioOnly, wanted, compat) {
      if (!this.hub.prearm || this.hub.targetId !== id || this.prearmOverflow || !this.live.hasData) return false;
      if (!audioOnly && wanted && wanted !== this.player.currentQuality()) return false;
      if (compat) {
        const video = mainRep(this.live, 'video');
        const audio = mainRep(this.live, 'audio');
        if ((video && video.info.codecId !== 'V_MPEG4/ISO/AVC') || (audio && audio.info.codecId !== 'A_AAC')) return false;
      }
      return true;
    }

    /** Fuera de captura: sigue al video actual, vigila la memoria y cuenta lo precapturado. */
    #idleRefresh() {
      if (this.state === 'capturing' || this.busy || this.queueRun) return;
      const id = this.player.videoId();
      if (id && id !== this.hub.targetId && !this.player.isAdShowing()) this.#armPrecapture(id);
      if (this.hub.prearm && this.live.bytes > PREARM_LIMIT_BYTES) {
        this.#armPrecapture(id);
        this.hub.prearm = false;
        this.prearmOverflow = true;
      }
      this.panel.setHint(this.#prearmLine());
      this.#render();
    }

    #prearmLine() {
      if (this.prearmOverflow) return 'Precaptura detenida: este video ocupa demasiada memoria.';
      if (!this.hub.prearm || !this.live.hasData) return '';
      const saved = this.#precapturedSeconds();
      if (saved < 1) return '';
      const compat = this.panel.selectedMode !== 'audio' && this.panel.selectedFormat === 'mp4c';
      if (compat && !this.#precaptureFits(this.hub.targetId, true, '', true)) {
        return 'La precaptura está en VP9/Opus: con «MP4 compatible» se recargará en H.264. Para usarla tal cual, elige «MP4 · máxima calidad».';
      }
      const duration = this.player.duration();
      if (duration > 0 && !missingIn(this.live, 'av', 0, duration, RANGE_START_SLACK_S, 0).length) {
        return 'Precaptura completa: «Capturar» lo guarda al instante.';
      }
      const quality = this.player.currentQuality();
      const inQuality = quality ? ` en ${this.player.qualityLabel(quality)}` : '';
      return `Precaptura: ${formatTime(saved * 1000)} ya guardados${inQuality}. Con esa calidad, «Capturar» solo pedirá lo que falte.`;
    }

    /** Otro video en la misma pestaña: precaptura nueva y calidades frescas; la última captura se conserva. */
    #onNavigate() {
      if (this.state === 'capturing' || this.queueRun) return;
      const id = this.player.videoId();
      if (id !== this.hub.targetId) this.#armPrecapture(id);
      this.#loadQualities();
      this.#refreshTranscript();
      const ready = id ? 'Listo para este video.' : 'Abre un video para capturarlo.';
      this.panel.setStatus(this.resultWindow ? `${ready} «Descargar» guarda la captura anterior.` : ready);
    }

    /** @param {number} covered @param {number} span segundos */
    #progressLine(covered, span) {
      const known = Number.isFinite(span);
      const parts = [`Capturando… ${formatTime(covered * 1000)} de ${known ? formatTime(span * 1000) : '?'}`, formatBytes(this.hub.capturedBytes)];
      const run = this.queueRun;
      if (run) {
        const c = this.queue.counts();
        parts.unshift(`Cola ${run.done + run.failed + 1}/${run.done + run.failed + c.active + c.pending}`);
      }
      const speed = this.meter.speed;
      if (speed > 0.5) {
        parts.push(`×${speed >= 10 ? Math.round(speed) : speed.toFixed(1)}`);
        if (known && span > covered && !this.refilling) parts.push(`quedan ${formatTime(((span - covered) / speed) * 1000)}`);
      }
      if (this.refilling) parts.push('rellenando huecos');
      return parts.join(' · ');
    }

    #captureLine() {
      const extras = [this.governor.mode.label];
      if (this.pacer.leaps) extras.push(`${this.pacer.leaps} saltos, ${this.pacer.keyLeaps} a fotograma clave`);
      if (this.refills) extras.push(`${this.refills} hueco(s) recuperado(s)`);
      if (this.adsSkipped) extras.push(`${this.adsSkipped} anuncio(s) saltado(s)`);
      return `Captura en ${formatTime(this.captureMs)}${extras.length ? ` (${extras.join(', ')})` : ''} · sin huecos (verificado)`;
    }

    /** Reafirma la calidad cuando aparece el primer SourceBuffer del video recargado. @param {StreamSink} sink */
    #onSink(sink) {
      if (this.state !== 'capturing' || this.qualityReasserted || sink.videoId !== this.hub.targetId) return;
      this.qualityReasserted = true;
      setTimeout(() => this.player.lockQuality(this.quality), 0);
    }

    /** La lista de calidades puede tardar en existir si el video aún carga. */
    #loadQualities(attempt = 0) {
      const list = this.player.qualities();
      this.panel.setQualities(list);
      this.#render();
      if (!list.length && attempt < 5) setTimeout(() => this.#loadQualities(attempt + 1), 1500);
    }

    #trackLines() {
      return this.live.withData()
        .sort((a, b) => b.coverage.total - a.coverage.total)
        .slice(0, 4)
        .map((r) => `${r.info.kind === 'video' ? 'Video' : 'Audio'} · ${r.label} · ${formatBytes(r.samples.bytes)}${r.info.encrypted ? ' · cifrado (DRM)' : ''}`);
    }

    // ── Transcripción ─────────────────────────────────────────────────────

    /** Opciones de transcripción del video del reproductor (su ficha puede tardar en llegar). */
    #refreshTranscript(attempt = 0) {
      clearTimeout(this.transcriptTimer);
      this.transcriptChoices = transcriptOptions(this.player.captionInfo(), this.transcriptPrefs.lang);
      const pick = defaultTranscriptOption(this.transcriptChoices, this.transcriptPrefs.lang);
      this.panel.transcriptView.setOptions(this.transcriptChoices, pick?.value ?? '');
      if (!this.transcriptChoices.length && attempt < 5) {
        this.transcriptTimer = window.setTimeout(() => this.#refreshTranscript(attempt + 1), 1500);
      }
    }

    /** Recuerda lo elegido: el idioma (el de destino, si es traducción), el formato y «también con cada captura». */
    #transcriptChanged() {
      const view = this.panel.transcriptView;
      const chosen = this.transcriptChoices.find((o) => o.value === view.selectedValue);
      this.transcriptPrefs = {
        lang: chosen ? languageBase(chosen.choice.translateTo || chosen.choice.track.languageCode) : this.transcriptPrefs.lang,
        format: view.selectedFormat,
        withCapture: view.alsoOnCapture,
      };
      saveTranscriptPrefs(this.transcriptPrefs);
    }

    /** «Descargar transcripción»: la del idioma elegido, del video que muestra el reproductor. */
    async #downloadTranscript() {
      const id = this.player.videoId();
      const chosen = this.transcriptChoices.find((o) => o.value === this.panel.transcriptView.selectedValue);
      if (!id || !chosen || this.transcriptBusy) return;
      this.panel.setStatus('Buscando la transcripción…');
      const result = await this.#saveTranscript(id, chosen.choice, this.player.title());
      this.panel.setStatus(result.message, result.ok ? 'ok' : 'warn');
    }

    /**
     * Tras guardar una captura: su transcripción, en el idioma preferido.
     * @returns {Promise<string>} nota para la cola ('' si se guardó)
     */
    async #transcriptAfterCapture() {
      const { id, title } = this.plan;
      const pick = defaultTranscriptOption(transcriptOptions(this.player.captionInfo(), this.transcriptPrefs.lang), this.transcriptPrefs.lang);
      if (!pick) {
        this.panel.appendDetail('Transcripción: este video no tiene.');
        return 'Sin transcripción: el video no tiene.';
      }
      const result = await this.#saveTranscript(id, pick.choice, title);
      this.panel.appendDetail(result.ok ? result.message : `Transcripción: ${result.message}`);
      return result.ok ? '' : 'Sin transcripción: YouTube no la entregó.';
    }

    /**
     * Consigue la transcripción y la guarda en el formato elegido.
     * @param {string} videoId @param {TranscriptChoice} choice @param {string} title
     * @returns {Promise<{ok: boolean, message: string}>}
     */
    async #saveTranscript(videoId, choice, title) {
      const view = this.panel.transcriptView;
      this.transcriptBusy = true;
      view.setBusy(true);
      try {
        const { cues, via } = await this.transcriptSource.load(videoId, choice);
        if (!cues.length || !via) {
          return { ok: false, message: 'YouTube no entregó la transcripción. Activa los subtítulos (CC) en ese idioma unos segundos y vuelve a intentarlo.' };
        }
        const file = buildTranscriptFile(cues, view.selectedFormat, { title, videoId, choice, via });
        saveBlob(file.blob, file.name);
        return { ok: true, message: `Transcripción descargada: ${file.name} · ${cues.length} subtítulos (${TRANSCRIPT_VIA_LABEL[via]}).` };
      } finally {
        this.transcriptBusy = false;
        view.setBusy(false);
      }
    }

    // ── Cola de videos ────────────────────────────────────────────────────

    #queueAddCurrent() {
      const id = this.player.videoId();
      if (!id) {
        this.panel.setStatus('No encuentro el video en esta página.', 'error');
        return;
      }
      const added = this.queue.add([{ id, title: this.player.title() }]);
      this.panel.setStatus(added ? 'Video añadido a la cola.' : 'Ese video ya está en la cola.');
      this.#renderQueue();
    }

    #queueAddPlaylist() {
      const entries = playlistEntries();
      if (!entries.length) {
        this.panel.setStatus('No veo una lista de reproducción en esta página.', 'warn');
        return;
      }
      const added = this.queue.add(entries);
      const repeated = entries.length - added;
      this.panel.setStatus(`Añadidos ${added} video(s) de la lista${repeated ? ` (${repeated} ya estaban)` : ''}.`);
      this.#renderQueue();
    }

    /** @param {string} text @returns {boolean} si había algún video en el texto */
    #queueAddText(text) {
      const ids = parseVideoIds(text);
      if (!ids.length) {
        this.panel.setStatus('No encontré enlaces ni ids de videos de YouTube en el texto.', 'error');
        return false;
      }
      const added = this.queue.add(ids.map((id) => ({ id })));
      const repeated = ids.length - added;
      this.panel.setStatus(`Añadidos ${added} video(s) a la cola${repeated ? ` (${repeated} ya estaban)` : ''}.`);
      this.#renderQueue();
      return true;
    }

    /** Captura uno tras otro los pendientes, completos, con la calidad, el archivo y el formato del panel. */
    #queueStart() {
      if (this.state === 'capturing' || this.busy || this.queueRun) return;
      if (!this.queue.next()) {
        this.panel.setStatus('La cola no tiene videos pendientes.', 'warn');
        return;
      }
      // En silencio toda la cola (anuncios y esperas incluidos); al terminar, el sonido vuelve a como estaba.
      this.queueRun = {
        quality: this.panel.selectedQuality, item: null, loaded: false, qualitySet: false,
        deadline: 0, timer: 0, done: 0, failed: 0, wasMuted: this.player.mute(),
      };
      this.#queueNext();
    }

    /** Abre el siguiente pendiente o, si no queda ninguno, termina la cola. */
    #queueNext() {
      const run = this.queueRun;
      if (!run || run.item) return;
      clearTimeout(run.timer);
      const item = this.queue.next();
      if (!item) {
        this.#queueFinish();
        return;
      }
      Object.assign(run, { item, qualitySet: false, loaded: this.player.videoId() !== item.id, deadline: performance.now() + QUEUE_LOAD_TIMEOUT_MS });
      this.queue.update(item.id, { status: 'active', note: '' });
      // La captura anterior ya se guardó: se suelta para no acumular memoria video tras video.
      this.result.clear();
      this.resultWindow = null;
      if (this.state === 'done') this.state = 'idle';
      this.panel.setProgress(0);
      this.panel.setDetails([]);
      this.panel.setHint('');
      this.panel.setStatus(`Cola: abriendo «${item.title || item.id}»…`);
      // Se guarda desde su primer segmento: si llega en la calidad pedida, la captura no tendrá que recargarlo.
      if (run.loaded || this.hub.targetId !== item.id) this.#armPrecapture(item.id);
      if (run.loaded) this.player.restart(item.id, 0);
      this.#renderQueue();
      this.#render();
      this.#queuePoll();
    }

    /**
     * Espera a que el video de la cola esté abierto y fuera de anuncios (los
     * salta si se puede) y arranca su captura. La llaman su temporizador y
     * los eventos del <video>: con la pestaña oculta, los temporizadores van lentos.
     */
    #queuePoll() {
      const run = this.queueRun;
      const item = run?.item;
      if (!run || !item || this.state === 'capturing' || this.busy) return;
      clearTimeout(run.timer);
      const p = this.player;
      const now = performance.now();
      if (p.isAdShowing()) {
        p.skipAd();
        run.deadline = Math.max(run.deadline, now + QUEUE_LOAD_TIMEOUT_MS); // el anuncio no cuenta
        this.panel.setStatus(`Cola: anuncio antes de «${item.title || item.id}» (lo salto si YouTube lo permite)…`);
      } else if (p.videoId() === item.id) {
        const list = p.qualities();
        if (list.length && !run.qualitySet) {
          // Cuanto antes llegue en la calidad pedida, más de lo precapturado sirve.
          run.qualitySet = true;
          this.panel.setQualities(list);
          if (run.quality) this.panel.selectQuality(pickQuality(list, run.quality));
          const want = this.panel.selectedMode === 'audio' ? p.lowestQuality() : this.panel.selectedQuality;
          if (want && want !== p.currentQuality()) p.lockQuality(want);
        }
        // Recién abierto con loadVideoById, duración y título pueden ser aún los del video anterior:
        // valen cuando ya llegan sus datos. Con imagen y sonido llegando, la captura sigue sin recargarlo.
        if (list.length && this.#plausibleDuration(p.duration()) && (!run.loaded || this.#precapturedSeconds() > 0)) {
          this.#startQueueItem(item);
          return;
        }
        this.#keepPlaying(now); // p. ej. si el navegador no dejó arrancar la reproducción
      }
      if (now > run.deadline) {
        this.#queueItemEnded(item, false, 'No llegó a abrirse (¿privado, eliminado o con restricción de edad?).');
        return;
      }
      run.timer = window.setTimeout(() => this.#queuePoll(), QUEUE_POLL_MS);
    }

    /** @param {QueueItem} item */
    #startQueueItem(item) {
      const fallbackTitle = item.title || item.id;
      this.queue.update(item.id, { title: this.player.title(fallbackTitle) });
      this.#renderQueue();
      this.#refreshTranscript();
      this.start({ whole: true, fallbackTitle });
      // Si arrancó, queda capturando (o ya guardando, si lo precapturado estaba completo).
      if (this.state !== 'capturing' && !this.busy) this.#queueItemEnded(item, false, this.panel.statusText);
    }

    /** @param {QueueItem} item @param {boolean} ok @param {string} [note] por qué no se pudo */
    #queueItemEnded(item, ok, note = '') {
      const run = this.queueRun;
      if (!run || run.item !== item) return;
      clearTimeout(run.timer);
      run.item = null;
      if (ok) run.done++;
      else run.failed++;
      this.queue.update(item.id, { status: ok ? 'done' : 'error', note });
      this.#renderQueue();
      this.#render();
      // Una pausa breve para ver el resultado; con la pestaña oculta nadie mira (y el temporizador iría lento).
      if (document.hidden) queueMicrotask(() => this.#queueNext());
      else run.timer = window.setTimeout(() => this.#queueNext(), QUEUE_GAP_MS);
    }

    #queueFinish() {
      const run = this.queueRun;
      if (!run) return;
      this.#queueStop();
      const failed = run.failed ? `; ${run.failed} no se pudo (el motivo está en la lista)` : '';
      this.panel.setStatus(`Cola terminada: ${run.done} video(s) guardado(s)${failed}.`, run.failed ? 'warn' : 'ok');
      this.#render();
    }

    /**
     * Detiene la cola: lo que se estaba atendiendo vuelve a quedar pendiente y
     * el sonido, como estaba antes de la cola.
     * @returns {boolean} si estaba en marcha
     */
    #queueStop() {
      const run = this.queueRun;
      if (!run) return false;
      clearTimeout(run.timer);
      if (run.item) this.queue.update(run.item.id, { status: 'pending', note: '' });
      this.queueRun = null;
      if (this.state === 'capturing') this.wasMuted = run.wasMuted; // lo repone la captura al acabar
      else if (!run.wasMuted) this.player.unmute();
      this.#renderQueue();
      return true;
    }

    #renderQueue() {
      this.panel.queueView.render(this.queue.items);
    }

    #render() {
      this.panel.setState(this.state, {
        canSave: this.resultWindow !== null && this.result.hasData && this.state !== 'capturing',
        busy: this.busy,
        queueRunning: this.queueRun !== null,
      });
      this.#syncUnloadGuard();
    }

    /**
     * Con una captura o un guardado en curso, recargar o cerrar la página pide
     * confirmación (lo grabado vive solo en esta pestaña y se perdería).
     */
    #syncUnloadGuard() {
      const need = this.state === 'capturing' || this.busy || this.queueRun !== null;
      if (need === this.unloadGuarded) return;
      this.unloadGuarded = need;
      if (need) window.addEventListener('beforeunload', this.onBeforeUnload);
      else window.removeEventListener('beforeunload', this.onBeforeUnload);
    }
  }

  new App().boot();
})();
