# WRECKPARK

Souped-up cars in one enormous concrete skatepark. Flips, barrel rolls, a
loop-the-loop, a corkscrew tower, and a demolition derby where the damage is
real — panels actually crumple where you get hit.

Runs in the browser. Your mates join with a 4-character code. Nothing to install
on their end.

---

## Getting it running

```bash
cd ~/wreckpark
npm install      # only needed the first time
npm start        # builds the game and starts the server
```

Then open **http://localhost:8080**.

That's it. `npm start` builds the client and serves both the game and the
multiplayer server on one port.

### While you're tinkering with it

```bash
npm run dev
```

Opens a hot-reloading client on **http://localhost:5173** with the game server
on 8080. Edit a file, the browser updates instantly.

---

## Playing with your friends

### Same house / same wifi

1. Run `npm start`. It prints something like:

   ```
   local     http://localhost:8080
   same wifi http://192.168.10.112:8080
   ```

2. Click **HOST GAME**. You get a room code like `K7QP`.
3. Send your mates the **link shown in the lobby** (it uses your wifi address,
   not `localhost`, so it actually works on their machines), or just tell them
   the code and have them type it into the **CODE** box.

Up to **8 players** per room.

### Friends somewhere else

```bash
brew install cloudflared    # once, free, no account
npm run share
```

That opens a public tunnel, starts the server already knowing its public
address, and prints the link to send:

```
  ====================================================
     SEND YOUR FRIENDS THIS LINK
     https://something-random.trycloudflare.com
  ====================================================
```

They click it and they're in — no wifi, no accounts, no install. The lobby
share link and the room code both work. Keep the window open; `Ctrl+C` stops
the game and closes the link.

> **Don't use ngrok's free tier for this.** It puts a browser warning page
> (`ERR_NGROK_6024`) in front of the game, so whoever you sent the link to just
> sees a blank-looking page and assumes it's broken. Cloudflare has no such
> page.

The lobby always tells you how far your link reaches — "works for anyone,
anywhere" or "same wifi only" — so you never send someone a link they can't
open.

---

## Controls

| Key | On the ground | In the air |
|---|---|---|
| `W` / `S` | Throttle / brake and reverse | Flip forwards / backwards |
| `A` / `D` | Steer | Barrel roll |
| Arrow keys | Drive (same as WASD) | **Gentle trim** — for lining a landing up |
| `Q` / `E` | — | Spin left / right |
| `SHIFT` | **BOOST** — works in reverse too | Boost (slightly weaker) |
| `SPACE` | Jump | **Flip-dash** — one per jump, aims where you're pointing |
| `OPT` / `CTRL` / `X` | Handbrake — hold it into a corner for big slides | — |
| `R` | Flip the car back over | — |
| `T` | Chat with the room | |
| `C` | Change camera (chase / close / bumper) | |
| `TAB` | Scoreboard | |
| `ESC` | Pause | |

The **arrow keys are the landing aid**. WASD throws the trick at full speed;
the arrows nudge the car at about a third of that rate, which is what you want
in the last half-second before you touch down.

> **Why not CMD for the handbrake?** The browser owns `CMD+W` (close tab) and
> `CMD+Q` (quit), and no web page is allowed to block them. Holding CMD and
> tapping throttle would shut the game down mid-corner. `OPT` sits right next
> to it and is safe.

The **flip-dash** is the important one. Jump, then hit `SPACE` again in mid-air
to lunge in whatever direction you're holding. It's how you get big air, how you
chain combos, and how you close the gap on someone in a derby.

---

## Modes

### SMASH DERBY

Three lives each. Ram people to wreck them. Last one rolling takes the round.

Damage is computed from how hard you actually hit — a Mauler at full boost will
end someone in one shot; a love-tap won't. Panels dent where they were struck
and the car handles worse as it gets wrecked.

### TRICK BATTLE

