# pod3d — the 3D table on the Pod tab

The Set Up Pod tab draws its table, thrones and spellfire orbs live in WebGL.
The models are built and baked in **Blender**; **three.js** only draws them,
so thrones can slide and swivel, the table can turn to any seat, and every orb
can change state at any seat count (1–8) without a pre-rendered frame for each
combination. `app.js` (`initPod3D`, `syncPod3DSeats`, `syncPod3DSigil`) mirrors
the pod's state into it; the CSS table in `style.css` stays as the fallback
(no WebGL, `?pod3d=0`, a lost context, or a failed load).

It loads lazily on the first visit to the Pod tab (~3 MB: the bundle plus
three models), never at sign-in.

| File | What it is |
|---|---|
| `pod3d.js` | The built runtime: `src/pod3d.src.js` + three.js, bundled and minified. Don't edit. |
| `pod-table.glb` | Table: oak top with the scrying well, gold inlay, gems, six legs. |
| `pod-spire.glb`, `pod-crest.glb` | The two throne carvings, instanced per seat. |
| `src/pod3d.src.js` | Scene, seat tweens, orb/flame/ember shaders, sigil canvas, nameplate anchors. |
| `blender/make_pod.py` | Builds and exports the three `.glb` files. |

## Rebuilding the models

Needs Blender 4.x (headless) and its bundled Python's numpy:

```bash
cd pod3d/blender
for p in table spire crest; do blender -b -P make_pod.py -- $p; done
mv pod-*.glb .. && rm -f *_wood.jpg *.blend1
```

Wood grain × ambient occlusion is baked into one texture per model by hand in
the script (Cycles' own shader bake returns black in the apt build). The bake
has no light direction on purpose: thrones swivel and the table spins, so
direction-dependent light would turn with them. Gold, leather and gems are
flat PBR materials lit live.

## Rebuilding the runtime

```bash
npm i three@0.170.0 esbuild      # anywhere outside the repo
npx esbuild pod3d/src/pod3d.src.js --bundle --minify --format=esm \
  --target=es2020 --legal-comments=inline --outfile=pod3d/pod3d.js
```

Then bump `POD3D_VERSION` in `app.js`: it cache-busts the bundle and the
models. three.js is MIT licensed; its `@license` notice is kept inline in the bundle (`--legal-comments=inline`).
