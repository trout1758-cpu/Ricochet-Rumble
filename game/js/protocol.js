// Bluetooth LE protocol shared with the Android controller app.
// Keep in sync with controller-android/app/src/main/java/com/ricochetrumble/controller/Protocol.kt
// and docs/PROTOCOL.md.
window.RR = window.RR || {};

RR.PROTO = {
  SERVICE_UUID:  '9938fe42-6fb5-4186-b966-95ce510c09c9',
  INPUT_UUID:    '9938fe43-6fb5-4186-b966-95ce510c09c9', // phone -> game, notify
  FEEDBACK_UUID: '9938fe44-6fb5-4186-b966-95ce510c09c9', // game -> phone, write

  VERSION: 1,

  // Input packet (phone -> game), 10 bytes
  //  0 version   uint8
  //  1 seq       uint8
  //  2 moveX     int8  (-127..127, right positive)
  //  3 moveY     int8  (-127..127, down positive)
  //  4 aimX      int8  last aim direction
  //  5 aimY      int8
  //  6 flags     bit0 = aim stick held, bit1 = move stick held
  //  7 fireCount uint8 (wrapping counter, +1 per shot request)
  //  8 mineCount uint8
  //  9 pauseCount uint8
  INPUT_LEN: 10,
  FLAG_AIM_HELD: 1,
  FLAG_MOVE_HELD: 2,

  // Feedback messages (game -> phone)
  MSG_ASSIGN: 1,  // [1, playerIndex, r, g, b]
  MSG_RUMBLE: 2,  // [2, duration/10ms, amplitude 1..255]
  MSG_STATUS: 3,  // [3, state, myWins, theirWins, winsNeeded, shellsLeft, minesLeft, ready, shellsMax]

  STATE: { LOBBY: 0, COUNTDOWN: 1, PLAYING: 2, ROUND_OVER: 3, MATCH_OVER: 4, PAUSED: 5 },

  decodeInput(dv) {
    if (dv.byteLength < RR.PROTO.INPUT_LEN) return null;
    const flags = dv.getUint8(6);
    return {
      version: dv.getUint8(0),
      seq: dv.getUint8(1),
      moveX: dv.getInt8(2) / 127,
      moveY: dv.getInt8(3) / 127,
      aimX: dv.getInt8(4) / 127,
      aimY: dv.getInt8(5) / 127,
      aimHeld: (flags & RR.PROTO.FLAG_AIM_HELD) !== 0,
      moveHeld: (flags & RR.PROTO.FLAG_MOVE_HELD) !== 0,
      fireCount: dv.getUint8(7),
      mineCount: dv.getUint8(8),
      pauseCount: dv.getUint8(9),
    };
  },

  // Difference between two wrapping uint8 counters.
  counterDelta(prev, next) {
    return (next - prev + 256) & 0xff;
  },
};
