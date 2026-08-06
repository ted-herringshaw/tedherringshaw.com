// Pre-resolves every curated movie against TMDB and writes the static bundle
// the browser loads: public/movies/movies.json.
//
// Why this exists: the page used to do this work itself, in the browser, on
// every first visit — two TMDB calls per movie (a title+year search to find
// the id, then a details fetch) for ~1000 movies at concurrency 5. That's
// ~2000 round-trips, which measured out to 100-160s on a phone before the
// Spin button unlocked. The answer is identical for every visitor, so it's
// computed once here instead.
//
// Usage:
//   npm run refresh-movies            # reads the key from public/movies/config.js
//   TMDB_API_KEY=xxx npm run refresh-movies
//
// The generated JSON is committed to the repo on purpose: deploys stay
// deterministic, a TMDB outage can never fail a site build, and the diff
// shows exactly which movies changed. Regenerate when you edit movies.js or
// when streaming availability has drifted (the weekly GitHub Action in
// .github/workflows/refresh-movies.yml does the latter automatically).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOVIES_DIR = join(ROOT, "public", "movies");
const SOURCE_FILE = join(MOVIES_DIR, "movies.js");
const OUTPUT_FILE = join(MOVIES_DIR, "movies.json");
const BACKDROPS_FILE = join(ROOT, "src", "data", "movie-backdrops.json");

const REGION = "US";
const CONCURRENCY = 8;
const MAX_ATTEMPTS = 4;

// A title in movies.js that TMDB simply has no match for is a data problem in
// movies.js, not a transient one — it's reported but doesn't fail the run.
// This guards against the *other* case: enough calls failing that we'd commit
// a truncated catalog. Below this hit rate the run aborts and writes nothing.
const MIN_HIT_RATE = 0.97;

// Single source of truth for the streaming selector. `match` holds the
// provider_name values TMDB actually returns, which sometimes differ from the
// marketing name (Apple TV+ comes back as "Apple TV", Max as either "Max" or
// "HBO Max"). Order here defines the bit order of each movie's providerMask,
// and app.js builds its selector straight from the `services` array in the
// output — so this list is the only place these are defined.
const STREAMING_SERVICES = [
  { key: "netflix", label: "Netflix", match: ["Netflix"] },
  { key: "hulu", label: "Hulu", match: ["Hulu"] },
  { key: "max", label: "Max", match: ["Max", "HBO Max"] },
  { key: "disney", label: "Disney+", match: ["Disney Plus"] },
  { key: "prime", label: "Prime Video", match: ["Amazon Prime Video"] },
  { key: "appletv", label: "Apple TV+", match: ["Apple TV", "Apple TV Plus"] },
  { key: "peacock", label: "Peacock", match: ["Peacock Premium", "Peacock"] },
  {
    key: "paramount",
    label: "Paramount+",
    match: ["Paramount Plus Premium", "Paramount Plus Essential", "Paramount Plus"],
  },
];

// ---------- Setup ----------

function resolveApiKey() {
  if (process.env.TMDB_API_KEY) return process.env.TMDB_API_KEY;
  // Fall back to the key the page already ships, so a local run needs no setup.
  const config = readFileSync(join(MOVIES_DIR, "config.js"), "utf8");
  const found = config.match(/TMDB_API_KEY\s*=\s*"([^"]+)"/);
  if (!found) {
    throw new Error("No TMDB_API_KEY env var, and none found in public/movies/config.js");
  }
  return found[1];
}

const API_KEY = resolveApiKey();

// movies.js is a plain `const CURATED_MOVIES = [...]` script (it's hand-edited
// and was historically loaded by a <script> tag), so evaluating it is the
// least brittle way to read it — no parsing, and it stays valid as-is.
function readCuratedMovies() {
  const source = readFileSync(SOURCE_FILE, "utf8");
  const movies = new Function(`${source}; return CURATED_MOVIES;`)();
  if (!Array.isArray(movies) || movies.length === 0) {
    throw new Error("CURATED_MOVIES in movies.js is missing or empty");
  }
  return movies;
}

