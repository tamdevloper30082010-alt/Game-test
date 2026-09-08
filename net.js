/* ===========================================================
   PUZZLE BATTALION — net.js
   Serverless P2P via PeerJS public cloud (signaling only).
   Room code = 3-4 digit number used as the Peer ID suffix.
   Host runs the authoritative battle sim (from game.js) and
   broadcasts state; the client sends puzzle spawn events and
   renders whatever the host broadcasts. See plan section III.
   =========================================================== */

const Net = (() => {

  const PEER_PREFIX = 'puzzlebattalion-';
  const ICE_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const STATE_HZ = 12; // host -> client broadcast rate

  let peer = null;
  let conn = null;          // RTCDataConnection (PeerJS DataConnection)
  let mediaCall = null;
  let localStream = null;
  let role = 'solo';        // 'solo' | 'host' | 'client'
  let broadcastTimer = null;

  const els = {};

  function cacheEls(){
    els.connDot   = document.getElementById('connState');
    els.roomInput = document.getElementById('roomInput');
    els.roomLabel = document.getElementById('roomLabel');
    els.btnHost   = document.getElementById('btnHost');
    els.btnJoin   = document.getElementById('btnJoin');
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

  function randomRoomCode(){
    return String(Math.floor(1000 + Math.random() * 9000)); // 4 digits
  }

  // ---------- media ----------
  async function ensureLocalMedia(){
    if (localStream) return localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      els.localVideo.srcObject = localStream;
    } catch (err) {
      console.warn('Không lấy được camera/mic:', err);
      localStream = null;
    }
    return localStream;
  }

  function wireMediaButtons(){
    els.btnMic.addEventListener('click', () => {
      if (!localStream) return;
      const track = localStream.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      els.btnMic.dataset.on = track.enabled ? '1' : '0';
      els.btnMic.textContent = 'MIC: ' + (track.enabled ? 'BẬT' : 'TẮT');
    });
    els.btnCam.addEventListener('click', () => {
      if (!localStream) return;
      const track = localStream.getVideoTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      els.btnCam.dataset.on = track.enabled ? '1' : '0';
      els.btnCam.textContent = 'CAM: ' + (track.enabled ? 'BẬT' : 'TẮT');
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

  // ---------- host / join flows ----------
  async function hostGame(){
    const code = randomRoomCode();
    role = 'host';
    Game.setRole('host', 'A');
    setConnState('connecting');
    els.roomLabel.textContent = 'PHÒNG ' + code + ' — đang chờ đối thủ...';

    await ensureLocalMedia();

    peer = new Peer(PEER_PREFIX + code, { config: ICE_CONFIG });
    peer.on('open', () => { els.roomInput.value = code; });
    peer.on('connection', (c) => attachConnHandlers(c));
    peer.on('call', (call) => {
      call.answer(localStream || undefined);
      mediaCall = call;
      call.on('stream', (remoteStream) => { els.remoteVideo.srcObject = remoteStream; });
    });
    peer.on('error', (e) => {
      console.warn('Peer error:', e);
      setConnState('offline');
      els.roomLabel.textContent = 'LỖI: ' + e.type;
    });
  }

  async function joinGame(){
    const code = (els.roomInput.value || '').trim();
    if (!/^\d{3,4}$/.test(code)) {
      els.roomLabel.textContent = 'Nhập mã phòng 3-4 số';
      return;
    }
    role = 'client';
    Game.setRole('client', 'B');
    setConnState('connecting');
    els.roomLabel.textContent = 'ĐANG VÀO PHÒNG ' + code + '...';

    await ensureLocalMedia();

    peer = new Peer({ config: ICE_CONFIG });
    peer.on('open', () => {
      const c = peer.connect(PEER_PREFIX + code, { reliable: true });
      attachConnHandlers(c);
      const call = peer.call(PEER_PREFIX + code, localStream || new MediaStream());
      mediaCall = call;
      call.on('stream', (remoteStream) => { els.remoteVideo.srcObject = remoteStream; });
    });
    peer.on('call', (call) => {
      call.answer(localStream || undefined);
      call.on('stream', (remoteStream) => { els.remoteVideo.srcObject = remoteStream; });
    });
    peer.on('error', (e) => {
      console.warn('Peer error:', e);
      setConnState('offline');
      els.roomLabel.textContent = 'LỖI: ' + e.type;
    });
  }

  // ---------- bullet chat (danmaku) ----------
  function spawnDanmaku(text, who){
    const item = document.createElement('div');
    item.className = 'danmaku-item ' + (who === 'mine' ? 'mine' : 'theirs');
    item.textContent = (who === 'mine' ? '► ' : '◄ ') + text;
    const layerH = els.danmakuLayer.clientHeight || 28;
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
        // solo sandbox or host: spawn directly into the authoritative sim
        Game.spawnUnit(side, unitType);
      }
    };
    Game.hooks.onGameOver = () => { stopBroadcasting(); };
  }

  function init(){
    cacheEls();
    wireMediaButtons();
    wireChatForm();
    wireGameHooks();
    els.btnHost.addEventListener('click', hostGame);
    els.btnJoin.addEventListener('click', joinGame);
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => Net.init());
