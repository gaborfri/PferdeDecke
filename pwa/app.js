const $ = (sel) => document.querySelector(sel);
function showToast(message, variant = 'info', duration = 3000) {
  try {
    const host = document.getElementById('toaster') || (()=>{
      const d = document.createElement('div'); d.id = 'toaster'; d.className = 'toaster'; document.body.appendChild(d); return d;
    })();
    const el = document.createElement('div');
    el.className = `toast ${variant}`;
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(()=> el.classList.add('visible'));
    const remove = ()=>{ el.classList.remove('visible'); setTimeout(()=> el.remove(), 220); };
    if (duration > 0) setTimeout(remove, duration);
    return { dismiss: remove };
  } catch {}
}
const fmt = (n, unit) => `${Math.round(n)}${unit}`;

// ---------- Config & State ----------
// Kategorien-Voreinstellung für Pferdedecken (Skalierung der Gramm nach ~0..100)
const DEFAULT_ITEMS = [
  { id: "default-none", name: "keine", warmth: 0, waterproof: false },
  { id: "default-50g", name: "50g", warmth: 20, waterproof: false },
  { id: "default-100g", name: "100g", warmth: 40, waterproof: false },
  { id: "default-150g", name: "150g", warmth: 60, waterproof: false },
  { id: "default-250g", name: "250g", warmth: 100, waterproof: false },
];

function cloneItems(items) {
  return items.map((it) => ({ ...it }));
}

function cryptoRandomId(){
  try { return crypto.randomUUID(); } catch { return "id-" + Math.random().toString(36).slice(2); }
}

function loadItems(){
  const raw = localStorage.getItem("clothing_items");
  if (!raw) {
    const defaults = cloneItems(DEFAULT_ITEMS);
    saveItems(defaults);
    return defaults;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {}
  const defaults = cloneItems(DEFAULT_ITEMS);
  saveItems(defaults);
  return defaults;
}
function saveItems(items){ localStorage.setItem("clothing_items", JSON.stringify(items)); }

const DEFAULT_LOC = { lat: 52.37424617149301, lon: 10.436978270056711, name: "Gut Warxbüttel" };

const state = {
  sensitivity: Number(localStorage.getItem("sensitivity")) || 0,
  items: loadItems(),
  timeMode: localStorage.getItem("time_mode") === "night" ? "night" : "day",
  // location settings
  locMode: (localStorage.getItem("loc_mode") === "manual") ? "manual" : (localStorage.getItem("loc_mode") === "auto" ? "auto" : "manual"),
  manualLat: (localStorage.getItem("manual_lat") ? Number(localStorage.getItem("manual_lat")) : DEFAULT_LOC.lat),
  manualLon: (localStorage.getItem("manual_lon") ? Number(localStorage.getItem("manual_lon")) : DEFAULT_LOC.lon),
  locationName: (localStorage.getItem("location_name") || DEFAULT_LOC.name),
  model: null,
  modelMeta: null,
  recoTodayId: null,
  recoTomorrowId: null,
  feedbackChoice: null,
  feedbackDay: null,
};

// ---------- UI Binds ----------
$("#sensitive").checked = state.sensitivity > 0;
$("#sensitive").addEventListener("change", (e) => {
  state.sensitivity = e.target.checked ? 2 : 0; // 2°C empfindlicher
  localStorage.setItem("sensitivity", String(state.sensitivity));
  if (state.lastData) refreshDerived();
});

// day/night selector
$("#time-mode").value = state.timeMode;
$("#time-mode").addEventListener("change", (e)=>{
  state.timeMode = e.target.value === 'night' ? 'night' : 'day';
  localStorage.setItem("time_mode", state.timeMode);
  if (state.lastData) render(state.lastData);
});

// Pull-to-refresh ersetzt den Aktualisieren-Button
// Menu toggle via floating button
const menuOverlay = document.getElementById('menu-overlay');
document.getElementById("btn-menu")?.addEventListener("click", (e) => {
  e.preventDefault();
  menuOverlay?.classList.remove('hidden');
  menuOverlay?.querySelector('button[role="menuitem"]')?.focus();
});
document.getElementById('btn-menu-close')?.addEventListener('click', () => hideMenu());
menuOverlay?.addEventListener('click', (e) => {
  if (e.target === menuOverlay) hideMenu();
});
// Menu actions
document.getElementById('menu-settings')?.addEventListener('click', ()=>{ hideMenu(); openSettings(); });
document.getElementById('menu-info')?.addEventListener('click', ()=>{ hideMenu(); openInfo(); });
document.getElementById('menu-export')?.addEventListener('click', ()=>{ hideMenu(); exportBackup(); });
document.getElementById('menu-import')?.addEventListener('click', ()=>{ hideMenu(); importBackup(); });

function hideMenu(){
  const overlay = document.getElementById('menu-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  document.getElementById('btn-menu')?.focus();
}

async function getLocation() {
  // Manual override
  if (state.locMode === 'manual') {
    const lat = Number(state.manualLat);
    const lon = Number(state.manualLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error("Bitte gültige manuelle Koordinaten speichern.");
    }
    return { lat, lon };
  }
  // GPS
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation nicht verfügbar"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { maximumAge: 10 * 60_000, timeout: 15_000, enableHighAccuracy: false }
    );
  });
}

