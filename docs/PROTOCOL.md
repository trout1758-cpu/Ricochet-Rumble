# Controller protocol

The phone runs a **GATT server** (BLE peripheral) and advertises one service.
The desktop game connects to it as a **central** using Web Bluetooth in Chrome or Edge.
No OS-level pairing is involved, and nothing needs encryption, so the browser's device picker is the only step.

| Item | UUID |
| --- | --- |
| Service | `9938fe42-6fb5-4186-b966-95ce510c09c9` |
| Input characteristic (phone → game, read + notify) | `9938fe43-6fb5-4186-b966-95ce510c09c9` |
| Feedback characteristic (game → phone, write / write without response) | `9938fe44-6fb5-4186-b966-95ce510c09c9` |

The service UUID is in the advertisement packet, so the browser picker only lists phones running the app.
The phone's Bluetooth name goes in the scan response.

## Input packet: phone → game (10 bytes, notification)

| Byte | Type | Meaning |
| --- | --- | --- |
| 0 | uint8 | protocol version (`1`) |
| 1 | uint8 | sequence number (wraps) |
| 2 | int8 | drive stick X, −127…127 (right is positive) |
| 3 | int8 | drive stick Y, −127…127 (down is positive) |
| 4 | int8 | last aim direction X |
| 5 | int8 | last aim direction Y |
| 6 | bits | bit 0 = aim stick held past the dead zone, bit 1 = drive stick held |
| 7 | uint8 | fire counter (+1 per shot request, wraps at 256) |
| 8 | uint8 | mine counter |
| 9 | uint8 | pause counter |

Button presses are **counters**, not momentary flags.
The game fires once per increment, so a press can't get lost between packets.
The phone sends a packet whenever the controls change, and re-sends the current state every 200 ms as a keep-alive.
It waits for each notification to be acknowledged before sending the next one, and only the newest state is ever queued.

## Feedback messages: game → phone

| First byte | Message | Payload |
| --- | --- | --- |
| `1` | Assign | `playerIndex, r, g, b`: which player the phone controls and that tank's colour |
| `2` | Rumble | `duration / 10 ms, amplitude 1…255` |
| `3` | Status | `state, myWins, theirWins, winsNeeded, shellsLeft, minesLeft, ready, shellsMax` |

`state` values: `0` lobby, `1` round countdown, `2` playing, `3` round over, `4` match over, `5` paused.

The game sends a Status only when something in it changes.

## Wi-Fi transport

Phones without the Android app use the web controller in `game/pad/`.
The launcher's local server (`launcher/server.py`, or `launcher/RicochetServer.cs` on Windows) serves that page to the phone and relays messages over a WebSocket at `/ws`.
The message bytes are exactly the ones above.

- The game connects with `/ws?role=game`.
  The server sends it JSON text messages:
  - `{"t":"hello","urls":[…]}`: this computer's controller addresses on the local network. The game requests a fresh copy with `{"t":"urls"}`.
  - `{"t":"join","pad":n,"id":…,"slot":…,"name":…}`: a phone connected.
  - `{"t":"leave","pad":n}`: a phone disconnected.
- A phone connects with `/ws?role=pad&id=<random id kept for the browser tab>&slot=<0|1|empty>&name=<device>`.
  The `slot` comes from the QR code that was scanned.
  Reconnecting with the same `id` gives the phone back its tank.
- Binary messages from a phone reach the game prefixed with its one-byte pad number `n`.
  The game sends `[n, …message]`, and the server strips `n` before passing it on.
- Two extra game → phone messages exist on Wi-Fi only:
  - `0` is a heartbeat, sent every 250 ms. A phone that hears nothing for 2.5 s reconnects.
  - `4, reason` removes the controller: `0` means the player removed it, `1` means both players already had controllers.
- The game treats a Wi-Fi phone as disconnected after 1.5 s without input packets, because Wi-Fi can drop without the socket closing.
