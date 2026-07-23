// ---------- Reference lists (edit here to add/remove options) ----------

const DECADES = [
  { key: "earlier", label: "Earlier", test: (y) => y < 1970 },
  { key: "70s", label: "70s", test: (y) => y >= 1970 && y < 1980 },
  { key: "80s", label: "80s", test: (y) => y >= 1980 && y < 1990 },
  { key: "90s", label: "90s", test: (y) => y >= 1990 && y < 2000 },
  { key: "2000s", label: "2000s", test: (y) => y >= 2000 && y < 2010 },
  { key: "2010s", label: "2010s", test: (y) => y >= 2010 && y < 2020 },
  { key: "2020s", label: "2020s", test: (y) => y >= 2020 },
];

const GENRES = [
  "Action", "Adventure", "Animation", "Comedy", "Crime", "Drama",
  "Family", "Fantasy", "Horror", "Mystery", "Romance",
  "Science Fiction", "Thriller",
];

// key = internal id, label = shown as a tooltip, match = the provider_name
// value(s) TMDB actually uses for this service (confirmed via TMDB's API —
// some differ from the marketing name, e.g. Apple TV+ shows as "Apple TV").
// logoPath is filled in at runtime by fetchProviderLogos().
const STREAMING_SERVICES = [
  { key: "netflix", label: "Netflix", match: ["Netflix"], logoPath: null },
  { key: "hulu", label: "Hulu", match: ["Hulu"], logoPath: null },
  { key: "max", label: "Max", match: ["Max", "HBO Max"], logoPath: null },
  { key: "disney", label: "Disney+", match: ["Disney Plus"], logoPath: null },
  { key: "prime", label: "Prime Video", match: ["Amazon Prime Video"], logoPath: null },
  { key: "appletv", label: "Apple TV+", match: ["Apple TV", "Apple TV Plus"], logoPath: null },
  { key: "peacock", label: "Peacock", match: ["Peacock Premium", "Peacock"], logoPath: null },
  {
    key: "paramount",
    label: "Paramount+",
    match: ["Paramount Plus Premium", "Paramount Plus Essential", "Paramount Plus"],
    logoPath: null,
  },
];

// Discrete length steps: the two ends are open-ended buckets rather than
// literal minutes, the middle moves in clean 10-minute increments.
const LENGTH_STEPS = [
  { label: "Tight 90 mins", max: 90 },
  { label: "1h 40m", max: 100 },
  { label: "1h 50m", max: 110 },
  { label: "2h 00m", max: 120 },
  { label: "2h 10m", max: 130 },
  { label: "2h 20m", max: 140 },
  { label: "2h 30m", max: 150 },
  { label: "2h 40m", max: 160 },
  { label: "2h 50m", max: 170 },
  { label: "3h 00m", max: 180 },
  { label: "3+ hour marathons", max: Infinity },
];

const CACHE_KEY = "movieNightCache_v3";
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const PALETTE = ["#ff2bd0", "#38f0ff", "#b6ff3b", "#ff8a3b", "#ffe600", "#a24bff", "#ff5b8a", "#3bd0ff"];

// ---------- State ----------

let movieDatabase = []; // enriched movies, filled in on load
let lastWinnerKey = null; // prevents back-to-back repeats
const selectedDecades = new Set();
const selectedGenres = new Set();
const selectedStreaming = new Set();

// ---------- Small helpers ----------

function movieKey(movie) {
  return `${movie.title}|${movie.year}`;
}

