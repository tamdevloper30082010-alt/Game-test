/* ===========================================================
   PUZZLE BATTALION — net.js
   Serverless P2P via PeerJS public cloud (signaling only).
   Room code = 3-4 digit number used as the Peer ID suffix.
   Host runs the authoritative battle sim (from game.js) and
   broadcasts state; the client sends puzzle spawn events and
   renders whatever the host broadcasts. See plan section III.

   Also wires the home-menu screen (create / join / vs bot) and
   handles camera+mic acquisition with graceful fallbacks.
   =========================================================== */

const Net = (() => {

  const PEER_PREFIX = 'puzzlebattalion-';
  const ICE_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const STATE_HZ = 12; // host -> client broadcast rate

  let peer = null;
  let conn = null;          // PeerJS DataConnection
  let mediaCall = null;
  let localStream = null;
  let role = 'solo';        // 'solo' | 'host' | 'client'
  let broadcastTimer = null;

  const els = {};

  function cacheEls(){
    els.homeScreen   = document.getElementById('homeScreen');
    els.app          = document.getElementById('app');
    els.homeStatus   = document.getElementById('homeStatus');
    els.menuHost     = document.getElementById('menuHost');
    els.menuJoinToggle = document.getElementById('menuJoinToggle');
    els.joinPanel    = document.getElementById('joinPanel');
    els.homeRoomInput = document.getElementById('homeRoomInput');
    els.menuJoinConfirm = document.getElementById('menuJoinConfirm');
    els.menuBot      = document.getElementById('menuBot');

    els.btnHome   = document.getElementById('btnHome');
    els.connDot   = document.getElementById('connState');
    els.roomLabel = document.getElementById('roomLabel');
    els.btnMic    = document.getElementById('btnMic');
    els.btnCam    = document.getElementById('btnCam');
    els.localVideo  = document.getElementById('localVideo');
    els.remoteVideo = document.getElementById('remoteVideo');
    els.chatForm  = document.getElementById('chatForm');
    els.chatInput = document.getElementById('chatInput');
    els.danmakuLayer = document.getElementById('danmakuLayer');
  }

  function setConnState(state){
    els.connDot.className = 'conn-dot ' + state; // offline | connecting | online
  }

  function setHomeStatus(text){
    els.homeStatus.textContent = text || '';
  }

  function randomRoomCode(){
    return String(Math.floor(1000 + Math.random() * 9000)); // 4 digits
  }

  function showGameScreen(){
    els.homeScreen.classList.add('hidden');
    els.app.classList.remove('hidden');
  }

  // ---------- media (camera / mic) ----------
  // Tries video+audio first, then falls back to whichever device is
  // actually available so one denied/missing device doesn't kill both.
  async function ensureLocalMedia(){
    if (localStream) return localStream;
    const attempts = [
      { video: true, audio: true },
      { video: false, audio: true },
      { video: true, audio: false }
    ];
    for (const constraints of attempts) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        console.warn('getUserMedia thất bại với', constraints, err.name);
      }
    }
    if (localStream) {
      els.localVideo.srcObject = localStream;
    }
    syncMediaButtons();
    return localStream;
  }

  function syncMediaButtons(){
    const audioTrack = localStream && localStream.getAudioTracks()[0];
    const videoTrack = localStream && localStream.getVideoTracks()[0];

    if (audioTrack) {
      els.btnMic.disabled = false;
      els.btnMic.dataset.on = audioTrack.enabled ? '1' : '0';
      els.btnMic.textContent = 'MIC: ' + (audioTrack.enabled ? 'BẬT' : 'TẮT');
    } else {
      els.btnMic.disabled = true;
      els.btnMic.dataset.on = '0';
      els.btnMic.textContent = 'MIC: KHÔNG CÓ';
    }

    if (videoTrack) {
      els.btnCam.disabled = false;
      els.btnCam.dataset.on = videoTrack.enabled ? '1' : '0';
      els.btnCam.textContent = 'CAM: ' + (videoTrack.enabled ? 'BẬT' : 'TẮT');
    } else {
      els.btnCam.disabled = true;
      els.btnCam.dataset.on = '0';
      els.btnCam.textContent = 'CAM: KHÔNG CÓ';
    }
  }

  function wireMediaButtons(){
    els.btnMic.addEventListener('click', () => {
      const track = localStream && localStream.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      syncMediaButtons();
    });
    els.btnCam.addEventListener('click', () => {
      const track = localStream && localStream.getVideoTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      syncMediaButtons();
    });
  }

  // ---------- data channel protocol ----------
  function onData(msg){
    switch (msg.type) {
      case 'spawn':
        // only the host acts on spawn requests, coming from the client (side B)
        if (role === 'host') Game.onRemoteSpawn(msg.side, msg.unitType);
        break;
      case 'state':
        if (role === 'client') Game.applyRemoteState(msg.state);
        break;
      case 'chat':
        spawnDanmaku(msg.text, 'theirs');
        break;
    }
  }

  function send(msg){
    if (conn && conn.open) conn.send(msg);
  }

  function attachConnHandlers(c){
    conn = c;
    conn.on('open', () => {
      setConnState('online');
      els.roomLabel.textContent = 'ĐÃ KẾT NỐI';
      if (role === 'host') startBroadcasting();
    });
    conn.on('data', onData);
    conn.on('close', () => {
      setConnState('offline');
      els.roomLabel.textContent = 'MẤT KẾT NỐI';
      stopBroadcasting();
    });
    conn.on('error', (e) => console.warn('Data connection error:', e));
  }

  function startBroadcasting(){
    stopBroadcasting();
    broadcastTimer = setInterval(() => {
      send({ type: 'state', state: Game.getSnapshot() });
    }, 1000 / STATE_HZ);
  }
  function stopBroadcasting(){
    if (broadcastTimer) clearInterval(broadcastTimer);
    broadcastTimer = null;
  }

  function peerJsAvailable(){
    return typeof Peer !== 'undefined';
  }

  // ---------- host / join / bot flows ----------
  async function hostGame(){
    if (!peerJsAvailable()) {
      setHomeStatus('Không tải được thư viện PeerJS — kiểm tra kết nối mạng rồi thử lại.');
      return;
    }
    role = 'host';
    Game.setRole('host', 'A');
    Game.setBotMode(false);
    showGameScreen();
    setConnState('connecting');

    const code = randomRoomCode();
    els.roomLabel.textContent = 'ĐANG MỞ PHÒNG ' + code + '...';

    await ensureLocalMedia();

    try {
      peer = new Peer(PEER_PREFIX + code, { config: ICE_CONFIG });
    } catch (err) {
      els.roomLabel.textContent = 'LỖI KHỞI TẠO PEER: ' + err.message;
      return;
    }

    peer.on('open', () => {
      els.roomLabel.textContent = 'MÃ PHÒNG: ' + code + ' — đang chờ đối thủ...';
    });
    peer.on('connection', (c) => attachConnHandlers(c));
    peer.on('call', (call) => {
      call.answer(localStream || undefined);
      mediaCall = call;
      call.on('stream', (remoteStream) => { els.remoteVideo.srcObject = remoteStream; });
    });
    peer.on('error', (e) => {
      console.warn('Peer error:', e);
      setConnState('offline');
      els.roomLabel.textContent = e.type === 'unavailable-id'
        ? 'Mã phòng đang được dùng, hãy về trang chủ và tạo lại.'
        : 'LỖI KẾT NỐI: ' + e.type;
    });
  }

  async function joinGame(code){
    if (!peerJsAvailable()) {
      setHomeStatus('Không tải được thư viện PeerJS — kiểm tra kết nối mạng rồi thử lại.');
      return;
    }
    if (!/^\d{3,4}$/.test(code)) {
      setHomeStatus('Nhập mã phòng 3-4 số.');
      return;
    }

    role = 'client';
    Game.setRole('client', 'B');
    Game.setBotMode(false);
    showGameScreen();
    setConnState('connecting');
    els.roomLabel.textContent = 'ĐANG VÀO PHÒNG ' + code + '...';

    await ensureLocalMedia();

    try {
      peer = new Peer({ config: ICE_CONFIG });
    } catch (err) {
      els.roomLabel.textContent = 'LỖI KHỞI TẠO PEER: ' + err.message;
      return;
    }

    peer.on('open', () => {
      const c = peer.connect(PEER_PREFIX + code, { reliable: true });
      attachConnHandlers(c);
      if (localStream && localStream.getTracks().length) {
        mediaCall = peer.call(PEER_PREFIX + code, localStream);
        mediaCall.on('stream', (remoteStream) => { els.remoteVideo.srcObject = remoteStream; });
      }
    });
    peer.on('call', (call) => {
      call.answer(localStream || undefined);
      call.on('stream', (remoteStream) => { els.remoteVideo.srcObject = remoteStream; });
    });
    peer.on('error', (e) => {
      console.warn('Peer error:', e);
      setConnState('offline');
      els.roomLabel.textContent = e.type === 'peer-unavailable'
        ? 'Không tìm thấy phòng với mã này.'
        : 'LỖI KẾT NỐI: ' + e.type;
    });
  }

  function startBotGame(){
    role = 'solo';
    Game.setRole('solo', 'A');
    Game.setBotMode(true);
    showGameScreen();
    setConnState('offline');
    els.roomLabel.textContent = 'CHẾ ĐỘ CHƠI VỚI MÁY';
    // camera/mic optional in bot mode — try to get it for the self-preview,
    // but never block starting the match if it fails.
    ensureLocalMedia();
  }

  function teardown(){
    stopBroadcasting();
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (conn) { try { conn.close(); } catch (e) {} }
    if (mediaCall) { try { mediaCall.close(); } catch (e) {} }
    if (peer) { try { peer.destroy(); } catch (e) {} }
  }

  // ---------- bullet chat (danmaku) ----------
  function spawnDanmaku(text, who){
    const item = document.createElement('div');
    item.className = 'danmaku-item ' + (who === 'mine' ? 'mine' : 'theirs');
    item.textContent = (who === 'mine' ? '► ' : '◄ ') + text;
    const layerH = els.danmakuLayer.clientHeight || 26;
    item.style.top = Math.max(2, Math.random() * (layerH - 16)) + 'px';
    item.style.left = els.danmakuLayer.clientWidth + 'px';
    els.danmakuLayer.appendChild(item);

    requestAnimationFrame(() => {
      const distance = els.danmakuLayer.clientWidth + item.offsetWidth + 20;
      const duration = 4500 + Math.random() * 1500;
      const anim = item.animate(
        [{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }],
        { duration, easing: 'linear', fill: 'forwards' }
      );
      anim.onfinish = () => item.remove();
    });
  }

  function wireChatForm(){
    els.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = els.chatInput.value.trim();
      if (!text) return;
      spawnDanmaku(text, 'mine');
      send({ type: 'chat', text });
      els.chatInput.value = '';
    });
  }

  // ---------- puzzle -> battle bridge ----------
  function wireGameHooks(){
    Game.hooks.onLocalRowCleared = (color) => {
      const unitType = Game.colorToType(color);
      const side = Game.getMySide();
      if (role === 'client') {
        send({ type: 'spawn', side, unitType });
      } else {
        // solo sandbox, vs-bot, or host: spawn directly into the authoritative sim
        Game.spawnUnit(side, unitType);
      }
    };
    Game.hooks.onGameOver = () => { stopBroadcasting(); };
  }

  // ---------- home menu wiring ----------
  function wireHomeMenu(){
    els.menuHost.addEventListener('click', () => { setHomeStatus(''); hostGame(); });

    els.menuJoinToggle.addEventListener('click', () => {
      els.joinPanel.classList.toggle('hidden');
      if (!els.joinPanel.classList.contains('hidden')) els.homeRoomInput.focus();
    });

    els.menuJoinConfirm.addEventListener('click', () => {
      setHomeStatus('');
      joinGame((els.homeRoomInput.value || '').trim());
    });
    els.homeRoomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') els.menuJoinConfirm.click();
    });

    els.menuBot.addEventListener('click', () => { setHomeStatus(''); startBotGame(); });

    els.btnHome.addEventListener('click', () => {
      teardown();
      location.reload();
    });
  }

  function init(){
    cacheEls();
    wireMediaButtons();
    wireChatForm();
    wireGameHooks();
    wireHomeMenu();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => Net.init());
