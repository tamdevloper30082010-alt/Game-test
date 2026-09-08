/* ===========================================================
   PUZZLE BATTALION — game.js
   Owns: puzzle grid (tetromino fall/clear) + battlefield sim/render.
   Knows NOTHING about networking directly — it only calls the
   hooks in Game.hooks, which net.js fills in. This keeps the game
   fully playable offline (solo sandbox) even with no P2P library.
   =========================================================== */

const Game = (() => {

  // ---------- constants ----------
  const COLS = 8, ROWS = 10;
  const LANE_LEN = 1000;          // logical battlefield width
  const BASE_MAX_HP = 3000;

  const UNIT_DEFS = {
    swordsman: { hp: 100, atk: 15, speed: 46, range: 16,  cooldown: 0.8, color: '#e5484d', radius: 11 },
    archer:    { hp: 40,  atk: 25, speed: 24, range: 130, cooldown: 1.4, color: '#3aa0ff', radius: 9  }
  };
  const COLOR_TO_TYPE = { red: 'swordsman', blue: 'archer' };

  const SHAPES = {
    I: [[0,1],[1,1],[2,1],[3,1]],
    O: [[1,0],[2,0],[1,1],[2,1]],
    T: [[0,1],[1,1],[2,1],[1,0]],
    S: [[1,0],[2,0],[0,1],[1,1]],
    Z: [[0,0],[1,0],[1,1],[2,1]],
    J: [[0,0],[0,1],[1,1],[2,1]],
    L: [[2,0],[0,1],[1,1],[2,1]]
  };
  const SHAPE_KEYS = Object.keys(SHAPES);

  // ---------- state ----------
  let grid = makeEmptyGrid();
  let cur = null;          // current falling piece
  let nextType = null, nextColor = null;
  let dropTimer = 0, dropInterval = 0.8;
  let rowsCleared = 0;
  let paused = false;
  let gameOver = false;
  let started = false;     // becomes true only when the actual match begins
                            // (immediately for solo/bot, or once the opponent
                            // connects for host/client) — prevents blocks from
                            // silently falling/locking while still on the home
                            // screen or waiting for a rival to join

  let role = 'solo';       // 'solo' | 'host' | 'client'
  let mySide = 'A';        // 'A' (left) or 'B' (right)

  // simple "chơi với máy" bot: periodically spawns a random unit for side B
  let botEnabled = false;
  let botTimer = 3;
  const BOT_TYPES = Object.keys(UNIT_DEFS);

  // battle sim (authoritative when role is solo/host)
  let sim = { baseA: BASE_MAX_HP, baseB: BASE_MAX_HP, units: [], nextId: 1, over: false, winner: null };
  let lastRemoteState = null; // used when role === 'client'

  const hooks = {
    onLocalRowCleared: null,   // (color, rowsClearedTotal) => {}
    onGameOver: null           // (winnerSide) => {}
  };

  // ---------- canvases ----------
  let puzzleCv, puzzleCtx, nextCv, nextCtx, fieldCv, fieldCtx;
  const cell = () => puzzleCv.width / COLS;

  function makeEmptyGrid(){
    const g = [];
    for (let r = 0; r < ROWS; r++) g.push(new Array(COLS).fill(null));
    return g;
  }

  // ---------- puzzle piece helpers ----------
  function randomPiece(){
    const key = SHAPE_KEYS[Math.floor(Math.random() * SHAPE_KEYS.length)];
    const color = Math.random() < 0.5 ? 'red' : 'blue';
    return { key, color, cells: SHAPES[key].map(c => c.slice()) };
  }

  function spawnPiece(){
    const type = nextType || randomPiece();
    cur = {
      key: type.key, color: type.color,
      cells: type.cells.map(c => c.slice()),
      x: Math.floor(COLS / 2) - 2, y: 0
    };
    nextType = randomPiece();
    drawNextPreview();
    if (collides(cur, cur.x, cur.y)) {
      // board topped out — reset board (soft-fail, keep game friendly)
      grid = makeEmptyGrid();
    }
  }

  function collides(p, nx, ny){
    for (const [cx, cy] of p.cells) {
      const gx = nx + cx, gy = ny + cy;
      if (gx < 0 || gx >= COLS || gy >= ROWS) return true;
      if (gy >= 0 && grid[gy][gx]) return true;
    }
    return false;
  }

  function rotate(p){
    // rotate around piece-local center (2,2) for a 4x4 box, classic SRS-lite
    const rotated = p.cells.map(([cx, cy]) => [ (3 - cy), cx ]);
    return { ...p, cells: rotated };
  }

  function tryMove(dx, dy){
    if (!cur || paused || gameOver) return false;
    if (!collides(cur, cur.x + dx, cur.y + dy)) {
      cur.x += dx; cur.y += dy;
      return true;
    }
    return false;
  }

  function tryRotate(){
    if (!cur || paused || gameOver) return;
    const r = rotate(cur);
    for (const kick of [0, -1, 1, -2, 2]) {
      if (!collides(r, cur.x + kick, cur.y)) {
        cur.cells = r.cells; cur.x += kick;
        return;
      }
    }
  }

  function hardDrop(){
    if (!cur || paused || gameOver) return;
    while (tryMove(0, 1)) {}
    lockPiece();
  }

  function lockPiece(){
    for (const [cx, cy] of cur.cells) {
      const gx = cur.x + cx, gy = cur.y + cy;
      if (gy >= 0) grid[gy][gx] = cur.color;
    }
    clearFullRows();
    spawnPiece();
  }

  function clearFullRows(){
    for (let r = ROWS - 1; r >= 0; r--) {
      if (grid[r].every(c => c)) {
        let red = 0, blue = 0;
        for (const c of grid[r]) c === 'red' ? red++ : blue++;
        const dominant = red >= blue ? 'red' : 'blue';
        grid.splice(r, 1);
        grid.unshift(new Array(COLS).fill(null));
        rowsCleared++;
        document.getElementById('rowsCleared').textContent = rowsCleared;
        if (hooks.onLocalRowCleared) hooks.onLocalRowCleared(dominant, rowsCleared);
        r++; // re-check same index after shift
      }
    }
  }

  // ---------- puzzle rendering ----------
  function drawGrid(){
    const c = cell();
    puzzleCtx.clearRect(0, 0, puzzleCv.width, puzzleCv.height);
    // grid lines
    puzzleCtx.strokeStyle = '#1b2531';
    puzzleCtx.lineWidth = 1;
    for (let x = 0; x <= COLS; x++) {
      puzzleCtx.beginPath(); puzzleCtx.moveTo(x*c, 0); puzzleCtx.lineTo(x*c, ROWS*c); puzzleCtx.stroke();
    }
    for (let y = 0; y <= ROWS; y++) {
      puzzleCtx.beginPath(); puzzleCtx.moveTo(0, y*c); puzzleCtx.lineTo(COLS*c, y*c); puzzleCtx.stroke();
    }
    // locked cells
    for (let r = 0; r < ROWS; r++)
      for (let cIdx = 0; cIdx < COLS; cIdx++)
        if (grid[r][cIdx]) drawCell(puzzleCtx, cIdx, r, grid[r][cIdx], c);
    // current piece
    if (cur) for (const [cx, cy] of cur.cells)
      if (cur.y + cy >= 0) drawCell(puzzleCtx, cur.x + cx, cur.y + cy, cur.color, c);

    if (paused) {
      puzzleCtx.fillStyle = 'rgba(6,8,11,.75)';
      puzzleCtx.fillRect(0, 0, puzzleCv.width, puzzleCv.height);
      puzzleCtx.fillStyle = '#d9a63e';
      puzzleCtx.font = '16px "Chakra Petch", sans-serif';
      puzzleCtx.textAlign = 'center';
      puzzleCtx.fillText('TẠM DỪNG', puzzleCv.width/2, puzzleCv.height/2);
    }
  }

  function drawCell(ctx, gx, gy, color, c){
    const pad = 1.5;
    ctx.fillStyle = color === 'red' ? '#e5484d' : '#3aa0ff';
    ctx.fillRect(gx*c+pad, gy*c+pad, c-pad*2, c-pad*2);
    ctx.strokeStyle = color === 'red' ? '#ff9a9d' : '#9ad2ff';
    ctx.lineWidth = 1;
    ctx.strokeRect(gx*c+pad, gy*c+pad, c-pad*2, c-pad*2);
  }

  function drawNextPreview(){
    nextCtx.clearRect(0, 0, nextCv.width, nextCv.height);
    const c = 18;
    const offX = (nextCv.width - 4*c) / 2, offY = (nextCv.height - 4*c) / 2;
    for (const [cx, cy] of nextType.cells) {
      nextCtx.fillStyle = nextType.color === 'red' ? '#e5484d' : '#3aa0ff';
      nextCtx.fillRect(offX + cx*c + 1, offY + cy*c + 1, c-2, c-2);
    }
  }

  // ---------- battle simulation (solo/host authoritative) ----------
  function spawnUnit(side, type){
    if (gameOver) return;
    const def = UNIT_DEFS[type];
    sim.units.push({
      id: sim.nextId++, side, type,
      x: side === 'A' ? 0 : LANE_LEN,
      hp: def.hp, maxHp: def.hp,
      cd: 0
    });
  }

  function tickBattle(dt){
    if (role === 'client' || sim.over) return;

    if (botEnabled) {
      botTimer -= dt;
      if (botTimer <= 0) {
        const type = BOT_TYPES[Math.floor(Math.random() * BOT_TYPES.length)];
        spawnUnit('B', type);
        botTimer = 2.2 + Math.random() * 2.2; // ~2.2–4.4s between bot summons
      }
    }

    const units = sim.units;

    for (const u of units) {
      if (u.hp <= 0) continue;
      const def = UNIT_DEFS[u.type];
      const dir = u.side === 'A' ? 1 : -1;

      // find nearest living enemy unit ahead
      let target = null, bestDist = Infinity;
      for (const o of units) {
        if (o.side === u.side || o.hp <= 0) continue;
        const ahead = u.side === 'A' ? (o.x >= u.x) : (o.x <= u.x);
        if (!ahead) continue;
        const d = Math.abs(o.x - u.x);
        if (d < bestDist) { bestDist = d; target = o; }
      }

      if (target && bestDist <= def.range) {
        u.cd -= dt;
        if (u.cd <= 0) { target.hp -= def.atk; u.cd = def.cooldown; }
        continue;
      }

      // no unit in range — check base
      const enemyBaseX = u.side === 'A' ? LANE_LEN : 0;
      const distToBase = Math.abs(enemyBaseX - u.x);
      if (distToBase <= def.range) {
        u.cd -= dt;
        if (u.cd <= 0) {
          if (u.side === 'A') sim.baseB -= def.atk; else sim.baseA -= def.atk;
          // recoil: hitting the base costs the unit the same amount of HP,
          // so players can't just pile units on the base for free
          u.hp -= def.atk;
          u.cd = def.cooldown;
        }
        continue;
      }

      u.x += dir * def.speed * dt;
      u.x = Math.max(0, Math.min(LANE_LEN, u.x));
    }

    sim.units = units.filter(u => u.hp > 0);
    sim.baseA = Math.max(0, sim.baseA);
    sim.baseB = Math.max(0, sim.baseB);

    if (!sim.over && (sim.baseA <= 0 || sim.baseB <= 0)) {
      sim.over = true;
      sim.winner = sim.baseA <= 0 ? 'B' : 'A';
      gameOver = true;
      if (hooks.onGameOver) hooks.onGameOver(sim.winner);
    }
  }

  function getSnapshot(){
    return {
      baseA: sim.baseA, baseB: sim.baseB,
      units: sim.units.map(u => ({ side: u.side, type: u.type, x: u.x, hp: u.hp, maxHp: u.maxHp })),
      over: sim.over, winner: sim.winner
    };
  }

  // pure function of a snapshot — works identically for the host's own sim
  // and for the client's last-received broadcast, so no extra network state
  // is needed to know when a unit is "firing" for rendering purposes.
  function findEngagementTarget(state, u){
    const def = UNIT_DEFS[u.type];
    let target = null, bestDist = Infinity;
    for (const o of state.units) {
      if (o.side === u.side || o.hp <= 0) continue;
      const ahead = u.side === 'A' ? (o.x >= u.x) : (o.x <= u.x);
      if (!ahead) continue;
      const d = Math.abs(o.x - u.x);
      if (d < bestDist) { bestDist = d; target = o; }
    }
    if (target && bestDist <= def.range) return target.x;
    const baseX = u.side === 'A' ? LANE_LEN : 0;
    if (Math.abs(baseX - u.x) <= def.range) return baseX;
    return null;
  }

  function applyRemoteState(state){
    lastRemoteState = state;
    if (state.over && !gameOver) {
      gameOver = true;
      if (hooks.onGameOver) hooks.onGameOver(state.winner);
    }
  }

  // ---------- battlefield rendering ----------
  function renderBattlefield(){
    const state = (role === 'client') ? lastRemoteState : getSnapshot();
    fieldCtx.clearRect(0, 0, fieldCv.width, fieldCv.height);
    if (!state) return;

    const W = fieldCv.width, H = fieldCv.height;
    const midY = H / 2;

    // lane
    fieldCtx.strokeStyle = '#26323f';
    fieldCtx.setLineDash([6,6]);
    fieldCtx.beginPath(); fieldCtx.moveTo(20, midY); fieldCtx.lineTo(W-20, midY); fieldCtx.stroke();
    fieldCtx.setLineDash([]);

    const flip = mySide === 'B';
    const toScreenX = (logicalX) => {
      const t = logicalX / LANE_LEN;
      const p = flip ? (1 - t) : t;
      return 30 + p * (W - 60);
    };

    // bases
    const myHp = flip ? state.baseB : state.baseA;
    const enemyHp = flip ? state.baseA : state.baseB;
    drawBase(20, midY, myHp, '#d9a63e');
    drawBase(W - 20, midY, enemyHp, '#e5484d');

    // units
    for (const u of state.units) {
      const isMine = (flip ? u.side === 'B' : u.side === 'A');
      const x = toScreenX(u.x);
      const engageLogicalX = findEngagementTarget(state, u);
      const engageX = engageLogicalX === null ? null : toScreenX(engageLogicalX);
      drawUnit(x, midY, u, isMine, engageX);
    }

    // update HUD numbers
    document.getElementById('hpMine').style.width = Math.max(0, myHp/BASE_MAX_HP*100) + '%';
    document.getElementById('hpEnemy').style.width = Math.max(0, enemyHp/BASE_MAX_HP*100) + '%';
    document.getElementById('hpMineNum').textContent = Math.max(0, Math.round(myHp));
    document.getElementById('hpEnemyNum').textContent = Math.max(0, Math.round(enemyHp));

    if (state.over) showGameOver(state.winner, flip);
  }

  function drawBase(x, y, hp, color){
    fieldCtx.save();
    fieldCtx.translate(x, y);
    fieldCtx.fillStyle = color;
    fieldCtx.beginPath();
    fieldCtx.moveTo(0,-16); fieldCtx.lineTo(14,0); fieldCtx.lineTo(0,16); fieldCtx.lineTo(-14,0);
    fieldCtx.closePath(); fieldCtx.fill();
    fieldCtx.strokeStyle = '#00000066'; fieldCtx.stroke();
    fieldCtx.restore();
  }

  function drawUnit(x, y, u, isMine, engageX){
    const def = UNIT_DEFS[u.type];
    const engaged = engageX !== null && engageX !== undefined;
    const localTargetX = engaged ? engageX - x : null;
    const dir = engaged ? (localTargetX >= 0 ? 1 : -1) : (u.side === 'A' ? 1 : -1);

    fieldCtx.save();
    fieldCtx.translate(x, y);

    // body
    fieldCtx.fillStyle = def.color;
    fieldCtx.globalAlpha = isMine ? 1 : 0.85;
    fieldCtx.beginPath();
    fieldCtx.arc(0, 0, def.radius, 0, Math.PI*2);
    fieldCtx.fill();
    fieldCtx.strokeStyle = isMine ? '#d9a63e' : '#0a0e14';
    fieldCtx.lineWidth = 2;
    fieldCtx.stroke();
    fieldCtx.globalAlpha = 1;

    // weapon (drawn facing `dir`; use a horizontal scale so we only ever
    // have to write the geometry once, facing right)
    fieldCtx.save();
    fieldCtx.scale(dir, 1);
    if (u.type === 'swordsman') {
      const swing = engaged ? Math.sin(performance.now() / 90) * 0.5 : 0.08;
      fieldCtx.save();
      fieldCtx.rotate(swing);
      fieldCtx.strokeStyle = '#f2f2f2';
      fieldCtx.lineWidth = 2.5;
      fieldCtx.beginPath();
      fieldCtx.moveTo(def.radius - 2, -2);
      fieldCtx.lineTo(def.radius + 11, -2);
      fieldCtx.stroke();
      fieldCtx.strokeStyle = '#8a5a2a';
      fieldCtx.lineWidth = 3;
      fieldCtx.beginPath();
      fieldCtx.moveTo(def.radius - 4, 2);
      fieldCtx.lineTo(def.radius + 2, 2);
      fieldCtx.stroke();
      fieldCtx.restore();
    } else if (u.type === 'archer') {
      fieldCtx.strokeStyle = '#7a4a20';
      fieldCtx.lineWidth = 2;
      fieldCtx.beginPath();
      fieldCtx.arc(def.radius + 2, 0, 6, -Math.PI*0.4, Math.PI*0.4);
      fieldCtx.stroke();
      fieldCtx.strokeStyle = '#d9c48a';
      fieldCtx.lineWidth = 1;
      fieldCtx.beginPath();
      fieldCtx.moveTo(def.radius + 2, -5.5);
      fieldCtx.lineTo(def.radius + 2, 5.5);
      fieldCtx.stroke();
    }
    fieldCtx.restore();

    // flying arrow — archer only, looping over its cooldown so it visibly
    // travels from the archer to whatever it's currently hitting
    if (u.type === 'archer' && engaged) {
      const period = def.cooldown * 1000;
      const phase = (performance.now() % period) / period;
      const arrowX = localTargetX * phase;
      fieldCtx.save();
      fieldCtx.translate(arrowX, 0);
      fieldCtx.rotate(dir === 1 ? 0 : Math.PI);
      fieldCtx.strokeStyle = '#e8d9a0';
      fieldCtx.lineWidth = 1.5;
      fieldCtx.beginPath();
      fieldCtx.moveTo(-7, 0); fieldCtx.lineTo(4, 0); fieldCtx.stroke();
      fieldCtx.beginPath();
      fieldCtx.moveTo(4, 0); fieldCtx.lineTo(0, -2.5); fieldCtx.lineTo(0, 2.5); fieldCtx.closePath();
      fieldCtx.fillStyle = '#e8d9a0'; fieldCtx.fill();
      fieldCtx.restore();
    }

    // hp sliver
    const w = def.radius*2;
    fieldCtx.fillStyle = '#000'; fieldCtx.fillRect(-w/2, -def.radius-7, w, 3);
    fieldCtx.fillStyle = '#4ee08a'; fieldCtx.fillRect(-w/2, -def.radius-7, w*(u.hp/u.maxHp), 3);
    fieldCtx.restore();
  }

  function showGameOver(winnerSide, flip){
    const banner = document.getElementById('gameOverBanner');
    const iWon = flip ? winnerSide === 'B' : winnerSide === 'A';
    banner.innerHTML = iWon
      ? 'CHIẾN THẮNG<span>Nhà Chính đối phương đã sụp đổ</span>'
      : 'THẤT BẠI<span>Nhà Chính của bạn đã sụp đổ</span>';
    banner.classList.remove('hidden');
  }

  // ---------- controls ----------
  function setupControls(){
    window.addEventListener('keydown', (e) => {
      if (paused || gameOver) return;
      if (e.key === 'ArrowLeft') tryMove(-1, 0);
      else if (e.key === 'ArrowRight') tryMove(1, 0);
      else if (e.key === 'ArrowDown') tryMove(0, 1);
      else if (e.key === 'ArrowUp') tryRotate();
      else if (e.code === 'Space') { e.preventDefault(); hardDrop(); }
    });

    let touchStartX = 0, touchStartY = 0, touchStartT = 0;
    puzzleCv.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      touchStartX = t.clientX; touchStartY = t.clientY; touchStartT = Date.now();
    }, { passive: true });

    puzzleCv.addEventListener('touchend', (e) => {
      if (paused || gameOver) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchStartX, dy = t.clientY - touchStartY;
      const dt = Date.now() - touchStartT;
      const absX = Math.abs(dx), absY = Math.abs(dy);

      if (absX < 12 && absY < 12) {
        // tap: left half = move left, right half = move right
        const rect = puzzleCv.getBoundingClientRect();
        const tapX = t.clientX - rect.left;
        if (tapX < rect.width / 2) tryMove(-1, 0); else tryMove(1, 0);
        return;
      }
      if (absY > absX && dt < 500) {
        if (dy > 40) hardDrop(); else if (dy < -40) tryRotate();
        return;
      }
      if (absX > absY) {
        if (dx > 30) tryMove(1, 0); else if (dx < -30) tryMove(-1, 0);
      }
    }, { passive: true });

    document.getElementById('btnPause').addEventListener('click', () => {
      paused = !paused;
      document.getElementById('btnPause').textContent = paused ? 'TIẾP TỤC' : 'TẠM DỪNG';
    });
  }

  // ---------- main loop ----------
  let lastT = null;
  function loop(ts){
    if (lastT === null) lastT = ts;
    const dt = Math.min(0.05, (ts - lastT) / 1000);
    lastT = ts;

    if (started && !paused && !gameOver) {
      dropTimer += dt;
      if (dropTimer >= dropInterval) {
        dropTimer = 0;
        if (!tryMove(0, 1)) lockPiece();
      }
      tickBattle(dt);
    }

    drawGrid();
    renderBattlefield();
    requestAnimationFrame(loop);
  }

  // ---------- public API ----------
  function init(){
    puzzleCv = document.getElementById('puzzleGrid'); puzzleCtx = puzzleCv.getContext('2d');
    nextCv = document.getElementById('nextPiece'); nextCtx = nextCv.getContext('2d');
    fieldCv = document.getElementById('battlefield'); fieldCtx = fieldCv.getContext('2d');

    nextType = randomPiece();
    drawNextPreview();
    setupControls();
    requestAnimationFrame(loop);
  }

  function resetState(){
    grid = makeEmptyGrid();
    sim = { baseA: BASE_MAX_HP, baseB: BASE_MAX_HP, units: [], nextId: 1, over: false, winner: null };
    lastRemoteState = null;
    rowsCleared = 0; gameOver = false; paused = false; botTimer = 3;
    cur = null;
    document.getElementById('rowsCleared').textContent = 0;
    document.getElementById('gameOverBanner').classList.add('hidden');
    nextType = randomPiece();
    drawNextPreview();
  }

  return {
    init,
    hooks,
    setRole(r, side){ role = r; mySide = side; },
    getMySide(){ return mySide; },
    setBotMode(enabled){ botEnabled = enabled; botTimer = 3; },
    spawnUnit,
    onRemoteSpawn(side, type){ spawnUnit(side, type); },
    getSnapshot,
    applyRemoteState,
    colorToType(color){ return COLOR_TO_TYPE[color]; },
    // Reset to a clean, idle board and STOP — used the moment a player enters
    // a host/join room, so nothing falls or fights while still waiting for
    // an opponent to actually connect.
    prepare(){
      resetState();
      started = false;
    },
    // Reset and actually begin ticking — used immediately for solo/bot play,
    // or once an opponent has connected for host/client play.
    start(){
      resetState();
      spawnPiece();
      started = true;
    }
  };
})();

document.addEventListener('DOMContentLoaded', () => Game.init());
