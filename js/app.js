let player;
let audioPlayer = null;
let playbackEngine = "none"; // none | youtube | audio
let audioFallbackAttempted = false;
let catalog = [];
let catalogMeta = [];
let visibleSongs = [];
let playQueue = [];
let currentQueueIndex = -1;
let currentSong = null;
let playerReady = false;
let shuffleEnabled = false;
let repeatEnabled = false;
let progressTimer = null;
let selectedDecade = "all";
let selectedLanguage = "english";
let globalSearchActive = false;
let customSongs = [];
let favoriteSongKeys = new Set();
let personalizationUpdatedAt = null;
let editingCustomSongId = null;
let metadataPlayer = null;
let metadataPlayerReady = false;
let metadataLookupToken = 0;
let metadataLookupReject = null;
let autoAddTimer = null;
let autoAddInProgress = false;
let lastAutoAddedVideoId = "";
let youtubeSearchResults = [];
let selectedSearchVideoIds = new Set();
let youtubeSearchAbortController = null;
const CUSTOM_SONGS_STORAGE_KEY = "cgoMusicCustomSongsV1";
const PERSONALIZATION_STORAGE_KEY = "cgoMusicPersonalizationV2";
const PERSONALIZATION_REMOTE_PATH = "data/personalizacion.json";

// Reproductor estático: usa únicamente IDs guardados en los JSON.
let stoppedByUser = true;
let pendingAdvanceTimer = null;
let failedSongIds = new Set();
let currentVideoCandidates = [];
let currentVideoCandidateIndex = 0;
let playRequestToken = 0;
let playbackWatchdogTimer = null;
let playbackWatchdogCandidate = null;

const $ = (id) => document.getElementById(id);


// =========================================================
// PWA + Media Session (iPhone / Android)
// La instalación sigue disponible desde el navegador, pero CGO Music ya no
// muestra un botón de instalación dentro de la interfaz.
// =========================================================
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || isFileProtocol()) return;

  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    console.warn("No se pudo registrar el Service Worker:", error);
  }
}

function setMediaAction(action, handler) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch (error) {
    // Algunos navegadores no implementan todos los botones de Media Session.
    console.debug(`Media Session no soporta ${action}:`, error);
  }
}

function directAudioUrl(song) {
  return String(song?.audioUrl || "").trim();
}

function activeMediaElement() {
  if (playbackEngine === "audio") return audioPlayer;
  return null;
}

function updatePlaybackSourceBadge() {
  const badge = $("playbackSourceBadge");
  const videoArea = $("videoArea");
  if (videoArea) videoArea.classList.toggle("audio-mode", playbackEngine === "audio");
  if (!badge) return;

  if (!currentSong || playbackEngine === "none") {
    badge.hidden = true;
    return;
  }

  badge.hidden = false;
  if (playbackEngine === "audio") {
    badge.textContent = "Audio · segundo plano";
    badge.classList.add("audio-source");
    badge.classList.remove("youtube-source");
  } else {
    badge.textContent = "YouTube · primer plano";
    badge.classList.add("youtube-source");
    badge.classList.remove("audio-source");
  }
}

function setupAudioPlayer() {
  audioPlayer = $("audioPlayer");
  if (!audioPlayer) return;

  audioPlayer.volume = Number($("volume")?.value || 70) / 100;

  audioPlayer.addEventListener("play", () => {
    if (playbackEngine !== "audio" || !currentSong) return;
    stoppedByUser = false;
    setMediaSessionPlaybackState("playing");
    $("playPauseBtn").textContent = "❚❚";
    startProgressTimer();
    updatePlaybackSourceBadge();
    syncMediaSessionPosition();
    setStatus("Audio directo · la reproducción en segundo plano está disponible.");
  });

  audioPlayer.addEventListener("pause", () => {
    if (playbackEngine !== "audio" || !currentSong || stoppedByUser) return;
    setMediaSessionPlaybackState("paused");
    $("playPauseBtn").textContent = "▶";
    stopProgressTimer();
    syncMediaSessionPosition();
  });

  audioPlayer.addEventListener("loadedmetadata", () => {
    if (playbackEngine === "audio") syncMediaSessionPosition();
  });

  audioPlayer.addEventListener("ended", () => {
    if (playbackEngine !== "audio") return;
    setMediaSessionPlaybackState("none");
    $("playPauseBtn").textContent = "▶";
    stopProgressTimer();
    if (!stoppedByUser) nextSong(true);
  });

  audioPlayer.addEventListener("error", () => {
    if (playbackEngine !== "audio" || stoppedByUser || !currentSong) return;
    fallbackCurrentSongToYouTube("El audio directo no pudo reproducirse.");
  });
}

async function playActiveMedia() {
  if (!currentSong) {
    startUserPlayback();
    setQueueFromVisible();
    playCurrent();
    return;
  }

  startUserPlayback();

  if (playbackEngine === "audio" && audioPlayer) {
    try {
      await audioPlayer.play();
    } catch (error) {
      console.warn("No se pudo reanudar el audio:", error);
      setStatus("El sistema no permitió reanudar el audio todavía.");
    }
    return;
  }

  if (playbackEngine === "youtube" && playerReady) {
    player.playVideo();
    return;
  }

  playCurrent();
}

function pauseActiveMedia() {
  if (playbackEngine === "audio" && audioPlayer) {
    audioPlayer.pause();
  } else if (playbackEngine === "youtube" && playerReady) {
    player.pauseVideo();
  }
}

function activeMediaPosition() {
  if (playbackEngine === "audio" && audioPlayer) {
    return {
      current: Number(audioPlayer.currentTime || 0),
      duration: Number(audioPlayer.duration || 0),
      rate: Number(audioPlayer.playbackRate || 1)
    };
  }

  if (playbackEngine === "youtube" && playerReady) {
    return {
      current: Number(player.getCurrentTime?.() || 0),
      duration: Number(player.getDuration?.() || 0),
      rate: Number(player.getPlaybackRate?.() || 1)
    };
  }

  return { current: 0, duration: 0, rate: 1 };
}

function seekActiveMedia(seconds) {
  const target = Math.max(0, Number(seconds || 0));

  if (playbackEngine === "audio" && audioPlayer) {
    const duration = Number(audioPlayer.duration || 0);
    audioPlayer.currentTime = duration > 0 ? Math.min(duration, target) : target;
  } else if (playbackEngine === "youtube" && playerReady) {
    player.seekTo(target, true);
  }

  syncMediaSessionPosition();
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;

  setMediaAction("play", playActiveMedia);
  setMediaAction("pause", pauseActiveMedia);
  setMediaAction("stop", stopPlayback);
  setMediaAction("previoustrack", previousSong);
  setMediaAction("nexttrack", () => nextSong(false));

  setMediaAction("seekbackward", details => {
    if (!currentSong) return;
    const { current } = activeMediaPosition();
    seekActiveMedia(current - Number(details.seekOffset || 10));
  });

  setMediaAction("seekforward", details => {
    if (!currentSong) return;
    const { current, duration } = activeMediaPosition();
    const target = current + Number(details.seekOffset || 10);
    seekActiveMedia(duration > 0 ? Math.min(duration, target) : target);
  });

  setMediaAction("seekto", details => {
    if (!currentSong || !Number.isFinite(details.seekTime)) return;
    seekActiveMedia(details.seekTime);
  });
}

function updateMediaSessionMetadata() {
  if (!("mediaSession" in navigator) || !currentSong || !("MediaMetadata" in window)) return;

  const customArtwork = customArtworkUrl(currentSong);
  const thumb = youtubeThumb(currentSong);
  const artwork = customArtwork
    ? [{ src: customArtwork }]
    : thumb
      ? [
          { src: thumb, sizes: "320x180", type: "image/jpeg" },
          { src: thumb.replace("mqdefault.jpg", "hqdefault.jpg"), sizes: "480x360", type: "image/jpeg" }
        ]
      : [
          { src: new URL("icons/icon-192.png", document.baseURI).href, sizes: "192x192", type: "image/png" },
          { src: new URL("icons/icon-512.png", document.baseURI).href, sizes: "512x512", type: "image/png" }
        ];

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentSong.title,
      artist: currentSong.artist,
      album: `CGO Music · ${currentSong.custom ? "Mi Música" : (currentSong.decade || "Catálogo")}`,
      artwork
    });
  } catch (error) {
    console.debug("No se pudo actualizar Media Session metadata:", error);
  }
}

function setMediaSessionPlaybackState(state) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = state;
  } catch (error) {
    console.debug("No se pudo actualizar playbackState:", error);
  }
}

function syncMediaSessionPosition() {
  if (!("mediaSession" in navigator) || !currentSong) return;
  if (typeof navigator.mediaSession.setPositionState !== "function") return;

  try {
    const { duration, current, rate } = activeMediaPosition();
    if (duration > 0) {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: rate > 0 ? rate : 1,
        position: Math.min(Math.max(0, current), duration)
      });
    }
  } catch (error) {
    console.debug("No se pudo sincronizar la posición con el sistema:", error);
  }
}

function clearPendingAdvance() {
  if (pendingAdvanceTimer) {
    clearTimeout(pendingAdvanceTimer);
    pendingAdvanceTimer = null;
  }
}

function clearPlaybackWatchdog() {
  if (playbackWatchdogTimer) {
    clearTimeout(playbackWatchdogTimer);
    playbackWatchdogTimer = null;
  }
  playbackWatchdogCandidate = null;
}

async function playAudioForCurrentSong(audioUrl) {
  if (!audioPlayer || !currentSong || stoppedByUser) return;

  playbackEngine = "audio";
  audioFallbackAttempted = false;
  clearPlaybackWatchdog();
  clearPendingAdvance();

  // Si veníamos desde YouTube, detenemos el iframe para evitar dos fuentes sonando.
  if (playerReady) {
    try { player.stopVideo(); } catch {}
  }

  const resolvedUrl = new URL(audioUrl, document.baseURI).href;
  if (audioPlayer.src !== resolvedUrl) {
    audioPlayer.src = resolvedUrl;
    audioPlayer.load();
  }

  audioPlayer.volume = Number($("volume")?.value || 70) / 100;
  updatePlaybackSourceBadge();

  try {
    await audioPlayer.play();
  } catch (error) {
    console.warn("No se pudo iniciar audio directo:", error);
    if (error?.name === "NotAllowedError") {
      setStatus("El navegador requiere tocar Play para continuar con el audio.");
      setMediaSessionPlaybackState("paused");
      $("playPauseBtn").textContent = "▶";
      return;
    }
    fallbackCurrentSongToYouTube("El audio directo no pudo iniciarse.");
  }
}

