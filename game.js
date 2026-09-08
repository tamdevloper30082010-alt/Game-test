/* ===========================================================
   PUZZLE BATTALION — game.js
   Owns: puzzle grid (tetromino fall/clear) + battlefield sim/render.
   Knows NOTHING about networking directly — it only calls the
   hooks in Game.hooks, which net.js fills in. This keeps the game
   fully playable offline (solo sandbox) even with no P2P library.
   =========================================================== */

const Game = (() => {

  // ---------- constants ----------
  // Giữ đúng tỉ lệ 4:5 như cũ (8:10) để ô luôn vuông và khung lưới không
  // đổi hình dạng trên giao diện — chỉ tăng số ô để mỗi ô nhỏ lại và xếp
  // được nhiều khối hơn trên cùng một khung.
  const COLS = 12, ROWS = 15;
  // battlefield "width": only affects how long a unit takes to walk from
  // base to base (toScreenX below normalizes by LANE_LEN, so the UI never
  // gets visually wider/longer — only travel time changes).
  const LANE_LEN = 1500;
  const BASE_MAX_HP = 3000;

  // ---------- unit stat sheet (thang điểm 0–10) ----------
  // hpBase / atkBase: số máu / sát thương "đọc được" theo yêu cầu thiết kế.
  // atkSpeedRating / speedRating: thang 0-10, quy đổi bên dưới.
  //   - tốc đánh: 10/10 = 1 giây/đòn, 1/10 = 10 giây/đòn  → cooldown = 10 / rating
  //   - tốc độ:   quy tuyến tính theo rating/10 * speedMax
  const UNIT_DEFS_RAW = {
    swordsman: { hpBase: 6, atkBase: 0.6, atkSpeedRating: 4,  speedRating: 4, range: 16,  radius: 11, color: '#e5484d' },
    archer:    { hpBase: 3, atkBase: 1,   atkSpeedRating: 8,  speedRating: 3, range: 130, radius: 9,  color: '#3aa0ff' },
    knight:    { hpBase: 4, atkBase: 0.7, atkSpeedRating: 10, speedRating: 7, range: 20,  radius: 13, color: '#4ee08a' }
  };
  // hệ số quy đổi từ thang điểm sang số liệu thật dùng trong mô phỏng —
  // chỉnh ở đây để cân bằng lại toàn bộ game mà không đụng vào công thức.
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

  // đơn vị mới triệu hồi được +40% tất cả chỉ số chiến đấu (sát thương, tốc
  // độ, tầm đánh, tốc đánh) trong 1.5 giây rồi trở lại bình thường.
  const SPAWN_BUFF_MULT = 1.4;
  const SPAWN_BUFF_MS = 1500;

  // tỉ lệ loại lính được gán cho MỖI Ô "có lính" của khối rơi (độc lập theo
  // từng ô, nên một khối có thể chứa nhiều loại lính khác nhau cùng lúc).
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

  // ---------- "số ô có lính" trong một khối rơi ----------
  // Không phải mọi ô của khối đều chứa lính. Mỗi khối rơi random ra "có bao
  // nhiêu ô có lính" theo phân phối dưới đây (chỉ số mảng = số ô có lính,
  // giá trị = xác suất) — càng nhiều ô có lính thì xác suất càng thấp.
  // Khối 4 ô (I/O/T/S/Z/J/L) dùng đúng tỉ lệ yêu cầu: 10% 0 ô, 50% 1 ô,
  // 20% 2 ô, 15% 3 ô, 5% 4 ô. Các kích thước khối khác (1/2/3/5 ô) suy ra
  // theo cùng quy luật: đỉnh phân phối ở 1 ô, giảm dần khi số ô tăng.
  const CELL_FILL_DIST_BY_SIZE = {
    1: [0.20, 0.80],
    2: [0.20, 0.60, 0.20],
    3: [0.15, 0.55, 0.20, 0.10],
    4: [0.10, 0.50, 0.20, 0.15, 0.05],
    5: [0.08, 0.45, 0.20, 0.15, 0.08, 0.04]
  };
  // giá trị đánh dấu một ô của khối/lưới bị chiếm chỗ (chặn va chạm, tính
  // để nổ hàng) nhưng KHÔNG có lính bên trong — hiển thị là ô trắng trống.
  const BLANK = 'blank';

  function pickFilledCellCount(total){
    const dist = CELL_FILL_DIST_BY_SIZE[total];
    if (!dist) return total; // fallback an toàn nếu có hình mới chưa khai báo
    const r = Math.random();
    let acc = 0;
    for (let k = 0; k < dist.length; k++) {
      acc += dist[k];
      if (r <= acc) return k;
    }
    return dist.length - 1;
  }

  // gán loại lính (hoặc BLANK) cho từng ô của một khối có `total` ô: chọn
  // ngẫu nhiên vị trí nào có lính theo pickFilledCellCount, các ô còn lại
  // là BLANK (trắng, trống).
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
  // và tỉ lệ loại lính máy chọn (khó hơn = triệu hồi nhanh hơn & thiên về
  // lính mạnh/nhanh hơn).
  const BOT_DIFFICULTY = {
    easy:   { minGap: 3.5, maxGap: 6.0, weights: { swordsman: 0.5,  archer: 0.3,  knight: 0.2  } },
    medium: { minGap: 2.2, maxGap: 4.0, weights: { swordsman: 0.4,  archer: 0.35, knight: 0.25 } },
    hard:   { minGap: 1.2, maxGap: 2.4, weights: { swordsman: 0.3,  archer: 0.35, knight: 0.35 } }
  };

  const SHAPES = {
    I: [[0,1],[1,1],[2,1],[3,1]],
    O: [[1,0],[2,0],[1,1],[2,1]],
    T: [[0,1],[1,1],[2,1],[1,0]],
    S: [[1,0],[2,0],[0,1],[1,1]],
    Z: [[0,0],[1,0],[1,1],[2,1]],
    J: [[0,0],[0,1],[1,1],[2,1]],
    L: [[2,0],[0,1],[1,1],[2,1]],
    // các hình mới — thêm độ đa dạng cho khối rơi
    DOT:    [[1,1]],
    DOMINO: [[1,1],[2,1]],
    TRIO:   [[1,1],[2,1],[3,1]],
    CORNER: [[1,1],[2,1],[1,2]],
    PLUS:   [[1,0],[0,1],[1,1],[2,1],[1,2]]
  };
  const SHAPE_KEYS = Object.keys(SHAPES);

  // ---------- state ----------
  let grid = makeEmptyGrid();      // mỗi ô lưu tên loại lính, BLANK (ô trắng trống), hoặc null (chưa chiếm chỗ)
  let cur = null;                  // current falling piece: { key, cells, types, x, y }
  let nextType = null;             // { key, cells, types }
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
    const cells = SHAPES[key].map(c => c.slice());
    const types = assignCellTypes(cells.length);
    return { key, cells, types };
  }

  function spawnPiece(){
    const piece = nextType || randomPiece();
    cur = {
      key: piece.key,
      cells: piece.cells.map(c => c.slice()),
      types: piece.types.slice(),
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
    // rotate around piece-local center (2,2) for a 4x4 box, classic SRS-lite.
    // `types` stays index-aligned with `cells`, so it doesn't need to change.
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
    cur.cells.forEach(([cx, cy], i) => {
      const gx = cur.x + cx, gy = cur.y + cy;
      if (gy >= 0) grid[gy][gx] = cur.types[i];
    });
    clearFullRows();
    spawnPiece();
  }

  function clearFullRows(){
    for (let r = ROWS - 1; r >= 0; r--) {
      if (grid[r].every(c => c)) {
        // chỉ những ô THỰC SỰ có lính (khác BLANK) mới triệu hồi ra chiến
        // trường — ô trắng trống trong hàng vừa nổ không sinh ra lính nào.
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

  // visual-only pulse over the battlefield the instant a row clears —
  // reads as "triệu hồi ra chiến trường" even before the units render in.
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
    if (cur) cur.cells.forEach(([cx, cy], i) => {
      if (cur.y + cy >= 0) drawCell(puzzleCtx, cur.x + cx, cur.y + cy, cur.types[i], c);
    });

    if (paused) {
      puzzleCtx.fillStyle = 'rgba(6,8,11,.75)';
      puzzleCtx.fillRect(0, 0, puzzleCv.width, puzzleCv.height);
      puzzleCtx.fillStyle = '#d9a63e';
      puzzleCtx.font = '16px "Chakra Petch", sans-serif';
      puzzleCtx.textAlign = 'center';
      puzzleCtx.fillText('TẠM DỪNG', puzzleCv.width/2, puzzleCv.height/2);
    }
  }

  // ô khối/lưới giờ luôn nền TRẮNG — loại lính (nếu ô đó có lính) chỉ được
  // vẽ như một hình nhân vật nhỏ (glyph) bên trong, còn ô BLANK là ô trắng
  // trống hoàn toàn (không có nhân vật).
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

  // vẽ một glyph nhỏ đại diện cho từng loại lính, dùng màu gốc của loại đó
  // (đỏ/xanh dương/xanh lá) để vẫn phân biệt được loại lính dù nền ô trắng.
  function drawUnitIcon(ctx, cx, cy, size, type){
    const def = UNIT_DEFS[type];
    const s = size * 0.32;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = def.color;
    ctx.fillStyle = def.color;
    ctx.lineWidth = Math.max(1, size * 0.09);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (type === 'swordsman') {
      // lưỡi kiếm
      ctx.beginPath();
      ctx.moveTo(0, -s*1.3);
      ctx.lineTo(0, s*0.9);
      ctx.stroke();
      // cán chắn ngang
      ctx.beginPath();
      ctx.moveTo(-s*0.6, s*0.15);
      ctx.lineTo(s*0.6, s*0.15);
      ctx.stroke();
      // chuôi kiếm
      ctx.beginPath();
      ctx.arc(0, s*1.15, s*0.18, 0, Math.PI*2);
      ctx.fill();
    } else if (type === 'archer') {
      // cánh cung
      ctx.beginPath();
      ctx.arc(0, 0, s*1.1, -Math.PI*0.35, Math.PI*0.35);
      ctx.stroke();
      // dây cung
      ctx.beginPath();
      ctx.moveTo(s*0.75, -s*0.85);
      ctx.lineTo(s*0.75, s*0.85);
      ctx.stroke();
      // thân mũi tên
      ctx.beginPath();
      ctx.moveTo(-s*0.9, 0);
      ctx.lineTo(s*0.75, 0);
      ctx.stroke();
      // đầu mũi tên
      ctx.beginPath();
      ctx.moveTo(s*0.75, 0);
      ctx.lineTo(s*0.35, -s*0.3);
      ctx.lineTo(s*0.35, s*0.3);
      ctx.closePath();
      ctx.fill();
    } else if (type === 'knight') {
      // đầu ngựa cách điệu: thân hình thoi + 2 tai
      ctx.beginPath();
      ctx.moveTo(0, -s*1.2);
      ctx.lineTo(s*0.9, 0);
      ctx.lineTo(0, s*1.2);
      ctx.lineTo(-s*0.9, 0);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-s*0.25, -s*1.1);
      ctx.lineTo(-s*0.05, -s*1.75);
      ctx.lineTo(s*0.15, -s*1.05);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawNextPreview(){
    nextCtx.clearRect(0, 0, nextCv.width, nextCv.height);
    const c = 18;
    const offX = (nextCv.width - 4*c) / 2, offY = (nextCv.height - 4*c) / 2;
    nextType.cells.forEach(([cx, cy], i) => {
      const type = nextType.types[i];
      const x = offX + cx*c + 1, y = offY + cy*c + 1, w = c - 2, h = c - 2;

      nextCtx.fillStyle = '#f4f6f8';
      nextCtx.fillRect(x, y, w, h);
      nextCtx.strokeStyle = '#9aa5b0';
      nextCtx.globalAlpha = 0.7;
      nextCtx.lineWidth = 1;
      nextCtx.strokeRect(x, y, w, h);
      nextCtx.globalAlpha = 1;

      if (type && type !== BLANK && UNIT_DEFS[type]) {
        drawUnitIcon(nextCtx, x + w/2, y + h/2, Math.min(w, h), type);
      }
    });
  }

  // ---------- battle simulation (solo/host authoritative) ----------
  function spawnUnit(side, type){
    if (gameOver || !UNIT_DEFS[type]) return;
    const def = UNIT_DEFS[type];
    sim.units.push({
      id: sim.nextId++, side, type,
      x: side === 'A' ? 0 : LANE_LEN,
      hp: def.hp, maxHp: def.hp,
      cd: 0,
      spawnTime: performance.now(),
      buffed: true
    });
  }

  // stats "hiệu lực" tại thời điểm hiện tại — cộng thêm buff mới-triệu-hồi
  // (sát thương / tốc độ / tầm đánh +40%, tốc đánh nhanh hơn tương ứng)
  // nếu đơn vị vẫn còn trong 1.5 giây đầu đời.
  function effectiveDef(u){
    const def = UNIT_DEFS[u.type];
    if (!u.buffed) return def;
    return {
      ...def,
      atk: def.atk * SPAWN_BUFF_MULT,
      speed: def.speed * SPAWN_BUFF_MULT,
      range: def.range * SPAWN_BUFF_MULT,
      cooldown: def.cooldown / SPAWN_BUFF_MULT
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
      units: sim.units.map(u => ({ side: u.side, type: u.type, x: u.x, hp: u.hp, maxHp: u.maxHp, buffed: u.buffed })),
      over: sim.over, winner: sim.winner
    };
  }

  // pure function of a snapshot — works identically for the host's own sim
  // and for the client's last-received broadcast, so no extra network state
  // is needed to know when a unit is "firing" for rendering purposes.
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
    const def = effectiveDef(u);
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
    } else if (u.type === 'knight') {
      // lance
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
      // hind legs hint (cưỡi ngựa)
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

    // buff ring — pulsing gold halo while the +40% mới-triệu-hồi buff is active
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

    // explicit rotate button — same as swipe-up/ArrowUp, useful on mobile
    // where a deliberate tap is easier than a precise upward swipe.
    document.getElementById('btnRotate').addEventListener('click', () => {
      if (!paused && !gameOver) tryRotate();
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
    rowsCleared = 0; gameOver = false; paused = false;
    botTimer = BOT_DIFFICULTY[botDifficulty].minGap;
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
    // difficulty: 'easy' | 'medium' | 'hard' (defaults to 'medium' / keeps
    // the current one if an unknown value is passed)
    setBotMode(enabled, difficulty){
      botEnabled = enabled;
      if (difficulty && BOT_DIFFICULTY[difficulty]) botDifficulty = difficulty;
      botTimer = BOT_DIFFICULTY[botDifficulty].minGap;
    },
    spawnUnit,
    onRemoteSpawn(side, type){ spawnUnit(side, type); },
    getSnapshot,
    applyRemoteState,
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