function formatLength(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function decadeForYear(year) {
  const match = DECADES.find((d) => d.test(year));
  return match ? match.key : null;
}

// A movie whose year matches no DECADES bucket is silently excluded from
// every era filter (decadeForYear returns null, which never equals a
// selected key) — warn once at load time so a bad/missing year in
// CURATED_MOVIES doesn't just quietly vanish from filtered results.
function warnAboutUnrecognizedYears(movies) {
  movies
    .filter((m) => decadeForYear(m.year) === null)
    .forEach((m) => console.warn(`"${m.title}" has an unrecognized year (${m.year}) and will be excluded from era filters.`));
}

function posterUrl(posterPath) {
  return posterPath
    ? `https://image.tmdb.org/t/p/w342${posterPath}`
    : "https://placehold.co/342x513?text=No+Poster";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs `fn` over `items` with at most `limit` calls in flight at once,
// so we don't blast TMDB with 100+ simultaneous requests.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// ---------- Building the filter controls ----------

function buildToggleGroup(container, items, selectedSet, getKey, getLabel, paletteOffset = 0) {
  container.innerHTML = "";
  items.forEach((item, i) => {
    const key = getKey(item);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sticker-btn";
    btn.textContent = getLabel(item);
    const rot = ((i * 37) % 7) - 3;
    btn.style.transform = `rotate(${rot}deg)`;
    const color = PALETTE[(i + paletteOffset) % PALETTE.length];

    const applySelected = (sel) => {
      btn.classList.toggle("selected", sel);
      btn.style.background = sel ? color : "";
    };
    applySelected(selectedSet.has(key));

    btn.addEventListener("click", () => {
      if (selectedSet.has(key)) {
        selectedSet.delete(key);
      } else {
        selectedSet.add(key);
      }
      applySelected(selectedSet.has(key));
    });
    container.appendChild(btn);
  });
}

function buildStreamingIcons(container) {
  container.innerHTML = "";
  STREAMING_SERVICES.forEach((service, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stream-sticker-btn";
    btn.title = service.label;
    const rot = ((i * 53) % 11) - 5;
    btn.style.transform = `rotate(${rot}deg)`;

    if (service.logoPath) {
      const img = document.createElement("img");
      img.src = `https://image.tmdb.org/t/p/w92${service.logoPath}`;
      img.alt = service.label;
      btn.appendChild(img);
    } else {
      // Logo lookup failed (offline, TMDB hiccup) — fall back to text.
      btn.textContent = service.label;
    }

    btn.addEventListener("click", () => {
      if (selectedStreaming.has(service.key)) {
        selectedStreaming.delete(service.key);
        btn.classList.remove("selected");
      } else {
        selectedStreaming.add(service.key);
        btn.classList.add("selected");
      }
    });
    container.appendChild(btn);
  });
}

// Builds a draggable half-circle "lever" dial that mirrors its value onto a
// hidden native <input type="range">, which stays the actual source of truth
// for matchesFilters() — this widget is a visual/interaction layer on top.
function setupLeverDial(wrap, hiddenInput, side, labels) {
  const min = Number(hiddenInput.min);
  const max = Number(hiddenInput.max);
  const step = Number(hiddenInput.step);

  const dial = document.createElement("div");
  dial.className = `lever-dial lever-dial--${side}`;
  dial.innerHTML = `
    <div class="lever-track"></div>
    <div class="lever-arm"><div class="lever-bar"></div><div class="lever-ball"></div></div>
    <div class="lever-pivot"></div>
    <div class="lever-label lever-label-top">${labels.top}</div>
    <div class="lever-label lever-label-bottom">${labels.bottom}</div>
  `;
  wrap.appendChild(dial);
  const arm = dial.querySelector(".lever-arm");

  function render() {
    const value = Number(hiddenInput.value);
    const t = (value - min) / (max - min);
    const angle = side === "left" ? t * 156 - 78 : 78 - t * 156;
    arm.style.transform = `rotate(${angle}deg)`;
  }
  render();
  hiddenInput.addEventListener("input", render);

  let drag = null;
  const stepsCount = (max - min) / step;
  const pxPerStep = 180 / stepsCount;

  function onPointerMove(e) {
    if (!drag) return;
    const dy = drag.startY - e.clientY;
    let v = Math.round((drag.startVal + (dy / pxPerStep) * step) / step) * step;
    v = Math.max(min, Math.min(max, v));
    if (v !== Number(hiddenInput.value)) {
      hiddenInput.value = v;
      hiddenInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  function onPointerUp() {
    drag = null;
    dial.classList.remove("dragging");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }
  dial.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    drag = { startY: e.clientY, startVal: Number(hiddenInput.value) };
    dial.classList.add("dragging");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  });
}

function buildBulbs() {
  const counts = { top: 14, bottom: 14, left: 7, right: 7 };
  Object.entries(counts).forEach(([side, count]) => {
    const container = document.querySelector(`.stage-lights-${side}`);
    for (let i = 0; i < count; i++) {
      const bulb = document.createElement("div");
      bulb.className = "bulb";
      bulb.style.animationDelay = `${(i % 5) * 0.15}s`;
      bulb.style.animationDuration = `${1 + (i % 4) * 0.25}s`;
      container.appendChild(bulb);
    }
  });
}

// ---------- Confetti + floating text FX ----------

function ding(text, color) {
  const fxLayer = document.getElementById("fxLayer");
  const el = document.createElement("div");
  el.className = "fx-ding";
  el.textContent = text;
  el.style.color = color;
  el.style.setProperty("--r", `${(Math.random() * 24 - 12).toFixed(0)}deg`);
  el.style.left = `${12 + Math.random() * 76}%`;
  el.style.top = `${18 + Math.random() * 60}%`;
  fxLayer.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

function burstPopcorn() {
  const fxLayer = document.getElementById("fxLayer");
  const emojis = ["🍿", "🍿", "🍿", "🍿", "🎟️", "⭐", "🎬", "🥤", "🍬", "🎉"];
  const n = 26;
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dist = 100 + Math.random() * 260;
    const span = document.createElement("span");
    span.className = "fx-popcorn";
    span.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    span.style.fontSize = `${18 + Math.random() * 20}px`;
    span.style.setProperty("--tx", `${(Math.cos(ang) * dist).toFixed(0)}px`);
    span.style.setProperty("--ty", `${(Math.sin(ang) * dist - 100).toFixed(0)}px`);
    span.style.setProperty("--pr", `${(Math.random() * 700 - 350).toFixed(0)}deg`);
    span.style.setProperty("--dur", `${(0.9 + Math.random() * 0.9).toFixed(2)}s`);
    fxLayer.appendChild(span);
    setTimeout(() => span.remove(), 1900);
  }
}

async function fetchProviderLogos() {
  try {
    const url =
      `https://api.themoviedb.org/3/watch/providers/movie?api_key=${TMDB_API_KEY}` +
      `&watch_region=${TMDB_REGION}`;
    const data = await fetchJson(url);
    const allProviders = data.results || [];
    STREAMING_SERVICES.forEach((service) => {
      const found = allProviders.find((p) => service.match.includes(p.provider_name));
      service.logoPath = found ? found.logo_path : null;
    });
  } catch (err) {
    console.warn("Failed to load streaming provider logos:", err);
  }
}

// ---------- Talking to TMDB ----------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB request failed: ${res.status}`);
  return res.json();
}

function findTrailerKey(videos) {
  if (!videos || videos.length === 0) return null;
  const isYouTube = (v) => v.site === "YouTube";
  const officialTrailer = videos.find(
    (v) => isYouTube(v) && v.type === "Trailer" && v.official
  );
  if (officialTrailer) return officialTrailer.key;
  const anyTrailer = videos.find((v) => isYouTube(v) && v.type === "Trailer");
  if (anyTrailer) return anyTrailer.key;
  const teaser = videos.find((v) => isYouTube(v) && v.type === "Teaser");
  return teaser ? teaser.key : null;
}

async function enrichMovie(movie) {
  try {
    const searchUrl =
      `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}` +
      `&query=${encodeURIComponent(movie.title)}&year=${movie.year}`;
    const searchData = await fetchJson(searchUrl);
    const found = searchData.results && searchData.results[0];
    if (!found) {
      console.warn(`No TMDB match for "${movie.title}" (${movie.year})`);
      return null;
    }

    const detailsUrl =
      `https://api.themoviedb.org/3/movie/${found.id}?api_key=${TMDB_API_KEY}` +
      `&append_to_response=watch/providers,videos`;
    const details = await fetchJson(detailsUrl);

    const flatrate =
      (details["watch/providers"] &&
        details["watch/providers"].results &&
        details["watch/providers"].results[TMDB_REGION] &&
        details["watch/providers"].results[TMDB_REGION].flatrate) ||
      [];

    return {
      title: movie.title,
      year: movie.year,
      rtScore: movie.rtScore,
      runtime: details.runtime || null,
      genres: (details.genres || []).map((g) => g.name),
      posterPath: details.poster_path,
      overview: details.overview || "",
      trailerKey: findTrailerKey(details.videos && details.videos.results),
      providers: flatrate.map((p) => ({
        name: p.provider_name,
        logoPath: p.logo_path,
      })),
    };
  } catch (err) {
    console.warn(`Failed to enrich "${movie.title}":`, err);
    return null;
  }
}

// Shape enrichMovie() guarantees for every non-null result — used to reject
// a cached record that doesn't match (stale schema, hand-edited localStorage).
function isValidCachedMovie(m) {
  return (
    m &&
    typeof m.title === "string" &&
    typeof m.year === "number" &&
    Array.isArray(m.genres) &&
    Array.isArray(m.providers)
  );
}

// Cache is keyed per-movie rather than validated as an all-or-nothing blob:
// any curated title missing from (or invalid within) the cache — whether
// because it's new, because a prior enrichment failed transiently, or
// because it will never have a TMDB match — is simply re-fetched here. That
// makes a partial failure self-healing on the very next load instead of
// getting silently frozen into the cache for CACHE_MAX_AGE_MS.
async function loadMovieData(statusEl) {
  const cached = (readCache() || []).filter(isValidCachedMovie);
  const cachedByKey = new Map(cached.map((m) => [movieKey(m), m]));
  const missing = CURATED_MOVIES.filter((m) => !cachedByKey.has(movieKey(m)));

  if (missing.length === 0) {
    movieDatabase = CURATED_MOVIES.map((m) => cachedByKey.get(movieKey(m))).filter(Boolean);
    return;
  }

  statusEl.textContent = `Loading movie data... (0/${missing.length})`;
  let done = 0;

  const enriched = await mapWithConcurrency(missing, 5, async (movie) => {
    const result = await enrichMovie(movie);
    done++;
    statusEl.textContent = `Loading movie data... (${done}/${missing.length})`;
    return result;
  });
  const enrichedByKey = new Map(enriched.filter(Boolean).map((m) => [movieKey(m), m]));

  movieDatabase = CURATED_MOVIES.map(
    (m) => cachedByKey.get(movieKey(m)) || enrichedByKey.get(movieKey(m))
  ).filter(Boolean);
  writeCache(movieDatabase);
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { timestamp, data } = JSON.parse(raw);
    if (!Number.isFinite(timestamp) || Date.now() - timestamp > CACHE_MAX_AGE_MS) return null;
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        timestamp: Date.now(),
        data,
      })
    );
  } catch {
    // localStorage might be full or unavailable — not critical, just skip caching.
  }
}