function fallbackCurrentSongToYouTube(reason) {
  if (stoppedByUser || !currentSong || audioFallbackAttempted) return;
  audioFallbackAttempted = true;

  if (audioPlayer) {
    try { audioPlayer.pause(); } catch {}
  }

  if (!playerReady) {
    markCurrentSongFailed(`${reason} YouTube todavía no está listo.`);
    return;
  }

  playbackEngine = "youtube";
  currentVideoCandidateIndex = 0;
  currentVideoCandidates = staticVideoCandidates(currentSong);
  updatePlaybackSourceBadge();

  if (!currentVideoCandidates.length) {
    markCurrentSongFailed(`${reason} Tampoco hay un youtubeId disponible.`);
    return;
  }

  setStatus(`${reason} Probando YouTube como respaldo…`);
  loadCurrentVideoCandidate();
}

function loadCurrentVideoCandidate() {
  if (
    stoppedByUser ||
    !playerReady ||
    !currentSong ||
    !currentVideoCandidates.length ||
    currentVideoCandidateIndex >= currentVideoCandidates.length
  ) {
    return;
  }

  playbackEngine = "youtube";
  if (audioPlayer && !audioPlayer.paused) {
    try { audioPlayer.pause(); } catch {}
  }
  updatePlaybackSourceBadge();

  const candidateId = currentVideoCandidates[currentVideoCandidateIndex];
  const token = playRequestToken;

  clearPlaybackWatchdog();
  playbackWatchdogCandidate = candidateId;

  try {
    player.loadVideoById(candidateId);
  } catch (error) {
    console.warn("No se pudo cargar candidato de YouTube:", candidateId, error);
    rejectCurrentVideoCandidate("El reproductor rechazó el video.");
    return;
  }

  // Algunos errores genéricos de YouTube aparecen dentro del iframe y NO
  // generan onError. Si en 9 s no existe reproducción, buffer ni duración,
  // damos ese candidato por fallido y probamos el siguiente.
  playbackWatchdogTimer = setTimeout(() => {
    playbackWatchdogTimer = null;

    if (
      stoppedByUser ||
      token !== playRequestToken ||
      !currentSong ||
      playbackWatchdogCandidate !== candidateId
    ) {
      return;
    }

    let state = -1;
    let duration = 0;

    try {
      state = player.getPlayerState();
      duration = Number(player.getDuration?.() || 0);
    } catch {
      // El watchdog continuará con el fallback.
    }

    const healthyStates = [
      YT.PlayerState.PLAYING,
      YT.PlayerState.BUFFERING,
      YT.PlayerState.PAUSED,
      YT.PlayerState.CUED
    ];

    if (!healthyStates.includes(state) && duration <= 0) {
      console.warn("Watchdog: video sin respuesta", candidateId);
      rejectCurrentVideoCandidate("YouTube no inició esta versión.");
    }
  }, 9000);
}

function rejectCurrentVideoCandidate(reason) {
  if (stoppedByUser) return;

  clearPlaybackWatchdog();

  if (currentVideoCandidateIndex + 1 < currentVideoCandidates.length) {
    currentVideoCandidateIndex += 1;

    setStatus(
      `${reason} Probando otra versión de “${currentSong?.title || "la canción"}” ` +
      `(${currentVideoCandidateIndex + 1}/${currentVideoCandidates.length})…`
    );

    clearPendingAdvance();
    pendingAdvanceTimer = setTimeout(() => {
      pendingAdvanceTimer = null;
      if (!stoppedByUser) loadCurrentVideoCandidate();
    }, 500);

    return;
  }

  markCurrentSongFailed(
    `${reason} No se encontró otra versión reproducible de ` +
    `${currentSong?.title || "la canción"}.`
  );
}

function setStatus(message) {
  $("status").textContent = message;
}

function isFileProtocol() {
  return window.location.protocol === "file:";
}

function languageLabel(lang) {
  return lang === "spanish" ? "Español" : "Inglés";
}


function makeCustomSongId() {
  if (window.crypto?.randomUUID) return `custom-${window.crypto.randomUUID()}`;
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function inferDecadeFromYear(year) {
  const value = Number(year);
  if (!Number.isFinite(value)) return "other";
  if (value >= 1950 && value <= 1959) return "50s";
  if (value >= 1960 && value <= 1969) return "60s";
  if (value >= 1970 && value <= 1979) return "70s";
  if (value >= 1980 && value <= 1989) return "80s";
  if (value >= 1990 && value <= 1999) return "90s";
  if (value >= 2000 && value <= 2009) return "2000s";
  if (value >= 2010 && value <= 2019) return "2010s";
  if (value >= 2020 && value <= 2029) return "2020s";
  return "other";
}


function getYouTubeApiKey() {
  const configKey = String(window.CGO_CONFIG?.YOUTUBE_API_KEY || "").trim();
  if (configKey && configKey !== "PEGA_AQUI_TU_API_KEY") return configKey;

  // Compatibilidad con versiones anteriores: si ya había una clave guardada en
  // este dispositivo, todavía puede usarse. La configuración oficial de esta
  // versión es js/config.js.
  try {
    return String(localStorage.getItem("cgoMusicYouTubeApiKeyV1") || "").trim();
  } catch (error) {
    return "";
  }
}

function decodeYouTubeText(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = String(value || "");
  return textarea.value;
}

function youtubeSearchItemFromApi(item) {
  const videoId = String(item?.id?.videoId || "").trim();
  const snippet = item?.snippet || {};
  return {
    videoId,
    title: decodeYouTubeText(snippet.title || ""),
    channelTitle: decodeYouTubeText(snippet.channelTitle || ""),
    publishedAt: String(snippet.publishedAt || ""),
    thumbnail: String(snippet?.thumbnails?.medium?.url || snippet?.thumbnails?.high?.url || snippet?.thumbnails?.default?.url || (videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : ""))
  };
}

function updateSearchSelectionButton() {
  const button = $("saveSongBtn");
  if (!button || editingCustomSongId) return;
  const count = selectedSearchVideoIds.size;
  button.disabled = count === 0;
  button.textContent = count === 0
    ? "Agregar seleccionadas"
    : `Agregar seleccionada${count === 1 ? "" : "s"} (${count})`;
}

function toggleSearchVideoSelection(videoId, checked) {
  if (checked) selectedSearchVideoIds.add(videoId);
  else selectedSearchVideoIds.delete(videoId);
  updateSearchSelectionButton();
}

function renderYouTubeSearchResults() {
  const container = $("youtubeSearchResults");
  if (!container) return;
  container.innerHTML = "";

  if (!youtubeSearchResults.length) return;

  youtubeSearchResults.forEach((result, index) => {
    const existing = findExistingSongByVideoId(result.videoId);
    const card = document.createElement("label");
    card.className = `youtube-result-card${existing ? " already-added" : ""}`;
    card.innerHTML = `
      <input class="youtube-result-check" type="checkbox" value="${escapeHtml(result.videoId)}" ${existing ? "disabled" : ""}>
      <img src="${escapeHtml(result.thumbnail)}" alt="" loading="lazy">
      <span class="youtube-result-copy">
        <strong>${escapeHtml(result.title)}</strong>
        <span>${escapeHtml(result.channelTitle)}</span>
        <small>${existing ? `Ya está en CGO Music como “${escapeHtml(existing.title)}”` : `Alternativa ${index + 1}`}</small>
      </span>
    `;

    const checkbox = card.querySelector(".youtube-result-check");
    checkbox?.addEventListener("change", event => {
      toggleSearchVideoSelection(result.videoId, event.target.checked);
      card.classList.toggle("selected", event.target.checked);
    });
    container.appendChild(card);
  });
}

async function searchYouTubeCandidates() {
  if (editingCustomSongId) return;
  const query = String($("youtubeSearchQuery")?.value || "").trim();
  const status = $("customSongFormStatus");
  const button = $("youtubeSearchBtn");
  const apiKey = getYouTubeApiKey();

  if (!query) {
    status.textContent = "Escribe el nombre de una canción o artista.";
    $("youtubeSearchQuery")?.focus();
    return;
  }

  if (!apiKey) {
    status.textContent = "Falta la API key de YouTube. Agrégala en js/config.js y vuelve a cargar CGO Music.";
    return;
  }

  youtubeSearchAbortController?.abort();
  youtubeSearchAbortController = new AbortController();
  youtubeSearchResults = [];
  selectedSearchVideoIds.clear();
  renderYouTubeSearchResults();
  updateSearchSelectionButton();
  button.disabled = true;
  button.textContent = "Buscando…";
  status.textContent = "Buscando 5 alternativas reproducibles en YouTube…";

  try {
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      maxResults: "5",
      videoEmbeddable: "true",
      videoSyndicated: "true",
      safeSearch: "moderate",
      q: query,
      key: apiKey
    });
    const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`, {
      signal: youtubeSearchAbortController.signal
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const apiMessage = payload?.error?.message || `HTTP ${response.status}`;
      throw new Error(apiMessage);
    }

    youtubeSearchResults = (Array.isArray(payload?.items) ? payload.items : [])
      .map(youtubeSearchItemFromApi)
      .filter(item => /^[A-Za-z0-9_-]{11}$/.test(item.videoId));

    renderYouTubeSearchResults();
    if (youtubeSearchResults.length) {
      const available = youtubeSearchResults.filter(item => !findExistingSongByVideoId(item.videoId)).length;
      status.textContent = available
        ? `Encontré ${youtubeSearchResults.length} alternativas. Marca una o varias para agregarlas.`
        : "Los 5 resultados encontrados ya existen en CGO Music.";
    } else {
      status.textContent = "YouTube no devolvió videos para esa búsqueda.";
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.warn("Búsqueda YouTube Data API:", error);
    status.textContent = `No pude buscar en YouTube: ${error.message || error}. Revisa js/config.js y las restricciones de la API key.`;
  } finally {
    button.disabled = false;
    button.textContent = "Buscar";
  }
}

function customSongFromSearchResult(result) {
  const parsed = splitYouTubeArtistAndTitle(result.title, result.channelTitle);
  const year = inferYearFromVideoTitle(result.title);
  return normalizeCustomSong({
    id: makeCustomSongId(),
    title: parsed.title,
    artist: parsed.artist,
    year,
    language: languageForAutomaticSong(`${parsed.title} ${parsed.artist}`),
    decade: inferDecadeFromYear(year),
    youtubeId: result.videoId,
    youtubeUrl: `https://www.youtube.com/watch?v=${result.videoId}`,
    artworkUrl: result.thumbnail || `https://i.ytimg.com/vi/${result.videoId}/hqdefault.jpg`,
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

function addSelectedYouTubeResults() {
  if (editingCustomSongId) return;
  const status = $("customSongFormStatus");
  const selected = youtubeSearchResults.filter(item => selectedSearchVideoIds.has(item.videoId));
  if (!selected.length) {
    status.textContent = "Selecciona al menos una alternativa.";
    return;
  }

  const added = [];
  const skipped = [];
  selected.forEach(result => {
    const existing = findExistingSongByVideoId(result.videoId);
    if (existing) {
      skipped.push(existing);
      return;
    }
    const song = customSongFromSearchResult(result);
    if (song.title && song.artist) {
      customSongs.push(song);
      added.push(song);
    }
  });

  if (!added.length) {
    status.textContent = skipped.length ? "Las alternativas seleccionadas ya estaban registradas." : "No pude agregar las alternativas seleccionadas.";
    return;
  }

  saveCustomSongs();
  rebuildCatalogWithCustomSongs();
  closeCustomSongDialog();
  $("searchInput").value = "";
  globalSearchActive = false;
  selectCollection("custom");
  selectDecade("all");
  applyFilters();
  setStatus(`${added.length} canción${added.length === 1 ? "" : "es"} agregada${added.length === 1 ? "" : "s"} a Mi Música${skipped.length ? ` · ${skipped.length} ya existía${skipped.length === 1 ? "" : "n"}` : ""}.`);
}

function cleanYouTubeChannelName(value) {
  return String(value || "")
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/\s*Official$/i, "")
    .replace(/VEVO$/i, "")
    .trim();
}