async function fetchWeather(lat, lon) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: [
      "temperature_2m",
      "apparent_temperature",
      "relativehumidity_2m",
      "precipitation_probability",
      "precipitation",
      "weathercode",
      "windspeed_10m",
      "windgusts_10m",
      "winddirection_10m",
      "uv_index"
    ].join(","),
    daily: [
      "precipitation_hours",
      "precipitation_sum",
      "windspeed_10m_max",
      "uv_index_max",
      "sunrise",
      "sunset"
    ].join(","),
    current_weather: "true",
    timezone: "auto",
  }).toString();
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Wetterfehler: ${res.status}`);
  return res.json();
}

// ---------- Recommendation: Rule baseline using configurable items ----------
function recommendRule(tempC, windMps, precipProb, isRaining, sensitivity = 0, items = []) {
  // Map temperature -> desired warmth bucket (0..100)
  const windChill = Math.max(0, (windMps - 4) * 0.7);
  const feels = tempC - windChill + sensitivity;
  let target;
  if (isRaining || precipProb > 0.6) target = 60; // favor rain‑capable around mid warmth
  else if (feels < 0) target = 90;
  else if (feels < 5) target = 80;
  else if (feels < 10) target = 65;
  else if (feels < 16) target = 45;
  else if (feels < 22) target = 20;
  else target = 0;

  const sorted = [...items].sort((a,b)=>a.warmth-b.warmth);
  let candidates = sorted;
  if (isRaining || precipProb > 0.6) {
    const rainies = sorted.filter(i=>i.waterproof);
    if (rainies.length) candidates = rainies;
  }
  // choose item with minimal distance to target warmth
  let best = candidates[0];
  let bestDist = Infinity;
  for (const it of candidates){
    const d = Math.abs(it.warmth - target);
    if (d < bestDist) { best = it; bestDist = d; }
  }
  return best;
}

function renderWeatherDetails(data) {
  const c = data.current_weather;
  const windMps = c.windspeed / 3.6;
  const idx = data.hourly.time.indexOf(c.time);
  const apparent = idx >= 0 ? data.hourly.apparent_temperature[idx] : c.temperature;
  const tempAir = idx >= 0 ? data.hourly.temperature_2m[idx] : c.temperature;
  const precipProb = idx >= 0 ? (data.hourly.precipitation_probability[idx] ?? 0) / 100 : 0;
  const humidity = idx >= 0 ? (data.hourly.relativehumidity_2m[idx] ?? 0) / 100 : 0;
  const gust = idx >= 0 ? (data.hourly.windgusts_10m[idx] ?? 0) / 3.6 : windMps;
  const winddir = idx >= 0 ? (data.hourly.winddirection_10m[idx] ?? c.winddirection) : c.winddirection;
  const uv = idx >= 0 ? (data.hourly.uv_index?.[idx] ?? 0) : 0;

  return {
    temp: apparent,
    tempAir,
    wind: windMps,
    precipProb,
    isRaining: Number(c.weathercode) >= 50, // grob: 50+ sind Niederschlagscodes
    humidity,
    gust,
    winddir,
    uv,
  };
}

// ---------- Forecast selection helpers ----------
function pickHourIndex(data, localIso) {
  const idx = data.hourly.time.indexOf(localIso);
  if (idx >= 0) return idx;
  // fallback: nearest hour same day and hour
  const target = new Date(localIso).getTime();
  let best = 0, bestDist = Infinity;
  data.hourly.time.forEach((t,i)=>{
    const d = Math.abs(new Date(t).getTime() - target);
    if (d<bestDist){bestDist=d;best=i;}
  });
  return best;
}

function featuresFromIdx(data, idx){
  const tAir = data.hourly.temperature_2m?.[idx] ?? data.hourly.apparent_temperature[idx];
  const tApp = data.hourly.apparent_temperature[idx];
  const wind = (data.hourly.windspeed_10m[idx] || 0) / 3.6;
  const gust = (data.hourly.windgusts_10m?.[idx] || 0) / 3.6;
  const wdir = Number(data.hourly.winddirection_10m?.[idx] || 0);
  const pprob = (data.hourly.precipitation_probability[idx] || 0) / 100;
  const precip = data.hourly.precipitation[idx] || 0;
  const rh = (data.hourly.relativehumidity_2m?.[idx] || 0) / 100;
  const uv = Number(data.hourly.uv_index?.[idx] || 0);
  const code = Number(data.hourly.weathercode[idx] || 0);
  const isRain = code >= 50 || precip > 0;
  const dt = new Date(data.hourly.time[idx]);
  const doy = Math.floor((Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) - Date.UTC(dt.getFullYear(),0,0)) / 86400000);
  const sin = Math.sin(2*Math.PI*doy/365);
  const cos = Math.cos(2*Math.PI*doy/365);
  const wsin = Math.sin((wdir/180)*Math.PI), wcos = Math.cos((wdir/180)*Math.PI);
  return {temp: tApp, tAir, wind, gust, pprob, isRain, rh, uv, wsin, wcos, sin, cos};
}

function toVector(feat){
  return [
    feat.temp, feat.tAir ?? feat.temp, feat.wind, feat.gust ?? feat.wind,
    feat.pprob, feat.isRain?1:0, feat.rh ?? 0, feat.uv ?? 0,
    feat.wsin ?? 0, feat.wcos ?? 0, feat.sin, feat.cos
  ];
}

function render(data) {
  showToast('Aktualisiert.', 'ok', 1600);

  // Build indices based on mode
  const localHourIso = (d) => new Date(d).toISOString().slice(0,13)+":00"; // approx to hour
  const today = new Date();
  const tomorrow = new Date(Date.now()+86400000);
  if (state.timeMode === 'day') {
    today.setHours(12,0,0,0);
    tomorrow.setHours(8,0,0,0);
  } else { // night
    today.setHours(22,0,0,0);
    tomorrow.setHours(22,0,0,0);
  }
  const idxToday = pickHourIndex(data, localHourIso(today));
  const idxTomorrow = pickHourIndex(data, localHourIso(tomorrow));

  const fToday = featuresFromIdx(data, idxToday);
  const fTomorrow = featuresFromIdx(data, idxTomorrow);

  state.ctx = { idxToday, idxTomorrow, fToday, fTomorrow };

  // Dynamic section headings
  const hToday = document.querySelector('#today h3');
  const hTomorrow = document.querySelector('#tomorrow h3');
  if (hToday) hToday.textContent = state.timeMode === 'night' ? 'Heute Nacht' : 'Heute';
  if (hTomorrow) hTomorrow.textContent = state.timeMode === 'night' ? 'Morgen Nacht' : 'Morgen';

  refreshDerived();
}

function refreshDerived(){
  if (!state.lastData || !state.ctx) return;
  const { fToday, fTomorrow } = state.ctx;
  const items = state.items;

  // Recommendation selection (ML or rules)
  const selToday = selectItem(fToday, items);
  const selTomorrow = selectItem(fTomorrow, items);

  // Render tomorrow
  $("#tomorrow").classList.remove("hidden");
  $("#tomorrow-forecast").innerHTML = forecastDetailsHTML(state.lastData, state.ctx.idxTomorrow, fTomorrow, 1);
  try { adjustMetricSpans(document.getElementById('tomorrow')); } catch {}
  state.recoTomorrowId = selTomorrow.id;
  const baseTomorrow = state.timeMode === 'night' ? 'Morgen Nacht' : 'Morgen';
  const hTomorrow = document.querySelector('#tomorrow h3');
  if (hTomorrow) hTomorrow.innerHTML = `${baseTomorrow} · <span class="muted">Empfehlung: ${selTomorrow.name}</span>`;

  // Render today + feedback select
  $("#today").classList.remove("hidden");
  $("#today-forecast").innerHTML = forecastDetailsHTML(state.lastData, state.ctx.idxToday, fToday, 0);
  try { adjustMetricSpans(document.getElementById('today')); } catch {}
  state.recoTodayId = selToday.id;
  const baseToday = state.timeMode === 'night' ? 'Heute Nacht' : 'Heute';
  const hToday = document.querySelector('#today h3');
  if (hToday) hToday.innerHTML = `${baseToday} · <span class=\"muted\">Empfehlung: ${selToday.name}</span>`;
  const todayKey = new Date().toISOString().slice(0,10);
  if (state.feedbackDay !== todayKey) {
    state.feedbackDay = todayKey;
    state.feedbackChoice = selToday.id;
  }
  renderFeedbackOptions(items, selToday.id);
  attachSparklineHandlers();
}

