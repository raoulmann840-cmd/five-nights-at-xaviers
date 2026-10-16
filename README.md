# Five Nights at Xavier's

A browser-based survival horror parody of *Five Nights at Freddy's 4*, built with HTML5 Canvas, CSS and vanilla JavaScript. It has no build step, no dependencies and no audio files: every sound is generated live with the Web Audio API.

You play **Raoul Mann**. Your job is to survive from **12 AM to 6 AM** in your bedroom while **Xavier**, **Steven Pivac** and **Zynovan Snusvac** come for you.

---

## Play locally

The game works if you open `index.html` directly. A local server is better, because then the photo color grading runs at full quality:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Testing flags: `?fast` makes each hour last 8 seconds. `?debug` shows the AI state.

## Deploy to Netlify

Pick one:

1. **Drag & drop:** go to <https://app.netlify.com/drop> and drop the whole project folder on the page.
2. **Connect GitHub:** in Netlify, choose *Add new site → Import from Git*, pick this repo and keep the defaults. `netlify.toml` already sets `publish = "."` with no build.

Each time you commit (for example, after adding a new photo), Netlify redeploys on its own.

---

## Adding your friends' photos

All photos are optional. Any missing file falls back to built-in vector animatronics. Photos you do add get an automatic horror color grade: desaturation, crushed blacks, a sickly tint, film grain, scratches, a heavy vignette and feathered edges.

```
assets/
├── player/
│   └── raoul.png          ← Raoul Mann headshot (menu + 6 AM screen)
└── villains/
    ├── xavier/
    │   ├── normal.png     ← headshot → becomes the animatronic's FACE
    │   ├── jumpscare.png  ← (optional) full-screen scream photo
    │   └── hallway.png    ← (optional) full-body photo seen in the hall
    ├── steven/            ← same three files
    └── zynovan/           ← same three files
```

**On GitHub, step by step:**

1. Open the repo and click into the folder you want, e.g. `assets/villains/xavier/`.
2. Click **Add file → Upload files** and drag your photo in.
3. Give it the exact lowercase name, e.g. `normal.png`. `.jpg`, `.jpeg` and `.webp` work too.
4. Click **Commit changes**. Once Netlify finishes redeploying, refresh the game.

**Photo tips**
- A front-facing headshot with the face centered and a roughly square crop works best for `normal.png`.
- For `jumpscare.png`, use the most unhinged open-mouth scream face you can get.
- Keep each photo under about 2 MB so it loads quickly.
- The in-game **Asset Guide** (main menu) lists every file the game found and every slot that is using a fallback.

---

## How to play

| Control | Action |
|---|---|
| `A` / `←` | Run to the **Left Door** |
| `D` / `→` | Run to the **Right Door** |
| `W` / `↑` | Check the **Closet** |
| `S` / `↓` | Turn around to the **Bed** (from the room), or go back |
| Hold `Mouse` / `F` / `Shift` | Flashlight (aim with the mouse). Battery is limited. |
| Hold `Space` / `Right-click` | Hold the door or closet shut |
| `Esc` · `H` · `M` | Pause · toggle hints · mute |

On touch screens, use the on-screen arrows plus the **LIGHT** and **HOLD** buttons.

### The Three
- **Steven Pivac (left hall).** He makes heavy footsteps. If he's down the hall, flash him and he backs off. If you hear **breathing at the door**, keep the light off and **hold the door** until he walks away.
- **Xavier (right hall + bed).** Same rules as Steven, but he whispers, he's faster and he gives up less easily. He also sends **Little Xaviers** onto your bed: turn around and flash them away. If three of them gather, Xavier himself rises behind the bed.
- **Zynovan Snusvac (closet).** A rattling snus tin means he's in there. Check the closet and hold it shut to push him back. If he's all the way out, hold it closed until the banging stops.

Stand at a door with the light **off** to *listen*. Sounds are panned left/right, so headphones help.

Nights 1–5 get harder each night. Beat Night 5 to unlock **Nightmare**.

---

## Project structure

```
index.html     – markup: canvas, HUD, menus
style.css      – layout, menus, scanlines / CRT flicker / vignette / screen shake
script.js      – asset loader + color grade, synth audio, scenes, villains, AI, game loop
netlify.toml   – static deploy config
assets/        – drop photos here (see above)
```

*Fan-made parody. Not affiliated with Scott Cawthon or Five Nights at Freddy's.*