function cleanYouTubeSongTitle(value) {
  return String(value || "")
    .replace(/\s*[\[(](?:official\s*)?(?:music\s*)?video(?:\s*clip)?[\])]/ig, "")
    .replace(/\s*[\[(](?:official\s*)?audio[\])]/ig, "")
    .replace(/\s*[\[(](?:official\s*)?(?:lyric|lyrics)(?:\s*video)?[\])]/ig, "")
    .replace(/\s*[\[(](?:hd|hq|4k|remaster(?:ed)?(?:\s*\d{4})?)[\])]/ig, "")
    .replace(/\s*\|\s*(?:official\s*)?(?:music\s*)?video.*$/i, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*[-–—|]\s*$/g, "")
    .trim();
}

function inferYearFromVideoTitle(value) {
  const years = String(value || "").match(/\b(?:19[5-9]\d|20[0-2]\d)\b/g);
  if (!years?.length) return null;
  const year = Number(years[years.length - 1]);
  return Number.isFinite(year) ? year : null;
}

function splitYouTubeArtistAndTitle(videoTitle, channelName) {
  const raw = String(videoTitle || "").trim();
  const channel = cleanYouTubeChannelName(channelName);
  const separators = [" - ", " – ", " — ", " | "];

  for (const separator of separators) {
    const index = raw.indexOf(separator);
    if (index > 0 && index < raw.length - separator.length) {
      const left = cleanYouTubeSongTitle(raw.slice(0, index));
      const right = cleanYouTubeSongTitle(raw.slice(index + separator.length));
      if (left && right && left.length <= 90) {
        return { artist: left, title: right };
      }
    }
  }

  return {
    artist: channel || "YouTube",
    title: cleanYouTubeSongTitle(raw) || raw || "Canción de YouTube"
  };
}

function languageForAutomaticSong(title = "") {
  if (selectedLanguage === "spanish") return "spanish";
  if (selectedLanguage === "english") return "english";

  // En Mi Música el idioma no afecta la reproducción. Esta heurística sólo
  // decide la etiqueta inicial y el usuario puede corregirla con Editar.
  const spanishHints = /[áéíóúñ¿¡]|\b(el|la|los|las|una|un|amor|corazón|corazon|quiero|vida|noche|baila|canción|cancion)\b/i;
  return spanishHints.test(title) ? "spanish" : "english";
}

function waitForMetadataPlayerReady(timeoutMs = 7000) {
  if (metadataPlayerReady && metadataPlayer) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (metadataPlayerReady && metadataPlayer) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("El lector de YouTube todavía no está disponible."));
      }
    }, 100);
  });
}

async function readYouTubeMetadata(videoId) {
  await waitForMetadataPlayerReady();
  const token = ++metadataLookupToken;

  return new Promise((resolve, reject) => {
    let attempts = 0;
    metadataLookupReject = message => {
      if (token !== metadataLookupToken) return;
      metadataLookupReject = null;
      reject(new Error(message || "YouTube no pudo leer ese video."));
    };

    try {
      metadataPlayer.cueVideoById(videoId);
    } catch (error) {
      metadataLookupReject = null;
      reject(error);
      return;
    }

    const timer = setInterval(() => {
      if (token !== metadataLookupToken) {
        clearInterval(timer);
        return;
      }

      attempts += 1;
      try {
        const data = typeof metadataPlayer.getVideoData === "function"
          ? metadataPlayer.getVideoData()
          : null;
        const loadedId = String(data?.video_id || data?.videoId || "");

        if (data?.title && (!loadedId || loadedId === videoId)) {
          clearInterval(timer);
          metadataLookupReject = null;
          resolve({
            title: String(data.title || "").trim(),
            author: String(data.author || "").trim()
          });
          return;
        }
      } catch (error) {
        // Seguimos esperando unos segundos: el iframe puede estar cargando metadatos.
      }

      if (attempts >= 36) {
        clearInterval(timer);
        metadataLookupReject = null;
        reject(new Error("No pude obtener el título y artista desde YouTube."));
      }
    }, 250);
  });
}

function setupMetadataPlayer() {
  if (!window.YT?.Player || metadataPlayer) return;

  const playerVars = { playsinline: 1, rel: 0, controls: 0 };
  if (window.location.origin && window.location.origin !== "null") {
    playerVars.origin = window.location.origin;
  }

  metadataPlayer = new YT.Player("metadataPlayer", {
    width: "1",
    height: "1",
    videoId: "",
    playerVars,
    events: {
      onReady: () => { metadataPlayerReady = true; },
      onError: event => {
        if (metadataLookupReject) {
          const reject = metadataLookupReject;
          metadataLookupReject = null;
          reject(`YouTube rechazó el video (${errorDescription(event.data)}).`);
        }
      }
    }
  });
}

function findExistingSongByVideoId(videoId) {
  return catalog.find(song => {
    const candidates = staticVideoCandidates(song);
    return song.youtubeId === videoId || candidates.includes(videoId);
  }) || null;
}