function forecastDetailsHTML(data, idx, f, dayOffset){
  // daily context
  const hourDate = new Date(data.hourly.time[idx]);
  const dayStr = hourDate.toISOString().slice(0,10);
  const dailyIdx = data.daily?.time?.indexOf(dayStr) ?? -1;
  const rainHours = dailyIdx>=0 ? (data.daily.precipitation_hours?.[dailyIdx] ?? 0) : 0;
  const rainSum = dailyIdx>=0 ? (data.daily.precipitation_sum?.[dailyIdx] ?? 0) : 0;
  const uvMax = dailyIdx>=0 ? (data.daily.uv_index_max?.[dailyIdx] ?? f.uv ?? 0) : (f.uv ?? 0);
  const code = Number(data.hourly.weathercode?.[idx] ?? 0);
  const icon = weatherIcon(code, state.timeMode === 'night');
  const label = weatherLabel(code);
  const wdir = Number(data.hourly.winddirection_10m?.[idx] ?? 0);
  const dirArrows = ['↑','↗','→','↘','↓','↙','←','↖'];
  const dir = dirArrows[Math.round(((wdir % 360) / 45)) % 8];

  const spark = makeSparkline(data, dayStr);
  // Temperature chip
  const tFeel = f.temp + state.sensitivity;
  const tAir = f.tAir ?? f.temp;
  const showBothTemps = Math.abs(tAir - tFeel) >= 1;
  const chipTemp = `<div class="metric">🌡️ <div class="nowrap"><span class="val">${fmt(tFeel, "°C")}</span>${showBothTemps ? ` • Luft ${fmt(tAir, "°C")}` : ""}</div></div>`;
  // Wind chip (km/h), gusts only if +5 km/h
  const wKmh = Math.round((f.wind||0) * 3.6);
  const gKmh = Math.round(((f.gust ?? f.wind) || 0) * 3.6);
  const gustText = (gKmh - wKmh) >= 5 ? ` • Böen ${gKmh}` : '';
  const chipWind = `<div class="metric"><span class="icon-w" style="transform: rotate(${wdir}deg)">➤</span><div class="nowrap"><span class="val">${wKmh} km/h</span>${gustText}</div></div>`;
  // Rain chip (compact, conditional hours/sum)
  const prob = Math.round((f.pprob||0)*100);
  const parts = [`<span class="val">${prob}%</span>`];
  if (rainHours >= 0.3) parts.push(`${Math.round(rainHours*10)/10}&nbsp;h`);
  if (rainSum >= 0.2) parts.push(`${Math.round(rainSum*10)/10}&nbsp;mm`);
  const chipRain = `<div class="metric metric-rain">☔️ <div class="nowrap">${parts.join(' • ')}</div></div>`;
  // UV chip only (humidity removed)
  const uvShow = (uvMax >= 1 && state.timeMode === 'day');
  const chipUv = uvShow ? `<div class="metric">☀️ <div class="nowrap"><span class="val">UV ${Math.round(uvMax)}</span></div></div>` : '';

  const chips = [chipTemp, chipWind, chipRain, chipUv].filter(Boolean).join('');
  return `
    <div class="forecast">
      <div class="forecast-text">
        <div><strong>${label}</strong></div>
        <div class="metrics">${chips}</div>
        <div class="sparkline" role="img" aria-label="Tagesverlauf" data-temps-app='${JSON.stringify(spark.tempsApp)}' data-temps-air='${JSON.stringify(spark.tempsAir)}' data-precip='${JSON.stringify(spark.precips)}' data-probs='${JSON.stringify(spark.probs)}' data-hours='${JSON.stringify(spark.hours)}'>${spark.svg}</div>
      </div>
      <div class="forecast-icon" aria-label="${label}" title="${label}">${icon}</div>
    </div>
  `;
}

function renderFeedbackOptions(items, suggestedId){
  const host = document.getElementById('fb-chip-scroll');
  if (!host) return;
  host.innerHTML = '';
  const fallback = items.find(it => it.id === suggestedId)?.id || items[0]?.id || '';
  if (!state.feedbackChoice || !items.some(it => it.id === state.feedbackChoice)) {
    state.feedbackChoice = fallback;
  }
  const selected = state.feedbackChoice || fallback;
  items.forEach((it) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = it.name;
    chip.dataset.value = it.id;
    chip.id = `fb-chip-${it.id}`;
    chip.setAttribute('role', 'option');
    chip.tabIndex = -1;
    host.appendChild(chip);
  });
  updateFeedbackChips(selected, false);
}

function updateFeedbackChips(selectedId, ensureVisible=false){
  const host = document.getElementById('fb-chip-scroll');
  if (!host) return;
  host.dataset.selected = selectedId || '';
  host.querySelectorAll('button[data-value]').forEach((btn) => {
    const active = btn.dataset.value === selectedId;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
  });
  const activeEl = host.querySelector('button[data-value].active');
  if (activeEl) {
    host.setAttribute('aria-activedescendant', activeEl.id);
    if (ensureVisible) {
      try { activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }); } catch {}
    }
  } else {
    host.removeAttribute('aria-activedescendant');
  }
}

function handleFeedbackSelection(labelId, ensureVisible=true){
  if (!labelId) return;
  state.feedbackChoice = labelId;
  state.feedbackDay = new Date().toISOString().slice(0,10);
  updateFeedbackChips(labelId, ensureVisible);
  recordFeedback(labelId);
}

function recordFeedback(labelId){
  if (!state.lastData || !state.ctx) return;
  const feat = toVector(state.ctx.fToday);
  const todayKey = new Date().toISOString().slice(0,10);
  const sample = {
    date: todayKey,
    x: feat,
    y: labelId,
    name: item?.name || null,
    warmth: item?.warmth ?? null,
  };
  const ds = loadDataset();
  const idx = ds.findIndex(s => s.date === todayKey);
  if (idx >= 0) ds[idx] = sample; else ds.push(sample);
  saveDataset(ds);
  const item = state.items.find(it => it.id === labelId);
  const isReco = labelId === state.recoTodayId;
  const name = item?.name || 'Auswahl';
  showToast(isReco ? 'Danke! Empfehlung passt.' : `Feedback gespeichert: ${name}.`, 'ok', 2200);
  checkAutoRetrain();
}

function setupFeedback() {
  const host = document.getElementById('fb-chip-scroll');
  if (!host || host._feedbackInit) return;
  host.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    const val = btn.dataset.value;
    handleFeedbackSelection(val, true);
  });
  host.addEventListener('keydown', (e) => {
    if (!['ArrowRight','ArrowLeft','Home','End','Enter',' '].includes(e.key)) return;
    const chips = Array.from(host.querySelectorAll('button[data-value]'));
    if (!chips.length) return;
    const currentVal = host.dataset.selected;
    let idx = chips.findIndex(btn => btn.dataset.value === currentVal);
    if (idx < 0) idx = 0;
    let nextIdx = idx;
    if (e.key === 'ArrowRight') nextIdx = Math.min(chips.length - 1, idx + 1);
    if (e.key === 'ArrowLeft') nextIdx = Math.max(0, idx - 1);
    if (e.key === 'Home') nextIdx = 0;
    if (e.key === 'End') nextIdx = chips.length - 1;
    const next = chips[nextIdx];
    if (!next) return;
    e.preventDefault();
    const val = next.dataset.value;
    handleFeedbackSelection(val, true);
  });
  host._feedbackInit = true;
}

// ---------- Items Config UI ----------
function renderItems(){
  const cont = $("#items");
  cont.innerHTML = "";
  const items = state.items.sort((a,b)=>a.warmth-b.warmth);
  for (const it of items){
    const row = document.createElement("div");
    row.className = "item-row";
    row.innerHTML = `
      <input type="text" value="${it.name}" aria-label="Name" />
      <input type="number" value="${it.warmth}" min="0" max="100" step="5" aria-label="Wärmegrad" />
      <button title="Entfernen">Entf.</button>
    `;
    const [nameI, warmI, delB] = row.querySelectorAll("input,button");
    nameI.addEventListener("input", ()=>{ it.name = nameI.value; saveItems(state.items); refreshDerived(); });
    warmI.addEventListener("input", ()=>{ it.warmth = Number(warmI.value)||0; saveItems(state.items); refreshDerived(); });
    delB.addEventListener("click", ()=>{ state.items = state.items.filter(x=>x.id!==it.id); saveItems(state.items); renderItems(); refreshDerived(); });
    cont.appendChild(row);
  }
}

