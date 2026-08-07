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

// The streaming services, their labels, and their logo paths all come from
// movies.json (see scripts/build-movie-data.mjs, which owns the list and the
// TMDB provider-name matching). Filled in by loadMovieData(); the bit order
// here matches each movie's providerMask.
let STREAMING_SERVICES = [];

// TMDB's full genre vocabulary, also from movies.json. Index = bit position in
// each movie's genreMask. Wider than GENRES above on purpose: the result card
// prints every genre a movie has, including ones the filter row doesn't offer.
let GENRE_VOCABULARY = [];

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
  { label: "Any Length", max: Infinity },
];

// Everything needed to filter and display the catalog, pre-resolved against
// TMDB at build time by scripts/build-movie-data.mjs. Cache-busted by the
// deploy itself, since Vercel fingerprints nothing in public/ — the query
// string is bumped by hand only if a schema change ever needs to force it.
const BUNDLE_URL = "/movies/movies.json";

// The page used to enrich all ~1000 movies in the browser on first load and
// stash the result here. That's now precomputed, so this key is dead — and it
// held roughly 700 KB, worth reclaiming from anyone who still has it.
const LEGACY_CACHE_KEY = "movieNightCache_v3";

// Shared links point at /movies/pick/<tmdbId> rather than straight here, so the
// text-message preview can carry the movie's own image and title — those tags
// have to exist in the served HTML, and link crawlers don't run JavaScript.
// That page bounces the visitor to /movies?pick=<tmdbId>, handled by revealPick().
const SHARE_BASE = "https://www.tedherringshaw.com/movies/pick";
const SHARE_MESSAGE = "It's movie night, baby!";

const PALETTE = ["#ff2bd0", "#38f0ff", "#b6ff3b", "#ff8a3b", "#ffe600", "#a24bff", "#ff5b8a", "#3bd0ff"];

// Sound-effect words flung across the stage mid-spin. Two pools so the noise
// suits the moment: mechanical clatter while the reels are turning, then a
// celebration once a movie lands. Drawn at random every spin so the machine
// never sounds quite the same twice.
const SPIN_SOUNDS = [
  "KA-CHUNK!", "BRRRRRR...", "🎰 SPINNIN'!", "CLICK-CLACK!", "WHIRRRR!",
  "CHK-CHK-CHK!", "RATTLE-RATTLE!", "CLATTER!", "ZZZZIP!", "KLUNK!",
  "TICKA-TICKA!", "RUMBLE!", "VRRRRM!", "WHIRLY-WHIRL!", "CLINKETY-CLINK!",
  "THUNKA-THUNKA!", "WOBBLE-WOBBLE!", "ZOOM-ZOOM!", "CHUGGA-CHUGGA!",
  "FLIPPITY-FLIP!", "SHUFFLE-SHUFFLE!", "GRRRIND!", "WHIZZ-BANG!", "RAT-A-TAT!",
];

const WIN_SOUNDS = [
  "🎉 TA-DAAA!", "WINNER!", "🍿 POW!", "JACKPOT!", "BINGO!", "KA-POW!",
  "BOOM!", "ZOWIE!", "YOWZA!", "HOT DANG!", "BULLSEYE!", "DING-DING-DING!",
  "WOO-HOO!", "KABLAM!", "SHAZAM!", "EUREKA!", "BADA-BING!", "HUZZAH!",
  "YAHTZEE!", "SCORE!", "NAILED IT!", "OH BABY!", "🍿 THAT'S THE ONE!",
  "LOCKED IN!", "SIZZLE!", "🎬 ACTION!", "BOOM-SHAKA!", "🌟 STARRING!",
  "HOT TICKET!", "🎟️ SOLD OUT!",
];

// ---------- State ----------

let movieDatabase = []; // unpacked from movies.json on load
let lastWinnerKey = null; // prevents back-to-back repeats
let currentWinner = null; // what the share button is currently pointing at
const selectedDecades = new Set();
const selectedGenres = new Set();
const selectedStreaming = new Set();

// Overview + trailer aren't in the bundle (they'd quadruple it, and trailer
// keys go stale as YouTube pulls videos), so they're fetched for the single
// winning movie during the spin animation. Memoized per session by TMDB id so
// landing on the same movie twice doesn't refetch.
const winnerExtrasCache = new Map();

// ---------- Small helpers ----------

function movieKey(movie) {
  return `${movie.title}|${movie.year}`;
}

