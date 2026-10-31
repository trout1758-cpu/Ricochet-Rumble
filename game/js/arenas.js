// Arena layouts and visual themes.
//
// Every arena is written as its LEFT half only (11 columns x 13 rows) and
// mirrored to the right at load time, so all maps are perfectly fair.
// Legend:  .  floor      #  solid block      x  crate (mines destroy it)
//          o  pit (blocks tanks, shells fly over)        1  player 1 spawn
// The mirrored half turns "1" into player 2's spawn.
window.RR = window.RR || {};

RR.TILE = { FLOOR: 0, WALL: 1, CRATE: 2, PIT: 3 };

RR.THEMES = {
  workshop: {
    label: 'Workshop',
    backdrop: '#3b2b22', backdropLine: 'rgba(0,0,0,0.18)',
    rimTop: '#9a6a44', rimSide: '#6e452a',
    floor: '#ead2a2', floorAlt: '#e2c690', pattern: 'grain', patternInk: 'rgba(140,90,40,0.13)',
    wallTop: '#5d82bd', wallSide: '#3c5d91', wallEdge: '#86a7dc', wallStyle: 'toy',
    crateTop: '#cd9f63', crateSide: '#9b6f3d', crateMark: '#e9c992', crateStyle: 'box',
    pit: '#271c14', pitWall: '#5b4532',
    tread: 'rgba(95,60,25,0.14)', scorch: '40,25,12',
  },
  sandbox: {
    label: 'Sandbox',
    backdrop: '#5b4a36', backdropLine: 'rgba(0,0,0,0.15)',
    rimTop: '#b88f5c', rimSide: '#8a6537',
    floor: '#f1dca2', floorAlt: '#e8cf8e', pattern: 'speckle', patternInk: 'rgba(150,115,60,0.22)',
    wallTop: '#a3a8ae', wallSide: '#73787f', wallEdge: '#c7cbd0', wallStyle: 'stone',
    crateTop: '#b97f47', crateSide: '#87582c', crateMark: '#8a5a2e', crateStyle: 'planks',
    pit: '#3a2d1c', pitWall: '#8c7146',
    tread: 'rgba(120,90,40,0.18)', scorch: '50,35,15',
  },
  frost: {
    label: 'Frost',
    backdrop: '#2b3c52', backdropLine: 'rgba(255,255,255,0.05)',
    rimTop: '#d6e6f3', rimSide: '#9fb8cf',
    floor: '#eef5fb', floorAlt: '#e3edf6', pattern: 'sparkle', patternInk: 'rgba(120,160,200,0.25)',
    wallTop: '#9fd6f2', wallSide: '#5fa8d2', wallEdge: '#e2f6ff', wallStyle: 'ice',
    crateTop: '#fbfdff', crateSide: '#c4d6e6', crateMark: '#d9e6f1', crateStyle: 'snow',
    pit: '#2a6b96', pitWall: '#bfe3f7', pitStyle: 'water',
    tread: 'rgba(90,120,160,0.16)', scorch: '30,40,55',
  },
  garden: {
    label: 'Garden',
    backdrop: '#4a3a2a', backdropLine: 'rgba(0,0,0,0.2)',
    rimTop: '#8d6b49', rimSide: '#644a30',
    floor: '#97c96f', floorAlt: '#8cbf64', pattern: 'grass', patternInk: 'rgba(40,90,30,0.22)',
    wallTop: '#3e8e47', wallSide: '#2a6532', wallEdge: '#5fb168', wallStyle: 'hedge',
    crateTop: '#cf6e43', crateSide: '#9b4a28', crateMark: '#e48e66', crateStyle: 'pot',
    pit: '#1f4a63', pitWall: '#4d8db0', pitStyle: 'water',
    tread: 'rgba(40,70,20,0.18)', scorch: '35,30,15',
  },
  playroom: {
    label: 'Playroom',
    backdrop: '#3d3550', backdropLine: 'rgba(255,255,255,0.04)',
    rimTop: '#f2f2f2', rimSide: '#c9c4d6',
    floor: '#f6dbe3', floorAlt: '#f0ccd7', pattern: 'dots', patternInk: 'rgba(200,120,150,0.22)',
    wallTop: '#f0c43a', wallSide: '#c79a18', wallEdge: '#ffe17f', wallStyle: 'multi',
    crateTop: '#cfa36a', crateSide: '#9f773f', crateMark: '#ead0a2', crateStyle: 'box',
    pit: '#2c2238', pitWall: '#5e4d78',
    tread: 'rgba(150,80,110,0.14)', scorch: '45,25,35',
  },
  blueprint: {
    label: 'Blueprint',
    backdrop: '#1a2233', backdropLine: 'rgba(255,255,255,0.04)',
    rimTop: '#dfe6f2', rimSide: '#9fadc4',
    floor: '#2f63a8', floorAlt: '#2c5d9f', pattern: 'grid', patternInk: 'rgba(210,230,255,0.22)',
    wallTop: '#f3f6fb', wallSide: '#b9c4d6', wallEdge: '#ffffff', wallStyle: 'paper',
    crateTop: '#c89d63', crateSide: '#966f3c', crateMark: '#e4c38f', crateStyle: 'box',
    pit: '#0f1d33', pitWall: '#244a7c',
    tread: 'rgba(200,225,255,0.12)', scorch: '10,15,30',
  },
};