$("#add-item").addEventListener("click", ()=>{
  state.items.push({ id: cryptoRandomId(), name: "Neu", warmth: 50, waterproof: false });
  saveItems(state.items); renderItems(); refreshDerived();
});
$("#reset-items").addEventListener("click", ()=>{
  if (!confirm("Kategorien auf Standard zurücksetzen?")) return;
  state.items = cloneItems(DEFAULT_ITEMS); saveItems(state.items); renderItems(); refreshDerived();
});

// ---------- Dataset storage ----------
function loadDataset(){
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem("dataset") || "[]");
  } catch {
    return [];
  }
  const entries = Array.isArray(raw) ? raw.slice() : [];
  const items = (state && Array.isArray(state.items)) ? state.items : [];
  if (!items.length) return entries;
  const idMap = new Map(items.map((it) => [it.id, it]));
  const nameMap = new Map(items.map((it) => [String(it.name || "").trim().toLowerCase(), it]));
  const cleaned = [];
  let changed = false;
  for (const sample of entries) {
    if (!sample || typeof sample !== "object") { changed = true; continue; }
    let id = sample.y;
    let item = idMap.get(id);
    if (!item) {
      const fallbackName = typeof sample.name === "string" ? sample.name.trim().toLowerCase() : "";
      if (fallbackName && nameMap.has(fallbackName)) {
        item = nameMap.get(fallbackName);
        id = item.id;
        sample.y = id;
        changed = true;
      } else {
        changed = true;
        continue;
      }
    }
    if (!Array.isArray(sample.x)) { changed = true; continue; }
    sample.name = item.name;
    sample.warmth = item.warmth;
    cleaned.push(sample);
  }
  if (changed) saveDataset(cleaned);
  return cleaned;
}
function saveDataset(ds){
  if (!Array.isArray(ds)) return;
  localStorage.setItem("dataset", JSON.stringify(ds));
}