// ---------- Filtering ----------

function matchesFilters(movie) {
  const stepIndex = Number(document.getElementById("lengthSlider").value);
  const maxLength = LENGTH_STEPS[stepIndex].max;
  if (movie.runtime && movie.runtime > maxLength) return false;

  if (selectedDecades.size > 0) {
    const decade = decadeForYear(movie.year);
    if (!selectedDecades.has(decade)) return false;
  }

  if (selectedGenres.size > 0) {
    const hasGenre = movie.genres.some((g) => selectedGenres.has(g));
    if (!hasGenre) return false;
  }

  const minScore = Number(document.getElementById("rtSlider").value);
  if (minScore > 0 && !(typeof movie.rtScore === "number" && movie.rtScore >= minScore)) return false;

  if (selectedStreaming.size > 0) {
    const checkedServices = STREAMING_SERVICES.filter((s) =>
      selectedStreaming.has(s.key)
    );
    const movieProviderNames = movie.providers.map((p) => p.name);
    const available = checkedServices.some((s) =>
      s.match.some((name) => movieProviderNames.includes(name))
    );
    if (!available) return false;
  }

  return true;
}

// ---------- Slot machine animation + result ----------

// Only badge providers the streaming selector actually knows about — TMDB's
// flatrate list includes services (regional add-ons, ad-tier variants, etc.)
// that aren't one of our selectable STREAMING_SERVICES.
function renderProviderIcons(container, movie) {
  container.innerHTML = "";
  const trackedProviders = movie.providers.filter(
    (p) => p.logoPath && STREAMING_SERVICES.some((s) => s.match.includes(p.name))
  );
  if (trackedProviders.length === 0) {
    const span = document.createElement("span");
    span.className = "no-providers";
    span.textContent = "Not currently on a major streaming subscription.";
    container.appendChild(span);
    return;
  }
  trackedProviders.forEach((p) => {
    const img = document.createElement("img");
    img.src = `https://image.tmdb.org/t/p/w45${p.logoPath}`;
    img.alt = p.name;
    img.title = p.name;
    container.appendChild(img);
  });
}

