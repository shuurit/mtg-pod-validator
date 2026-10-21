# Season closing-ceremony video

A Hyperframes (via Kinocut) composition that turns a closed season's trophies,
decks and games into a ~110s MTG-themed recap video.

```bash
npm install
node build-season.mjs        # most recently closed season (or: node build-season.mjs 4)
npx hyperframes snapshot --at 4,40,95   # spot-check frames
npx hyperframes render -q high -o out/season-silent.mp4
python music.py out/music.wav           # score, cues timed from season-data.js
```

Then loudness-normalize the score (`ffmpeg -i out/music.wav -af loudnorm=I=-16:TP=-1.5 out/music-master.wav`)
and mux it onto the render with Kinocut's `video_add_audio`.

`build-season.mjs` runs read-only SELECTs against the live D1 database through
wrangler (needs `npx wrangler login`) and downloads commander art from Scryfall
into `assets/art/`, and copies each awarded trophy's emblem from the repo's
`emblems/` folder into `assets/emblems/`. Trophy names come from `ACHIEVEMENTS` in
`cloudflare-worker/relay.js`. The video's length follows the data, so set
`data-duration` on `#root` in `index.html` to match if the number of trophies
changes.

Scenes: intro → The Battlefield (season totals) → The Command Zone (every
commander played) → Battle Log (every game + wins) → one turn-phase per trophy
category (Upkeep → Cleanup) → The Hoard (trophy counts) → Final Judgment
(podium) → next-season outro.

The soundtrack is `music.py`: an original procedural lo-fi fantasy loop
(72 BPM, D minor; plucked lute arpeggios, pad, bass, soft beat, ocarina
melody) with harp glissandos into each scene and a bell on every emblem
reveal. Its scene timings mirror `index.html`, so change both together.

## Publishing a season's video to the app

The app's Closing Ceremony modal plays the video for any season listed in
`CEREMONY_VIDEOS` in `app.js`. The files live in the repo's `videos/` folder
and are served by GitHub Pages next to `emblems/`. To add a season:

```bash
# ~10 MB at 1080p; +faststart lets it start playing before it fully downloads
ffmpeg -i out/season-N-closing-ceremony.mp4 -c:v libx264 -preset slow -crf 26 -tune animation \
  -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart ../videos/season-N.mp4
# poster: a frame from the intro title card (not the podium, so it doesn't spoil the winner)
ffmpeg -ss 4.5 -i ../videos/season-N.mp4 -frames:v 1 -vf scale=1280:-2 -q:v 4 ../videos/season-N.jpg
```

Then add `N: { src: "videos/season-N.mp4", poster: "videos/season-N.jpg" }`
to `CEREMONY_VIDEOS` (keyed by the season's id), and bump `app.js?v=` in `index.html`.
