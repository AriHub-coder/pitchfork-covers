# Pitchfork Selects — Cover Archive

A self-updating archive of album covers from Apple Music's [Pitchfork Selects](https://music.apple.com/us/playlist/pitchfork-selects/pl.9107845577c24fe3be7193c55d7864b0) playlist (refreshed by Pitchfork every Monday).

Every Monday a GitHub Action scrapes the public playlist page, extracts each album's 2000×2000 cover from Apple's CDN, tags new albums with the ISO week they appeared, and enriches design / art-direction / photography credits from Discogs when available. A static viewer (`index.html`) presents one cover at a time — arrow navigation, registrar-style metadata, and a week-grouped archive overlay.

## Setup (once, ~5 minutes)

1. **Create a GitHub repo** and push these files.
2. **Enable GitHub Pages**: Settings → Pages → Source: *Deploy from a branch* → `main` / root.
3. **Optional but recommended — Discogs credits**: create a free personal access token at discogs.com → Settings → Developers, then add it as a repo secret named `DISCOGS_TOKEN` (Settings → Secrets and variables → Actions). Without it, the archive still works — covers and artist data only, no design credits.
4. **Seed the archive**: Actions tab → *Weekly cover archive update* → *Run workflow*. This does the first scrape immediately; after that it runs itself every Monday at 12:30 UTC.

Your viewer lives at `https://<username>.github.io/<repo>/`.

## How it behaves

- Albums that leave the playlist **stay in the archive** (flagged `inPlaylist: false`) — the collection only grows.
- Albums missing credits are **re-checked against Discogs for 60 days** after first appearing, since credits are often documented weeks after release.
- Covers are hotlinked from Apple's `mzstatic` CDN (content-addressed URLs, long-lived). The `{w}x{h}` template is stored per album, so any resolution can be derived later.
- If Apple changes the page structure, the script **fails loudly** — the Action goes red and GitHub emails you, rather than silently serving stale data.

## Viewer controls

`←` / `→` or on-screen arrows · swipe on mobile · **Archive** opens the week-grouped index · URLs deep-link to a cover via `#n`.