Three minutes, biggest score wins. Points bank **only when you land it** — bin
the landing and you lose the whole combo. Bumping someone mid-air makes them
bail, which is the "battle" part.

Chaining matters far more than any single trick. Different trick types stack a
multiplier, and landing again quickly keeps the chain alive.

**Trick Battle also works on your own.** Pick TRICK BATTLE and hit **SOLO TRICK
RUN** — a timed three-minute run against nobody but your own best score.

### SINGLE PLAYER vs BOTS

Pick SMASH DERBY, set **BOTS** to 1/3/5/7 and difficulty to easy/normal/hard,
then hit **BATTLE**. The bots drive the same cars with the same physics and the
same weapons you have — they chase, ram, shoot, drop countermeasures, try to
land on their wheels, and get themselves unstuck. Set BOTS to OFF for plain
free roam.

---

## Weapons

Every car carries one offensive and one defensive system, fixed to the car —
part of what makes each one feel different.

| Car | Weapon (`F`) | Countermeasure (`G`) |
|---|---|---|
| **RIPSAW** | **Rockets** — flat, fast, splash | **Oil slick** — anyone through it loses all grip |
| **HORNET** | **Gatling** — hoses rounds, chews armour close up | **Caltrops** — spikes that shred whatever follows |
| **MAULER** | **Mortar** — lobs over cover, enormous bang | **Wrecking ball** — chained ball you swing into people |
| **VOLT** | **Laser** — instant beam, drains fast | **Deflector** — refracting field, bounces damage for a few seconds |

Ammo reloads automatically when you run dry; countermeasures recharge one
charge at a time. The HUD shows both bottom-left.

Damage authority works the same as ramming: the shooter broadcasts *that it
fired*, everyone simulates the shot, and each machine decides only whether it
was hit. Nobody can assert damage onto anyone else's car.

---

## Personal bests and replays

Every solo trick run is recorded. Beat your best and it's saved, along with the
replay.

- Your best score sits on the main menu under **PERSONAL BEST**, with a
  **WATCH** button.
- After a run, **WATCH REPLAY** replays it immediately.
- During a replay: `SPACE` restarts, `C` changes camera, `ESC` exits.

Trick pop-ups replay at the moment you landed them, so you can see exactly where
the run was won.

Replays are stored compactly — a full three-minute run is about 80 KB — so they
live in your browser's local storage alongside your unlocks. Online trick
battles count too: beat your best there and it's saved the same way.

Want shorter runs? Add `?round=60` to the URL for one-minute runs.

---

## The park

One giant bowl, 210 m across, with a 20 m banked quarter-pipe running all the
way around the rim that you can carve and launch off.

- **Loop-the-loop** — hit it at about 120 km/h on the boost and you'll get all
  the way round. Too slow and you'll drop off the top; way too fast and you'll
  launch off it.
- **Corkscrew tower** — spirals 17 m up to a launch ramp off the top. There's an
  OVERDRIVE pickup on the platform as a reward for getting up there.
- **Mega gap** — a 6.7 m kicker and a landing ramp 34 m away.
- **Halfpipe**, **vert wall and spine**, **drop-in tower** (15 m), **funbox**,
  and a row of **rollers** to pump over.
- Barrels, crates and cones everywhere, all smashable.
- **Pickups**: repair (green), boost (cyan), overdrive (pink — double ram damage).

---

## The four cars

| | Class | The idea |
|---|---|---|
| **RIPSAW** | Muscle | Balanced. Start here. |
| **HORNET** | Stunt buggy | Silly air control, folds like a can. Best for tricks. |
| **MAULER** | Monster truck | 2.6 tonnes. Slow to wind up, drives *through* people. |
| **VOLT** | Hyper EV | Fastest thing here, huge boost, hates being hit. |

---

## Garage

Win rounds, wreck people and land tricks to earn **SCRAP**. Spend it on paint,
finishes (including chrome, neon and gold), liveries, spoilers, roof kit,
wheels, bumpers, underglow and boost-trail colours.

