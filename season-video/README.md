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