function fillResult(winner) {
  document.getElementById("resultPoster").src = posterUrl(winner.posterPath);
  document.getElementById("resultTitle").textContent = `${winner.title} (${winner.year})`;
  document.getElementById("resultMeta").textContent =
    `${winner.genres.join(", ") || "Unknown genre"} · ` +
    `${winner.runtime ? formatLength(winner.runtime) : "Unknown length"} · ` +
    `${winner.rtScore}% 🍅`;
  document.getElementById("resultOverview").textContent = winner.overview || "No summary available.";
  renderProviderIcons(document.getElementById("resultProviders"), winner);

  const trailerWrap = document.getElementById("trailerWrap");
  const trailerFrame = document.getElementById("trailerFrame");
  if (winner.trailerKey) {
    trailerFrame.src = `https://www.youtube.com/embed/${winner.trailerKey}`;
    trailerWrap.hidden = false;
  } else {
    trailerFrame.src = "";
    trailerWrap.hidden = true;
  }
}

async function spin() {
  const statusEl = document.getElementById("statusMessage");
  const spinBtn = document.getElementById("spinButton");
  const stage = document.getElementById("stage");
  const stageIdle = document.getElementById("stageIdle");
  const slotMachine = document.getElementById("slotMachine");
  const resultSection = document.getElementById("result");
  const reelPoster = document.getElementById("reelPoster");

  const matches = movieDatabase.filter(matchesFilters);

  if (matches.length === 0) {
    statusEl.textContent = "No movies match those filters — try loosening one 🎬";
    return;
  }

  statusEl.textContent = "";
  spinBtn.disabled = true;
  stage.classList.remove("open");
  stageIdle.hidden = true;
  resultSection.hidden = true;
  document.getElementById("trailerFrame").src = ""; // stop any trailer still playing from the previous winner
  slotMachine.hidden = false;
  slotMachine.classList.add("spinning");

  ding("KA-CHUNK!", "#ffe600");

  // Never land on the same movie twice in a row — unless every match shares
  // the previous winner's key (e.g. a duplicate title+year), in which case
  // fall back to the full match list rather than an empty pool.
  const repeatFiltered = matches.filter((m) => movieKey(m) !== lastWinnerKey);
  const pool = repeatFiltered.length > 0 ? repeatFiltered : matches;
  const winner = pool[Math.floor(Math.random() * pool.length)];
  lastWinnerKey = movieKey(winner);

  // Cycle through random posters, slowing down, then land on the winner.
  const flips = 14;
  for (let i = 0; i < flips; i++) {
    const random = matches[Math.floor(Math.random() * matches.length)];
    reelPoster.src = posterUrl(random.posterPath);
    const delay = 60 + i * 18; // ramps from fast to slow
    await sleep(delay);
    if (i === 4) ding("BRRRRRR...", "#ff2bd0");
    if (i === 9) ding("🎰 SPINNIN'!", "#38f0ff");
  }
  reelPoster.src = posterUrl(winner.posterPath);

  // Fill the result card before the curtains open so it's ready the instant they part.
  fillResult(winner);

  slotMachine.classList.remove("spinning");
  slotMachine.hidden = true;
  resultSection.hidden = false;
  resultSection.classList.remove("reveal");
  void resultSection.offsetWidth; // force reflow so the reveal animation restarts
  resultSection.classList.add("reveal");
  stage.classList.add("open");

  burstPopcorn();
  ding("🎉 TA-DAAA!", "#b6ff3b");
  await sleep(250);
  ding("WINNER!", "#ff8a3b");
  await sleep(250);
  ding("🍿 POW!", "#ff5b8a");

  spinBtn.disabled = false;
}