// ---------- TMDB ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries on rate limits and server errors so a transient blip doesn't turn
// into a movie missing from the committed bundle for a week. A 404 or other
// 4xx is permanent and thrown immediately.
async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) throw new Error(`HTTP ${res.status}`);
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(400 * 2 ** (attempt - 1));
  }
  throw lastError;
}

const tmdb = (path, params = {}) => {
  const qs = new URLSearchParams({ api_key: API_KEY, ...params });
  return fetchJson(`https://api.themoviedb.org/3${path}?${qs}`);
};

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// ---------- Enrichment ----------

// Returns { status: "ok", movie } | { status: "notFound" } | { status: "error", message }
async function enrichMovie(movie, genreIndexById, serviceIndexByProviderName) {
  try {
    // TMDB's search ranks by popularity, not exactness, so a common title can
    // land on the wrong film — searching "The Ring" (2002) returns Fellowship
    // of the Ring first. Pin those cases with an explicit tmdbId in movies.js.
    let id = movie.tmdbId;
    if (!id) {
      const search = await tmdb("/search/movie", {
        query: movie.title,
        year: String(movie.year),
      });
      const found = search.results?.[0];
      if (!found) return { status: "notFound" };
      id = found.id;
    }

    const details = await tmdb(`/movie/${id}`, {
      append_to_response: "watch/providers",
    });

    let genreMask = 0;
    for (const g of details.genres || []) {
      const bit = genreIndexById.get(g.id);
      if (bit !== undefined) genreMask |= 1 << bit;
    }

    let providerMask = 0;
    const flatrate = details["watch/providers"]?.results?.[REGION]?.flatrate || [];
    for (const p of flatrate) {
      const bit = serviceIndexByProviderName.get(p.provider_name);
      if (bit !== undefined) providerMask |= 1 << bit;
    }

    return {
      status: "ok",
      movie: {
        id,
        title: movie.title,
        year: movie.year,
        rtScore: movie.rtScore,
        runtime: details.runtime || null,
        genreMask,
        posterPath: details.poster_path || null,
        // Landscape still, used as the link-preview image when a pick is
        // shared. The poster can't do this job: preview cards are wide, so a
        // tall poster gets centre-cropped and the title art is sliced in half.
        backdropPath: details.backdrop_path || null,
        providerMask,
      },
    };
  } catch (err) {
    return { status: "error", message: err.message };
  }
}

// ---------- Main ----------

