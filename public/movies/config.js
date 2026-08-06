// TMDB (The Movie Database) API key — free tier. Genre, runtime, poster, and
// streaming availability are all resolved ahead of time into movies.json by
// scripts/build-movie-data.mjs, so the only thing the browser still uses this
// for is fetching one movie's blurb and trailer after a spin.
//
// The streaming region lives in that build script now, not here.
const TMDB_API_KEY = "4e344fc16a2a1591c1087685f099ad2f";