RR.ARENA_DEFS = [
  {
    name: 'Opening Gambit', theme: 'workshop',
    half: [
      '...........',
      '...........',
      '...###.....',
      '...#.......',
      '...........',
      '........#..',
      '.1......#..',
      '........#..',
      '...........',
      '...#.......',
      '...###.....',
      '...........',
      '...........',
    ],
  },
  {
    name: 'Crate Alley', theme: 'sandbox',
    half: [
      '...........',
      '..##.......',
      '..#....x...',
      '......xx...',
      '..x........',
      '..x...##...',
      '.1x...#....',
      '..x...##...',
      '..x........',
      '......xx...',
      '..#....x...',
      '..##.......',
      '...........',
    ],
  },
  {
    name: 'The Moat', theme: 'frost',
    half: [
      '...........',
      '...........',
      '...#.......',
      '...#.......',
      '...#....ooo',
      '........ooo',
      '.1......ooo',
      '........ooo',
      '...#....ooo',
      '...#.......',
      '...#.......',
      '...........',
      '...........',
    ],
  },
  {
    name: 'Hedge Maze', theme: 'garden',
    half: [
      '...........',
      '.#####..#..',
      '.#......#..',
      '.#..##.....',
      '....#...###',
      '..#.#......',
      '.1#........',
      '..#.#......',
      '....#...###',
      '.#..##.....',
      '.#......#..',
      '.#####..#..',
      '...........',
    ],
  },
  {
    name: 'Checkerboard', theme: 'playroom',
    half: [
      '...........',
      '...........',
      '...#...#...',
      '..........x',
      '.....#...#.',
      '...........',
      '.1.#...#...',
      '...........',
      '.....#...#.',
      '..........x',
      '...#...#...',
      '...........',
      '...........',
    ],
  },
  {
    name: 'Twin Forts', theme: 'blueprint',
    half: [
      '...........',
      '...........',
      '#####......',
      '...........',
      '....x...#..',
      '....#...#..',
      '.1..#.....x',
      '....#...#..',
      '....x...#..',
      '...........',
      '#####......',
      '...........',
      '...........',
    ],
  },
  {
    name: 'Bank Shot', theme: 'workshop',
    half: [
      '...........',
      '...........',
      '..#########',
      '...........',
      '...........',
      '......#....',
      '.1....#....',
      '......#....',
      '...........',
      '...........',
      '..#########',
      '...........',
      '...........',
    ],
  },
  {
    name: 'Crossroads', theme: 'frost',
    half: [
      '...........',
      '...........',
      '..##......#',
      '..#.......#',
      '..........#',
      '...........',
      '.1....####.',
      '...........',
      '..........#',
      '..#.......#',
      '..##......#',
      '...........',
      '...........',
    ],
  },
  {
    name: 'Lily Pads', theme: 'garden',
    half: [
      '...........',
      '....oo.....',
      '....oo...x.',
      '...........',
      '..#......oo',
      '..#......oo',
      '.1#........',
      '..#......oo',
      '..#......oo',
      '...........',
      '....oo...x.',
      '....oo.....',
      '...........',
    ],
  },
  {
    name: 'Toy Box', theme: 'playroom',
    half: [
      '...........',
      '.....#.....',
      '..x..#..xx.',
      '..x.....x..',
      '..x..###...',
      '...........',
      '.1.........',
      '...........',
      '..x..###...',
      '..x.....x..',
      '..x..#..xx.',
      '.....#.....',
      '...........',
    ],
  },
];

// Expand a half-arena definition into a full grid + spawn points.
RR.buildArena = function buildArena(def) {
  const { COLS, ROWS } = RR.CFG;
  const T = RR.TILE;
  const grid = new Uint8Array(COLS * ROWS);
  const spawns = [null, null];
  if (def.half.length !== ROWS) throw new Error(`${def.name}: expected ${ROWS} rows`);
  def.half.forEach((row, r) => {
    if (row.length !== COLS / 2) throw new Error(`${def.name}: row ${r} must be ${COLS / 2} wide`);
    for (let c = 0; c < COLS / 2; c++) {
      const ch = row[c];
      const mc = COLS - 1 - c;
      let t = T.FLOOR;
      if (ch === '#') t = T.WALL;
      else if (ch === 'x') t = T.CRATE;
      else if (ch === 'o') t = T.PIT;
      else if (ch === '1') {
        spawns[0] = { x: c + 0.5, y: r + 0.5, angle: 0 };
        spawns[1] = { x: mc + 0.5, y: r + 0.5, angle: Math.PI };
      }
      grid[r * COLS + c] = t;
      grid[r * COLS + mc] = t;
    }
  });
  if (!spawns[0]) throw new Error(`${def.name}: missing spawn`);
  return { name: def.name, theme: RR.THEMES[def.theme], themeKey: def.theme, grid, spawns };
};