**Everything in the garage is cosmetic.** Nobody can buy an advantage over
anyone else — deliberately, because this is a game for playing with friends.

---

## How it works

- **Rendering** — three.js. Every car, ramp and prop is generated from code at
  startup. There are no model files, no textures and no downloads.
- **Physics** — Rapier (Rust, compiled to WebAssembly) with its raycast vehicle
  controller: real suspension, per-wheel grip, and impact impulses.
- **Damage** — each car's body is one welded mesh, so impacts push its vertices
  in and the dents stay continuous across panels instead of tearing at seams.
- **Networking** — each player simulates their own car and broadcasts its
  position 20 times a second; the server relays those and owns match state and
  the scoreboard. That means zero input lag on your own car, and no arguments
  about the score. Other players' cars are real physics bodies, so ramming them
  shoves them properly before they settle back.
- **Audio** — synthesised at runtime with the Web Audio API. Engine note tracks
  RPM, tyres screech under slip, impacts scale with force. No audio files.

### Layout of the code

```
src/game/     arena, vehicle, tricks, damage, cars, fx, replay
src/net/      protocol (shared with the server), client
src/core/     input, audio, storage, maths
src/ui/       menu, HUD, garage, styles
server/       room + match server, also serves the built client
tools/        the test suite
```

---

## Tests

```bash
npm test           # everything
npm run test:unit  # headless physics, no browser (fast)
```

| Suite | What it covers |
|---|---|
| `charcheck` | No wrong-script homoglyphs in source |
| `arenatest` | Park geometry builds, features don't overlap, nothing falls through the floor |
| `simtest` | Ride height, suspension damping, acceleration, steering direction, jumps, air control, flip-dash, self-righting, damage, and getting round the loop |
| `tricktest` | Flips, rolls, spins, combos, banking, bailing, and that ordinary driving scores nothing |
| `browsertest` | Boots real Chrome, drives the game, checks frame rate and console errors |
| `nettest` | Two real browsers in one room, replicating each other's driving |
| `roundtest` | A full round through to results and the scrap payout |
| `replaytest` | Solo trick run, personal best, and replaying it back |
| `battletest` | Bots spawn and fight, weapons fire and reload, countermeasures deploy, damage lands |

The physics tests run headless in Node against the same code the browser uses,
which is why the tuning numbers in `carTypes.js` can be trusted.

---

## If something goes wrong

**"The client has not been built yet"** — run `npm run build`, or use
`npm start` which does it for you.

**Mates can't connect on your wifi** — use the `same wifi` address the server
prints, not `localhost`. If it still fails, macOS may be firewalling Node:
System Settings → Network → Firewall → allow incoming connections for Node.

**A friend elsewhere says it won't load** — check what the lobby says under the
share link. If it says "same wifi only" they physically can't reach you; stop
the server and use `npm run share` instead. If you used ngrok, they're most
likely stuck on its warning page — use `npm run share` (Cloudflare) instead.

**It's running slowly** — click **QUALITY** on the main menu to drop to medium
or low. Low turns off shadows and bloom and halves the particle budget.

**Nothing happens when you press keys** — click on the game window first so it
has keyboard focus.

**The interface is tiny / enormous** — it auto-scales to your screen, and
**UI SIZE** on the main menu applies your own multiplier on top (85% up to
175%). The button shows both your setting and the actual scale being used.

**Want to wipe your progress** — open the browser console and run
`localStorage.clear()`, then reload.

---

## Tuning it yourself

Car handling all lives in `src/game/carTypes.js` — mass, engine force, grip,
suspension, air control, armour, boost. Change a number, run `npm run test:sim`,
and you'll see immediately what it did to acceleration, ride height and the
loop.

Park layout is in `src/game/arena.js`. Move a feature and `npm run test:arena`
will tell you if it now overlaps something else; `npm run spawns` re-checks that
all eight spawn points are still clear with a drivable runway.
