const tracks = [
  { title: "Prueba 1 · Aurora", artist: "CGO Music · Audio original de prueba", src: "audio/prueba-1.m4a" },
  { title: "Prueba 2 · Horizonte", artist: "CGO Music · Audio original de prueba", src: "audio/prueba-2.m4a" },
  { title: "Prueba 3 · Nocturna", artist: "CGO Music · Audio original de prueba", src: "audio/prueba-3.m4a" }
];

const $ = id => document.getElementById(id);
const audio = $("audio");
let index = 0;
let testActive = false;
let hiddenAtWall = null;
let hiddenAtAudio = null;
let resultSamples = [];

function fmt(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function stamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function log(message) {
  const box = $("log");
  box.textContent += `\n[${stamp()}] ${message}`;
  box.scrollTop = box.scrollHeight;
}

function standalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
}

function setSupportInfo() {
  $("mediaSupport").textContent = "mediaSession" in navigator ? "Sí" : "No";
  $("swSupport").textContent = "serviceWorker" in navigator ? "Sí" : "No";
  $("standaloneSupport").textContent = standalone() ? "Sí" : "No";
  $("visibilityState").textContent = document.visibilityState;
  $("modeBadge").textContent = standalone() ? "App instalada" : "Navegador";
}

function setTrack(newIndex, autoplay = false) {
  index = (newIndex + tracks.length) % tracks.length;
  const track = tracks[index];
  const wasPlaying = !audio.paused;
  audio.src = track.src;
  $("title").textContent = track.title;
  $("artist").textContent = track.artist;
  $("progress").value = 0;
  $("current").textContent = "0:00";
  $("duration").textContent = "0:00";
  updateMediaMetadata();
  log(`Pista seleccionada: ${track.title}`);
  if (autoplay || wasPlaying) audio.play().catch(err => log(`Play bloqueado: ${err.message}`));
}

function updateMediaMetadata() {
  if (!("mediaSession" in navigator) || !("MediaMetadata" in window)) return;
  const track = tracks[index];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: "CGO Music · Prueba de bloqueo",
      artwork: [
        { src: new URL("icons/icon-192.png", document.baseURI).href, sizes: "192x192", type: "image/png" },
        { src: new URL("icons/icon-512.png", document.baseURI).href, sizes: "512x512", type: "image/png" }
      ]
    });
  } catch (err) { log(`Media metadata: ${err.message}`); }
}

function setAction(action, handler) {
  if (!("mediaSession" in navigator)) return;
  try { navigator.mediaSession.setActionHandler(action, handler); }
  catch (_) {}
}

function syncPosition() {
  if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setPositionState !== "function") return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(Math.max(0, audio.currentTime), audio.duration)
    });
  } catch (_) {}
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  setAction("play", () => audio.play().catch(err => log(`Play desde sistema falló: ${err.message}`)));
  setAction("pause", () => audio.pause());
  setAction("previoustrack", () => setTrack(index - 1, true));
  setAction("nexttrack", () => setTrack(index + 1, true));
  setAction("seekbackward", e => { audio.currentTime = Math.max(0, audio.currentTime - (e.seekOffset || 10)); syncPosition(); });
  setAction("seekforward", e => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + (e.seekOffset || 10)); syncPosition(); });
  setAction("seekto", e => { if (Number.isFinite(e.seekTime)) audio.currentTime = e.seekTime; syncPosition(); });
}