// ---------- Export / Import (Feedback) ----------
async function exportBackup(){
  try {
    // Ensure model is loaded if present in storage
    if (!state.model) await loadModelIfAny();

    // Capture model artifacts if available
    let modelDump = null;
    if (state.model) {
      const holder = {};
      await state.model.save({
        save: async (artifacts) => {
          holder.artifacts = artifacts;
          return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: typeof artifacts.modelTopology === 'object' ? 'JSON' : 'GraphDef', weightDataBytes: artifacts.weightData ? artifacts.weightData.byteLength : 0 } };
        }
      });
      if (holder.artifacts) {
        modelDump = {
          modelTopology: holder.artifacts.modelTopology,
          weightSpecs: holder.artifacts.weightSpecs,
          weightData: holder.artifacts.weightData ? arrayBufferToBase64(holder.artifacts.weightData) : null,
        };
      }
    }

    const payload = {
      type: 'pferdedecke-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        sensitivity: state.sensitivity,
        time_mode: state.timeMode,
        loc_mode: state.locMode,
        manual_lat: state.manualLat,
        manual_lon: state.manualLon,
        location_name: state.locationName,
      },
      items: state.items,
      dataset: loadDataset(),
      model_meta: state.modelMeta,
      model: modelDump,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0,10).replace(/-/g,'');
    a.href = url; a.download = `pferdedecke-backup-${date}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
    localStorage.setItem('last_backup', new Date().toISOString());
    showToast('Backup exportiert.', 'ok', 2200);
  } catch (e) {
    console.error(e);
    showToast('Backup-Export fehlgeschlagen.', 'error', 3000);
  }
}

function importBackup(){
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.addEventListener('change', async ()=>{
    const f = inp.files?.[0]; if (!f) return;
    try {
      const text = await f.text();
      const obj = JSON.parse(text);
      if (!obj || obj.type !== 'pferdedecke-backup') throw new Error('Unerwartetes Format');
      // Restore settings
      const s = obj.settings || {};
      if ('sensitivity' in s) { state.sensitivity = Number(s.sensitivity)||0; localStorage.setItem('sensitivity', String(state.sensitivity)); $("#sensitive").checked = state.sensitivity>0; }
      if (s.time_mode){ state.timeMode = (s.time_mode==='night'?'night':'day'); localStorage.setItem('time_mode', state.timeMode); $("#time-mode").value = state.timeMode; }
      if (s.loc_mode){ state.locMode = (s.loc_mode==='manual'?'manual':'auto'); localStorage.setItem('loc_mode', state.locMode); }
      if (Number.isFinite(s.manual_lat)) { state.manualLat = Number(s.manual_lat); localStorage.setItem('manual_lat', String(state.manualLat)); }
      if (Number.isFinite(s.manual_lon)) { state.manualLon = Number(s.manual_lon); localStorage.setItem('manual_lon', String(state.manualLon)); }
      if (typeof s.location_name === 'string') { state.locationName = s.location_name; localStorage.setItem('location_name', state.locationName); }

      // Restore items
      if (Array.isArray(obj.items)) { state.items = obj.items; saveItems(state.items); renderItems(); }

      // Restore dataset
      if (Array.isArray(obj.dataset)) { saveDataset(obj.dataset); }

      // Restore model meta
      if (obj.model_meta) { state.modelMeta = obj.model_meta; localStorage.setItem('model_meta', JSON.stringify(state.modelMeta)); }

      // Restore model weights if provided
      if (obj.model && (obj.model.modelTopology || obj.model.weightSpecs)) {
        const modelArtifacts = {
          modelTopology: obj.model.modelTopology,
          weightSpecs: obj.model.weightSpecs,
          weightData: obj.model.weightData ? base64ToArrayBuffer(obj.model.weightData) : undefined,
        };
        const handler = {
          load: async () => modelArtifacts
        };
        const model = await tf.loadLayersModel(handler);
        await model.save('localstorage://kleiderwetter-model');
        state.model = model;
      } else {
        // Try to load model from localstorage if present
        await loadModelIfAny();
      }

      localStorage.setItem('last_backup', new Date().toISOString());
      showToast('Backup importiert.', 'ok', 2200);
      refreshDerived();
      init(true);
      checkAutoRetrain();
    } catch (e) {
      console.error(e);
      showToast('Backup-Import fehlgeschlagen.', 'error', 3000);
    }
  }, { once: true });
  inp.click();
}

function arrayBufferToBase64(buffer){
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i=0; i<bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToArrayBuffer(base64){
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i=0; i<len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ---------- ML selection ----------
function alignVec(x, targetLen){
  const arr = x.slice(0, targetLen);
  while (arr.length < targetLen) arr.push(0);
  return arr;
}

function selectItem(feat, items){
  if (state.model && state.modelMeta && state.modelMeta.items) {
    try {
      const vec = toVector(feat);
      const aligned = alignVec(vec, state.modelMeta.mean.length);
      const x = normalizeVec(aligned, state.modelMeta.mean, state.modelMeta.std);
      const t = tf.tensor2d([x]);
      const logits = state.model.predict(t);
      const probs = logits.arraySync()[0];
      t.dispose(); logits.dispose?.();
      // map to item order as in meta
      const order = state.modelMeta.items;
      let bestIdx = 0; let best = -Infinity;
      probs.forEach((p,i)=>{ if (p>best){best=p; bestIdx=i;} });
      const id = order[bestIdx];
      const found = items.find(it=>it.id===id);
      if (found) return found;
    } catch (e) { console.warn("ML predict failed, fallback rules", e); }
  }
  return recommendRule(feat.temp, feat.wind, feat.pprob, feat.isRain, state.sensitivity, items);
}

function normalizeVec(x, mean, std){ return x.map((v,i)=> std[i] ? (v-mean[i])/std[i] : v); }

function weatherIcon(code, night){
  // Open-Meteo WMO codes mapping to emojis
  if (code === 0) return night ? '🌙' : '☀️';
  if (code === 1) return night ? '🌙' : '🌤️';
  if (code === 2) return '⛅';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 55) return '🌦️'; // drizzle
  if (code === 56 || code === 57) return '🌧️';
  if (code >= 61 && code <= 65) return '🌧️'; // rain
  if (code === 66 || code === 67) return '🌧️';
  if (code >= 71 && code <= 75) return '🌨️'; // snow
  if (code === 77) return '🌨️';
  if (code >= 80 && code <= 82) return '🌦️'; // showers
  if (code === 85 || code === 86) return '🌨️';
  if (code === 95) return '⛈️';
  if (code === 96 || code === 99) return '⛈️';
  return '🌡️';
}

function weatherLabel(code){
  if (code === 0) return 'Klar';
  if (code === 1) return 'Überwiegend klar';
  if (code === 2) return 'Teils bewölkt';
  if (code === 3) return 'Bewölkt';
  if (code === 45 || code === 48) return 'Nebel';
  if (code >= 51 && code <= 55) return 'Nieselregen';
  if (code === 56 || code === 57) return 'Gefrierender Niesel';
  if (code >= 61 && code <= 65) return 'Regen';
  if (code === 66 || code === 67) return 'Gefrierender Regen';
  if (code >= 71 && code <= 75) return 'Schneefall';
  if (code === 77) return 'Schneekörner';
  if (code >= 80 && code <= 82) return 'Regenschauer';
  if (code === 85 || code === 86) return 'Schneeschauer';
  if (code === 95) return 'Gewitter';
  if (code === 96 || code === 99) return 'Gewitter mit Hagel';
  return 'Wetter';
}

async function loadModelIfAny(){
  try {
    const meta = JSON.parse(localStorage.getItem("model_meta")||"null");
    if (!meta) return;
    const model = await tf.loadLayersModel("localstorage://kleiderwetter-model");
    state.model = model; state.modelMeta = meta;
  } catch (e) {
    console.warn("Kein gespeichertes Modell geladen", e);
  }
}

async function retrain(){
  const ds = loadDataset();
  if (ds.length < 8) { showToast('Zu wenig Feedback (min. 8 Tage)', 'warn', 2800); return false; }
  const items = state.items;
  const idToIdx = new Map(items.map((it,i)=>[it.id,i]));
  const X = []; const Y = [];
  const targetLen = toVector(state.ctx?.fToday || {temp:0,tAir:0,wind:0,gust:0,pprob:0,isRain:0,rh:0,uv:0,wsin:0,wcos:0,sin:0,cos:0}).length;
  for (const s of ds){
    if (!idToIdx.has(s.y)) continue;
    const x = Array.isArray(s.x) ? s.x : [];
    X.push(alignVec(x, targetLen));
    Y.push(idToIdx.get(s.y));
  }
  if (X.length < 4) { showToast('Nicht genug gültige Daten', 'warn', 2800); return false; }
  const mean = new Array(X[0].length).fill(0);
  const std = new Array(X[0].length).fill(0);
  for (let j=0;j<mean.length;j++){ mean[j] = X.reduce((a,r)=>a+r[j],0)/X.length; }
  for (let j=0;j<std.length;j++){ const m=mean[j]; std[j] = Math.sqrt(X.reduce((a,r)=>a+(r[j]-m)**2,0)/X.length) || 1; }
  const Xn = X.map(r=>normalizeVec(r,mean,std));
  const xs = tf.tensor2d(Xn);
  const ys = tf.tensor1d(Y,'int32');
  const ysOH = tf.oneHot(ys, items.length);

  const model = tf.sequential();
  model.add(tf.layers.dense({units: 8, activation: 'relu', inputShape: [Xn[0].length]}));
  model.add(tf.layers.dense({units: items.length, activation: 'softmax'}));
  model.compile({optimizer: tf.train.adam(0.05), loss: 'categoricalCrossentropy', metrics: ['accuracy']});
  showToast('Training…', 'info', 1600);
  await model.fit(xs, ysOH, {epochs: 60, batchSize: 8, shuffle: true});
  await model.save('localstorage://kleiderwetter-model');
  localStorage.setItem("model_meta", JSON.stringify({ mean, std, items: items.map(i=>i.id) }));
  state.model = model; state.modelMeta = { mean, std, items: items.map(i=>i.id) };
  xs.dispose(); ys.dispose(); ysOH.dispose();
  showToast('Training fertig. Modell gespeichert.', 'ok', 2600);
  // Merke Trainingsstand (für Auto-Retrain)
  try { localStorage.setItem('last_trained_count', String(ds.length)); } catch {}
  refreshDerived();
  return true;
}

// ---------- Init ----------
async function init(force = false) {
  try {
    if (state.locMode === 'manual') {
      const name = state.locationName?.trim();
      showToast(`Standort: ${name ? name + " · " : ""}${state.manualLat}, ${state.manualLon}.`, 'info', 2200);
    } else {
      showToast('Standort (GPS) wird ermittelt…', 'info', 2200);
    }
    const { lat, lon } = await getLocation();
    showToast('Wetter wird geladen…', 'info', 1800);

    // Cache im localStorage, um Offline‑Start zu erlauben
    const cacheKey = `wx_${state.locMode}_${lat.toFixed(3)}_${lon.toFixed(3)}`;
    if (!force) {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        try {
          const data = JSON.parse(cached);
          state.lastData = data;
          render(data);
        } catch {}
      }
    }

    const data = await fetchWeather(lat, lon);
    localStorage.setItem(cacheKey, JSON.stringify(data));
    state.lastData = data;
    render(data);
    // Check auto-train after data available
    checkAutoRetrain();
    // Soft prompt for iOS PWA install on first visit (after initial render)
    setTimeout(maybeShowIOSInstallHint, 900);
  } catch (e) {
    console.error(e);
    showToast(`Fehler: ${e.message}`, 'error', 4000);
  }
}

renderItems();
setupFeedback();
setupLocationUI();
loadModelIfAny().finally(()=>init());
setupSWUpdateWatch();

// ---------- Monthly backup prompt ----------
function checkMonthlyBackup(){
  try {
    const ih = document.getElementById('install-hint');
    const up = document.getElementById('update-prompt');
    if ((ih && !ih.classList.contains('hidden')) || (up && !up.classList.contains('hidden'))) return;
    const last = localStorage.getItem('last_backup');
    const lastT = last ? Date.parse(last) : 0;
    const days = (Date.now() - lastT) / 86400000;
    if (!last || days >= 28) {
      const ov = document.getElementById('backup-prompt');
      ov?.classList.remove('hidden');
    }
  } catch {}
}

document.getElementById('backup-now')?.addEventListener('click', async ()=>{
  document.getElementById('backup-prompt')?.classList.add('hidden');
  await exportBackup();
});
document.getElementById('backup-later')?.addEventListener('click', ()=>{
  localStorage.setItem('last_backup', new Date().toISOString());
  document.getElementById('backup-prompt')?.classList.add('hidden');
});
document.getElementById('btn-backup-close')?.addEventListener('click', ()=>{
  document.getElementById('backup-prompt')?.classList.add('hidden');
});

// Slight delay to avoid interrupting first render
setTimeout(checkMonthlyBackup, 1500);

// ---------- Auto-Retrain ----------
async function checkAutoRetrain(){
  try {
    const ds = loadDataset();
    const last = Number(localStorage.getItem('last_trained_count') || '0');
    if (ds.length >= 8 && (ds.length - last) >= 3) {
      const ok = await retrain();
      if (!ok) {
        try { localStorage.setItem('last_trained_count', String(ds.length)); } catch {}
      }
    }
  } catch (e) {
    console.warn('Auto-Retrain fehlgeschlagen', e);
  }
}

// ---------- Service Worker Update Flow ----------
function setupSWUpdateWatch(){
  if (!('serviceWorker' in navigator)) return;
  // If a registration exists, attach listeners; otherwise try later
  const attach = (reg)=>{
    if (!reg) return;
    // Check immediately for a waiting worker (e.g., previous load)
    if (reg.waiting) {
      showUpdatePrompt(reg);
    }
    // Listen for new installing workers
    reg.addEventListener('updatefound', ()=>{
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', ()=>{
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdatePrompt(reg);
        }
      });
    });
    // Optionally, poll occasionally
    setInterval(()=>{ reg.update().catch(()=>{}); }, 60*60*1000);
  };
  navigator.serviceWorker.getRegistration().then((reg)=>{
    if (reg) attach(reg);
  });
  // Also attach once ready
  navigator.serviceWorker.ready.then(attach).catch(()=>{});
  // Reload page when the controller changes after skipWaiting
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    // Ensure full reload to get fresh assets
    window.location.reload();
  });
}

function showUpdatePrompt(reg){
  try {
    const ov = document.getElementById('update-prompt');
    if (!ov) return;
    ov.classList.remove('hidden');
    const accept = ()=>{
      ov.classList.add('hidden');
      const sw = reg.waiting || reg.installing;
      if (sw) sw.postMessage({ type: 'SKIP_WAITING' });
    };
    const later = ()=>{ ov.classList.add('hidden'); };
    document.getElementById('update-now')?.addEventListener('click', accept, { once: true });
    document.getElementById('update-later')?.addEventListener('click', later, { once: true });
    document.getElementById('btn-update-close')?.addEventListener('click', later, { once: true });
    ov.addEventListener('click', (e)=>{ if (e.target && e.target.id === 'update-prompt') later(); }, { once: true });
  } catch {}
}

// ---------- Location UI ----------
function setupLocationUI(){
  const modeSel = $("#loc-mode");
  const manualBox = $("#manual-loc");
  const nameI = $("#loc-name");
  const latI = $("#loc-lat");
  const lonI = $("#loc-lon");
  const saveB = $("#loc-save");
  const urlI = $("#loc-url");
  const parseB = $("#loc-parse");
  const openB = $("#loc-open");

  // init values
  if (modeSel) modeSel.value = state.locMode;
  if (nameI) nameI.value = state.locationName || "";
  if (latI && Number.isFinite(state.manualLat)) latI.value = String(state.manualLat);
  if (lonI && Number.isFinite(state.manualLon)) lonI.value = String(state.manualLon);
  if (manualBox) manualBox.classList.toggle("hidden", state.locMode !== 'manual');

  modeSel?.addEventListener('change', (e)=>{
    state.locMode = e.target.value === 'manual' ? 'manual' : 'auto';
    localStorage.setItem('loc_mode', state.locMode);
    manualBox?.classList.toggle('hidden', state.locMode !== 'manual');
    init(true);
  });

  saveB?.addEventListener('click', ()=>{
    const lat = Number(latI.value);
    const lon = Number(lonI.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)){
      showToast('Bitte gültige Koordinaten eingeben.', 'warn', 2500);
      return;
    }
    state.manualLat = lat; state.manualLon = lon;
    state.locationName = (nameI.value || '').trim();
    localStorage.setItem('manual_lat', String(lat));
    localStorage.setItem('manual_lon', String(lon));
    localStorage.setItem('location_name', state.locationName);
    showToast('Standort gespeichert.', 'ok', 2200);
    init(true);
  });

  parseB?.addEventListener('click', ()=>{
    const src = (urlI?.value || '').trim();
    if (!src){ showToast('Bitte einen Karten-Link einfügen.', 'warn', 2600); return; }
    const parsed = parseMapLink(src);
    if (!parsed){ showToast('Konnte keine Koordinaten im Link finden.', 'warn', 2800); return; }
    const { lat, lon, name } = parsed;
    latI.value = String(lat);
    lonI.value = String(lon);
    if (name && !nameI.value) nameI.value = name;
    // Persist immediately for convenience
    state.manualLat = lat; state.manualLon = lon; state.locationName = (nameI.value||'').trim();
    localStorage.setItem('manual_lat', String(lat));
    localStorage.setItem('manual_lon', String(lon));
    localStorage.setItem('location_name', state.locationName);
    showToast('Koordinaten aus Link übernommen.', 'ok', 2200);
    init(true);
  });

  openB?.addEventListener('click', ()=>{
    const lat = Number(latI.value);
    const lon = Number(lonI.value);
    const name = (nameI.value||'Standort').trim();
    if (!Number.isFinite(lat) || !Number.isFinite(lon)){
      showToast('Bitte gültige Koordinaten eingeben.', 'warn', 2500);
      return;
    }
    const url = `https://maps.apple.com/?ll=${lat},${lon}&q=${encodeURIComponent(name)}`;
    window.open(url, '_blank');
  });
}