// Vercel Web Analytics custom event. The script is loaded from index.html; if
// it hasn't arrived — still loading, blocked by an ad blocker, offline — then
// window.va is undefined and this quietly does nothing. Measurement must never
// be able to break a spin.
function track(name, data) {
  try {
    if (typeof window.va === "function") window.va("event", { name, data });
  } catch {
    // Deliberately swallowed: a failed beacon is not worth surfacing.
  }
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
// movies.js doesn't just quietly vanish from filtered results.
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

// Expands a bitmask into the values it selects from `vocabulary`, where bit i
// means vocabulary[i]. Both genres and streaming services ride in the bundle
// this way — it's what keeps 995 movies under 40 KB over the wire.
function unpackMask(mask, vocabulary) {
  const out = [];
  for (let i = 0; i < vocabulary.length; i++) {
    if (mask & (1 << i)) out.push(vocabulary[i]);
  }
  return out;
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

// Throws an unused word from `pool` in a random palette colour. `used` is
// carried across a single spin so one spin never repeats itself; if a pool runs
// dry it falls back to the full list rather than going silent.
function randomDing(pool, used) {
  const unheard = pool.filter((word) => !used.has(word));
  const choices = unheard.length > 0 ? unheard : pool;
  const word = choices[Math.floor(Math.random() * choices.length)];
  used.add(word);
  ding(word, PALETTE[Math.floor(Math.random() * PALETTE.length)]);
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

// The one TMDB call still made from the browser, for the winning movie only.
// It's kicked off the moment a winner is picked and awaited just before the
// curtains open, so it hides entirely inside the ~2.5s slot-machine animation.
// Returns null on any failure; fillResult() degrades to the bundled fields.
async function fetchWinnerExtras(tmdbId) {
  if (winnerExtrasCache.has(tmdbId)) return winnerExtrasCache.get(tmdbId);
  try {
    const details = await fetchJson(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}` +
        `&append_to_response=videos`
    );
    const extras = {
      overview: details.overview || "",
      trailerKey: findTrailerKey(details.videos && details.videos.results),
    };
    winnerExtrasCache.set(tmdbId, extras);
    return extras;
  } catch (err) {
    console.warn(`Couldn't load details for TMDB id ${tmdbId}:`, err);
    return null;
  }
}

// Loads the prebuilt bundle and expands each packed row into the object shape
// the rest of the app works with. Rows are arrays ordered by bundle.fields
// rather than keyed objects — that packing plus the genre/provider bitmasks is
// what gets ~1000 movies down to ~39 KB brotli, one request, instead of the
// ~2000 TMDB round-trips this used to cost every first-time visitor.
async function loadMovieData() {
  const bundle = await fetchJson(BUNDLE_URL);

  GENRE_VOCABULARY = bundle.genres;
  STREAMING_SERVICES = bundle.services;

  const idx = {};
  bundle.fields.forEach((name, i) => {
    idx[name] = i;
  });

  movieDatabase = bundle.movies.map((row) => ({
    id: row[idx.id],
    title: row[idx.title],
    year: row[idx.year],
    rtScore: row[idx.rtScore],
    runtime: row[idx.runtime],
    posterPath: row[idx.posterPath],
    rentable: row[idx.rentable] === 1,
    genres: unpackMask(row[idx.genreMask], GENRE_VOCABULARY),
    // Service objects, not names — matchesFilters() and renderProviderIcons()
    // both key off `.key`, so TMDB's provider-name aliasing is resolved once
    // at build time and never has to be re-matched here.
    services: unpackMask(row[idx.providerMask], STREAMING_SERVICES),
  }));

  try {
    localStorage.removeItem(LEGACY_CACHE_KEY);
  } catch {
    // Private mode or a full quota — nothing here is load-bearing.
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
    const available = movie.services.some((s) => selectedStreaming.has(s.key));
    if (!available) return false;
  }

  return true;
}

// ---------- Slot machine animation + result ----------

// movie.services only ever contains the eight selectable services — the build
// step already dropped everything else TMDB lists as flatrate (regional
// add-ons, ad-tier variants), so there's nothing left to filter out here.
function renderProviderIcons(container, movie) {
  container.innerHTML = "";
  const services = movie.services.filter((s) => s.logoPath);
  if (services.length === 0) {
    // 97% of the movies with no subscription can still be rented, so saying so
    // turns a dead end into an answer. No storefronts named: nearly all of them
    // are on all five majors, but not quite all, and TMDB publishes no prices.
    const span = document.createElement("span");
    span.className = "no-providers";
    // The final fallback is only reachable by a handful of titles, and they're
    // typically on a smaller ad-supported service we deliberately don't list —
    // so it says what isn't true rather than claiming the film is unfindable.
    span.textContent = movie.rentable
      ? "Not on a subscription — available to rent or buy."
      : "Not on a major subscription or rental.";
    container.appendChild(span);
    return;
  }
  services.forEach((s) => {
    const img = document.createElement("img");
    img.src = `https://image.tmdb.org/t/p/w45${s.logoPath}`;
    img.alt = s.label;
    img.title = s.label;
    container.appendChild(img);
  });
}

// `extras` is the result of fetchWinnerExtras(), or null if that call failed —
// in which case everything except the blurb and trailer still renders from the
// bundled data, and the trailer panel just stays hidden.
function fillResult(winner, extras) {
  document.getElementById("resultPoster").src = posterUrl(winner.posterPath);
  document.getElementById("resultTitle").textContent = `${winner.title} (${winner.year})`;
  document.getElementById("resultMeta").textContent =
    `${winner.genres.join(", ") || "Unknown genre"} · ` +
    `${winner.runtime ? formatLength(winner.runtime) : "Unknown length"} · ` +
    `${winner.rtScore}% 🍅`;
  document.getElementById("resultOverview").textContent =
    (extras && extras.overview) || "No summary available.";
  renderProviderIcons(document.getElementById("resultProviders"), winner);

  const trailerWrap = document.getElementById("trailerWrap");
  const trailerFrame = document.getElementById("trailerFrame");
  if (extras && extras.trailerKey) {
    trailerFrame.src = `https://www.youtube.com/embed/${extras.trailerKey}`;
    trailerWrap.hidden = false;
  } else {
    trailerFrame.src = "";
    trailerWrap.hidden = true;
  }
}

// ---------- Sharing ----------

// Called once a movie is on screen, however it got there — a spin or a friend's
// link. Share only exists from that point on, since there's nothing to send
// before it, and Spin stops being an invitation and becomes a re-roll.
function showPickActions() {
  document.getElementById("shareButton").hidden = false;
  document.getElementById("spinButton").textContent = "🎰 SPIN AGAIN";
  // Once a movie is on screen it speaks for itself — clear the load message so
  // nothing sits under the buttons competing with it. (Spin already clears this
  // on its way through; this covers arriving straight from a shared link.)
  document.getElementById("statusMessage").textContent = "";
}

// Whether to hand off to the OS share sheet. It's the right call on a phone —
// Messages is one tap away, and iOS composes the message text and the link
// together. It is NOT the right call on desktop: macOS supports navigator.share
// but its share sheet passes only the URL to Messages, silently dropping the
// text, so "It's movie night, baby!" never arrives. Copying is fully under our
// control, so desktop takes that path and gets the whole message.
//
// Touch capability is the signal, not screen width: a small browser window on a
// laptop still wants the clipboard, and a tablet still wants the share sheet.
function prefersNativeShare() {
  return typeof navigator.share === "function" && window.matchMedia("(pointer: coarse)").matches;
}

// On a phone this opens the OS share sheet. Everywhere else it copies the
// message and link together, confirming in place — the same copy-then-revert
// pattern the site's contact buttons already use.
async function shareCurrentPick() {
  if (!currentWinner) return;

  const btn = document.getElementById("shareButton");
  const label = document.getElementById("shareButtonLabel");
  const url = `${SHARE_BASE}/${currentWinner.id}`;

  // Tapped and completed are tracked separately: the gap between them is people
  // opening the share sheet and backing out, which is worth being able to see.
  const method = prefersNativeShare() ? "native" : "copy";
  track("share_tapped", { method, movie: currentWinner.title });

  if (prefersNativeShare()) {
    try {
      await navigator.share({ title: "Movie Night, Baby!", text: SHARE_MESSAGE, url });
      track("share_completed", { method: "native", movie: currentWinner.title });
      ding("🎟️ SENT!", "#b6ff3b");
    } catch (err) {
      // Dismissing the share sheet rejects with AbortError. That's a choice,
      // not a failure, so it should leave no trace on the page.
      if (err.name !== "AbortError") console.warn("Share failed:", err);
    }
    return;
  }

  try {
    await navigator.clipboard.writeText(`${SHARE_MESSAGE} ${url}`);
    track("share_completed", { method: "copy", movie: currentWinner.title });
    btn.classList.add("copied");
    label.textContent = "COPIED!";
    ding("🎟️ COPIED!", "#b6ff3b");
    setTimeout(() => {
      btn.classList.remove("copied");
      label.textContent = "SHARE";
    }, 2000);
  } catch (err) {
    console.warn("Couldn't copy the link:", err);
    label.textContent = "COPY FAILED";
    setTimeout(() => { label.textContent = "SHARE"; }, 2000);
  }
}

// ---------- Arriving from a shared link ----------

// Someone tapped a friend's link. Show them that movie straight away rather
// than pantomiming a spin that already happened — then leave the Spin button
// as the obvious next move, which is the whole reason for sharing a link back
// to the site instead of to a trailer.
async function revealPick(tmdbId) {
  const movie = movieDatabase.find((m) => m.id === tmdbId);
  if (!movie) return false;

  const stage = document.getElementById("stage");
  const resultSection = document.getElementById("result");

  document.getElementById("stageIdle").hidden = true;
  currentWinner = movie;
  lastWinnerKey = movieKey(movie);

  fillResult(movie, await fetchWinnerExtras(movie.id));

  resultSection.hidden = false;
  resultSection.classList.add("reveal");
  stage.classList.add("open");
  showPickActions();
  burstPopcorn();
  randomDing(WIN_SOUNDS, new Set());
  // The payoff event: someone actually followed a link a friend sent them.
  // This is what tells us whether sharing is doing anything.
  track("shared_link_opened", { movie: movie.title });
  return true;
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

  // Shared across this one spin so the same word can't land twice in a row.
  const heard = new Set();
  randomDing(SPIN_SOUNDS, heard);

  // Never land on the same movie twice in a row — unless every match shares
  // the previous winner's key (e.g. a duplicate title+year), in which case
  // fall back to the full match list rather than an empty pool.
  const repeatFiltered = matches.filter((m) => movieKey(m) !== lastWinnerKey);
  const pool = repeatFiltered.length > 0 ? repeatFiltered : matches;
  const winner = pool[Math.floor(Math.random() * pool.length)];
  lastWinnerKey = movieKey(winner);
  currentWinner = winner;

  // The denominator for the share rate: how many picks people saw at all.
  track("spin", { movie: winner.title });

  // Fire the winner's blurb/trailer lookup now and await it after the reels
  // finish — a ~100-300ms call under ~2.5s of animation, so it's never seen.
  const extrasPromise = fetchWinnerExtras(winner.id);

  // Cycle through random posters, slowing down, then land on the winner.
  const flips = 14;
  for (let i = 0; i < flips; i++) {
    const random = matches[Math.floor(Math.random() * matches.length)];
    reelPoster.src = posterUrl(random.posterPath);
    const delay = 60 + i * 18; // ramps from fast to slow
    await sleep(delay);
    if (i === 4) randomDing(SPIN_SOUNDS, heard);
    if (i === 9) randomDing(SPIN_SOUNDS, heard);
  }
  reelPoster.src = posterUrl(winner.posterPath);

  // Fill the result card before the curtains open so it's ready the instant they part.
  fillResult(winner, await extrasPromise);

  slotMachine.classList.remove("spinning");
  slotMachine.hidden = true;
  resultSection.hidden = false;
  resultSection.classList.remove("reveal");
  void resultSection.offsetWidth; // force reflow so the reveal animation restarts
  resultSection.classList.add("reveal");
  stage.classList.add("open");
  showPickActions();

  burstPopcorn();
  randomDing(WIN_SOUNDS, heard);
  await sleep(250);
  randomDing(WIN_SOUNDS, heard);
  await sleep(250);
  randomDing(WIN_SOUNDS, heard);

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

  try {
    await loadMovieData();
  } catch (err) {
    // The bundle is the whole catalog, so there's no partial mode to fall back
    // to — say so plainly rather than leaving a dead button with no reason.
    console.error("Failed to load the movie bundle:", err);
    statusEl.textContent = "Couldn't load the movie list — check your connection and refresh.";
    return;
  }

  // Needs the service list from the bundle, so it can't run any earlier.
  buildStreamingIcons(document.getElementById("streamingGroup"));
  warnAboutUnrecognizedYears(movieDatabase);

  statusEl.textContent = `Ready — ${movieDatabase.length} movies loaded.`;
  spinBtn.disabled = false;
  spinBtn.addEventListener("click", spin);
  document.getElementById("shareButton").addEventListener("click", shareCurrentPick);

  // ?pick=<tmdbId> means they followed someone's shared link. An id we don't
  // recognise (retired from the catalog, hand-edited URL) just falls through to
  // the normal idle state — a stranger's first visit shouldn't show an error.
  const requestedPick = Number(new URLSearchParams(location.search).get("pick"));
  if (Number.isInteger(requestedPick) && requestedPick > 0) {
    await revealPick(requestedPick);
  }
}

document.addEventListener("DOMContentLoaded", init);
