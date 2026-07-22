/**
 * Pitchfork Selects — cover archive fetcher
 * Runs weekly (GitHub Actions). Zero dependencies, Node 20+.
 *
 * 1. Fetches the public Apple Music playlist page
 * 2. Extracts every track's album + artwork from the embedded JSON
 * 3. Diffs against data/albums.json — new albums get tagged with the ISO week
 * 4. Optionally enriches design / art-direction credits via the Discogs API
 *    (set DISCOGS_TOKEN as a repo secret; skipped silently if absent)
 */

const PLAYLIST_URL =
  "https://music.apple.com/us/playlist/pitchfork-selects/pl.9107845577c24fe3be7193c55d7864b0";
const DATA_PATH = new URL("../data/albums.json", import.meta.url);
const ARTWORK_SIZE = 2000; // px — mzstatic serves any size via the URL template
const CREDIT_RETRY_DAYS = 60; // keep retrying Discogs for young albums missing credits
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || "";

import { readFile, writeFile } from "node:fs/promises";

/* ---------- helpers ---------- */

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*[\(\[].*?[\)\]]\s*/g, " ") // strip "(Deluxe)" etc.
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const albumKey = (artist, album) => `${norm(artist)}::${norm(album)}`;

const isoWeek = (d = new Date()) => {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const artworkFromTemplate = (tpl, size = ARTWORK_SIZE) =>
  tpl
    .replace("{w}", size)
    .replace("{h}", size)
    .replace("{c}", "bb")
    .replace("{f}", "jpg");

/* ---------- 1. fetch + parse the playlist page ---------- */

async function fetchPlaylistAlbums() {
  const res = await fetch(PLAYLIST_URL, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`Playlist page returned HTTP ${res.status}`);
  const html = await res.text();

  const blobs = [];
  const scriptRe =
    /<script[^>]*type="(?:application\/json|application\/ld\+json)"[^>]*>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(scriptRe)) {
    try {
      blobs.push(JSON.parse(m[1]));
    } catch {
      /* non-JSON script body — ignore */
    }
  }
  if (!blobs.length) {
    throw new Error(
      "No embedded JSON found — Apple may have changed the page structure. Parser needs an update."
    );
  }

  // Recursively collect anything that looks like a track: has artistName + artwork template.
  const found = new Map();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);

    const a = node.attributes || node;
    const artist = a.artistName;
    const artUrl = a.artwork?.url || a.artwork?.dictionary?.url;
    if (typeof artist === "string" && typeof artUrl === "string" && artUrl.includes("{w}")) {
      const album = a.albumName || a.collectionName || a.name || "";
      const track = a.albumName ? a.name : "";
      const key = albumKey(artist, album || track || artUrl);
      if (!found.has(key)) {
        found.set(key, {
          key,
          artist,
          album: album || track,
          cover: artworkFromTemplate(artUrl),
          coverTemplate: artUrl,
          appleUrl: a.url || node.href || null,
          releaseDate: a.releaseDate || null,
          tracks: [],
        });
      }
      if (track) {
        const entry = found.get(key);
        if (!entry.tracks.includes(track)) entry.tracks.push(track);
      }
    }
    for (const v of Object.values(node)) visit(v);
  };
  blobs.forEach(visit);

  if (!found.size) {
    throw new Error(
      "Embedded JSON parsed but no tracks recognized — schema likely changed. Parser needs an update."
    );
  }
  return [...found.values()];
}

/* ---------- 2. Discogs credit enrichment (optional) ---------- */

const CREDIT_ROLES = {
  design: /design|graphics|layout|sleeve/i,
  artDirection: /art direction|creative direction/i,
  photography: /photograph/i,
  illustration: /illustration|artwork by|painting|drawing/i,
};