function parseMapLink(input){
  try {
    // Handle raw "geo:" scheme
    if (input.startsWith('geo:')){
      const rest = input.slice(4);
      const [coords] = rest.split('?');
      const [latS, lonS] = coords.split(',');
      const lat = Number(latS), lon = Number(lonS);
      if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
      return null;
    }
    const u = new URL(input);
    const host = u.host;
    const qp = (k)=> u.searchParams.get(k);
    const tryNumPair = (s)=>{
      if (!s) return null;
      const m = s.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
      if (m) { const lat = Number(m[1]), lon = Number(m[2]); if (Number.isFinite(lat)&&Number.isFinite(lon)) return {lat, lon}; }
      return null;
    };
    // Apple Maps: ll=lat,lon or q=lat,lon
    let pair = tryNumPair(qp('ll')) || tryNumPair(qp('q'));
    if (pair) return { ...pair, name: qp('q') && !qp('ll') ? qp('q') : undefined };
    // Google Maps: q=lat,lon or query=lat,lon or path contains @lat,lon,zoom
    pair = tryNumPair(qp('q')) || tryNumPair(qp('query'));
    if (pair) return pair;
    const pathAt = u.pathname.match(/@(-?\d+\.\d+),(-?\d+\.\d+)(,|$)/);
    if (pathAt) {
      const lat = Number(pathAt[1]), lon = Number(pathAt[2]);
      if (Number.isFinite(lat)&&Number.isFinite(lon)) return { lat, lon };
    }
    // OpenStreetMap: mlat/mlon or hash #map=zoom/lat/lon
    const mlat = qp('mlat'), mlon = qp('mlon');
    if (mlat && mlon){
      const lat = Number(mlat), lon = Number(mlon);
      if (Number.isFinite(lat)&&Number.isFinite(lon)) return { lat, lon };
    }
    if (u.hash && u.hash.startsWith('#map=')){
      const parts = u.hash.slice(5).split('/'); // zoom/lat/lon
      if (parts.length >= 3){
        const lat = Number(parts[1]), lon = Number(parts[2]);
        if (Number.isFinite(lat)&&Number.isFinite(lon)) return { lat, lon };
      }
    }
    // Fallback: scan entire string for first lat,lon pair
    const any = input.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
    if (any) {
      const lat = Number(any[1]), lon = Number(any[2]);
      if (Number.isFinite(lat)&&Number.isFinite(lon)) return { lat, lon };
    }
  } catch {}
  return null;
}