async function autoAddSongFromYouTubeUrl() {
  if (editingCustomSongId || autoAddInProgress) return;

  const input = $("customYoutubeUrl");
  const status = $("customSongFormStatus");
  const rawUrl = input?.value.trim() || "";
  const videoId = videoIdFromUrl(rawUrl);

  if (!videoId) {
    status.textContent = "Pega una URL válida de YouTube (watch, youtu.be, shorts o live).";
    return;
  }

  if (lastAutoAddedVideoId === videoId) return;

  const existing = findExistingSongByVideoId(videoId);
  if (existing) {
    status.textContent = `Ese video ya está registrado como “${existing.title}” de ${existing.artist}.`;
    return;
  }

  autoAddInProgress = true;
  $("saveSongBtn").disabled = true;
  $("saveSongBtn").textContent = "Leyendo YouTube…";
  status.textContent = "Leyendo título y artista desde YouTube…";

  try {
    const metadata = await readYouTubeMetadata(videoId);
    const parsed = splitYouTubeArtistAndTitle(metadata.title, metadata.author);
    const year = inferYearFromVideoTitle(metadata.title);
    const song = normalizeCustomSong({
      id: makeCustomSongId(),
      title: parsed.title,
      artist: parsed.artist,
      year,
      language: languageForAutomaticSong(`${parsed.title} ${parsed.artist}`),
      decade: inferDecadeFromYear(year),
      youtubeId: videoId,
      youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
      artworkUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      addedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    if (!song.title || !song.artist) throw new Error("YouTube no entregó suficiente información del video.");

    customSongs.push(song);
    saveCustomSongs();
    rebuildCatalogWithCustomSongs();
    lastAutoAddedVideoId = videoId;

    closeCustomSongDialog();
    $("searchInput").value = "";
    globalSearchActive = false;
    selectCollection("custom");
    selectDecade("all");
    applyFilters();
    setStatus(`“${song.title}” de ${song.artist} fue agregada automáticamente a Mi Música.`);
  } catch (error) {
    console.warn("No se pudo completar el alta automática:", error);
    status.textContent = `${error.message || error} Prueba buscar la canción por nombre o revisa que la URL sea reproducible.`;
    $("customTitle").value ||= "";
    $("customArtist").value ||= "";
    $("customArtworkUrl").value ||= `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  } finally {
    autoAddInProgress = false;
    if (editingCustomSongId) {
      $("saveSongBtn").disabled = false;
      $("saveSongBtn").textContent = "Guardar cambios";
    } else {
      updateSearchSelectionButton();
    }
  }
}

function scheduleAutomaticAddFromUrl() {
  if (editingCustomSongId) return;
  clearTimeout(autoAddTimer);
  const value = $("customYoutubeUrl")?.value.trim() || "";
  const videoId = videoIdFromUrl(value);
  const status = $("customSongFormStatus");

  if (!value) {
    status.textContent = "";
    return;
  }
  if (!videoId) {
    status.textContent = "Pega el enlace completo de un video de YouTube.";
    return;
  }

  status.textContent = "URL detectada. Preparando registro automático…";
  autoAddTimer = setTimeout(() => autoAddSongFromYouTubeUrl(), 450);
}

function normalizeCustomSong(song) {
  const language = song?.language === "spanish" ? "spanish" : "english";
  const year = song?.year ? Number(song.year) : null;
  const youtubeId = String(song?.youtubeId || videoIdFromUrl(song?.youtubeUrl) || "").trim();
  const youtubeUrl = youtubeId
    ? `https://www.youtube.com/watch?v=${youtubeId}`
    : String(song?.youtubeUrl || "").trim();

  return {
    id: String(song?.id || makeCustomSongId()),
    title: String(song?.title || "").trim(),
    artist: String(song?.artist || "").trim(),
    year: Number.isFinite(year) ? year : null,
    language,
    decade: String(song?.decade || inferDecadeFromYear(year)),
    youtubeId: /^[A-Za-z0-9_-]{11}$/.test(youtubeId) ? youtubeId : "",
    youtubeUrl,
    youtubeAlternatives: Array.isArray(song?.youtubeAlternatives) ? song.youtubeAlternatives : [],
    audioUrl: String(song?.audioUrl || "").trim(),
    artworkUrl: String(song?.artworkUrl || "").trim(),
    verified: false,
    chart: "",
    chartPeak: null,
    position: null,
    custom: true,
    addedAt: song?.addedAt || new Date().toISOString(),
    updatedAt: song?.updatedAt || new Date().toISOString()
  };
}


function favoriteKey(song) {
  if (!song) return "";
  if (song.id) return String(song.id);
  if (song.youtubeId) return `youtube:${song.youtubeId}`;
  return `${song.language || ""}|${song.decade || ""}|${song.artist || ""}|${song.title || ""}`.toLowerCase();
}

function isFavorite(song) {
  const key = favoriteKey(song);
  return Boolean(key && favoriteSongKeys.has(key));
}

function normalizeFavoriteKeys(items) {
  if (!Array.isArray(items)) return [];
  return [...new Set(items.map(item => {
    if (typeof item === "string") return item.trim();
    if (item && typeof item === "object") return String(item.key || item.id || "").trim();
    return "";
  }).filter(Boolean))];
}

function parseDateMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function loadLocalPersonalization() {
  try {
    const raw = localStorage.getItem(PERSONALIZATION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        exists: true,
        updatedAt: parsed?.updatedAt || null,
        songs: Array.isArray(parsed?.songs) ? parsed.songs : [],
        favorites: normalizeFavoriteKeys(parsed?.favorites)
      };
    }

    // Migración transparente desde la versión anterior de Mi Música.
    const legacyRaw = localStorage.getItem(CUSTOM_SONGS_STORAGE_KEY);
    if (legacyRaw) {
      const legacyParsed = JSON.parse(legacyRaw);
      const legacySongs = Array.isArray(legacyParsed) ? legacyParsed : legacyParsed?.songs;
      return {
        exists: true,
        updatedAt: null,
        songs: Array.isArray(legacySongs) ? legacySongs : [],
        favorites: []
      };
    }
  } catch (error) {
    console.warn("No se pudo leer la personalización local:", error);
  }

  return { exists: false, updatedAt: null, songs: [], favorites: [] };
}

async function loadRemotePersonalization() {
  if (isFileProtocol()) return { exists: false, updatedAt: null, songs: [], favorites: [] };

  try {
    const response = await fetch(`${PERSONALIZATION_REMOTE_PATH}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      if (response.status !== 404) console.warn("No se pudo cargar personalizacion.json:", response.status);
      return { exists: false, updatedAt: null, songs: [], favorites: [] };
    }

    const parsed = await response.json();
    return {
      exists: true,
      updatedAt: parsed?.updatedAt || parsed?.exportedAt || null,
      songs: Array.isArray(parsed?.songs) ? parsed.songs : [],
      favorites: normalizeFavoriteKeys(parsed?.favorites)
    };
  } catch (error) {
    console.debug("No existe una personalización publicada todavía:", error);
    return { exists: false, updatedAt: null, songs: [], favorites: [] };
  }
}

function choosePersonalization(localState, remoteState) {
  if (!localState.exists && !remoteState.exists) return { songs: [], favorites: [], updatedAt: null, source: "none" };
  if (!localState.exists) return { ...remoteState, source: "github" };
  if (!remoteState.exists) return { ...localState, source: "local" };

  const localTime = parseDateMs(localState.updatedAt);
  const remoteTime = parseDateMs(remoteState.updatedAt);

  // Si ambos son antiguos y no tienen fecha, preservamos el dispositivo actual.
  if (remoteTime > localTime) return { ...remoteState, source: "github" };
  return { ...localState, source: "local" };
}

function personalStatePayload() {
  const favoriteSongs = catalog
    .filter(song => isFavorite(song))
    .map(song => ({
      key: favoriteKey(song),
      id: song.id || null,
      title: song.title,
      artist: song.artist,
      year: song.year ?? null,
      language: song.language || null,
      decade: song.decade || null,
      youtubeId: song.youtubeId || null,
      custom: Boolean(song.custom)
    }));

  return {
    app: "CGO Music",
    version: 2,
    updatedAt: personalizationUpdatedAt || new Date().toISOString(),
    songs: customSongs,
    favorites: [...favoriteSongKeys],
    favoriteSongs
  };
}

function savePersonalization({ touch = true } = {}) {
  try {
    if (touch || !personalizationUpdatedAt) personalizationUpdatedAt = new Date().toISOString();
    const payload = personalStatePayload();
    payload.updatedAt = personalizationUpdatedAt;
    localStorage.setItem(PERSONALIZATION_STORAGE_KEY, JSON.stringify(payload));
    // Mantener compatibilidad con versiones anteriores de CGO Music.
    localStorage.setItem(CUSTOM_SONGS_STORAGE_KEY, JSON.stringify(customSongs));
  } catch (error) {
    console.error("No se pudo guardar la personalización:", error);
    alert("El navegador no pudo guardar tus cambios. Revisa el espacio disponible o la configuración de privacidad.");
  }
}

function updateFavoritesTabCount() {
  const count = catalog.filter(song => isFavorite(song)).length;
  if ($("favoritesTabCount")) {
    $("favoritesTabCount").textContent = `${count} favorita${count === 1 ? "" : "s"}`;
  }
}

function toggleFavorite(songId) {
  const song = catalog.find(item => String(item.id) === String(songId));
  if (!song) return;

  const key = favoriteKey(song);
  if (!key) return;

  const wasFavorite = favoriteSongKeys.has(key);
  if (wasFavorite) favoriteSongKeys.delete(key);
  else favoriteSongKeys.add(key);

  savePersonalization();
  updateFavoritesTabCount();
  applyFilters();
  setStatus(wasFavorite
    ? `“${song.title}” fue quitada de Favoritos.`
    : `★ “${song.title}” fue agregada a Favoritos.`);
}

function loadCustomSongs() {
  try {
    const raw = localStorage.getItem(CUSTOM_SONGS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : parsed?.songs;
    if (!Array.isArray(items)) return [];
    return items
      .map(normalizeCustomSong)
      .filter(song => song.title && song.artist && (song.audioUrl || staticVideoCandidates(song).length));
  } catch (error) {
    console.warn("No se pudo leer Mi Música:", error);
    return [];
  }
}

function saveCustomSongs() {
  savePersonalization();
}

function rebuildCatalogWithCustomSongs() {
  const baseSongs = catalog.filter(song => !song.custom);
  catalog = [...baseSongs, ...customSongs];
  updateCatalogProgress();
  updateCustomTabCount();
  updateFavoritesTabCount();
}

function updateCustomTabCount() {
  if ($("customTabCount")) {
    const count = customSongs.length;
    $("customTabCount").textContent = `${count} canción${count === 1 ? "" : "es"} agregada${count === 1 ? "" : "s"}`;
  }
}

function updateCustomToolbarVisibility() {
  const personalView = (selectedLanguage === "custom" || selectedLanguage === "favorites") && !globalSearchActive;
  $("importSongsBtn")?.toggleAttribute("hidden", !personalView);
  $("exportSongsBtn")?.toggleAttribute("hidden", !personalView);
}

function selectCollection(value) {
  selectedLanguage = value;
  document.querySelectorAll(".collection-tab").forEach(button => {
    button.classList.toggle("active", button.dataset.language === value);
  });
}

function selectDecade(value) {
  selectedDecade = value;
  document.querySelectorAll(".decade").forEach(button => {
    button.classList.toggle("active", button.dataset.decade === value);
  });
}

function openCustomSongDialog(song = null, initialQuery = "") {
  const dialog = $("customSongDialog");
  if (!dialog) return;

  editingCustomSongId = song?.id || null;
  lastAutoAddedVideoId = "";
  clearTimeout(autoAddTimer);
  youtubeSearchAbortController?.abort();
  youtubeSearchResults = [];
  selectedSearchVideoIds.clear();
  $("customSongForm").reset();
  $("customSongFormStatus").textContent = "";
  $("youtubeSearchResults").innerHTML = "";

  const searchMode = $("youtubeSearchMode");
  const manualDetails = $("manualSongDetails");
  $("customSongDialogTitle").textContent = song ? "Editar canción" : "Buscar y agregar canción";
  $("customSongDialogHelp").textContent = song
    ? "Puedes corregir los datos de esta canción y guardar los cambios."
    : "Escribe el nombre de la canción o artista. CGO Music mostrará 5 alternativas de YouTube y podrás agregar una o varias.";

  if (searchMode) searchMode.hidden = Boolean(song);
  if (manualDetails) {
    manualDetails.hidden = !song;
    manualDetails.open = Boolean(song);
  }

  if (song) {
    $("saveSongBtn").disabled = false;
    $("saveSongBtn").textContent = "Guardar cambios";
    $("customTitle").value = song.title || "";
    $("customArtist").value = song.artist || "";
    $("customYear").value = song.year || "";
    $("customLanguage").value = song.language === "spanish" ? "spanish" : "english";
    $("customDecade").value = song.decade || inferDecadeFromYear(song.year);
    $("customYoutubeUrl").value = song.youtubeUrl || (song.youtubeId ? `https://www.youtube.com/watch?v=${song.youtubeId}` : "");
    $("customAudioUrl").value = song.audioUrl || "";
    $("customArtworkUrl").value = song.artworkUrl || "";
  } else {
    $("saveSongBtn").disabled = true;
    $("saveSongBtn").textContent = "Agregar seleccionadas";
    $("youtubeSearchQuery").value = initialQuery || "";
    $("customLanguage").value = selectedLanguage === "spanish" ? "spanish" : "english";
    $("customDecade").value = "other";
  }

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  setTimeout(() => (song ? $("customTitle") : $("youtubeSearchQuery"))?.focus(), 50);
}

function closeCustomSongDialog() {
  clearTimeout(autoAddTimer);
  youtubeSearchAbortController?.abort();
  const dialog = $("customSongDialog");
  if (!dialog) return;
  editingCustomSongId = null;
  youtubeSearchResults = [];
  selectedSearchVideoIds.clear();
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function handleCustomSongFormSubmit(event) {
  event.preventDefault();
  if (editingCustomSongId) saveCustomSongFromForm(event);
  else addSelectedYouTubeResults();
}

function saveCustomSongFromForm(event) {
  event.preventDefault();

  const title = $("customTitle").value.trim();
  const artist = $("customArtist").value.trim();
  const yearValue = $("customYear").value.trim();
  const year = yearValue ? Number(yearValue) : null;
  const language = $("customLanguage").value;
  const decade = $("customDecade").value || inferDecadeFromYear(year);
  const youtubeInput = $("customYoutubeUrl").value.trim();
  const audioUrl = $("customAudioUrl").value.trim();
  const artworkUrl = $("customArtworkUrl").value.trim();
  const youtubeId = youtubeInput ? videoIdFromUrl(youtubeInput) : "";
  const status = $("customSongFormStatus");

  if (!title || !artist) {
    status.textContent = "Título y artista son obligatorios.";
    return;
  }
  if (year !== null && (!Number.isFinite(year) || year < 1900 || year > 2100)) {
    status.textContent = "Revisa el año ingresado.";
    return;
  }
  if (youtubeInput && !youtubeId) {
    status.textContent = "La URL de YouTube no parece válida. Usa un enlace del video (watch, youtu.be, shorts o live).";
    return;
  }
  if (!youtubeId && !audioUrl) {
    status.textContent = "Agrega una URL de YouTube o una URL de audio directo para poder reproducir la canción.";
    return;
  }

  const previous = customSongs.find(song => song.id === editingCustomSongId);
  const song = normalizeCustomSong({
    ...(previous || {}),
    id: previous?.id || makeCustomSongId(),
    title,
    artist,
    year,
    language,
    decade,
    youtubeId,
    youtubeUrl: youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : "",
    audioUrl,
    artworkUrl,
    addedAt: previous?.addedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  if (previous) {
    customSongs = customSongs.map(item => item.id === previous.id ? song : item);
  } else {
    customSongs.push(song);
  }

  saveCustomSongs();
  rebuildCatalogWithCustomSongs();
  closeCustomSongDialog();

  $("searchInput").value = "";
  globalSearchActive = false;
  selectCollection("custom");
  selectDecade("all");
  applyFilters();
  setStatus(previous ? `“${song.title}” fue actualizada en Mi Música.` : `“${song.title}” fue agregada a Mi Música.`);
}

function editCustomSong(songId) {
  const song = customSongs.find(item => item.id === songId);
  if (song) openCustomSongDialog(song);
}

function resetNowPlayingIfSong(songId) {
  if (currentSong?.id !== songId) return;
  stopPlayback();
  currentSong = null;
  playQueue = [];
  currentQueueIndex = -1;
  $("nowTitle").textContent = "Selecciona una canción";
  $("nowArtist").textContent = "CGO Music";
  $("sideTrackTitle").textContent = "Selecciona una canción";
  $("sideTitle").textContent = "CGO Music";
  $("sideArtist").textContent = "Elige un tema para comenzar";
  $("dockThumb").innerHTML = "<span>♪</span>";
  $("sideThumb").innerHTML = "<span>♪</span>";
}

function deleteCustomSong(songId) {
  const song = customSongs.find(item => item.id === songId);
  if (!song) return;
  if (!confirm(`¿Eliminar “${song.title}” de Mi Música?`)) return;

  resetNowPlayingIfSong(songId);
  favoriteSongKeys.delete(favoriteKey(song));
  customSongs = customSongs.filter(item => item.id !== songId);
  saveCustomSongs();
  rebuildCatalogWithCustomSongs();
  applyFilters();
  setStatus(`“${song.title}” fue eliminada de Mi Música.`);
}

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCustomSongs() {
  // Un solo archivo mantiene Mi Música + Favoritos. Al subirlo a
  // data/personalizacion.json, GitHub pasa a ser una copia persistente.
  personalizationUpdatedAt = new Date().toISOString();
  savePersonalization({ touch: false });
  const payload = {
    ...personalStatePayload(),
    updatedAt: personalizationUpdatedAt,
    exportedAt: new Date().toISOString()
  };

  downloadJson("personalizacion.json", payload);
  setStatus(
    `Exportado personalizacion.json · ${customSongs.length} de Mi Música · ` +
    `${favoriteSongKeys.size} favorito${favoriteSongKeys.size === 1 ? "" : "s"}. ` +
    `Súbelo a la carpeta data/ de GitHub.`
  );
}

async function importCustomSongs(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const items = Array.isArray(parsed) ? parsed : parsed?.songs;
    if (!Array.isArray(items)) throw new Error("El JSON no contiene una lista de canciones.");

    const imported = items
      .map(normalizeCustomSong)
      .filter(song => song.title && song.artist && (song.audioUrl || staticVideoCandidates(song).length));

    const byId = new Map(customSongs.map(song => [song.id, song]));
    imported.forEach(song => byId.set(song.id, song));
    customSongs = [...byId.values()];

    if (Array.isArray(parsed?.favorites)) {
      favoriteSongKeys = new Set(normalizeFavoriteKeys(parsed.favorites));
    }

    personalizationUpdatedAt = parsed?.updatedAt || parsed?.exportedAt || new Date().toISOString();
    rebuildCatalogWithCustomSongs();
    savePersonalization({ touch: false });
    updateFavoritesTabCount();

    if (selectedLanguage !== "favorites") selectCollection("custom");
    selectDecade("all");
    $("searchInput").value = "";
    applyFilters();
    setStatus(
      `Personalización importada · ${imported.length} canción${imported.length === 1 ? "" : "es"} · ` +
      `${favoriteSongKeys.size} favorito${favoriteSongKeys.size === 1 ? "" : "s"}.`
    );
  } catch (error) {
    console.error("Error importando personalización:", error);
    alert(`No se pudo importar el archivo: ${error.message || error}`);
  } finally {
    $("importSongsInput").value = "";
  }
}

function normalizeSong(song, meta) {
  return {
    ...song,
    language: song.language || meta.language,
    decade: song.decade || meta.decade
  };
}


function videoIdFromUrl(value) {
  if (!value) return "";

  try {
    const url = new URL(String(value));
    const host = url.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] || "";
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      const watchId = url.searchParams.get("v");
      if (watchId) return watchId;

      const parts = url.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(parts[0])) {
        return parts[1] || "";
      }
    }
  } catch {
    return "";
  }

  return "";
}

function youtubeThumb(song) {
  const id = uniqueVideoIds([
    song?.youtubeId,
    videoIdFromUrl(song?.youtubeUrl),
    ...(Array.isArray(song?.youtubeAlternatives) ? song.youtubeAlternatives : [])
  ])[0] || "";
  return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : "";
}

function customArtworkUrl(song) {
  const value = String(song?.artworkUrl || "").trim();
  if (!value) return "";
  try {
    return new URL(value, document.baseURI).href;
  } catch {
    return "";
  }
}

function displayArtwork(song) {
  return customArtworkUrl(song) || youtubeThumb(song);
}

function uniqueVideoIds(ids) {
  return [...new Set((ids || []).filter(id => /^[A-Za-z0-9_-]{11}$/.test(id)))];
}

function staticVideoCandidates(song) {
  return uniqueVideoIds([
    song?.youtubeId,
    videoIdFromUrl(song?.youtubeUrl),
    ...(Array.isArray(song?.youtubeAlternatives) ? song.youtubeAlternatives : [])
  ]);
}

async function loadCatalog() {
  try {
    setStatus("Cargando los 12 catálogos...");

    const manifestResponse = await fetch("data/catalogs.json");
    if (!manifestResponse.ok) {
      throw new Error("No se pudo cargar data/catalogs.json");
    }

    const manifest = await manifestResponse.json();

    const catalogResponses = await Promise.all(
      manifest.catalogs.map(async (entry) => {
        try {
          const response = await fetch(entry.path);
          if (!response.ok) throw new Error(`${response.status} ${entry.path}`);

          const data = await response.json();
          const meta = data.meta || {
            language: entry.language,
            decade: entry.decade,
            targetCount: 100
          };

          return {
            ok: true,
            entry,
            meta,
            songs: Array.isArray(data.songs)
              ? data.songs.map(song => normalizeSong(song, meta))
              : []
          };
        } catch (error) {
          console.error("Error de catálogo:", entry.path, error);
          return {
            ok: false,
            entry,
            meta: {
              language: entry.language,
              decade: entry.decade,
              targetCount: 100
            },
            songs: []
          };
        }
      })
    );

    catalog = catalogResponses.flatMap(result => result.songs);

    const [remotePersonalization, localPersonalization] = await Promise.all([
      loadRemotePersonalization(),
      Promise.resolve(loadLocalPersonalization())
    ]);
    const personal = choosePersonalization(localPersonalization, remotePersonalization);
    customSongs = (personal.songs || [])
      .map(normalizeCustomSong)
      .filter(song => song.title && song.artist && (song.audioUrl || staticVideoCandidates(song).length));
    favoriteSongKeys = new Set(normalizeFavoriteKeys(personal.favorites));
    personalizationUpdatedAt = personal.updatedAt || null;

    catalog = [...catalog, ...customSongs];
    updateCustomTabCount();
    updateFavoritesTabCount();
    if (personal.source !== "none") savePersonalization({ touch: false });
    catalogMeta = catalogResponses.map(result => ({
      ...result.meta,
      path: result.entry.path,
      loaded: result.ok,
      currentCount: result.songs.length,
      verifiedCount: result.songs.filter(song => song.verified).length
    }));

    $("catalogTotal").textContent = catalog.length.toLocaleString("es-CL");
    updateCatalogProgress();
    applyFilters();

    const failed = catalogResponses.filter(result => !result.ok).length;

    if (failed > 0) {
      setStatus(`Catálogo cargado con ${failed} archivo(s) que no pudieron leerse.`);
    } else if (isFileProtocol()) {
      setStatus("⚠ Usa INICIAR_CGO_MUSIC.bat para reproducir YouTube correctamente.");
    } else {
      setStatus(`12 catálogos cargados · ${catalog.length.toLocaleString("es-CL")} canciones.`);
    }
  } catch (error) {
    console.error(error);
    setStatus("No se pudo cargar el índice de catálogos. Ejecuta INICIAR_CGO_MUSIC.bat.");
  }
}

function updateCatalogProgress() {
  const loadedCatalogs = catalogMeta.filter(item => item.loaded).length;
  const verifiedCount = catalog.filter(song => song.verified).length;

  if ($("catalogLists")) {
    $("catalogLists").textContent = `${loadedCatalogs}/12`;
  }
  if ($("verifiedTotal")) {
    $("verifiedTotal").textContent = verifiedCount.toLocaleString("es-CL");
  }
}

function onYouTubeIframeAPIReady() {
  const playerVars = { playsinline: 1, rel: 0 };

  if (window.location.origin && window.location.origin !== "null") {
    playerVars.origin = window.location.origin;
  }

  player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    videoId: "",
    playerVars,
    events: {
      onReady: () => {
        playerReady = true;
        player.setVolume(Number($("volume").value));
        updateVolumeLabel();
        if (playbackEngine !== "audio") {
          setStatus(isFileProtocol()
            ? "⚠ Abierto con file://. Ejecuta INICIAR_CGO_MUSIC.bat."
            : "Reproductor híbrido listo.");
        }
      },
      onStateChange: handlePlayerState,
      onError: handlePlayerError
    }
  });

  setupMetadataPlayer();
}