async function main() {
  const curated = readCuratedMovies();
  console.log(`Read ${curated.length} movies from public/movies/movies.js`);

  // TMDB's genre list is fetched rather than hardcoded so the bundle carries
  // every genre a movie might have — the result card prints all of them, even
  // ones the filter row doesn't offer (War, Western, History…). Sorted by id
  // for a stable bit order across runs.
  const genreList = (await tmdb("/genre/movie/list")).genres
    .slice()
    .sort((a, b) => a.id - b.id);
  const genreIndexById = new Map(genreList.map((g, i) => [g.id, i]));
  console.log(`Genre vocabulary: ${genreList.length} genres`);

  // Provider logo paths get baked in, which removes another blocking request
  // the page used to make before it could draw the streaming selector.
  const allProviders = (await tmdb("/watch/providers/movie", { watch_region: REGION })).results || [];
  const services = STREAMING_SERVICES.map((service) => {
    const found = allProviders.find((p) => service.match.includes(p.provider_name));
    if (!found) console.warn(`  ! no TMDB provider matched "${service.label}" — its icon will fall back to text`);
    return { key: service.key, label: service.label, logoPath: found?.logo_path || null };
  });
  const serviceIndexByProviderName = new Map(
    STREAMING_SERVICES.flatMap((s, i) => s.match.map((name) => [name, i]))
  );

  const startedAt = Date.now();
  let completed = 0;
  const results = await mapWithConcurrency(curated, CONCURRENCY, async (movie) => {
    const result = await enrichMovie(movie, genreIndexById, serviceIndexByProviderName);
    completed++;
    if (completed % 100 === 0 || completed === curated.length) {
      process.stdout.write(`  enriched ${completed}/${curated.length}\n`);
    }
    return { movie, result };
  });
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);

  const ok = results.filter((r) => r.result.status === "ok");
  const notFound = results.filter((r) => r.result.status === "notFound");
  const errored = results.filter((r) => r.result.status === "error");

  if (notFound.length > 0) {
    console.log(`\n${notFound.length} title(s) with no TMDB match — fix the title/year in movies.js:`);
    for (const r of notFound) console.log(`  - ${r.movie.title} (${r.movie.year})`);
  }
  if (errored.length > 0) {
    console.log(`\n${errored.length} title(s) failed after ${MAX_ATTEMPTS} attempts:`);
    for (const r of errored) console.log(`  - ${r.movie.title} (${r.movie.year}): ${r.result.message}`);
  }

  // Two rows resolving to the same TMDB id means either the same film is in
  // movies.js twice (it gets double the odds of being picked, and both rows
  // collapse to one share page) or a title matched the wrong film entirely.
  // Worth surfacing loudly — it's how the "The Ring" → Fellowship mismatch
  // was caught — but not worth failing a run over.
  const byTmdbId = new Map();
  for (const { movie, result } of ok) {
    const id = result.movie.id;
    if (!byTmdbId.has(id)) byTmdbId.set(id, []);
    byTmdbId.get(id).push(`${movie.title} (${movie.year})`);
  }
  const collisions = [...byTmdbId].filter(([, rows]) => rows.length > 1);
  if (collisions.length > 0) {
    console.log(`\n${collisions.length} TMDB id collision(s) — duplicate entry, or a wrong match:`);
    for (const [id, rows] of collisions) console.log(`  id ${id}: ${rows.join("  ==  ")}`);
    console.log("  Fix by removing the duplicate, or pin the right film with tmdbId in movies.js.");
  }

  const hitRate = ok.length / curated.length;
  if (hitRate < MIN_HIT_RATE) {
    throw new Error(
      `Only ${ok.length}/${curated.length} movies resolved (${(hitRate * 100).toFixed(1)}%, ` +
        `floor is ${(MIN_HIT_RATE * 100).toFixed(0)}%). Refusing to write a truncated catalog.`
    );
  }

  // Field order is emitted alongside the rows so app.js unpacks by looking up
  // names rather than trusting hardcoded indexes — adding a field here can't
  // silently shift the client's reads.
  // Deliberately excludes backdropPath: only the share-page build reads it, and
  // carrying ~995 more paths here would add ~20 KB brotli to every visitor's
  // first load for data the browser never touches. It goes to BACKDROPS_FILE.
  const fields = ["id", "title", "year", "rtScore", "runtime", "genreMask", "posterPath", "providerMask"];
  const bundle = {
    version: 1,
    generatedAt: new Date().toISOString(),
    region: REGION,
    genres: genreList.map((g) => g.name),
    services,
    fields,
    movies: ok.map(({ result }) => fields.map((f) => result.movie[f])),
  };

  writeFileSync(OUTPUT_FILE, `${JSON.stringify(bundle)}\n`);

  // Build-only companion, keyed by TMDB id. Lives under src/ rather than
  // public/ precisely so it is never served to a browser — the share pages
  // read it at build time to pick a link-preview image.
  const backdrops = Object.fromEntries(
    ok
      .filter(({ result }) => result.movie.backdropPath)
      .map(({ result }) => [result.movie.id, result.movie.backdropPath])
  );
  mkdirSync(dirname(BACKDROPS_FILE), { recursive: true });
  writeFileSync(BACKDROPS_FILE, `${JSON.stringify(backdrops, null, 0)}\n`);

  const bytes = Buffer.byteLength(JSON.stringify(bundle));
  const withoutBackdrop = ok.length - Object.keys(backdrops).length;
  console.log(
    `\nWrote public/movies/movies.json — ${ok.length} movies, ` +
      `${(bytes / 1024).toFixed(0)} KB raw, in ${elapsedSec}s`
  );
  console.log(
    `Wrote src/data/movie-backdrops.json — ${Object.keys(backdrops).length} preview images` +
      (withoutBackdrop > 0 ? ` (${withoutBackdrop} will fall back to the poster)` : "")
  );
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