// ---------- Init ----------

function formatRtLabel(value) {
  if (value === 0) return "Any score";
  return `${value}%+${value >= 70 ? " 🍅" : ""}`;
}

async function init() {
  const lengthSlider = document.getElementById("lengthSlider");
  const lengthValue = document.getElementById("lengthValue");
  lengthSlider.addEventListener("input", () => {
    lengthValue.textContent = LENGTH_STEPS[Number(lengthSlider.value)].label;
  });
  lengthValue.textContent = LENGTH_STEPS[Number(lengthSlider.value)].label;
  setupLeverDial(document.getElementById("lengthDialWrap"), lengthSlider, "left", {
    top: "3+ hr",
    bottom: "90 min",
  });

  const rtSlider = document.getElementById("rtSlider");
  const rtValue = document.getElementById("rtValue");
  rtSlider.addEventListener("input", () => {
    rtValue.textContent = formatRtLabel(Number(rtSlider.value));
  });
  rtValue.textContent = formatRtLabel(Number(rtSlider.value));
  setupLeverDial(document.getElementById("rtDialWrap"), rtSlider, "right", {
    top: "100",
    bottom: "ANY",
  });

  buildBulbs();

  buildToggleGroup(
    document.getElementById("decadeGroup"),
    DECADES,
    selectedDecades,
    (d) => d.key,
    (d) => d.label
  );
  buildToggleGroup(
    document.getElementById("genreGroup"),
    GENRES,
    selectedGenres,
    (g) => g,
    (g) => g,
    2
  );

  const statusEl = document.getElementById("statusMessage");
  const spinBtn = document.getElementById("spinButton");
  spinBtn.disabled = true;

  await fetchProviderLogos();
  buildStreamingIcons(document.getElementById("streamingGroup"));

  await loadMovieData(statusEl);
  warnAboutUnrecognizedYears(movieDatabase);

  statusEl.textContent = `Ready — ${movieDatabase.length} movies loaded.`;
  spinBtn.disabled = false;
  spinBtn.addEventListener("click", spin);
}

document.addEventListener("DOMContentLoaded", init);