function handlePlayerState(event) {
  if (playbackEngine !== "youtube") return;

  if (event.data === YT.PlayerState.PLAYING) {
    stoppedByUser = false;
    setMediaSessionPlaybackState("playing");
    syncMediaSessionPosition();
    clearPendingAdvance();
    clearPlaybackWatchdog();
    $("playPauseBtn").textContent = "❚❚";
    startProgressTimer();
  } else if (event.data === YT.PlayerState.BUFFERING) {
    clearPlaybackWatchdog();
  } else if (event.data === YT.PlayerState.PAUSED) {
    setMediaSessionPlaybackState("paused");
    syncMediaSessionPosition();
    clearPlaybackWatchdog();
    $("playPauseBtn").textContent = "▶";
    stopProgressTimer();
  } else if (event.data === YT.PlayerState.ENDED) {
    setMediaSessionPlaybackState("none");
    clearPlaybackWatchdog();
    $("playPauseBtn").textContent = "▶";
    stopProgressTimer();
    if (!stoppedByUser) nextSong(true);
  }
}

function errorDescription(code) {
  const descriptions = {
    2: "ID de video inválido",
    5: "error del reproductor HTML5",
    100: "video eliminado o privado",
    101: "video sin permiso para reproducción embebida",
    150: "video sin permiso para reproducción embebida",
    153: "YouTube no recibió un HTTP Referer válido"
  };
  return descriptions[code] || `error de YouTube ${code}`;
}