function updatePlayButton() {
  $("playBtn").textContent = audio.paused ? "▶" : "❚❚";
  if ("mediaSession" in navigator) {
    try { navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing"; } catch (_) {}
  }
}

function resetTest() {
  testActive = false;
  hiddenAtWall = null;
  hiddenAtAudio = null;
  resultSamples = [];
  $("resultPill").className = "result neutral";
  $("resultPill").textContent = "Sin probar";
  $("diagnostic").textContent = "Todavía no se ha iniciado una prueba.";
  log("Resultado reiniciado.");
}

async function startTest() {
  resetTest();
  testActive = true;
  try {
    await audio.play();
    $("resultPill").className = "result partial";
    $("resultPill").textContent = "Prueba activa";
    $("diagnostic").textContent = "Audio reproduciéndose. Ahora bloquea el teléfono durante 20–30 segundos y luego vuelve a esta pantalla.";
    log("PRUEBA INICIADA. Bloquea el teléfono cuando quieras.");
  } catch (err) {
    $("resultPill").className = "result fail";
    $("resultPill").textContent = "No inició";
    $("diagnostic").textContent = `El navegador no permitió iniciar el audio: ${err.message}`;
    log(`No se pudo iniciar la prueba: ${err.message}`);
  }
}

function evaluateReturn(wallElapsed, audioElapsed) {
  const ratio = wallElapsed > 0 ? audioElapsed / wallElapsed : 0;
  resultSamples.push({ wallElapsed, audioElapsed, ratio });
  const last = resultSamples[resultSamples.length - 1];
  if (wallElapsed < 5) {
    $("resultPill").className = "result partial";
    $("resultPill").textContent = "Prueba muy corta";
    $("diagnostic").textContent = `La app estuvo oculta ${wallElapsed.toFixed(1)} s. Repite bloqueando al menos 20 segundos.`;
    return;
  }
  if (ratio >= 0.75) {
    $("resultPill").className = "result success";
    $("resultPill").textContent = "Segundo plano OK";
    $("diagnostic").textContent = `ÉXITO: durante ${last.wallElapsed.toFixed(1)} s con la pantalla oculta/bloqueada, el audio avanzó ${last.audioElapsed.toFixed(1)} s (${Math.round(last.ratio*100)}%). Esto indica que HTML5 Audio sí puede mantener reproducción en segundo plano en este dispositivo.`;
  } else if (ratio >= 0.2) {
    $("resultPill").className = "result partial";
    $("resultPill").textContent = "Parcial";
    $("diagnostic").textContent = `Resultado parcial: pasaron ${last.wallElapsed.toFixed(1)} s y el audio avanzó ${last.audioElapsed.toFixed(1)} s. Puede haber habido una pausa del sistema o del usuario.`;
  } else {
    $("resultPill").className = "result fail";
    $("resultPill").textContent = "Se detuvo";
    $("diagnostic").textContent = `No funcionó en segundo plano: pasaron ${last.wallElapsed.toFixed(1)} s pero el audio sólo avanzó ${last.audioElapsed.toFixed(1)} s.`;
  }
  log(`Resultado: oculto ${wallElapsed.toFixed(1)} s, audio avanzó ${audioElapsed.toFixed(1)} s, ratio ${Math.round(ratio*100)}%.`);
}

$("playBtn").addEventListener("click", () => {
  if (audio.paused) audio.play().catch(err => log(`Play falló: ${err.message}`)); else audio.pause();
});
$("prevBtn").addEventListener("click", () => setTrack(index - 1, true));
$("nextBtn").addEventListener("click", () => setTrack(index + 1, true));
$("startTestBtn").addEventListener("click", startTest);
$("resetBtn").addEventListener("click", resetTest);
$("clearLogBtn").addEventListener("click", () => { $("log").textContent = "Registro limpiado."; });
$("volume").addEventListener("input", e => { audio.volume = Number(e.target.value) / 100; $("volumeValue").textContent = `${e.target.value}%`; });
$("progress").addEventListener("input", e => { if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = audio.duration * Number(e.target.value) / 1000; });

audio.addEventListener("play", () => { updatePlayButton(); log("Audio: PLAY"); });
audio.addEventListener("pause", () => { updatePlayButton(); log("Audio: PAUSA"); });
audio.addEventListener("ended", () => { log("Fin de pista; avanzando automáticamente."); setTrack(index + 1, true); });
audio.addEventListener("loadedmetadata", () => { $("duration").textContent = fmt(audio.duration); syncPosition(); });
audio.addEventListener("timeupdate", () => {
  $("current").textContent = fmt(audio.currentTime);
  if (Number.isFinite(audio.duration) && audio.duration > 0) $("progress").value = Math.round(audio.currentTime / audio.duration * 1000);
  syncPosition();
});
audio.addEventListener("error", () => log(`Error de audio: código ${audio.error?.code || "desconocido"}`));

document.addEventListener("visibilitychange", () => {
  $("visibilityState").textContent = document.visibilityState;
  if (document.hidden) {
    hiddenAtWall = Date.now();
    hiddenAtAudio = audio.currentTime;
    log(`Página oculta. Audio en ${audio.currentTime.toFixed(1)} s; paused=${audio.paused}.`);
  } else {
    log(`Página visible otra vez. Audio en ${audio.currentTime.toFixed(1)} s; paused=${audio.paused}.`);
    if (testActive && hiddenAtWall !== null && hiddenAtAudio !== null) {
      const wallElapsed = (Date.now() - hiddenAtWall) / 1000;
      const audioElapsed = Math.max(0, audio.currentTime - hiddenAtAudio);
      evaluateReturn(wallElapsed, audioElapsed);
    }
    hiddenAtWall = null;
    hiddenAtAudio = null;
  }
});

window.addEventListener("pagehide", () => log("Evento pagehide."));
window.addEventListener("pageshow", e => log(`Evento pageshow. persisted=${e.persisted}.`));

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./sw.js").then(() => log("Service Worker registrado.")).catch(err => log(`Service Worker: ${err.message}`));
}

setSupportInfo();
setupMediaSession();
audio.volume = 0.75;
setTrack(0, false);
updatePlayButton();
log(`User agent: ${navigator.userAgent}`);