async function discogs(path, params = {}) {
  const url = new URL(`https://api.discogs.com${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: {
      "user-agent": "PitchforkCoversArchive/1.0 (personal, non-commercial)",
      authorization: `Discogs token=${DISCOGS_TOKEN}`,
    },
  });
  await sleep(1200); // authed rate limit: 60 req/min — stay well under
  if (res.status === 429) {
    await sleep(10000);
    return discogs(path, params);
  }
  if (!res.ok) return null;
  return res.json();
}

async function enrichCredits(album) {
  const search = await discogs("/database/search", {
    artist: album.artist,
    release_title: album.album,
    type: "release",
    per_page: "5",
  });
  const hit = search?.results?.[0];
  if (!hit?.id) return { checked: true };

  const release = await discogs(`/releases/${hit.id}`);
  if (!release) return { checked: true };

  const credits = {};
  for (const person of release.extraartists || []) {
    for (const [field, re] of Object.entries(CREDIT_ROLES)) {
      if (re.test(person.role || "")) {
        credits[field] = credits[field] || [];
        if (!credits[field].includes(person.name)) credits[field].push(person.name);
      }
    }
  }
  return {
    checked: true,
    credits: Object.keys(credits).length ? credits : null,
    label: release.labels?.[0]?.name || null,
    year: release.year || null,
    discogsUrl: release.uri || null,
  };
}

/* ---------- 3. main ---------- */

const now = new Date();
const week = isoWeek(now);

let store = { meta: {}, albums: [] };
try {
  store = JSON.parse(await readFile(DATA_PATH, "utf8"));
} catch {
  console.log("No existing data/albums.json — starting a fresh archive.");
}

const byKey = new Map(store.albums.map((a) => [a.key, a]));
const live = await fetchPlaylistAlbums();
console.log(`Playlist page parsed: ${live.length} unique albums currently listed.`);

let added = 0;
for (const album of live) {
  const existing = byKey.get(album.key);
  if (existing) {
    existing.inPlaylist = true;
    existing.lastSeen = now.toISOString().slice(0, 10);
    existing.tracks = [...new Set([...(existing.tracks || []), ...album.tracks])];
  } else {
    byKey.set(album.key, {
      ...album,
      weekAdded: week,
      firstSeen: now.toISOString().slice(0, 10),
      lastSeen: now.toISOString().slice(0, 10),
      inPlaylist: true,
      creditsChecked: false,
    });
    added++;
  }
}
// Albums that left the playlist stay in the archive, flagged.
for (const a of byKey.values()) {
  if (!live.find((l) => l.key === a.key)) a.inPlaylist = false;
}
console.log(`New this week: ${added} album${added === 1 ? "" : "s"} (tagged ${week}).`);

/* Discogs pass — new albums + young albums still missing credits */
if (DISCOGS_TOKEN) {
  const cutoff = new Date(now - CREDIT_RETRY_DAYS * 86400000).toISOString().slice(0, 10);
  const queue = [...byKey.values()].filter(
    (a) => !a.credits && (!a.creditsChecked || a.firstSeen >= cutoff)
  );
  console.log(`Discogs enrichment: checking ${queue.length} albums…`);
  for (const a of queue) {
    try {
      const info = await enrichCredits(a);
      a.creditsChecked = true;
      if (info.credits) a.credits = info.credits;
      if (info.label) a.label = a.label || info.label;
      if (info.year) a.year = a.year || info.year;
      if (info.discogsUrl) a.discogsUrl = info.discogsUrl;
      console.log(
        `  ${a.artist} — ${a.album}: ${info.credits ? "credits found" : "no credits yet"}`
      );
    } catch (e) {
      console.warn(`  ${a.artist} — ${a.album}: enrichment failed (${e.message})`);
    }
  }
} else {
  console.log("DISCOGS_TOKEN not set — skipping credit enrichment.");
}

/* Sort newest week first, then by artist within a week */
const albums = [...byKey.values()].sort(
  (x, y) => y.weekAdded.localeCompare(x.weekAdded) || x.artist.localeCompare(y.artist)
);

store = {
  meta: {
    source: PLAYLIST_URL,
    lastRun: now.toISOString(),
    lastWeek: week,
    totalAlbums: albums.length,
  },
  albums,
};

await writeFile(DATA_PATH, JSON.stringify(store, null, 2));
console.log(`Archive written: ${albums.length} albums total.`);