function handlePlayerError(event) {
  if (playbackEngine !== "youtube" || stoppedByUser) return;

  console.warn(
    "YouTube error:",
    event.data,
    errorDescription(event.data)
  );

  rejectCurrentVideoCandidate(
    `Esta versión falló (${errorDescription(event.data)}).`
  );
}

function markCurrentSongFailed(message) {
  if (currentSong) failedSongIds.add(currentSong.id);

  if (playQueue.length > 0 && failedSongIds.size >= playQueue.length) {
    stoppedByUser = true;
    clearPendingAdvance();
    stopProgressTimer();
    $("playPauseBtn").textContent = "▶";
    setStatus("No quedan canciones con URL de YouTube reproducible en esta cola.");
    return;
  }

  setStatus(`${message} Saltando a la siguiente...`);
  clearPendingAdvance();
  pendingAdvanceTimer = setTimeout(() => {
    pendingAdvanceTimer = null;
    if (!stoppedByUser) nextSong(true);
  }, 900);
}

function applyFilters() {
  const query = $("searchInput").value.trim().toLowerCase();
  globalSearchActive = query.length > 0;

  visibleSongs = catalog.filter(song => {
    if (globalSearchActive) {
      const haystack = [
        song.title,
        song.artist,
        song.year ?? "",
        song.decade,
        song.language,
        languageLabel(song.language),
        song.chart ?? "",
        song.chartPeak ?? "",
        song.verified ? "verificado" : ""
      ].join(" ").toLowerCase();

      return haystack.includes(query);
    }

    const matchesCollection = selectedLanguage === "custom"
      ? song.custom === true
      : selectedLanguage === "favorites"
        ? isFavorite(song)
        : song.language === selectedLanguage;
    const matchesDecade = selectedDecade === "all" || song.decade === selectedDecade;
    return matchesCollection && matchesDecade;
  });

  visibleSongs.sort((a, b) => {
    if (a.decade !== b.decade) return decadeOrder(a.decade) - decadeOrder(b.decade);

    const posA = Number(a.position || 9999);
    const posB = Number(b.position || 9999);
    if (posA !== posB) return posA - posB;

    const yearA = Number(a.year || 9999);
    const yearB = Number(b.year || 9999);
    if (yearA !== yearB) return yearA - yearB;

    return a.title.localeCompare(b.title, "es");
  });

  updateLibraryHeader(query);
  updateCustomToolbarVisibility();
  renderSongList();
}

function decadeOrder(decade) {
  const order = {
    "50s": 0, "60s": 1, "70s": 2,
    "80s": 3, "90s": 4, "2000s": 5,
    "2010s": 6, "2020s": 7, "other": 99
  };
  return order[decade] ?? 999;
}

function getCurrentCatalogMeta() {
  if (globalSearchActive || selectedLanguage === "custom" || selectedLanguage === "favorites" || selectedDecade === "all") return null;
  return catalogMeta.find(item =>
    item.language === selectedLanguage &&
    item.decade === selectedDecade
  ) || null;
}

function updateLibraryHeader(query) {
  const currentMeta = getCurrentCatalogMeta();

  if (query) {
    $("collectionEyebrow").textContent = "RESULTADOS GLOBALES";
    $("libraryTitle").textContent = `“${$("searchInput").value.trim()}”`;
    $("songCount").textContent =
      `${visibleSongs.length} resultado${visibleSongs.length === 1 ? "" : "s"} en todo CGO Music`;
    return;
  }

  if (selectedLanguage === "favorites") {
    $("collectionEyebrow").textContent = "FAVORITOS";
    $("libraryTitle").textContent = selectedDecade === "all"
      ? "Tus canciones favoritas"
      : selectedDecade === "other"
        ? "Favoritos · Otras décadas"
        : `Favoritos · ${selectedDecade === "2000s" ? "2000" : selectedDecade.replace("s", "")}s`;
    $("songCount").textContent = `${visibleSongs.length} favorita${visibleSongs.length === 1 ? "" : "s"}`;
    return;
  }

  if (selectedLanguage === "custom") {
    $("collectionEyebrow").textContent = "MI MÚSICA";
    $("libraryTitle").textContent = selectedDecade === "all"
      ? "Canciones agregadas por ti"
      : selectedDecade === "other"
        ? "Otras décadas"
        : `Década de los ${selectedDecade === "2000s" ? "2000" : selectedDecade.replace("s", "")}`;
    $("songCount").textContent = `${visibleSongs.length} canción${visibleSongs.length === 1 ? "" : "es"}`;
    return;
  }

  $("collectionEyebrow").textContent =
    `COLECCIÓN EN ${languageLabel(selectedLanguage).toUpperCase()}`;

  if (selectedDecade === "all") {
    $("libraryTitle").textContent = "Todas las décadas";
    const languageSongs = catalog.filter(song => song.language === selectedLanguage);
    const verified = languageSongs.filter(song => song.verified).length;

    $("songCount").textContent = selectedLanguage === "spanish"
      ? `${languageSongs.length} canciones`
      : `${languageSongs.length} canciones · ${verified} con ranking verificado`;
  } else {
    $("libraryTitle").textContent = selectedDecade === "other"
      ? "Otras décadas"
      : `Década de los ${selectedDecade === "2000s" ? "2000" : selectedDecade.replace("s", "")}`;

    const currentCount = currentMeta?.currentCount ?? visibleSongs.length;
    const verifiedCount = currentMeta?.verifiedCount ?? visibleSongs.filter(song => song.verified).length;

    $("songCount").textContent = selectedLanguage === "spanish"
      ? `${currentCount} canciones`
      : `${currentCount} canciones · ${verifiedCount} verificadas`;
  }
}

