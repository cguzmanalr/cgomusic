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
// =========================================================
let deferredInstallPrompt = null;

function isIosDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isAndroidDevice() {
  return /Android/i.test(navigator.userAgent);
}

function isStandaloneMode() {
  return window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
}

function setInstallButtonVisible(visible) {
  const button = $("installAppBtn");
  if (button) button.hidden = !visible;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || isFileProtocol()) return;

  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    console.warn("No se pudo registrar el Service Worker:", error);
  }
}

function setupInstallExperience() {
  if (isStandaloneMode()) {
    setInstallButtonVisible(false);
    return;
  }

  // iOS no entrega beforeinstallprompt: mostramos nuestro botón con instrucciones.
  if (isIosDevice()) {
    setInstallButtonVisible(true);
  }

  // Android puede tardar unos segundos en considerar la PWA instalable.
  if (isAndroidDevice()) {
    setInstallButtonVisible(true);
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    setInstallButtonVisible(true);
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    setInstallButtonVisible(false);
    setStatus("CGO Music quedó instalada como aplicación.");
  });

  $("installAppBtn")?.addEventListener("click", async () => {
    if (isStandaloneMode()) {
      setInstallButtonVisible(false);
      return;
    }

    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      try {
        await deferredInstallPrompt.userChoice;
      } finally {
        deferredInstallPrompt = null;
      }
      return;
    }

    if (isIosDevice()) {
      alert(
        "Para instalar CGO Music en iPhone:\n\n" +
        "1. Ábrela en Safari.\n" +
        "2. Pulsa Compartir (cuadrado con flecha hacia arriba).\n" +
        "3. Elige ‘Añadir a pantalla de inicio’.\n" +
        "4. Abre CGO Music desde el nuevo icono."
      );
      return;
    }

    alert(
      "En Android abre el menú del navegador y elige ‘Instalar aplicación’ o " +
      "‘Añadir a pantalla principal’. Si esa opción todavía no aparece, recarga la página."
    );
  });
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
      album: `CGO Music · ${currentSong.decade || "Grandes canciones"}`,
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

    const matchesLanguage = song.language === selectedLanguage;
    const matchesDecade = selectedDecade === "all" || song.decade === selectedDecade;
    return matchesLanguage && matchesDecade;
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
  renderSongList();
}

function decadeOrder(decade) {
  const order = {
    "50s": 0, "60s": 1, "70s": 2,
    "80s": 3, "90s": 4, "2000s": 5
  };
  return order[decade] ?? 999;
}

function getCurrentCatalogMeta() {
  if (globalSearchActive || selectedDecade === "all") return null;
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
      `${visibleSongs.length} resultado${visibleSongs.length === 1 ? "" : "s"} en los 12 catálogos`;
    return;
  }

  $("collectionEyebrow").textContent =
    `COLECCIÓN EN ${languageLabel(selectedLanguage).toUpperCase()}`;

  if (selectedDecade === "all") {
    $("libraryTitle").textContent = "Todas las décadas";
    const languageSongs = catalog.filter(song => song.language === selectedLanguage);
    const verified = languageSongs.filter(song => song.verified).length;

    $("songCount").textContent =
      selectedLanguage === "spanish"
        ? `${languageSongs.length} canciones`
        : `${languageSongs.length} canciones · ${verified} con ranking verificado`;
  } else {
    $("libraryTitle").textContent =
      `Década de los ${selectedDecade === "2000s" ? "2000" : selectedDecade.replace("s", "")}`;

    const currentCount = currentMeta?.currentCount ?? visibleSongs.length;
    const verifiedCount =
      currentMeta?.verifiedCount ??
      visibleSongs.filter(song => song.verified).length;

    $("songCount").textContent =
      selectedLanguage === "spanish"
        ? `${currentCount} canciones`
        : `${currentCount} canciones · ${verifiedCount} verificadas`;
  }
}

function chartBadge(song) {
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

  visibleSongs.forEach((song, index) => {
    const row = document.createElement("button");
    row.className = `song-row ${currentSong?.id === song.id ? "active" : ""}`;
    row.dataset.songId = song.id;

    const displayPosition =
      selectedDecade !== "all" && !globalSearchActive && song.position
        ? String(song.position).padStart(2, "0")
        : String(index + 1).padStart(2, "0");

    row.innerHTML = `
      <span class="song-index">${displayPosition}</span>
      <span class="song-title-wrap">
        <span class="song-thumb">
          ${thumbMarkup(song)}
          <span class="play-overlay">${currentSong?.id === song.id ? "♫" : "▶"}</span>
        </span>
        <span class="song-copy">
          <strong>${escapeHtml(song.title)}</strong>
          <span>${escapeHtml(song.artist)} · ${languageLabel(song.language)}</span>
        </span>
      </span>
      <span class="song-year">${song.year ?? "—"}</span>
      <span class="peak ${(!song.verified && song.language !== "spanish") ? "pending" : ""}">${chartBadge(song)}</span>
    `;

    row.addEventListener("click", () => {
      startUserPlayback();
      setQueueFromVisible(song.id);
      playCurrent();
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

  if (verified) {
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
  setupInstallExperience();
  setupAudioPlayer();
  setupMediaSession();
  loadCatalog();
  updateVolumeLabel();

  $("searchInput").addEventListener("input", applyFilters);
  $("clearSearchBtn").addEventListener("click", clearSearch);

  document.querySelectorAll(".collection-tab").forEach(button => {
    button.addEventListener("click", () => {
      selectedLanguage = button.dataset.language;

      document.querySelectorAll(".collection-tab")
        .forEach(b => b.classList.toggle("active", b === button));

      if (globalSearchActive) $("searchInput").value = "";
      applyFilters();
    });
  });

  document.querySelectorAll(".decade").forEach(button => {
    button.addEventListener("click", () => {
      selectedDecade = button.dataset.decade;

      document.querySelectorAll(".decade")
        .forEach(b => b.classList.toggle("active", b === button));

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