// ---------- Settings Overlay ----------
function openSettings(){
  const ov = document.getElementById('settings');
  if (!ov) return;
  ov.classList.remove('hidden');
}
function closeSettings(){
  const ov = document.getElementById('settings');
  if (!ov) return;
  ov.classList.add('hidden');
}
document.getElementById('btn-settings-close')?.addEventListener('click', closeSettings);
// Close when clicking backdrop
document.getElementById('settings')?.addEventListener('click', (e)=>{
  if (e.target && e.target.id === 'settings') closeSettings();
});
// Close on Escape
window.addEventListener('keydown', (e)=>{
  if (e.key === 'Escape') { closeSettings(); hideMenu(); }
});

// ---------- Info Overlay ----------
function openInfo(){ document.getElementById('info')?.classList.remove('hidden'); }
function closeInfo(){ document.getElementById('info')?.classList.add('hidden'); }
document.getElementById('btn-info-close')?.addEventListener('click', closeInfo);
document.getElementById('info')?.addEventListener('click', (e)=>{ if (e.target && e.target.id === 'info') closeInfo(); });

// ---------- iOS Install Hint ----------
function isIOS(){
  const ua = navigator.userAgent || navigator.vendor || '';
  return /iPad|iPhone|iPod/.test(ua);
}
function isStandalone(){
  const mql = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  const iosStandalone = 'standalone' in navigator && navigator.standalone;
  return !!(mql || iosStandalone);
}
function isSafari(){
  const ua = navigator.userAgent || '';
  return ua.includes('Safari') && !ua.includes('CriOS') && !ua.includes('FxiOS');
}
function maybeShowIOSInstallHint(){
  try {
    if (!isIOS() || !isSafari() || isStandalone()) return;
    if (localStorage.getItem('ios_install_hint_shown') === '1') return;
    const ov = document.getElementById('install-hint');
    ov?.classList.remove('hidden');
  } catch {}
}
function closeInstallHint(mark=true){
  document.getElementById('install-hint')?.classList.add('hidden');
  if (mark) try { localStorage.setItem('ios_install_hint_shown','1'); } catch {}
}
document.getElementById('btn-install-close')?.addEventListener('click', ()=> closeInstallHint(true));
document.getElementById('install-ok')?.addEventListener('click', ()=> closeInstallHint(true));
document.getElementById('install-hint')?.addEventListener('click', (e)=>{ if (e.target && e.target.id === 'install-hint') closeInstallHint(false); });

// setupLocationUI is invoked above so controls are ready before init()

// ---------- Sparkline helpers ----------
function makeSparkline(data, dayStr){
  try {
    const idxs = [];
    for (let i=0;i<data.hourly.time.length;i++){
      const t = data.hourly.time[i];
      if (typeof t === 'string' && t.startsWith(dayStr)) idxs.push(i);
    }
    if (!idxs.length) return '';
    const tempsApp = idxs.map(i => data.hourly.apparent_temperature?.[i] ?? data.hourly.temperature_2m?.[i] ?? 0);
    const tempsAir = idxs.map(i => data.hourly.temperature_2m?.[i] ?? tempsApp[i] ?? 0);
    const precips = idxs.map(i => data.hourly.precipitation?.[i] ?? 0);
    const probs = idxs.map(i => (data.hourly.precipitation_probability?.[i] ?? 0) / 100);
    const hours = idxs.map(i => {
      const ts = data.hourly.time[i];
      const hh = Number(ts.slice(11,13));
      return Number.isFinite(hh) ? hh : new Date(ts).getHours();
    });
    return { svg: sparklineSVG2(tempsApp, precips, probs, hours), tempsApp, tempsAir, precips, probs, hours };
  } catch { return { svg: '', tempsApp: [], tempsAir: [], precips: [], probs: [], hours: [] }; }
}

// ---------- Pull-to-Refresh ----------
(function setupPullToRefresh(){
  const ptrEl = document.getElementById('ptr');
  if (!ptrEl) return;
  const label = ptrEl.querySelector('.ptr-label');
  const spinner = ptrEl.querySelector('.ptr-spinner');
  const threshold = 70;
  let startY = 0; let pulling = false; let dy = 0; let refreshing = false;
  const scrollEl = document.scrollingElement || document.documentElement;

  function setOffset(off){
    // Move body content down slightly
    document.body.style.transform = off ? `translateY(${off}px)` : '';
    ptrEl.style.height = off ? off + 'px' : '0px';
  }
  function onStart(e){
    if (refreshing) return;
    if (scrollEl.scrollTop > 0) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    pulling = true; startY = t.clientY; dy = 0;
    label && (label.textContent = 'Zum Aktualisieren ziehen');
    spinner && spinner.classList.add('hidden');
  }
  function onMove(e){
    if (!pulling || refreshing) return;
    const t = e.touches && e.touches[0]; if (!t) return;
    dy = Math.max(0, t.clientY - startY);
    if (dy>0 && scrollEl.scrollTop <= 0) {
      try { e.preventDefault(); } catch {}
      const off = Math.min(100, dy * 0.5);
      setOffset(off);
      if (label) label.textContent = off > threshold ? 'Loslassen zum Aktualisieren' : 'Zum Aktualisieren ziehen';
    }
  }
  async function onEnd(){
    if (!pulling || refreshing) { pulling=false; return; }
    pulling = false;
    const off = Math.min(100, dy * 0.5);
    if (off > threshold) {
      refreshing = true;
      spinner && spinner.classList.remove('hidden');
      if (label) label.textContent = 'Aktualisiere…';
      setOffset(56);
      try { await init(true); } finally {
        refreshing = false; setOffset(0);
      }
    } else {
      setOffset(0);
    }
  }
  window.addEventListener('touchstart', onStart, { passive: true });
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onEnd, { passive: true });
})();