function chartBadge(song) {
  if (song.custom) return "Mi música";
  if (song.verified && song.chart && Number(song.chartPeak) > 0) {
    return `${song.chart} #${song.chartPeak}`;
  }

  // En la colección en español no exigimos mostrar verificación histórica.
  if (song.language === "spanish") {
    return "—";
  }

  return "—";
}

function thumbMarkup(song) {
  const thumb = displayArtwork(song);
  return thumb
    ? `<img src="${thumb}" alt="" loading="lazy">`
    : `<span class="song-note" aria-hidden="true">♪</span>`;
}

function renderSongList() {
  const list = $("songList");
  list.innerHTML = "";
  $("emptyState").hidden = visibleSongs.length > 0;
  if ($("emptyAddBtn")) {
    $("emptyAddBtn").hidden = !(globalSearchActive && visibleSongs.length === 0);
  }

  visibleSongs.forEach((song, index) => {
    const row = document.createElement("div");
    row.className = `song-row ${currentSong?.id === song.id ? "active" : ""}`;
    row.dataset.songId = song.id;
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-label", `Reproducir ${song.title} de ${song.artist}`);

    const displayPosition =
      selectedDecade !== "all" && !globalSearchActive && song.position
        ? String(song.position).padStart(2, "0")
        : String(index + 1).padStart(2, "0");

    const customActions = song.custom ? `
      <span class="custom-song-actions" aria-label="Acciones de Mi Música">
        <button class="mini-action edit-custom-song" type="button" title="Editar">Editar</button>
        <button class="mini-action danger delete-custom-song" type="button" title="Eliminar">Eliminar</button>
      </span>` : "";

    row.innerHTML = `
      <span class="song-index">${displayPosition}</span>
      <span class="song-title-wrap">
        <span class="song-thumb">
          ${thumbMarkup(song)}
          <span class="play-overlay">${currentSong?.id === song.id ? "♫" : "▶"}</span>
        </span>
        <span class="song-copy">
          <strong>${escapeHtml(song.title)}</strong>
          <span>${escapeHtml(song.artist)} · ${languageLabel(song.language)}${song.custom ? " · Mi Música" : ""}</span>
          ${customActions}
        </span>
        <button class="favorite-btn ${isFavorite(song) ? "active" : ""}" type="button"
                title="${isFavorite(song) ? "Quitar de Favoritos" : "Agregar a Favoritos"}"
                aria-label="${isFavorite(song) ? "Quitar de Favoritos" : "Agregar a Favoritos"}"
                aria-pressed="${isFavorite(song) ? "true" : "false"}">${isFavorite(song) ? "★" : "☆"}</button>
      </span>
      <span class="song-year">${song.year ?? "—"}</span>
      <span class="peak ${(!song.verified && song.language !== "spanish" && !song.custom) ? "pending" : ""}">${chartBadge(song)}</span>
    `;

    const playRow = () => {
      startUserPlayback();
      setQueueFromVisible(song.id);
      playCurrent();
    };

    row.addEventListener("click", event => {
      if (event.target.closest(".custom-song-actions") || event.target.closest(".favorite-btn")) return;
      playRow();
    });
    row.addEventListener("keydown", event => {
      if (event.target.closest(".custom-song-actions") || event.target.closest(".favorite-btn")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        playRow();
      }
    });

    row.querySelector(".edit-custom-song")?.addEventListener("click", event => {
      event.stopPropagation();
      editCustomSong(song.id);
    });
    row.querySelector(".delete-custom-song")?.addEventListener("click", event => {
      event.stopPropagation();
      deleteCustomSong(song.id);
    });
    row.querySelector(".favorite-btn")?.addEventListener("click", event => {
      event.stopPropagation();
      toggleFavorite(song.id);
    });

    list.appendChild(row);
  });
}

function setQueueFromVisible(songId = null, forceShuffle = false) {
  const shouldShuffle = forceShuffle || shuffleEnabled;
  playQueue = shouldShuffle ? shuffledCopy(visibleSongs) : [...visibleSongs];

  if (!playQueue.length) return;

  if (songId !== null) {
    const selected = playQueue.find(song => song.id === songId);

    if (shouldShuffle && selected) {
      playQueue = [
        selected,
        ...playQueue.filter(song => song.id !== songId)
      ];
      currentQueueIndex = 0;
    } else {
      currentQueueIndex = playQueue.findIndex(song => song.id === songId);
    }
  } else {
    currentQueueIndex = 0;
  }
}

function startUserPlayback() {
  stoppedByUser = false;
  clearPendingAdvance();
  failedSongIds.clear();
}

function playCurrent() {
  if (stoppedByUser) return;

  if (!playQueue.length || currentQueueIndex < 0) {
    setStatus("No hay canciones en la cola.");
    return;
  }

  ++playRequestToken;
  currentSong = playQueue[currentQueueIndex];
  currentVideoCandidateIndex = 0;
  currentVideoCandidates = [];
  audioFallbackAttempted = false;

  updateNowPlaying();

  const audioUrl = directAudioUrl(currentSong);
  if (audioUrl) {
    playAudioForCurrentSong(audioUrl);
    renderSongList();
    return;
  }

  if (!playerReady) {
    playbackEngine = "none";
    updatePlaybackSourceBadge();
    setStatus("YouTube todavía no está listo. Espera un momento y vuelve a intentar.");
    return;
  }

  playbackEngine = "youtube";
  updatePlaybackSourceBadge();
  currentVideoCandidates = staticVideoCandidates(currentSong);

  if (!currentVideoCandidates.length) {
    markCurrentSongFailed(
      `No hay audioUrl ni youtubeId estático para ${currentSong.title}. ` +
      `Agrega una fuente de audio o ejecuta ACTUALIZAR_URLS_YOUTUBE.bat.`
    );
    return;
  }

  loadCurrentVideoCandidate();
  setStatus(shuffleEnabled ? "Reproducción aleatoria con YouTube." : "Reproducción en orden con YouTube.");
  renderSongList();
}

function nextSong(auto = false) {
  if (auto && stoppedByUser) return;

  if (!playQueue.length) {
    setQueueFromVisible();
    if (!playQueue.length) return;
  }

  if (!auto) startUserPlayback();

  const atEnd = currentQueueIndex >= playQueue.length - 1;

  if (atEnd && !repeatEnabled && auto) {
    stoppedByUser = true;
    stopProgressTimer();
    $("playPauseBtn").textContent = "▶";
    setStatus("La lista terminó.");
    return;
  }

  currentQueueIndex = (currentQueueIndex + 1) % playQueue.length;
  playCurrent();
}

function previousSong() {
  if (!playQueue.length) {
    setQueueFromVisible();
    if (!playQueue.length) return;
  }

  startUserPlayback();
  currentQueueIndex =
    (currentQueueIndex - 1 + playQueue.length) % playQueue.length;
  playCurrent();
}

function togglePlayPause() {
  if (!currentSong) {
    startUserPlayback();
    setQueueFromVisible();
    playCurrent();
    return;
  }

  if (playbackEngine === "audio" && audioPlayer) {
    if (audioPlayer.paused) {
      playActiveMedia();
    } else {
      audioPlayer.pause();
    }
    return;
  }

  if (playbackEngine === "youtube" && playerReady) {
    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
      player.pauseVideo();
    } else {
      startUserPlayback();
      player.playVideo();
    }
    return;
  }

  startUserPlayback();
  playCurrent();
}

function stopPlayback() {
  stoppedByUser = true;
  playRequestToken += 1;
  clearPendingAdvance();
  clearPlaybackWatchdog();
  failedSongIds.clear();
  stopProgressTimer();

  if (audioPlayer) {
    try {
      audioPlayer.pause();
      audioPlayer.currentTime = 0;
    } catch (error) {
      console.warn("No se pudo detener audio directo:", error);
    }
  }

  if (playerReady) {
    try {
      player.stopVideo();
    } catch (error) {
      console.warn("No se pudo detener YouTube:", error);
    }
  }

  playbackEngine = "none";
  updatePlaybackSourceBadge();
  $("playPauseBtn").textContent = "▶";
  setMediaSessionPlaybackState("none");
  $("progress").value = 0;
  $("currentTime").textContent = "0:00";
  $("duration").textContent = "0:00";
  setStatus("Reproducción detenida.");
}

function setShuffle(enabled) {
  shuffleEnabled = enabled;
  $("shuffleBtn").classList.toggle("active", shuffleEnabled);
  $("shuffleBtn").setAttribute("aria-pressed", String(shuffleEnabled));
  $("shuffleBtn").title = shuffleEnabled ? "Aleatorio activado" : "Activar aleatorio";
}

function toggleShuffle() {
  setShuffle(!shuffleEnabled);

  if (currentSong) {
    const source = playQueue.length ? playQueue : visibleSongs;
    const remaining = source.filter(song => song.id !== currentSong.id);

    playQueue = shuffleEnabled
      ? [currentSong, ...shuffledCopy(remaining)]
      : [...visibleSongs];

    currentQueueIndex =
      playQueue.findIndex(song => song.id === currentSong.id);

    if (currentQueueIndex < 0) {
      playQueue.unshift(currentSong);
      currentQueueIndex = 0;
    }
  }
}

function toggleRepeat() {
  repeatEnabled = !repeatEnabled;
  $("repeatBtn").classList.toggle("active", repeatEnabled);
  $("repeatBtn").setAttribute("aria-pressed", String(repeatEnabled));
  $("repeatBtn").title = repeatEnabled
    ? "Repetición de lista activada"
    : "Repetir lista";

  setStatus(repeatEnabled
    ? "Repetición de lista activada."
    : "Repetición de lista desactivada.");
}

