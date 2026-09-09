/* ===========================================================
   PUZZLE BATTALION — game.js
   Owns: puzzle grid (drag & drop placement + row clear) +
   battlefield sim/render. Knows NOTHING about networking
   directly — it only calls the hooks in Game.hooks, which
   net.js fills in. This keeps the game fully playable offline
   (solo sandbox) even with no P2P library.

   Puzzle mode: a tray of 3 upcoming pieces sits below the grid.
   Player presses & drags a piece; while held it floats a bit
   above the finger so it stays visible, and a green/red preview
   shows where it would land. Releasing over a valid spot locks
   it into the grid; releasing anywhere invalid just cancels the
   drag and the piece stays in the tray. No falling, no rotation.
   =========================================================== */

const Game = (() => {

  // ---------- constants ----------
  const COLS = 12, ROWS = 15;
  // battlefield "width": only affects how long a unit takes to walk from
  // base to base (toScreenX below normalizes by LANE_LEN, so the UI never
  // gets visually wider/longer — only travel time changes).
  const LANE_LEN = 1500;
  const BASE_MAX_HP = 3000;

  // how far above the finger (in CSS px) a dragged piece floats — keeps
  // the shape visible instead of hidden under the fingertip.
  const DRAG_LIFT_PX = 70;

  // ---------- unit stat sheet (thang điểm 0–10) ----------
  const UNIT_DEFS_RAW = {
    swordsman: { hpBase: 6, atkBase: 0.6, atkSpeedRating: 4,  speedRating: 4, range: 16,  radius: 11, color: '#e5484d' },
    archer:    { hpBase: 3, atkBase: 1,   atkSpeedRating: 8,  speedRating: 3, range: 130, radius: 9,  color: '#3aa0ff' },
    knight:    { hpBase: 4, atkBase: 0.7, atkSpeedRating: 10, speedRating: 7, range: 20,  radius: 13, color: '#4ee08a' }
  };
  const STAT_SCALE = { hp: 20, atk: 20, speedMax: 45 };

  const UNIT_DEFS = {};
  for (const [type, raw] of Object.entries(UNIT_DEFS_RAW)) {
    UNIT_DEFS[type] = {
      ...raw,
      hp: raw.hpBase * STAT_SCALE.hp,
      atk: raw.atkBase * STAT_SCALE.atk,
      cooldown: 10 / raw.atkSpeedRating,
      speed: (raw.speedRating / 10) * STAT_SCALE.speedMax
    };
  }
  const UNIT_TYPE_KEYS = Object.keys(UNIT_DEFS); // ['swordsman','archer','knight']

  // đơn vị mới triệu hồi được +40% tất cả chỉ số chiến đấu trong 1.5s
  const SPAWN_BUFF_MULT = 1.4;
  const SPAWN_BUFF_MS = 1500;

  const CELL_TYPE_WEIGHTS = { swordsman: 1/3, archer: 1/3, knight: 1/3 };

  function weightedRandomType(weights){
    const r = Math.random();
    let acc = 0;
    for (const type of UNIT_TYPE_KEYS) {
      acc += weights[type] || 0;
      if (r <= acc) return type;
    }
    return UNIT_TYPE_KEYS[UNIT_TYPE_KEYS.length - 1];
  }
  function randomCellType(){ return weightedRandomType(CELL_TYPE_WEIGHTS); }

  const CELL_FILL_DIST_BY_SIZE = {
    1: [0.20, 0.80],
    2: [0.20, 0.60, 0.20],
    3: [0.15, 0.55, 0.20, 0.10],
    4: [0.10, 0.50, 0.20, 0.15, 0.05],
    5: [0.08, 0.45, 0.20, 0.15, 0.08, 0.04]
  };
  const BLANK = 'blank';

  function pickFilledCellCount(total){
    const dist = CELL_FILL_DIST_BY_SIZE[total];
    if (!dist) return total;
    const r = Math.random();
    let acc = 0;
    for (let k = 0; k < dist.length; k++) {
      acc += dist[k];
      if (r <= acc) return k;
    }
    return dist.length - 1;
  }

  function assignCellTypes(total){
    const filledCount = pickFilledCellCount(total);
    const indices = Array.from({ length: total }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const filled = new Set(indices.slice(0, filledCount));
    const types = new Array(total).fill(BLANK);
    filled.forEach(i => { types[i] = randomCellType(); });
    return types;
  }

  // 3 độ khó "chơi với máy": khoảng cách giữa các lần máy triệu hồi quân,
  // tỉ lệ loại lính máy chọn, và powerMult — hệ số nhân sát thương/tốc độ
  // (và máu lúc triệu hồi) của lính bên máy, dùng để hạ sức mạnh bot ở độ
  // dễ xuống thấp hơn hẳn thay vì chỉ giãn nhịp triệu hồi (một mình nhịp
  // triệu hồi chậm hơn không đủ nếu mỗi lính vẫn đánh mạnh/nhanh như cũ).
  const BOT_DIFFICULTY = {
    easy:   { minGap: 6.5, maxGap: 10.0, weights: { swordsman: 0.7,  archer: 0.2,  knight: 0.1  }, powerMult: 0.5  },
    medium: { minGap: 3.5, maxGap: 5.5,  weights: { swordsman: 0.45, archer: 0.3,  knight: 0.25 }, powerMult: 0.8  },
    hard:   { minGap: 1.8, maxGap: 3.2,  weights: { swordsman: 0.3,  archer: 0.35, knight: 0.35 }, powerMult: 1.05 }
  };

  const SHAPES = {
    I: [[0,1],[1,1],[2,1],[3,1]],
    O: [[1,0],[2,0],[1,1],[2,1]],
    T: [[0,1],[1,1],[2,1],[1,0]],
    S: [[1,0],[2,0],[0,1],[1,1]],
    Z: [[0,0],[1,0],[1,1],[2,1]],
    J: [[0,0],[0,1],[1,1],[2,1]],
    L: [[2,0],[0,1],[1,1],[2,1]],
    DOT:    [[1,1]],
    DOMINO: [[1,1],[2,1]],
    TRIO:   [[1,1],[2,1],[3,1]],
    CORNER: [[1,1],[2,1],[1,2]],
    PLUS:   [[1,0],[0,1],[1,1],[2,1],[1,2]]
  };
  const SHAPE_KEYS = Object.keys(SHAPES);

  // ---------- state ----------
  let grid = makeEmptyGrid();      // mỗi ô lưu tên loại lính, BLANK, hoặc null
  let tray = [null, null, null];   // 3 khối tiếp theo hiện đang chờ ở thanh dưới
  let dragState = null;            // { slot, piece, w, h, tx, ty, valid } khi đang kéo
  let rowsCleared = 0;
  let paused = false;
  let gameOver = false;
  let started = false;

  let role = 'solo';       // 'solo' | 'host' | 'client'
  let mySide = 'A';        // 'A' (left) or 'B' (right)

  // simple "chơi với máy" bot: periodically spawns a random unit for side B
  let botEnabled = false;
  let botDifficulty = 'medium';
  let botTimer = BOT_DIFFICULTY[botDifficulty].minGap;

  // battle sim (authoritative when role is solo/host)
  let sim = { baseA: BASE_MAX_HP, baseB: BASE_MAX_HP, units: [], nextId: 1, over: false, winner: null };
  let lastRemoteState = null; // used when role === 'client'

  const hooks = {
    onLocalRowCleared: null,   // (rowTypes: string[], rowsClearedTotal) => {}
    onGameOver: null           // (winnerSide) => {}
  };

  // ---------- canvases ----------
  let puzzleCv, puzzleCtx, fieldCv, fieldCtx, dragCv, dragCtx;
  let traySlots = []; // [{canvas, ctx}]
  const cell = () => puzzleCv.width / COLS;

  function makeEmptyGrid(){
    const g = [];
    for (let r = 0; r < ROWS; r++) g.push(new Array(COLS).fill(null));
    return g;
  }

  // ---------- piece helpers ----------
  // normalize cells to a 0,0-based bounding box so all placement math can
  // ignore whatever raw offsets the SHAPES table happens to use.
  function normalizeCells(cells){
    const minX = Math.min(...cells.map(c => c[0]));
    const minY = Math.min(...cells.map(c => c[1]));
    return cells.map(([x, y]) => [x - minX, y - minY]);
  }

  function pieceBBox(cells){
    const w = Math.max(...cells.map(c => c[0])) + 1;
    const h = Math.max(...cells.map(c => c[1])) + 1;
    return { w, h };
  }

  function randomPiece(){
    const key = SHAPE_KEYS[Math.floor(Math.random() * SHAPE_KEYS.length)];
    const cells = normalizeCells(SHAPES[key].map(c => c.slice()));
    const types = assignCellTypes(cells.length);
    const { w, h } = pieceBBox(cells);
    return { key, cells, types, w, h };
  }

  function collidesAt(piece, tx, ty){
    for (const [cx, cy] of piece.cells) {
      const gx = tx + cx, gy = ty + cy;
      if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return true;
      if (grid[gy][gx]) return true;
    }
    return false;
  }

  function hasAnyPlacement(piece){
    if (!piece) return false;
    for (let ty = 0; ty <= ROWS - piece.h; ty++) {
      for (let tx = 0; tx <= COLS - piece.w; tx++) {
        if (!collidesAt(piece, tx, ty)) return true;
      }
    }
    return false;
  }

  // if none of the 3 pieces currently in the tray fit anywhere on the
  // board, soft-reset the grid instead of permanently jamming the player.
  function ensureTrayPlayable(){
    if (tray.some(p => hasAnyPlacement(p))) return;
    grid = makeEmptyGrid();
  }

  function refillSlot(i){
    tray[i] = randomPiece();
    drawTraySlot(i);
  }

  function initTray(){
    for (let i = 0; i < 3; i++) tray[i] = randomPiece();
    drawAllTraySlots();
  }

  function placePieceAt(piece, tx, ty){
    piece.cells.forEach(([cx, cy], i) => {
      grid[ty + cy][tx + cx] = piece.types[i];
    });
    clearFullRows();
  }

  function clearFullRows(){
    for (let r = ROWS - 1; r >= 0; r--) {
      if (grid[r].every(c => c)) {
        const rowTypes = grid[r].filter(t => t && t !== BLANK);
        grid.splice(r, 1);
        grid.unshift(new Array(COLS).fill(null));
        rowsCleared++;
        document.getElementById('rowsCleared').textContent = rowsCleared;
        triggerSummonEffect();
        if (hooks.onLocalRowCleared) hooks.onLocalRowCleared(rowTypes, rowsCleared);
        r++; // re-check same index after shift
      }
    }
  }

  function triggerSummonEffect(){
    const wrap = document.getElementById('battlefieldWrap');
    if (!wrap) return;
    const flash = document.createElement('div');
    flash.className = 'summon-flash';
    wrap.appendChild(flash);
    flash.addEventListener('animationend', () => flash.remove());
  }

  // ---------- puzzle rendering ----------
  function drawGrid(){
    const c = cell();
    puzzleCtx.clearRect(0, 0, puzzleCv.width, puzzleCv.height);
    puzzleCtx.strokeStyle = '#1b2531';
    puzzleCtx.lineWidth = 1;
    for (let x = 0; x <= COLS; x++) {
      puzzleCtx.beginPath(); puzzleCtx.moveTo(x*c, 0); puzzleCtx.lineTo(x*c, ROWS*c); puzzleCtx.stroke();
    }
    for (let y = 0; y <= ROWS; y++) {
      puzzleCtx.beginPath(); puzzleCtx.moveTo(0, y*c); puzzleCtx.lineTo(COLS*c, y*c); puzzleCtx.stroke();
    }
    for (let r = 0; r < ROWS; r++)
      for (let cIdx = 0; cIdx < COLS; cIdx++)
        if (grid[r][cIdx]) drawCell(puzzleCtx, cIdx, r, grid[r][cIdx], c);

    // drag placement preview — green if the held piece would fit at this
    // spot, red if not; recomputed every frame from dragState.
    if (dragState) {
      const { piece, tx, ty, valid } = dragState;
      piece.cells.forEach(([cx, cy]) => {
        drawDragPreviewCell(puzzleCtx, tx + cx, ty + cy, c, valid);
      });
    }

    if (paused) {
      puzzleCtx.fillStyle = 'rgba(6,8,11,.75)';
      puzzleCtx.fillRect(0, 0, puzzleCv.width, puzzleCv.height);
      puzzleCtx.fillStyle = '#d9a63e';
      puzzleCtx.font = '16px "Chakra Petch", sans-serif';
      puzzleCtx.textAlign = 'center';
      puzzleCtx.fillText('TẠM DỪNG', puzzleCv.width/2, puzzleCv.height/2);
    }
  }

  function drawDragPreviewCell(ctx, gx, gy, c, valid){
    if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return;
    const pad = 1.5;
    const x = gx*c + pad, y = gy*c + pad, w = c - pad*2, h = c - pad*2;
    ctx.save();
    ctx.fillStyle = valid ? 'rgba(78,224,138,.35)' : 'rgba(229,72,77,.35)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = valid ? '#4ee08a' : '#e5484d';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  // ô khối/lưới luôn nền TRẮNG — loại lính (nếu có) vẽ như glyph nhỏ bên
  // trong, ô BLANK là ô trắng trống hoàn toàn (không có nhân vật).
  function drawCell(ctx, gx, gy, type, c){
    const pad = 1.5;
    const x = gx*c + pad, y = gy*c + pad, w = c - pad*2, h = c - pad*2;

    ctx.fillStyle = '#f4f6f8';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#9aa5b0';
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    ctx.globalAlpha = 1;

    if (type && type !== BLANK && UNIT_DEFS[type]) {
      drawUnitIcon(ctx, x + w/2, y + h/2, Math.min(w, h), type);
    }
  }

  function drawUnitIcon(ctx, cx, cy, size, type){
    const def = UNIT_DEFS[type];
    const s = size * 0.42;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = def.color;
    ctx.strokeStyle = def.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (type === 'swordsman') {
      ctx.beginPath();
      ctx.arc(-s*0.05, -s*0.85, s*0.28, 0, Math.PI*2);
      ctx.fill();
      ctx.lineWidth = Math.max(1.4, size * 0.11);
      ctx.beginPath();
      ctx.moveTo(-s*0.05, -s*0.58);
      ctx.lineTo(-s*0.05, s*0.35);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-s*0.05, s*0.35); ctx.lineTo(-s*0.35, s*0.95);
      ctx.moveTo(-s*0.05, s*0.35); ctx.lineTo(s*0.2, s*0.95);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-s*0.05, -s*0.35);
      ctx.lineTo(s*0.32, -s*0.18);
      ctx.stroke();
      ctx.lineWidth = Math.max(1.7, size * 0.14);
      ctx.beginPath();
      ctx.moveTo(s*0.3, -s*0.2);
      ctx.lineTo(s*0.98, -s*1.05);
      ctx.stroke();
      ctx.lineWidth = Math.max(1.2, size * 0.09);
      ctx.beginPath();
      ctx.moveTo(s*0.15, -s*0.38);
      ctx.lineTo(s*0.48, -s*0.02);
      ctx.stroke();
    } else if (type === 'archer') {
      ctx.beginPath();
      ctx.arc(-s*0.15, -s*0.85, s*0.26, 0, Math.PI*2);
      ctx.fill();
      ctx.lineWidth = Math.max(1.4, size * 0.11);
      ctx.beginPath();
      ctx.moveTo(-s*0.15, -s*0.6);
      ctx.lineTo(-s*0.15, s*0.35);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-s*0.15, s*0.35); ctx.lineTo(-s*0.4, s*0.95);
      ctx.moveTo(-s*0.15, s*0.35); ctx.lineTo(s*0.05, s*0.95);
      ctx.stroke();
      ctx.lineWidth = Math.max(1.7, size * 0.13);
      ctx.beginPath();
      ctx.arc(s*0.35, -s*0.15, s*0.62, -Math.PI*0.42, Math.PI*0.42);
      ctx.stroke();
      ctx.lineWidth = Math.max(1, size * 0.06);
      ctx.beginPath();
      ctx.moveTo(s*0.62, -s*0.65);
      ctx.lineTo(s*0.05, -s*0.15);
      ctx.lineTo(s*0.62, s*0.35);
      ctx.stroke();
      ctx.lineWidth = Math.max(1.2, size * 0.08);
      ctx.beginPath();
      ctx.moveTo(s*0.05, -s*0.15);
      ctx.lineTo(s*0.85, -s*0.15);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s*0.85, -s*0.15);
      ctx.lineTo(s*0.55, -s*0.32);
      ctx.lineTo(s*0.55, s*0.02);
      ctx.closePath();
      ctx.fill();
    } else if (type === 'knight') {
      ctx.beginPath();
      ctx.ellipse(0, s*0.05, s*0.62, s*0.32, 0, 0, Math.PI*2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(s*0.45, -s*0.1);
      ctx.lineTo(s*0.85, -s*0.75);
      ctx.lineTo(s*1.05, -s*0.55);
      ctx.lineTo(s*0.65, s*0.05);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(s*0.78, -s*0.62);
      ctx.lineTo(s*0.9, -s*0.95);
      ctx.lineTo(s*0.95, -s*0.6);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = Math.max(1.2, size * 0.09);
      ctx.beginPath();
      ctx.moveTo(-s*0.4, s*0.32);  ctx.lineTo(-s*0.45, s*0.9);
      ctx.moveTo(-s*0.1, s*0.34);  ctx.lineTo(-s*0.15, s*0.9);
      ctx.moveTo(s*0.25, s*0.34);  ctx.lineTo(s*0.3, s*0.9);
      ctx.moveTo(s*0.5, s*0.28);   ctx.lineTo(s*0.55, s*0.85);
      ctx.stroke();
      ctx.lineWidth = Math.max(1.2, size * 0.08);
      ctx.beginPath();
      ctx.moveTo(-s*0.6, -s*0.05);
      ctx.quadraticCurveTo(-s*0.95, s*0.15, -s*0.75, s*0.55);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, -s*0.35, s*0.22, s*0.28, 0, 0, Math.PI*2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(s*0.02, -s*0.68, s*0.18, 0, Math.PI*2);
      ctx.fill();
      ctx.lineWidth = Math.max(1.3, size * 0.09);
      ctx.beginPath();
      ctx.moveTo(s*0.2, -s*0.4);
      ctx.lineTo(s*1.15, -s*0.7);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- tray (3 khối tiếp theo) rendering ----------
  function drawPieceIntoCanvas(canvas, ctx, piece){
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!piece) return;
    const pad = 6;
    const c = Math.min((canvas.width - pad*2) / piece.w, (canvas.height - pad*2) / piece.h);
    const offX = (canvas.width - piece.w*c) / (2*c);
    const offY = (canvas.height - piece.h*c) / (2*c);
    piece.cells.forEach(([cx, cy], i) => {
      drawCell(ctx, offX + cx, offY + cy, piece.types[i], c);
    });
  }

  function drawTraySlot(i){
    const slot = traySlots[i];
    if (!slot) return;
    drawPieceIntoCanvas(slot.canvas, slot.ctx, tray[i]);
  }

  function drawAllTraySlots(){
    for (let i = 0; i < traySlots.length; i++) drawTraySlot(i);
  }

  // ---------- drag & drop controls ----------
  function setupDragControls(){
    traySlots.forEach((slot, i) => {
      slot.canvas.addEventListener('pointerdown', (e) => onDragStart(e, i));
    });
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  }

  function onDragStart(e, slotIndex){
    if (paused || gameOver || !started) return;
    const piece = tray[slotIndex];
    if (!piece) return;
    e.preventDefault();

    const rect = puzzleCv.getBoundingClientRect();
    const cellPx = rect.width / COLS;

    dragState = {
      slot: slotIndex,
      piece,
      pointerId: e.pointerId,
      cellPx,
      tx: 0, ty: 0,
      valid: false
    };

    // hide the piece from its tray slot while it's being carried
    traySlots[slotIndex].ctx.clearRect(0, 0, traySlots[slotIndex].canvas.width, traySlots[slotIndex].canvas.height);

    // size + draw the floating "ghost" that follows the finger
    dragCv.width = piece.w * cellPx;
    dragCv.height = piece.h * cellPx;
    dragCv.style.width = dragCv.width + 'px';
    dragCv.style.height = dragCv.height + 'px';
    piece.cells.forEach(([cx, cy], i) => drawCell(dragCtx, cx, cy, piece.types[i], cellPx));
    dragCv.classList.remove('hidden');

    updateDragPosition(e.clientX, e.clientY);
  }

  function updateDragPosition(clientX, clientY){
    if (!dragState) return;
    const liftedY = clientY - DRAG_LIFT_PX;

    // position the floating ghost so its center sits at the lifted point
    dragCv.style.left = (clientX - dragCv.width / 2) + 'px';
    dragCv.style.top = (liftedY - dragCv.height / 2) + 'px';

    const rect = puzzleCv.getBoundingClientRect();
    const c = dragState.cellPx;
    const { piece } = dragState;

    // is the lifted point even over/near the grid? if it's way off, treat
    // the drop as a cancel rather than force-snapping to an edge.
    const margin = c * 1.5;
    const overGrid =
      clientX >= rect.left - margin && clientX <= rect.right + margin &&
      liftedY  >= rect.top  - margin && liftedY  <= rect.bottom + margin;

    if (!overGrid) {
      dragState.tx = null;
      dragState.ty = null;
      dragState.valid = false;
      return;
    }

    const fracCol = (clientX - rect.left) / c;
    const fracRow = (liftedY - rect.top) / c;
    let tx = Math.round(fracCol - piece.w / 2);
    let ty = Math.round(fracRow - piece.h / 2);
    tx = Math.max(0, Math.min(COLS - piece.w, tx));
    ty = Math.max(0, Math.min(ROWS - piece.h, ty));

    dragState.tx = tx;
    dragState.ty = ty;
    dragState.valid = !collidesAt(piece, tx, ty);
  }

  function onDragMove(e){
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    updateDragPosition(e.clientX, e.clientY);
  }

  function onDragEnd(e){
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const { slot, piece, tx, ty, valid } = dragState;

    dragCv.classList.add('hidden');

    if (valid && tx !== null) {
      placePieceAt(piece, tx, ty);
      refillSlot(slot);
      ensureTrayPlayable();
      drawAllTraySlots();
    } else {
      // cancelled — piece goes back to its tray slot unchanged
      drawTraySlot(slot);
    }

    dragState = null;
  }

  // ---------- main loop ----------
  let lastT = null;
  function loop(ts){
    if (lastT === null) lastT = ts;
    const dt = Math.min(0.05, (ts - lastT) / 1000);
    lastT = ts;

    if (started && !paused && !gameOver) {
      tickBattle(dt);
    }

    drawGrid();
    renderBattlefield();
    requestAnimationFrame(loop);
  }

  // ---------- battle simulation (solo/host authoritative) ----------
  function spawnUnit(side, type){
    if (gameOver || !UNIT_DEFS[type]) return;
    const def = UNIT_DEFS[type];
    // lính bên máy (side B khi đang chơi với bot) bị nhân sức mạnh theo
    // powerMult của độ khó — máu tính ngay lúc triệu hồi, sát thương/tốc
    // độ/tốc đánh tính động trong effectiveDef() bên dưới.
    const mult = (botEnabled && side === 'B') ? (BOT_DIFFICULTY[botDifficulty].powerMult || 1) : 1;
    const hp = def.hp * mult;
    sim.units.push({
      id: sim.nextId++, side, type,
      x: side === 'A' ? 0 : LANE_LEN,
      hp, maxHp: hp,
      cd: 0,
      spawnTime: performance.now(),
      buffed: true,
      powerMult: mult
    });
  }

  function effectiveDef(u){
    const def = UNIT_DEFS[u.type];
    const powerMult = u.powerMult || 1;
    const buffMult = u.buffed ? SPAWN_BUFF_MULT : 1;
    const mult = powerMult * buffMult;
    return {
      ...def,
      atk: def.atk * mult,
      speed: def.speed * mult,
      range: def.range * buffMult,
      cooldown: def.cooldown / mult
    };
  }

  function tickBattle(dt){
    if (role === 'client' || sim.over) return;

    if (botEnabled) {
      botTimer -= dt;
      if (botTimer <= 0) {
        const cfg = BOT_DIFFICULTY[botDifficulty];
        spawnUnit('B', weightedRandomType(cfg.weights));
        botTimer = cfg.minGap + Math.random() * (cfg.maxGap - cfg.minGap);
      }
    }

    const units = sim.units;

    for (const u of units) {
      if (u.hp <= 0) continue;
      u.buffed = (performance.now() - u.spawnTime) < SPAWN_BUFF_MS;
      const def = effectiveDef(u);
      const dir = u.side === 'A' ? 1 : -1;

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

      const enemyBaseX = u.side === 'A' ? LANE_LEN : 0;
      const distToBase = Math.abs(enemyBaseX - u.x);
      if (distToBase <= def.range) {
        u.cd -= dt;
        if (u.cd <= 0) {
          if (u.side === 'A') sim.baseB -= def.atk; else sim.baseA -= def.atk;
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
      units: sim.units.map(u => ({ side: u.side, type: u.type, x: u.x, hp: u.hp, maxHp: u.maxHp, buffed: u.buffed, powerMult: u.powerMult })),
      over: sim.over, winner: sim.winner
    };
  }

  function findEngagementTarget(state, u){
    const def = effectiveDef(u);
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

    const myHp = flip ? state.baseB : state.baseA;
    const enemyHp = flip ? state.baseA : state.baseB;
    drawBase(20, midY, myHp, '#d9a63e');
    drawBase(W - 20, midY, enemyHp, '#e5484d');

    for (const u of state.units) {
      const isMine = (flip ? u.side === 'B' : u.side === 'A');
      const x = toScreenX(u.x);
      const engageLogicalX = findEngagementTarget(state, u);
      const engageX = engageLogicalX === null ? null : toScreenX(engageLogicalX);
      drawUnit(x, midY, u, isMine, engageX);
    }

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
    const def = effectiveDef(u);
    const engaged = engageX !== null && engageX !== undefined;
    const localTargetX = engaged ? engageX - x : null;
    const dir = engaged ? (localTargetX >= 0 ? 1 : -1) : (u.side === 'A' ? 1 : -1);

    fieldCtx.save();
    fieldCtx.translate(x, y);

    fieldCtx.fillStyle = def.color;
    fieldCtx.globalAlpha = isMine ? 1 : 0.85;
    fieldCtx.beginPath();
    fieldCtx.arc(0, 0, def.radius, 0, Math.PI*2);
    fieldCtx.fill();
    fieldCtx.strokeStyle = isMine ? '#d9a63e' : '#0a0e14';
    fieldCtx.lineWidth = 2;
    fieldCtx.stroke();
    fieldCtx.globalAlpha = 1;

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
    } else if (u.type === 'knight') {
      fieldCtx.strokeStyle = '#d9a63e';
      fieldCtx.lineWidth = 3;
      fieldCtx.beginPath();
      fieldCtx.moveTo(def.radius - 2, 0);
      fieldCtx.lineTo(def.radius + 16, 0);
      fieldCtx.stroke();
      fieldCtx.fillStyle = '#d9a63e';
      fieldCtx.beginPath();
      fieldCtx.moveTo(def.radius + 16, -3);
      fieldCtx.lineTo(def.radius + 22, 0);
      fieldCtx.lineTo(def.radius + 16, 3);
      fieldCtx.closePath();
      fieldCtx.fill();
      fieldCtx.strokeStyle = '#0a0e14';
      fieldCtx.lineWidth = 2;
      fieldCtx.beginPath();
      fieldCtx.moveTo(-def.radius + 3, def.radius - 3);
      fieldCtx.lineTo(-def.radius + 6, def.radius + 5);
      fieldCtx.moveTo(-def.radius - 2, def.radius - 3);
      fieldCtx.lineTo(-def.radius - 5, def.radius + 5);
      fieldCtx.stroke();
    }
    fieldCtx.restore();

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

    if (u.buffed) {
      fieldCtx.save();
      fieldCtx.strokeStyle = 'rgba(217,166,62,0.9)';
      fieldCtx.lineWidth = 2;
      const pulse = def.radius + 4 + Math.sin(performance.now() / 80) * 2;
      fieldCtx.beginPath();
      fieldCtx.arc(0, 0, pulse, 0, Math.PI*2);
      fieldCtx.stroke();
      fieldCtx.restore();
    }

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
    setupDragControls();

    document.getElementById('btnPause').addEventListener('click', () => {
      paused = !paused;
      document.getElementById('btnPause').textContent = paused ? 'TIẾP TỤC' : 'TẠM DỪNG';
    });
  }

  // ---------- public API ----------
  function init(){
    puzzleCv = document.getElementById('puzzleGrid'); puzzleCtx = puzzleCv.getContext('2d');
    fieldCv = document.getElementById('battlefield'); fieldCtx = fieldCv.getContext('2d');
    dragCv = document.getElementById('dragGhost'); dragCtx = dragCv.getContext('2d');

    traySlots = Array.from(document.querySelectorAll('.tray-slot')).map(canvas => ({
      canvas, ctx: canvas.getContext('2d')
    }));

    initTray();
    setupControls();
    requestAnimationFrame(loop);
  }

  function resetState(){
    grid = makeEmptyGrid();
    sim = { baseA: BASE_MAX_HP, baseB: BASE_MAX_HP, units: [], nextId: 1, over: false, winner: null };
    lastRemoteState = null;
    rowsCleared = 0; gameOver = false; paused = false;
    botTimer = BOT_DIFFICULTY[botDifficulty].minGap;
    dragState = null;
    if (dragCv) dragCv.classList.add('hidden');
    document.getElementById('rowsCleared').textContent = 0;
    document.getElementById('gameOverBanner').classList.add('hidden');
    document.getElementById('btnPause').textContent = 'TẠM DỪNG';
    initTray();
  }

  return {
    init,
    hooks,
    setRole(r, side){ role = r; mySide = side; },
    getMySide(){ return mySide; },
    setBotMode(enabled, difficulty){
      botEnabled = enabled;
      if (difficulty && BOT_DIFFICULTY[difficulty]) botDifficulty = difficulty;
      botTimer = BOT_DIFFICULTY[botDifficulty].minGap;
    },
    spawnUnit,
    onRemoteSpawn(side, type){ spawnUnit(side, type); },
    getSnapshot,
    applyRemoteState,
    prepare(){
      resetState();
      started = false;
    },
    start(){
      resetState();
      started = true;
    }
  };
})();

document.addEventListener('DOMContentLoaded', () => Game.init());
