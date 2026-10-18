# Five Nights at Xavier's

A browser survival horror parody of *Five Nights at Freddy's 4*, set in a dark classroom. You play **Raoul Mann**, locked in after hours, and must survive from **12 AM to 6 AM** while **Xavier**, **Steven Pivac** and **Zynovan Snusvac** come for you.

Built with **PixiJS 7** (the WebGL engine and shaders) and **Three.js r160** (an offline 3D pre-renderer). It's a static site with no build step. Both engines are vendored in `/lib`, so it doesn't depend on a CDN.

---

## How the "pre-rendered" look works

FNAF 4's art consists of pre-rendered 3D images. This game builds that pipeline in the browser:

1. **3D scene.** Three.js builds the classroom, the hallway, the storage closet and the three villains (bloodied human bodies wearing your friends' faces) as real geometry. The surfaces use procedurally generated textures: vinyl floor tiles, painted cinder block, acoustic ceiling tiles, chalkboards, rusted and dented lockers, wood grain and matted fur, each with a bump map.
2. **Bake.** While the loading screen shows, every camera view and every villain pose is rendered offline with soft shadows into G-buffers: albedo, view-space normals, and depth plus emissive.
3. **Deferred lighting.** PixiJS shows those layers through a custom GLSL shader. The flashlight is a narrow cone of light with per-pixel N·L, distance falloff, a hot spot, specular highlights and haze in the beam. A deep red emergency light also lights the room. Everything outside the beam stays pitch black.
4. **Post-processing.** Film grain, CRT scanlines, barrel distortion, chromatic aberration (boosted during jumpscares), vignette and screen shake.
5. **Jumpscares.** Each one is a multi-frame 3D camera rush at the villain's face as the jaw opens. It plays with rapid red and white flicker, heavy shake, and `assets/audio/scream.wav` pushed through a distortion stage.

**About the visuals:** everything you see is generated procedurally from code. That gets the lighting, contrast and mood of FNAF 4, but not the hand-sculpted detail of its artist-made models. For that last step, render your own scenes and characters in Blender or Cinema 4D and drop them into `/assets/` (see below). The same lighting pipeline uses them.

---

## Run locally

```bash
python3 -m http.server 8000      # then open http://localhost:8000
```

Use a local server rather than opening `index.html` directly. Browsers block reading pixels from photos loaded over `file://`, so photo blending would be skipped.

URL flags: `?fast` (8-second hours), `?debug` (AI overlay), `?quality=low|medium|high` (bake resolution 960 / 1280 / 1920; it is picked automatically by default).

## Deploy to Netlify

- **Drag and drop:** drop the project folder on <https://app.netlify.com/drop>.
- **From GitHub:** choose *Add new site → Import from Git* and pick this repo. `netlify.toml` already sets `publish = "."` with no build.

Each commit redeploys automatically.

---

## Adding your friends' photos

Every file is optional. Anything missing falls back to the built-in 3D renders.

```
assets/
├── player/raoul.png                     ← Raoul Mann headshot (6 AM screen)
├── villains/
│   ├── (any villain) gameover.png  poster.png
│   ├── xavier/   face.png  hallway_far.png  hallway_near.png  podium.png
│   │             jumpscare_stage_1.png … jumpscare_stage_12.png
│   ├── steven/   face.png  hallway_far.png  hallway_near.png  jumpscare_stage_*.png
│   └── zynovan/  face.png  locker_stage_1.png … locker_stage_4.png  jumpscare_stage_*.png
├── classroom/    center.png door_left.png door_right.png locker.png desks.png
│                 (+ _normal / _depth maps, + door_left_closed.png etc.)
└── audio/        scream.wav (included) + optional overrides
```

- **`face.png` is the important one.** It's wrapped onto the animatronic's 3D skull before baking, so the face is shaded, shadowed and lit by your flashlight together with the robot body, the mechanical jaw and the teeth. Use a front-facing headshot with the face centred.
- **Sprites** (`hallway_far.png` and similar) are colour-graded and given a normal map estimated from brightness, so the beam rakes across them.
- **Jumpscare frames** play in order, from stage 1 (far away) to the last frame (right in your face). If they exist they replace the built-in 3D jumpscare; delete them to get the 3D version back.
- **`gameover.png`** appears on the game-over screen; **`poster.png`** is hung on the classroom wall as a framed poster.

**Steven Pivac has a real photo in place:** `face.jpg` (pasted on the bunny animatronic), an 8-frame zoom jumpscare, `gameover.jpg` and `poster.jpg` (Hall Monitor).

**Zynovan (Donny) has real photos in place:** `face.jpg` (locker stages 1–2 and the glimpse through the locker gap), `face_2.jpg` (stages 3–4), a jumpscare that alternates between both, `gameover.jpg` and `poster.jpg`. Any villain can take a `face_2.png`.

**Xavier already has real photos in place:** `face.jpg` (the visor-glasses photo — it replaces his whole face: no 3D teeth, jaw or eyes; the Little Xaviers wear it too), `jumpscare_stage_1–8.jpg` (zoom into the glasses photo), `gameover.jpg` and `poster.jpg`.

**Uploading on GitHub:**
1. Open the folder, for example `assets/villains/xavier/`.
2. Choose **Add file → Upload files** and drag the image in.
3. Rename it exactly as listed above, in lowercase. `.png`, `.jpg`, `.jpeg` and `.webp` all work.
4. Commit. Netlify redeploys; refresh the game.

The in-game **Asset Guide** lists every file it found and which slots are using built-in renders. Each assets folder also has its own README.

---

## How to play

| Control | Action |
|---|---|
| `A` / `←` | Run to the **Hall Door** (classroom door to the hallway) |
| `D` / `→` | Run to the **Storage Door** (dark storage closet) |
| `W` / `↑` | Check the **Supply Locker** |
| `S` / `↓` | **Turn around** to the desks and the teacher's podium, or go back |
| Hold `Mouse` / `F` / `Shift` | Flashlight beam (aim with the mouse). The battery is limited. |
| Hold `Space` / `Right-click` | Hold a door or the locker shut |
| `Esc` · `H` · `M` | Pause · control hints · mute |

- **Steven Pivac (hallway).** Footsteps echo down the corridor. If he's down the hall, hit him with the beam. If you hear breathing right outside the door, keep the light **off** and hold the door until he leaves.
- **Xavier (storage closet and desks).** You'll hear boxes shifting and whispering. He follows Steven's rules but gives up less easily. Little Xaviers climb onto the desks behind you: flash them away before three gather, or Xavier rises behind the podium.
- **Zynovan Snusvac (supply locker).** You'll hear metal creaks, the latch clicking and a snus tin rattling. Hold the locker shut. If he's fully out, keep holding until the banging stops.

**There are no on-screen warnings — listening is how you survive.** The audio is 3D (HRTF) and follows the direction you're facing. Closed doors muffle sound, and the hallway echoes. Wear headphones.

---

## Project layout

```
index.html    – page shell, HUD and menus (DOM)
style.css     – UI styling (all horror rendering happens in WebGL)
script.js     – textures, 3D world, animatronics, baker, lighting shaders, audio, AI, game loop
lib/          – vendored pixi.js 7.4.2 + three.js r160 (MIT licences included)
netlify.toml  – static deploy config
assets/       – your photos, renders and sounds
```

*Fan-made parody. Not affiliated with Scott Cawthon or Five Nights at Freddy's.*
