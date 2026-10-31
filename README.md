# Ricochet Rumble

A two-player toy-tank duel for the big screen, with **phones as controllers**: any phone over Wi-Fi by scanning a QR code, or Android phones over Bluetooth with the Ricochet Pad app.

![Ricochet Rumble gameplay](docs/screenshot.jpg)

Two tanks face off in a tabletop diorama arena.
Shells ricochet off the blocks, one hit destroys a tank, and the last tank rolling wins the round.
Lay mines to clear crates or ambush your opponent, and watch out for your own bouncing shells.

The project has two parts:

| Part | What it is | Where |
| --- | --- | --- |
| **The game** | Runs in Chrome or Edge on your computer. | [`game/`](game) |
| **Wi-Fi controller** | A web page the computer serves to phones on the same network. Works on iPhones and Android phones with nothing to install. | [`game/pad/`](game/pad) |
| **Ricochet Pad** | Android app that connects over Bluetooth instead, for when there's no usable Wi-Fi. | [`controller-android/`](controller-android) |

Either player can also use a keyboard and mouse, the arrow keys, or a USB/Bluetooth gamepad.

---

## What you need

- **A computer** running **Google Chrome or Microsoft Edge** (Windows 10/11, macOS or Linux).
- **One or two phones**, connected one of two ways:
  - **Wi-Fi (any phone):** the phones and the computer must be on the same Wi-Fi network. It doesn't need internet access. Nothing to install.
  - **Bluetooth (Android only):** the phone needs the Ricochet Pad app (Android 8.0 or newer), and the computer needs Bluetooth. Linux needs one browser flag (see [Troubleshooting](#troubleshooting)).

## 1. (Bluetooth only) Install the Android app on each phone

Skip this if everyone is joining over Wi-Fi.

**Option A: download it on the phone (easiest).**

1. On the phone, open Chrome and sign in at [github.com](https://github.com). The repository is private, so the link only works when you're signed in.
2. Open **https://github.com/trout1758-cpu/Wii-Tanks/releases/download/controller-latest/RicochetPad.apk**.
   GitHub rebuilds this file every time the app changes, so the same link always gets the newest version.
3. Open the downloaded file.
   The first time, Android asks you to allow Chrome to install apps; turn that on.
   If Play Protect warns about an unknown app, tap **More details → Install anyway**.

To update later, open the same link again and install over the old version; your settings are kept.
Every build is signed with the same development key (`controller-android/app/ricochetpad-dev.keystore`), which is what lets updates install over each other.

**Option B: build it yourself.**
Open the `controller-android` folder in Android Studio and press **Run** with your phone plugged in (USB debugging on).
From the command line, run `./gradlew assembleRelease`; the APK lands in `app/build/outputs/apk/release/`.

The first time the app opens, it asks for the **Nearby devices** (Bluetooth) permission.
Allow it.

## 2. Start the game on the computer

| System | How |
| --- | --- |
| Windows | Double-click **`start-game.bat`**. |
| macOS / Linux | Run **`./start-game.sh`** (needs `python3`). |

Each script starts a small local server and opens **http://localhost:8080** in Chrome or Edge.
Keep the script's window open while you play.
The same server hands the Wi-Fi controller to phones on your network; nothing goes over the internet.

The first time on Windows, a firewall window asks whether to allow access.
Click **Allow** (if there are checkboxes, tick the one for your type of network), or phones won't be able to connect.
If the Wi-Fi server can't start for any reason, the script says so and starts in local-only mode, where the Android app, keyboards and gamepads still work.

> Why not just open `index.html`? Wi-Fi phones need the local server, and browsers only allow Bluetooth on secure pages: `http://localhost` counts as one, but a local file doesn't.
> Keyboard and gamepad play also work if you open the file directly.

## 3. Connect the phones

### Over Wi-Fi (any phone)

1. Make sure the phone is on the **same Wi-Fi network** as the computer.
2. In the game, click **Play**, then **Phone · scan QR code** on a player card.
3. Point the phone's camera at the QR code and open the link.
   The controller opens in the phone's browser and the pill turns into **PLAYER 1** (or 2).
4. Turn the phone sideways.

On Android, the first tap makes it full screen.
On iPhone, Safari can't hide its bars for a web page; for a full-screen controller, tap **Share → Add to Home Screen** and open it from there.
If the phone drops off the Wi-Fi, the game pauses and the phone reconnects to the same tank by itself when the network comes back.

### Over Bluetooth (Android app)

1. Open **Ricochet Pad** on the phone.
   The top-left pill says **WAITING FOR GAME**, and the screen shows the name to look for (your phone's Bluetooth name).
2. In the game, click **Play**, then click **Android app** on the Player 1 card.
3. Chrome opens a Bluetooth list.
   Pick your phone and click **Pair** / **Connect**.
4. The phone's pill turns into **PLAYER 1** in that tank's colour, and it buzzes.
5. Repeat on the Player 2 card with the second phone, or pick another controller type.
6. Press **fire** on both controllers to ready up (tap the right half of the phone screen), or click **Start match**.

Try the sticks in the lobby: the tank picture on your card follows your phone, so you can check it works before the match starts.

---

## Controls

### Phone (Wi-Fi controller or Ricochet Pad)

Both look and work the same.

| Control | Action |
| --- | --- |
| **Left half**: drag | Drive. The tank turns toward the stick direction and reverses when that's quicker. |
| **Right half**: drag | Aim the turret. A dotted guide appears on the TV. |
| **Right half**: let go | Fire. Slide back to the centre before letting go to cancel. |
| **Right half**: quick tap | Fire wherever the turret already points. |
| **MINE** button | Drop a mine. |
| **Pause** button (top bar) | Pause or resume. |
| Settings button (top bar) | Turn fire-on-release, vibration or left-handed layout on or off. |

The phone vibrates when you fire, lay a mine, get hit, score a hit, or a mine blows up nearby.
iPhones don't let web pages vibrate, so the Wi-Fi controller on an iPhone is silent; everything else works.
It also shows the score, your remaining shells and mines, and the game state.

### Keyboard, mouse and gamepad

| Scheme | Drive | Aim | Fire | Mine | Pause |
| --- | --- | --- | --- | --- | --- |
| Keys + mouse | `WASD` | mouse | left click / `F` | `Space` / right click / `E` | `Esc` |
| Arrow keys | arrows | `,` `.` rotate turret | `/` / `Enter` | `Right Shift` / `'` | `Esc` |
| Gamepad | left stick | right stick | RT / RB / A | LT / LB / B | Start |

To use a gamepad, click **Gamepad** on a player card and press any button on the pad.

---

## Rules and mechanics

- **One hit destroys a tank.** Last tank standing wins the round. If both go down within a moment of each other, the round is a draw.
- **Shells ricochet.** They bounce off blocks and walls, and they can destroy the tank that fired them.
- **Limited ammo in the air.** You can only have a few shells flying at once. A new one is available as soon as one disappears.
- **Shells collide.** Two shells that meet destroy each other, so you can shoot an incoming shell out of the air.
- **Mines.** You can have two out at a time. A mine arms after a moment, blinks faster as its fuse runs down, and explodes after 10 seconds. It goes off early if the enemy drives close or anyone shoots it. Blasts destroy tanks, crates and shells in range, and set off other mines.
- **Crates** block tanks and shells, but a mine blast clears them.
- **Pits and ponds** stop tanks, but shells fly straight over them.
- First to 3, 5 or 7 round wins takes the match.

### Tuning

All numbers live in [`game/js/config.js`](game/js/config.js). Distances are in arena tiles; the arena is 22 × 13 tiles.

| | Value |
| --- | --- |
| Tank speed | 2.4 tiles/s; hull turns ~300°/s; turret ~800°/s |
| Fire cooldown | 0.16 s |
| Classic shells | 5.6 tiles/s · 1 bounce · 5 in the air |
| Rubber shells | 4.4 tiles/s · 3 bounces · 4 in the air |
| Rocket shells | 9.6 tiles/s · 1 bounce · 2 in the air |
| Mines | 2 per tank · arms in 0.8 s · 10 s fuse · triggers within 1.05 tiles (0.4 s delay) · 1.75-tile blast |

The ammo type and mines on/off are chosen in the lobby.

### Arenas

Every arena is mirrored left-to-right, so both sides are equal.

| Arena | Theme | Feature |
| --- | --- | --- |
| Opening Gambit | Workshop | A simple layout to learn on |
| Crate Alley | Sandbox | Crate walls to blast through |
| The Moat | Frost | Icy pond in the middle; shells fly over, tanks go around |
| Hedge Maze | Garden | Tight corridors |
| Checkerboard | Playroom | Scattered toy blocks for bank shots |
| Twin Forts | Blueprint | Walled bases with crate doors |
| Bank Shot | Workshop | Long walls built for ricochets |
| Crossroads | Frost | A cross of cover in the middle |
| Lily Pads | Garden | Ponds and planters |
| Toy Box | Playroom | Crates and blocks everywhere |

Choose **Rotation** to play them in order, **Random**, or a single arena.
To make your own, add an entry to [`game/js/arenas.js`](game/js/arenas.js): you draw the left half and it's mirrored automatically.

---

## Troubleshooting

**A phone can't open the QR code link, or it stays on CONNECTING….**
- The phone must be on the same Wi-Fi network as the computer, not on mobile data.
- On Windows, the firewall may be blocking it. If you missed the "Allow" prompt, open *Windows Security → Firewall → Allow an app through firewall* and allow **Windows PowerShell** for your network type.
- Some networks stop devices from seeing each other: hotels, schools, cafés and many "guest" networks. There, or wherever the Wi-Fi keeps dropping out, make your own network instead. Turn on a phone's hotspot and connect the computer and the other phones to it; it doesn't need mobile data for this. A cheap travel router works too.
- If the computer has several network connections (VPN, virtual machines), click **Try another address** under the QR code.

**My Android phone isn't in Chrome's Bluetooth list.**
- Make sure Ricochet Pad is open on the phone and says **WAITING FOR GAME**. It only advertises while it's on screen.
- Make sure Bluetooth is on for both the phone and the computer.
- Don't pair the phone in Windows or Android Bluetooth settings first. The game connects directly.
- A phone can only control one player at a time. If it's already connected, it stops advertising.

**The lobby says "Android app (Bluetooth) unavailable".**
The page was opened as a file or in a browser without Web Bluetooth (Firefox and Safari don't have it).
Use the start script and Chrome or Edge.

**Linux.**
Open `chrome://flags/#enable-experimental-web-platform-features`, enable it, and restart Chrome.
You also need BlueZ 5.41 or newer.

**A phone disconnected mid-match.**
The game pauses and keeps trying to reconnect on its own.
Wi-Fi phones come back to the same tank automatically.
For the Android app:
If you closed and reopened the app, Android may have switched to a new Bluetooth address.
In that case, click **Re-pair … phone** on the pause screen and pick it again.

**The controls feel laggy.**
Keep the phones within a few metres of the computer and away from crowded 2.4 GHz gear.
USB Bluetooth dongles at the back of a PC case can struggle, so try a short USB extension.

**Leaving the app.**
Back needs a double press, so a stray swipe mid-match doesn't close the controller.
Switching away from the app disconnects it; the game pauses until you return.

---

## Project layout

```
game/                      Desktop game (plain HTML/CSS/JS, no build step)
  index.html
  css/style.css
  js/config.js             Tuning values
  js/arenas.js             Arena layouts and visual themes
  js/world.js              Simulation (tanks, shells, mines, collisions)
  js/render.js             Canvas renderer, particles, decals
  js/audio.js              Synthesised sound effects and music
  js/input.js              Keyboard, mouse and gamepad
  js/ble.js                Android app over Web Bluetooth
  js/wifi.js               Phone controllers over Wi-Fi (WebSocket via the launcher)
  js/vendor/qrcode.js      QR code generator (Kazuhiko Arase, MIT licence)
  pad/                     Wi-Fi controller page served to phones
  js/protocol.js           Bluetooth packet format
  js/main.js               Menus, rounds, HUD, controller feedback
  tests/run.js             Headless tests for the simulation and protocol
controller-android/        Ricochet Pad (Kotlin, no external libraries)
launcher/server.py         Local server for macOS / Linux (game, Wi-Fi controller, relay)
launcher/RicochetServer.cs Same server for Windows, compiled by start-game.ps1
docs/PROTOCOL.md           Controller protocol (Bluetooth and Wi-Fi)
start-game.bat / .ps1 / .sh  Launchers
```

Run the simulation tests with:

```sh
node game/tests/run.js
```

Add `?debug` to the game URL for an FPS counter.

---

Ricochet Rumble is an original game in the classic top-down tank-duel genre.
The art, sounds, music and arenas were all made for this project, and the sounds and music are generated in code.