// Enhanced sparkline with dual axis + 4h grid
function sparklineSVG2(temps, precips, probs, hours, width=320, height=60){
  const n = temps.length;
  if (!n) return '';
  const padTop = 6;
  const padBottom = 16;
  const chartHeight = Math.max(1, height - padTop - padBottom);
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const span = Math.max(1e-6, max - min);
  const rainMax = Math.max(0, ...(Array.isArray(precips) ? precips : []));
  const rainScale = Math.max(0.2, rainMax);
  const px = (i)=> n===1 ? width/2 : (i*(width-2))/(n-1) + 1;
  const pyTemp = (v)=> padTop + (1 - ((v - min)/span)) * chartHeight;
  const pyRain = (v)=> padTop + (1 - Math.min(1, v / rainScale)) * chartHeight;

  let tempPath = '';
  for (let i=0;i<n;i++){
    const x = px(i), y = pyTemp(temps[i]);
    tempPath += (i? ' L':'M') + x.toFixed(1) + ' ' + y.toFixed(1);
  }

  let rainArea = '';
  if (Array.isArray(precips) && precips.length === n){
    const baseY = (padTop + chartHeight).toFixed(1);
    rainArea = `M${px(0).toFixed(1)} ${baseY} `;
    for (let i=0;i<n;i++){
      const x=px(i), y = pyRain(precips[i]);
      rainArea += `L${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    rainArea += `L${px(n-1).toFixed(1)} ${baseY} Z`;
  }

  let grid = '';
  if (Array.isArray(hours) && hours.length){
    const first = hours[0];
    const last = hours[hours.length-1];
    const startHour = first % 4 === 0 ? first : first + (4 - (first % 4));
    const toX = (hour)=>{
      if (!Array.isArray(hours) || !hours.length) return px(0);
      const idx = hours.indexOf(hour);
      if (idx >= 0) return px(idx);
      for (let i=1;i<hours.length;i++){
        const prev = hours[i-1];
        const curr = hours[i];
        if (hour >= prev && hour <= curr){
          const ratio = (hour - prev) / Math.max(1, curr - prev);
          const xPrev = px(i-1);
          return xPrev + (px(i) - xPrev) * ratio;
        }
      }
      return hour < hours[0] ? px(0) : px(hours.length-1);
    };
    for (let h = startHour; h <= last; h += 4){
      const x = toX(h).toFixed(1);
      grid += `<line x1="${x}" y1="${padTop}" x2="${x}" y2="${(padTop+chartHeight).toFixed(1)}" stroke="rgba(59,69,96,0.45)" stroke-width="1" stroke-dasharray="2 4" />`;
      grid += `<text x="${x}" y="${(height-4).toFixed(1)}" fill="#9aa5b1" font-size="9" text-anchor="middle">${String(h).padStart(2,'0')}h</text>`;
    }
  }

  const tempLabels = `<text x="4" y="${(padTop+8).toFixed(1)}" fill="#9aa5b1" font-size="9" text-anchor="start">${Math.round(max)}°</text>` +
    `<text x="4" y="${(height-4).toFixed(1)}" fill="#9aa5b1" font-size="9" text-anchor="start">${Math.round(min)}°</text>`;
  const rainLabels = rainMax > 0 ? (
    `<text x="${(width-4).toFixed(1)}" y="${(padTop+8).toFixed(1)}" fill="#9aa5b1" font-size="9" text-anchor="end">${(Math.round(rainScale*10)/10).toFixed(1)} mm/h</text>` +
    `<text x="${(width-4).toFixed(1)}" y="${(height-4).toFixed(1)}" fill="#9aa5b1" font-size="9" text-anchor="end">0</text>`
  ) : '';

  const hiIdx = temps.indexOf(max);
  const loIdx = temps.indexOf(min);
  const highlights = [];
  if (hiIdx >= 0) highlights.push(`<circle cx="${px(hiIdx).toFixed(1)}" cy="${pyTemp(max).toFixed(1)}" r="2.8" fill="#0b5fff" />`);
  if (loIdx >= 0 && loIdx !== hiIdx) highlights.push(`<circle cx="${px(loIdx).toFixed(1)}" cy="${pyTemp(min).toFixed(1)}" r="2.8" fill="#0b5fff" />`);

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Mini-Verlauf Temperatur/Niederschlag">
    ${grid}
    ${rainArea ? `<path d="${rainArea}" fill="rgba(60,140,255,0.3)" stroke="none"/>` : ''}
    <path d="${tempPath}" fill="none" stroke="#e6edf3" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${highlights.join('')}
    ${tempLabels}
    ${rainLabels}
  </svg>`;
}

function attachSparklineHandlers(){
  const charts = document.querySelectorAll('.sparkline');
  charts.forEach((el)=>{
    if (el._sparkInit) return; el._sparkInit = true;
    const svg = el.querySelector('svg'); if (!svg) return;
    const tempsApp = safeParseArray(el.getAttribute('data-temps-app'));
    const tempsAir = safeParseArray(el.getAttribute('data-temps-air'));
    const precips = safeParseArray(el.getAttribute('data-precip'));
    const probs = safeParseArray(el.getAttribute('data-probs'));
    const hours = safeParseArray(el.getAttribute('data-hours'));
    if (!tempsApp.length) return;
    const W = svg.viewBox.baseVal.width || 320;
    const H = svg.viewBox.baseVal.height || 60;
    const n = tempsApp.length;
    const min = Math.min(...tempsApp);
    const max = Math.max(...tempsApp);
    const span = Math.max(1e-6, max - min);
    const padTop = 6;
    const padBottom = 16;
    const chartHeight = Math.max(1, H - padTop - padBottom);
    const invIndex = (x) => {
      const i = ((x-1)*(n-1))/(W-2);
      return Math.max(0, Math.min(n-1, Math.round(i)));
    };
    const yFromTemp = (t) => padTop + (1 - ((t - min)/span)) * chartHeight;
    const guide = document.createElement('div'); guide.className = 'spark-guide'; guide.style.display = 'none'; el.appendChild(guide);
    const dot = document.createElement('div'); dot.className = 'spark-dot'; dot.style.display = 'none'; el.appendChild(dot);
    const tip = document.createElement('div'); tip.className = 'spark-tip'; tip.style.display = 'none'; el.appendChild(tip);

    function showAtPointer(ev){
      const clientX = ev.clientX;
      const rect = el.getBoundingClientRect();
      const relX = clientX - rect.left;
      const xInView = Math.max(0, Math.min(rect.width, relX));
      const xViewBox = (xInView/rect.width) * W;
      const idx = invIndex(xViewBox);
      const hh = hours[idx] ?? idx;
      const tA = tempsApp[idx];
      const tAir = tempsAir[idx] ?? tA;
      const prob = Math.round((probs[idx] ?? 0) * 100);
      const mm = Math.round(((precips[idx] ?? 0) * 10)) / 10;
      const yViewBox = yFromTemp(tA);
      const yPx = (yViewBox/H) * rect.height;
      const leftPx = Math.round(xInView);
      guide.style.left = leftPx + 'px'; guide.style.display = '';
      dot.style.left = leftPx + 'px'; dot.style.top = Math.round(yPx) + 'px'; dot.style.display = '';
      const mmText = mm > 0 ? ` • ${mm.toFixed(1)} mm/h` : '';
      tip.textContent = `${String(hh).padStart(2,'0')}:00 • gefühlt ${Math.round(tA)}°C • Luft ${Math.round(tAir)}°C • Regen ${prob}%${mmText}`;
      tip.style.left = leftPx + 'px';
      const verticalOffset = ev.pointerType === 'touch' ? 48 : 20;
      tip.style.top = (Math.max(8, yPx - verticalOffset)) + 'px';
      tip.style.display = '';
    }
    function hide(){ guide.style.display='none'; dot.style.display='none'; tip.style.display='none'; }

    el.addEventListener('pointermove', (e)=>{ showAtPointer(e); });
    el.addEventListener('pointerdown', (e)=>{ showAtPointer(e); });
    el.addEventListener('pointerleave', hide);
    el.addEventListener('pointerup', hide);
  });
}

// Automatically widen metric chips whose content overflows
function adjustMetricSpans(scope){
  try {
    const root = scope || document;
    const ms = root.querySelectorAll('.metrics .metric');
    ms.forEach(m => {
      m.classList.remove('wide');
      const content = m.querySelector('.nowrap');
      if (content && content.scrollWidth > content.clientWidth + 1) {
        m.classList.add('wide');
      }
    });
  } catch {}
}

let _resizeTimer;
window.addEventListener('resize', ()=>{
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(()=> adjustMetricSpans(), 120);
});

function safeParseArray(s){ try { const a = JSON.parse(s||'[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