function updateNowPlaying() {
  const thumb = displayArtwork(currentSong);
  const verified = Boolean(currentSong.verified);

  $("nowTitle").textContent = currentSong.title;
  $("nowArtist").textContent = currentSong.artist;
  $("trackBadge").textContent = chartBadge(currentSong);
  $("trackBadge").classList.toggle("pending", !verified && currentSong.language !== "spanish");

  $("sideTrackTitle").textContent = currentSong.title;
  $("sideTitle").textContent = currentSong.title;
  $("sideArtist").textContent =
    `${currentSong.artist}${currentSong.year ? ` · ${currentSong.year}` : ""}`;

  if (currentSong.custom) {
    $("verificationTitle").textContent = "Mi Música";
    $("verificationText").textContent = "Canción agregada por ti a este dispositivo.";
    $("verificationIcon").textContent = "♥";
    $("verificationIcon").classList.remove("pending");
  } else if (verified) {
    $("verificationTitle").textContent =
      `${currentSong.chart} Top ${currentSong.chartPeak}`;
    $("verificationText").textContent =
      `Ranking verificado${currentSong.chartYear ? ` · ${currentSong.chartYear}` : ""}`;
    $("verificationIcon").textContent = "✓";
    $("verificationIcon").classList.remove("pending");
  } else if (currentSong.language === "spanish") {
    $("verificationTitle").textContent = "Colección en español";
    $("verificationText").textContent =
      "Canción incluida en la selección CGO Music.";
    $("verificationIcon").textContent = "♪";
    $("verificationIcon").classList.remove("pending");
  } else {
    $("verificationTitle").textContent = "Información de ranking";
    $("verificationText").textContent =
      "No hay una fuente de ranking asociada a este registro.";
    $("verificationIcon").textContent = "♪";
    $("verificationIcon").classList.remove("pending");
  }

  $("verificationLink").href = currentSong.chartSource || "#";
  $("verificationLink").style.display =
    currentSong.chartSource ? "inline-block" : "none";

  $("dockThumb").innerHTML = thumb
    ? `<img src="${thumb}" alt="">`
    : `<span>♪</span>`;

  $("sideThumb").innerHTML = thumb
    ? `<img src="${thumb}" alt="">`
    : `<span>♪</span>`;

  updateMediaSessionMetadata();
  renderSongList();
}

function startProgressTimer() {
  stopProgressTimer();

  progressTimer = setInterval(() => {
    if (!currentSong || stoppedByUser) return;

    const { current, duration: total } = activeMediaPosition();

    $("currentTime").textContent = formatTime(current);
    $("duration").textContent = formatTime(total);

    if (total > 0) {
      $("progress").value = Math.min(100, (current / total) * 100);
      syncMediaSessionPosition();
    }
  }, 1000);
}

function stopProgressTimer() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
}

function updateVolumeLabel() {
  if ($("volumeValue")) {
    $("volumeValue").textContent = `${Number($("volume").value)}%`;
  }
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function shuffledCopy(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clearSearch() {
  $("searchInput").value = "";
  applyFilters();
  $("searchInput").focus();
}

document.addEventListener("DOMContentLoaded", () => {
  registerServiceWorker();
  setupAudioPlayer();
  setupMediaSession();
  loadCatalog();
  updateVolumeLabel();

  $("searchInput").addEventListener("input", applyFilters);
  $("clearSearchBtn").addEventListener("click", clearSearch);


  $("addSongBtn").addEventListener("click", () => openCustomSongDialog());
  $("emptyAddBtn").addEventListener("click", () => openCustomSongDialog(null, $("searchInput").value.trim()));
  $("closeSongDialogBtn").addEventListener("click", closeCustomSongDialog);
  $("cancelSongBtn").addEventListener("click", closeCustomSongDialog);
  $("customSongForm").addEventListener("submit", handleCustomSongFormSubmit);
  $("youtubeSearchBtn").addEventListener("click", searchYouTubeCandidates);
  $("youtubeSearchQuery").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchYouTubeCandidates();
    }
  });
  $("customYoutubeUrl").addEventListener("input", scheduleAutomaticAddFromUrl);
  $("customYear").addEventListener("change", event => {
    if (event.target.value) $("customDecade").value = inferDecadeFromYear(event.target.value);
  });
  $("customSongDialog").addEventListener("click", event => {
    if (event.target === $("customSongDialog")) closeCustomSongDialog();
  });
  $("importSongsBtn").addEventListener("click", () => $("importSongsInput").click());
  $("exportSongsBtn").addEventListener("click", exportCustomSongs);
  $("importSongsInput").addEventListener("change", event => importCustomSongs(event.target.files?.[0]));

  document.querySelectorAll(".collection-tab").forEach(button => {
    button.addEventListener("click", () => {
      selectCollection(button.dataset.language);
      if (globalSearchActive) $("searchInput").value = "";
      applyFilters();
    });
  });

  document.querySelectorAll(".decade").forEach(button => {
    button.addEventListener("click", () => {
      selectDecade(button.dataset.decade);
      if (globalSearchActive) $("searchInput").value = "";
      applyFilters();
    });
  });

  $("playAllBtn").addEventListener("click", () => {
    if (!visibleSongs.length) return;
    setShuffle(false);
    startUserPlayback();
    setQueueFromVisible();
    playCurrent();
  });

  $("shuffleAllBtn").addEventListener("click", () => {
    if (!visibleSongs.length) return;
    setShuffle(true);
    startUserPlayback();
    setQueueFromVisible(null, true);
    playCurrent();
  });

  $("playPauseBtn").addEventListener("click", togglePlayPause);
  $("stopBtn").addEventListener("click", stopPlayback);
  $("nextBtn").addEventListener("click", () => nextSong(false));
  $("prevBtn").addEventListener("click", previousSong);
  $("shuffleBtn").addEventListener("click", toggleShuffle);
  $("repeatBtn").addEventListener("click", toggleRepeat);

  $("volume").addEventListener("input", event => {
    updateVolumeLabel();
    const value = Number(event.target.value);
    if (playerReady) player.setVolume(value);
    if (audioPlayer) audioPlayer.volume = value / 100;
  });

  $("progress").addEventListener("input", event => {
    if (!currentSong) return;
    const { duration: total } = activeMediaPosition();
    if (total > 0) {
      seekActiveMedia((Number(event.target.value) / 100) * total);
    }
  });

  $("toggleVideoBtn").addEventListener("click", () => {
    const hidden = $("videoArea").classList.toggle("hidden");
    $("toggleVideoBtn").textContent = hidden ? "▸" : "▾";
  });
});

/* =========================================================
   CGO Music — instalación PWA y navegación móvil v8
   ========================================================= */
let deferredInstallPrompt = null;

function isRunningStandalone() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
}

function isIOSDevice() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function setInstallStatus(message = "") {
  const status = $("installStatus");
  if (status) status.textContent = message;
}

function refreshInstallButton() {
  const button = $("installAppBtn");
  if (!button) return;
  if (isRunningStandalone()) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  button.classList.toggle("install-ready", Boolean(deferredInstallPrompt));
}

function openInstallDialog() {
  const dialog = $("installDialog");
  if (!dialog) return;

  const iosSteps = $("iosInstallSteps");
  const genericSteps = $("genericInstallSteps");
  const nativeButton = $("nativeInstallBtn");
  const copy = $("installDialogText");

  iosSteps.hidden = true;
  genericSteps.hidden = true;
  nativeButton.hidden = true;
  setInstallStatus("");

  if (isRunningStandalone()) {
    copy.textContent = "CGO Music ya está abierta como aplicación en este dispositivo.";
    setInstallStatus("Ya está instalada.");
  } else if (deferredInstallPrompt) {
    copy.textContent = "Instala CGO Music para abrirla desde tu pantalla de inicio como una aplicación.";
    nativeButton.hidden = false;
  } else if (isIOSDevice()) {
    copy.textContent = "En iPhone y iPad, Apple permite agregar la app desde el menú Compartir de Safari.";
    iosSteps.hidden = false;
  } else {
    copy.textContent = "Puedes crear un acceso directo o instalar CGO Music desde las opciones de tu navegador.";
    genericSteps.hidden = false;
  }

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeInstallDialog() {
  const dialog = $("installDialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

async function triggerNativeInstall() {
  if (!deferredInstallPrompt) {
    setInstallStatus("Usa el menú de tu navegador para agregar CGO Music a la pantalla de inicio.");
    return;
  }

  try {
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice?.outcome === "accepted") {
      setInstallStatus("Instalación aceptada. CGO Music aparecerá en tu pantalla de inicio.");
    } else {
      setInstallStatus("Instalación cancelada.");
    }
  } catch (error) {
    console.warn("No se pudo abrir el diálogo de instalación:", error);
    setInstallStatus("No se pudo iniciar la instalación. Intenta desde el menú del navegador.");
  } finally {
    deferredInstallPrompt = null;
    refreshInstallButton();
  }
}

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  refreshInstallButton();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  refreshInstallButton();
  closeInstallDialog();
});

function setMobileNavActive(name) {
  document.querySelectorAll(".mobile-nav-btn").forEach(button => {
    button.classList.toggle("active", button.dataset.mobileNav === name);
  });
}

function mobileNavigate(name) {
  if (name === "search") {
    setMobileNavActive("search");
    window.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => $("searchInput")?.focus(), 280);
    return;
  }

  if (name === "custom" || name === "favorites") {
    if ($("searchInput")) $("searchInput").value = "";
    selectCollection(name);
    selectDecade("all");
    applyFilters();
    setMobileNavActive(name);
    document.querySelector(".collection-tabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  setMobileNavActive("home");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.addEventListener("DOMContentLoaded", () => {
  refreshInstallButton();

  $("installAppBtn")?.addEventListener("click", openInstallDialog);
  $("closeInstallDialogBtn")?.addEventListener("click", closeInstallDialog);
  $("nativeInstallBtn")?.addEventListener("click", triggerNativeInstall);
  $("installDialog")?.addEventListener("click", event => {
    if (event.target === $("installDialog")) closeInstallDialog();
  });

  document.querySelectorAll(".mobile-nav-btn").forEach(button => {
    button.addEventListener("click", () => mobileNavigate(button.dataset.mobileNav));
  });

  document.querySelectorAll(".collection-tab").forEach(button => {
    button.addEventListener("click", () => {
      const language = button.dataset.language;
      setMobileNavActive(language === "custom" || language === "favorites" ? language : "home");
    });
  });

  $("searchInput")?.addEventListener("focus", () => {
    if (window.matchMedia("(max-width: 760px)").matches) setMobileNavActive("search");
  });
});
