/* ── Aion 聊天室前端逻辑 ── */

const API = '/api/chatroom';
let currentRoom = null;
let rooms = [];
let isSending = false;
let isAiChatting = false;
let chatroomModel = '';
let chatroomConnorModel = 'Codex';
let chatroomReplyOrder = 'random';
let isReplyOnce = false;
let chatroomModels = [];
let pendingAttachments = [];  // [{url, type, name}]
let crMessagesById = {};

// ── 表情包相关 ──
const STICKER_BASE = '/static/stickers/';
let _stickerList = [];
let _recentStickers = [];
let _stickerCategories = {};
let _activeStickerTab = 'recent';
let _stickerLoaded = false;
let _stickerFileMap = {};  // { "抱抱": "抱抱.jpeg", ... }

// ── 气泡队列（多条消息暂存，统一发送）──
let _crBubbleQueue = [];        // 暂存的文字气泡（含 [STICKER:xxx]）
let _crAttachQueue = [];        // 暂存的附件 [{url, type, name}]
let _crAutoSendTimer = null;    // 自动发送定时器
let _crLastClickTime = 0;       // 双击检测

// ── 密语模式 ──
let crWhisperMode = false;
const crHandledToyEvents = new Set();

const AVATARS = {
  user: '/public/UserIcon.png',
  aion: '/public/gropicon1.png',
  connor: '/public/codexicon.png',
};

let crUserName = '我';
let crAiName = 'AI';
let crConnorName = 'Connor';

function crName(sender) {
  return { user: crUserName || '我', aion: crAiName || 'AI', connor: crConnorName || 'Connor' }[sender] || sender;
}

function applyChatroomNames(cfg = {}) {
  crAiName = cfg.ai_name || crAiName || 'AI';
  crUserName = cfg.user_name || crUserName || '我';
  crConnorName = cfg.connor_name || crConnorName || 'Connor';

  const aionPersonaLabel = document.querySelector('#fieldAionPersona label');
  if (aionPersonaLabel) aionPersonaLabel.textContent = `${crAiName} 人设`;
  const connorPersona = document.getElementById('setConnorPersona');
  if (connorPersona?.previousElementSibling) connorPersona.previousElementSibling.textContent = `${crConnorName} 补充设定（可选）`;
  const connorNameInput = document.getElementById('setConnorName');
  if (connorNameInput?.previousElementSibling) {
    connorNameInput.previousElementSibling.textContent = `${crConnorName} 名字`;
    connorNameInput.placeholder = crConnorName;
  }
  const aionVoice = document.getElementById('setTtsAionVoice');
  if (aionVoice?.previousElementSibling) aionVoice.previousElementSibling.textContent = `${crAiName} 音色`;
  const connorVoice = document.getElementById('setTtsConnorVoice');
  if (connorVoice?.previousElementSibling) connorVoice.previousElementSibling.textContent = `${crConnorName} 音色`;
  const walletTitle = document.querySelector('.wallet-panel-header span');
  if (walletTitle) walletTitle.textContent = `💰 ${crConnorName} 的钱包`;
  const optAion = document.getElementById('optAion');
  if (optAion) optAion.textContent = `${crAiName} 优先`;
  const optConnor = document.getElementById('optConnor');
  if (optConnor) optConnor.textContent = `${crConnorName} 优先`;
  const replyAionBtn = document.getElementById('replyAionBtn');
  if (replyAionBtn) replyAionBtn.textContent = `${crAiName} 说`;
  const replyConnorBtn = document.getElementById('replyConnorBtn');
  if (replyConnorBtn) replyConnorBtn.textContent = `${crConnorName} 说`;
  const aionModelLabel = document.querySelector('#fieldAionModel label');
  if (aionModelLabel) aionModelLabel.textContent = `${crAiName} 模型线路`;
  const connorModelLabel = document.querySelector('#fieldConnorModel label');
  if (connorModelLabel) connorModelLabel.textContent = `${crConnorName} 模型线路`;
  const personaSummary = document.getElementById('settingsPersonaSummary');
  if (personaSummary) personaSummary.textContent = `${crAiName} / ${crConnorName} 补充设定`;
  updateHeaderActions();
}

// ── 音效 ──
const sndSend = new Audio('/public/发送消息.mp3');
const sndRecv = new Audio('/public/收到消息.mp3');
function playSend() { sndSend.currentTime = 0; sndSend.play().catch(() => {}); }
function playRecv() { sndRecv.currentTime = 0; sndRecv.play().catch(() => {}); }

// ── TTS 语音合成（统一从服务端加载配置，init 时拉取）──
let crTtsEnabled = false;
let crTtsAionVoice = '';
let crTtsConnorVoice = '';
const crSeenTTSChunks = new Set();
const crSeenTTSDone = new Set();
const crIsEmbedded = (() => {
  try { return window.parent && window.parent !== window; }
  catch(e) { return false; }
})();

// TTS 播放引擎：Audio 使用本地对象（可靠播放），离开页面时移交给 parent（尽力续播）
const _ttsEngine = (function() {
  // 在 parent 上预建一个 handoff audio，用于离开页面后续播当前片段
  let _handoffAudio = null;
  try {
    if (window.parent && window.parent !== window) {
      if (!window.parent._crTtsHandoffAudio) {
        const a = window.parent.document.createElement('audio');
        a.style.display = 'none';
        window.parent.document.body.appendChild(a);
        window.parent._crTtsHandoffAudio = a;
      }
      _handoffAudio = window.parent._crTtsHandoffAudio;
    }
  } catch(e) {}

  const audio = new Audio(); // 本地 Audio，可靠播放
  let _cbId = 0; // 回调去重 ID，防止 onended/onerror/catch 多次触发
  let _resumeTimer = null;
  let _stopRequested = false;

  const clearResumeTimer = () => {
    if (_resumeTimer) {
      clearTimeout(_resumeTimer);
      _resumeTimer = null;
    }
  };

  const scheduleResume = () => {
    if (_stopRequested || !eng.playing || !eng.audio.src || eng.audio.ended || !eng.audio.paused) return;
    if (_resumeTimer) return;
    _resumeTimer = setTimeout(() => {
      _resumeTimer = null;
      if (_stopRequested || !eng.playing || !eng.audio.src || eng.audio.ended || !eng.audio.paused) return;
      eng.audio.play().catch(() => {
        scheduleResume();
      });
    }, 1500);
  };

  const eng = {
    audio: audio,
    playing: false,
    chunkQueues: {},
    playOrder: [],
    _next() {
      while (eng.playOrder.length > 0) {
        const msgId = eng.playOrder[0];
        const q = eng.chunkQueues[msgId];
        if (!q) { eng.playOrder.shift(); continue; }
        let url = q.chunks[q.nextPlay];
        if (url === undefined) {
          if (q.finished) {
            const maxSeq = Object.keys(q.chunks).length > 0 ? Math.max(...Object.keys(q.chunks).map(Number)) : -1;
            if (q.nextPlay > maxSeq) { eng.playOrder.shift(); delete eng.chunkQueues[msgId]; continue; }
            while (q.nextPlay <= maxSeq && q.chunks[q.nextPlay] === undefined) q.nextPlay++;
            if (q.nextPlay > maxSeq) { eng.playOrder.shift(); delete eng.chunkQueues[msgId]; continue; }
            url = q.chunks[q.nextPlay];
          }
          if (url === undefined) { eng.playing = false; return; }
        }
        eng.playing = true;
        _stopRequested = false;
        clearResumeTimer();
        const myId = ++_cbId;
        const advance = () => {
          if (myId !== _cbId) return; // 过时回调，忽略
          clearResumeTimer();
          _cbId++;
          eng.playing = false;
          q.nextPlay++;
          eng._next();
        };
        eng.audio.src = url;
        eng.audio.onended = advance;
        eng.audio.onerror = advance;
        eng.audio.onplaying = clearResumeTimer;
        eng.audio.onpause = () => {
          if (myId !== _cbId || eng.audio.ended) return;
          scheduleResume();
        };
        eng.audio.play().catch(() => {
          // 外部 App 抢占音频焦点时，play() 可能会短暂失败；保留当前分片，等待焦点恢复。
          scheduleResume();
        });
        return;
      }
      eng.playing = false;
    },
    enqueue(msgId, seq, url) {
      if (!eng.chunkQueues[msgId]) {
        eng.chunkQueues[msgId] = { nextPlay: 0, chunks: {}, finished: false };
        eng.playOrder.push(msgId);
      }
      eng.chunkQueues[msgId].chunks[seq] = url;
      if (!eng.playing) eng._next();
    },
    finish(msgId) {
      const q = eng.chunkQueues[msgId];
      if (!q) return;
      q.finished = true;
      while (eng.playOrder.length > 0) {
        const id = eng.playOrder[0];
        const qq = eng.chunkQueues[id];
        if (!qq || !qq.finished) break;
        const maxSeq = Object.keys(qq.chunks).length > 0 ? Math.max(...Object.keys(qq.chunks).map(Number)) : -1;
        if (qq.nextPlay > maxSeq) { eng.playOrder.shift(); delete eng.chunkQueues[id]; } else break;
      }
      if (!eng.playing) eng._next();
    },
    stop() {
      _cbId++;
      _stopRequested = true;
      clearResumeTimer();
      eng.audio.pause(); eng.audio.src = '';
      eng.chunkQueues = {}; eng.playOrder = []; eng.playing = false;
    }
  };

  // 页面卸载时，把当前正在播放的音频移交到 parent audio 续播
  if (_handoffAudio && !crIsEmbedded) {
    window.addEventListener('pagehide', () => {
      if (eng.playing && eng.audio.src && !eng.audio.paused) {
        try {
          _handoffAudio.src = eng.audio.src;
          _handoffAudio.currentTime = eng.audio.currentTime;
          _handoffAudio.play().catch(() => {});
        } catch(e) {}
      }
    });
  }

  return eng;
})();
let crTtsAudio = _ttsEngine.audio;

// ── 音乐卡片 ──
let crMusicCards = {}; // { msgId: [{ id, name, artist, album, cover, audio_url, candidates }] }

// ── 密语胶囊 ──
function crToyLabel(cmd) {
  const c = String(cmd || '').trim().toUpperCase();
  if (c === 'STOP' || c === '0') return '❤️ 停止';
  const n = parseInt(c);
  return (n >= 1 && n <= 9) ? `❤️ ${CR_TOY_PNAMES[n - 1]}` : `❤️ ${cmd}`;
}

function crToyCommandsFromAttachments(atts) {
  if (!Array.isArray(atts)) return [];
  return atts
    .filter(item => item && typeof item === 'object' && item.type === 'toy')
    .flatMap(item => Array.isArray(item.commands) ? item.commands : (item.command ? [item.command] : []));
}

function renderToyAttachments(atts) {
  const commands = crToyCommandsFromAttachments(atts);
  if (!commands.length) return '';
  return commands.map(cmd => `<div class="toy-capsule" data-toy-command="${esc(String(cmd))}">${esc(crToyLabel(cmd))}</div>`).join('');
}

function crShowToyCapsule(msgId, commands) {
  if (!msgId || !commands || !commands.length) return;
  const row = document.querySelector(`[data-msg-id="${msgId}"]`) || document.getElementById(`streaming-${msgId}`);
  if (!row) return;
  const msgContent = row.querySelector('.msg-content');
  if (!msgContent) return;
  commands.forEach(cmd => {
    const c = String(cmd || '').trim().toUpperCase();
    if (!c) return;
    if (msgContent.querySelector(`.toy-capsule[data-toy-command="${c}"]`)) return;
    const pill = document.createElement('div');
    pill.className = 'toy-capsule';
    pill.dataset.toyCommand = c;
    pill.textContent = crToyLabel(cmd);
    msgContent.appendChild(pill);
  });
  scrollToBottom();
}

function crHandleToyCommand(data) {
  if (!data || !data.commands || !data.commands.length) return;
  const msgId = data.msg_id || '';
  const commands = data.commands.map(c => String(c || '').trim().toUpperCase()).filter(Boolean);
  if (!commands.length) return;
  const key = `${msgId}:${commands.join('|')}`;
  const alreadyHandled = crHandledToyEvents.has(key);
  if (!alreadyHandled) {
    crHandledToyEvents.add(key);
    try {
      if (window.opener && window.opener.toyExecCmd) {
        commands.forEach(c => window.opener.toyExecCmd(c));
      } else if (window.parent && window.parent !== window && window.parent.toyExecCmd) {
        commands.forEach(c => window.parent.toyExecCmd(c));
      }
    } catch(e) {}
    if (typeof toyExecCmd === 'function') commands.forEach(c => toyExecCmd(c));
  }
  crShowToyCapsule(msgId, commands);
}

function crRenderMusicCards(msgId) {
  const cards = crMusicCards[msgId];
  if (!cards || !cards.length) return;
  const row = document.querySelector(`[data-msg-id="${msgId}"]`) || document.getElementById(`streaming-${msgId}`);
  if (!row) return;
  row.querySelectorAll('.music-capsule').forEach(e => e.style.display = 'none');
  row.querySelectorAll('.music-cards-container').forEach(e => e.remove());
  const container = document.createElement('div');
  container.className = 'music-cards-container';
  cards.forEach(song => { container.innerHTML += crBuildMusicCardHtml(song); });
  const msgContent = row.querySelector('.msg-content');
  if (msgContent) msgContent.appendChild(container);
}

function crBuildMusicCardHtml(song) {
  const cover = song.cover ? esc(song.cover) : '';
  const coverImg = cover
    ? `<img class="music-cover" src="${cover}" alt="">`
    : `<div class="music-cover" style="display:flex;align-items:center;justify-content:center;font-size:24px;color:var(--text3)">🎵</div>`;
  const name = esc(song.name || '未知歌曲');
  const artist = esc(song.artist || '未知歌手');
  const album = song.album ? `<div class="music-album">💿 ${esc(song.album)}</div>` : '';
  const songId = song.id;
  const onlineBtn = `<button class="music-btn secondary" onclick="crPlayMusicOnline(${songId})">▶ 在线播放</button>`;
  let candidatesHtml = '';
  if (song.candidates && song.candidates.length) {
    const items = song.candidates.map(c =>
      `<div class="cand-item" onclick="crOpenInNetease(${c.id})">🎵 ${esc(c.name)} - ${esc(c.artist)}</div>`
    ).join('');
    candidatesHtml = `<details class="music-candidates"><summary>不是这首？看看其他结果</summary>${items}</details>`;
  }
  return `
    <div class="music-card">
      ${coverImg}
      <div class="music-info">
        <div class="music-name">${name}</div>
        <div class="music-artist">${artist}</div>
        ${album}
        <div class="music-btns">
          <button class="music-btn primary" onclick="crOpenInNetease(${songId})">🎶 网易云播放</button>
          ${onlineBtn}
        </div>
        ${candidatesHtml}
      </div>
    </div>`;
}

function crOpenInNetease(songId) {
  window.open('https://music.163.com/song?id=' + songId, '_blank');
}

function crPlayMusicOnline(songId) {
  let wrap = document.getElementById('crGlobalMusicWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'crGlobalMusicWrap';
    wrap.style.cssText = 'position:fixed;top:calc(max(34px, env(safe-area-inset-top, 0px)) + 48px);left:0;right:0;z-index:999;display:none;align-items:center;gap:8px;background:var(--surface,#1e1e1e);padding:0 12px;height:36px;box-shadow:0 2px 8px rgba(0,0,0,0.25);border-bottom:1px solid var(--border,#333);';

    const playBtn = document.createElement('button');
    playBtn.id = 'crMusicPlayBtn';
    playBtn.textContent = '⏸';
    playBtn.style.cssText = 'background:none;border:none;font-size:16px;cursor:pointer;color:var(--text,#eee);padding:0 4px;line-height:1;flex-shrink:0;';

    const bar = document.createElement('input');
    bar.id = 'crMusicBar';
    bar.type = 'range'; bar.min = 0; bar.max = 1000; bar.value = 0;
    bar.style.cssText = 'flex:1;height:4px;accent-color:#e53935;cursor:pointer;';

    const volWrap = document.createElement('span');
    volWrap.style.cssText = 'display:flex;align-items:center;gap:2px;flex-shrink:0;';
    const volIcon = document.createElement('span');
    volIcon.textContent = '🔉';
    volIcon.style.cssText = 'font-size:13px;cursor:pointer;user-select:none;';
    const volBar = document.createElement('input');
    volBar.id = 'crMusicVol';
    volBar.type = 'range'; volBar.min = 0; volBar.max = 100;
    volBar.value = localStorage.getItem('musicVolume') ?? 50;
    volBar.style.cssText = 'width:52px;height:4px;accent-color:#ff9800;cursor:pointer;';

    const audio = document.createElement('audio');
    audio.id = 'crMusicAudio';
    audio.volume = (localStorage.getItem('musicVolume') ?? 50) / 100;

    volBar.oninput = () => { audio.volume = volBar.value / 100; localStorage.setItem('musicVolume', volBar.value); volIcon.textContent = volBar.value == 0 ? '🔇' : volBar.value < 50 ? '🔉' : '🔊'; };
    volIcon.onclick = () => { if (audio.volume > 0) { volIcon.dataset.prev = volBar.value; volBar.value = 0; audio.volume = 0; volIcon.textContent = '🔇'; } else { volBar.value = volIcon.dataset.prev || 50; audio.volume = volBar.value / 100; volIcon.textContent = volBar.value < 50 ? '🔉' : '🔊'; } localStorage.setItem('musicVolume', volBar.value); };
    volWrap.appendChild(volIcon);
    volWrap.appendChild(volBar);

    playBtn.onclick = () => { if (audio.paused) { audio.play(); playBtn.textContent = '⏸'; } else { audio.pause(); playBtn.textContent = '▶'; } };
    audio.ontimeupdate = () => { if (audio.duration) bar.value = (audio.currentTime / audio.duration) * 1000; };
    bar.oninput = () => { if (audio.duration) audio.currentTime = (bar.value / 1000) * audio.duration; };
    audio.onended = () => { wrap.style.display = 'none'; playBtn.textContent = '▶'; };
    audio.onplay = () => { playBtn.textContent = '⏸'; };
    audio.onpause = () => { if (!audio.ended) playBtn.textContent = '▶'; };

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none;border:none;font-size:14px;cursor:pointer;color:var(--text2,#888);padding:0 4px;line-height:1;flex-shrink:0;';
    closeBtn.onclick = () => { audio.pause(); audio.currentTime = 0; audio.src = ''; wrap.style.display = 'none'; bar.value = 0; };

    wrap.appendChild(playBtn);
    wrap.appendChild(bar);
    wrap.appendChild(volWrap);
    wrap.appendChild(audio);
    wrap.appendChild(closeBtn);
    document.body.appendChild(wrap);
  }
  const audio = document.getElementById('crMusicAudio');
  audio.src = '/api/music/stream/' + songId;
  wrap.style.display = 'flex';
  document.getElementById('crMusicBar').value = 0;
  document.getElementById('crMusicPlayBtn').textContent = '⏸';
  audio.play().catch(() => {});
}

function crEnqueueTTSChunk(msgId, seq, url) {
  if (!crTtsEnabled) return;
  const key = `${msgId}:${seq}`;
  if (crSeenTTSChunks.has(key)) return;
  crSeenTTSChunks.add(key);
  if (crIsEmbedded) return;
  _ttsEngine.enqueue(msgId, seq, url);
}

async function crPlayNextTTSChunk() {
  if (!_ttsEngine.playing) _ttsEngine._next();
}

function crFinishTTSForMsg(msgId) {
  if (crSeenTTSDone.has(msgId)) return;
  crSeenTTSDone.add(msgId);
  if (crIsEmbedded) return;
  _ttsEngine.finish(msgId);
}

function crStopTTS() {
  _ttsEngine.stop();
}

// ── TTS 重听 ──
let crReplayAudio = new Audio();
let crReplayChunks = [];
let crReplayIdx = 0;

async function crReplayTTS(msgId) {
  const btn = document.querySelector(`[data-msg-id="${msgId}"] .tts-replay-btn`);
  // 正在播放则停止
  if (btn && btn.classList.contains('playing')) {
    crReplayAudio.pause(); crReplayAudio.src = ''; crReplayChunks = [];
    btn.classList.remove('playing'); return;
  }
  crReplayAudio.pause(); crReplayChunks = [];
  document.querySelectorAll('.tts-replay-btn.playing').forEach(b => b.classList.remove('playing'));

  // 先尝试分段音频；允许中间偶发缺段，不让后续分段被挡住
  let chunks = [];
  let misses = 0;
  for (let i = 0; i < 120; i++) {
    const resp = await fetch(`/api/tts/audio/${msgId}_s${i}`, { method: 'HEAD' });
    if (resp.ok) {
      chunks.push(`/api/tts/audio/${msgId}_s${i}`);
      misses = 0;
    } else if (chunks.length > 0 && ++misses >= 8) {
      break;
    } else if (chunks.length === 0 && i >= 8) {
      break;
    }
  }

  // 降级：单文件
  if (chunks.length === 0) {
    const resp = await fetch(`/api/tts/audio/${msgId}`);
    if (!resp.ok) return;
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    crReplayAudio.src = url;
    if (btn) btn.classList.add('playing');
    crReplayAudio.onended = () => { URL.revokeObjectURL(url); if (btn) btn.classList.remove('playing'); };
    crReplayAudio.onerror = () => { URL.revokeObjectURL(url); if (btn) btn.classList.remove('playing'); };
    await crReplayAudio.play().catch(() => { if (btn) btn.classList.remove('playing'); });
    return;
  }

  // 顺序播放分段
  crReplayChunks = chunks; crReplayIdx = 0;
  if (btn) btn.classList.add('playing');
  _crPlayReplayChunk(btn);
}

function _crPlayReplayChunk(btn) {
  if (crReplayIdx >= crReplayChunks.length) { if (btn) btn.classList.remove('playing'); return; }
  crReplayAudio.src = crReplayChunks[crReplayIdx];
  crReplayAudio.onended = () => { crReplayIdx++; _crPlayReplayChunk(btn); };
  crReplayAudio.onerror = () => { crReplayIdx++; _crPlayReplayChunk(btn); };
  crReplayAudio.play().catch(() => { if (btn) btn.classList.remove('playing'); });
}

function onTtsToggleChange() {
  crTtsEnabled = document.getElementById('setTtsEnabled').checked;
  if (!crTtsEnabled) crStopTTS();
  // 持久化到服务端，所有窗口共享
  api('/config', { method: 'PUT', body: JSON.stringify({ tts_enabled: crTtsEnabled }) }).catch(() => {});
}

function onWhisperToggleChange() {
  crWhisperMode = !!document.getElementById('setWhisperMode')?.checked;
}

async function crLoadTTSVoices() {
  try {
    const resp = await fetch('/api/tts/voices');
    const data = await resp.json();
    const aionSel = document.getElementById('setTtsAionVoice');
    const connorSel = document.getElementById('setTtsConnorVoice');
    if (data.voices && data.voices.length > 0) {
      const opts = data.voices.map(v => {
        const name = v.customName || v.uri || 'Unknown';
        return { uri: v.uri, name };
      });
      aionSel.innerHTML = opts.map(o =>
        `<option value="${o.uri}" ${o.uri === crTtsAionVoice ? 'selected' : ''}>${o.name}</option>`
      ).join('');
      connorSel.innerHTML = opts.map(o =>
        `<option value="${o.uri}" ${o.uri === crTtsConnorVoice ? 'selected' : ''}>${o.name}</option>`
      ).join('');
    } else {
      aionSel.innerHTML = '<option value="">无可用音色</option>';
      connorSel.innerHTML = '<option value="">无可用音色</option>';
    }
  } catch(e) {
    console.error('加载TTS音色失败:', e);
  }
}

// ── DOM ──
const roomListEl = document.getElementById('roomList');
const messagesEl = document.getElementById('messages');

// ── 消息分页状态 ──
let oldestMsgTs = null;   // 当前已加载的最早消息时间戳
let noMoreMessages = false; // 是否已加载全部历史
let loadingOlder = false; // 防重复加载锁
const composer = document.getElementById('composer');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const roomTitleEl = document.getElementById('roomTitle');
const menuBtn = document.getElementById('menuBtn');
const sidebar = document.getElementById('sidebar');
const backdrop = document.getElementById('sidebarBackdrop');
const connorDot = document.getElementById('connorDot');
const connorStatusEl = document.getElementById('connorStatus');
const aiChatBtn = document.getElementById('aiChatBtn');
const replyAionBtn = document.getElementById('replyAionBtn');
const replyConnorBtn = document.getElementById('replyConnorBtn');
const toastEl = document.getElementById('toast');

// ══════════════════════════════════════════════════
//  工具函数
// ══════════════════════════════════════════════════

function toast(msg, ms = 2000) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), ms);
}

function timeStr(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now - d;
  const time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (diffMs > 12 * 60 * 60 * 1000) {
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + time;
  }
  return time;
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 100;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// 滚动到顶部时自动加载更早的消息
messagesEl.addEventListener('scroll', () => {
  if (messagesEl.scrollTop < 80) {
    loadOlderMessages();
  }
});

function resizeInput() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
}

// ══════════════════════════════════════════════════
//  API 调用
// ══════════════════════════════════════════════════

async function api(path, opts = {}) {
  const resp = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return resp.json();
}

async function fetchCurrentModel() {
  try {
    const [convs, models, cfg] = await Promise.all([
      (await fetch('/api/conversations')).json(),
      (await fetch('/api/models')).json(),
      api('/config'),
    ]);
    if (Array.isArray(models)) chatroomModels = models;
    if (cfg?.connor_model) chatroomConnorModel = cfg.connor_model;
    if (cfg?.aion_model) chatroomModel = cfg.aion_model;
    if (cfg?.reply_order) chatroomReplyOrder = cfg.reply_order;
    if (!chatroomModel && Array.isArray(convs) && convs.length > 0 && convs[0].model) {
      chatroomModel = convs[0].model;
    }
    updateHeaderActions();
  } catch {}
}

function renderModelOptions(selected) {
  const keys = chatroomModels.length ? chatroomModels.map(m => m.key) : [chatroomModel || 'Codex', 'Codex'];
  return [...new Set(keys.filter(Boolean))].map(k => `<option value="${esc(k)}"${k === selected ? ' selected' : ''}>${esc(k)}</option>`).join('');
}

function updateHeaderActions() {
  const isGroup = currentRoom && currentRoom.type === 'group';
  const manualMode = isGroup && chatroomReplyOrder === 'manual';
  if (aiChatBtn) aiChatBtn.style.display = isGroup ? '' : 'none';
  if (replyAionBtn) replyAionBtn.style.display = manualMode ? '' : 'none';
  if (replyConnorBtn) replyConnorBtn.style.display = manualMode ? '' : 'none';
}

// ══════════════════════════════════════════════════
//  房间列表
// ══════════════════════════════════════════════════

async function loadRooms() {
  rooms = await api('/rooms');
  renderRoomList();
}

let activeTab = 'group';

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.room-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  renderRoomList();
}

function renderRoomList() {
  const filtered = rooms.filter(r => r.type === activeTab);
  roomListEl.innerHTML = filtered.map(r => {
    const active = currentRoom && currentRoom.id === r.id ? 'active' : '';
    const typeBadge = r.type === 'connor_1v1'
      ? '<span class="type-badge connor">私聊</span>'
      : '<span class="type-badge group">群聊</span>';
    return `
      <div class="room-item ${active}" onclick="selectRoom('${r.id}')">
        ${typeBadge}
        <span class="title">${esc(r.title)}</span>
        <span class="msg-count">${r.message_count || 0}</span>
        <button class="del-btn" onclick="event.stopPropagation(); deleteRoom('${r.id}')" title="删除">✕</button>
      </div>`;
  }).join('');
  if (!filtered.length) {
    roomListEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:13px;">暂无' + (activeTab === 'group' ? '群聊' : '私聊') + '</div>';
  }
}

async function createRoom(type) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const label = type === 'connor_1v1' ? '私聊' : '群聊';
  const title = `${label} ${dateStr}`;
  const result = await api('/rooms', {
    method: 'POST',
    body: JSON.stringify({ title, type }),
  });
  if (result.error) {
    // connor_1v1 已存在，直接切过去
    if (result.existing_id) {
      switchTab(type);
      selectRoom(result.existing_id);
      closeSidebar();
    } else {
      toast(result.error);
    }
    return;
  }
  switchTab(type);
  await loadRooms();
  selectRoom(result.id);
  closeSidebar();
}

async function deleteRoom(roomId) {
  if (!confirm('确定删除此聊天室？消息和记忆将一并删除。')) return;
  await api(`/rooms/${roomId}`, { method: 'DELETE' });
  if (currentRoom && currentRoom.id === roomId) {
    currentRoom = null;
    renderEmptyChat();
  }
  await loadRooms();
}

async function selectRoom(roomId) {
  const room = rooms.find(r => r.id === roomId);
  if (!room) return;
  currentRoom = room;
  // 自动切换到对应 tab
  if (activeTab !== room.type) switchTab(room.type);
  else renderRoomList();
  roomTitleEl.textContent = room.title;
  // 退出语音模式（如果在语音模式中切换房间）
  if (_crVoiceMode) {
    _crVoiceMode = false;
    document.getElementById('crVoiceModeRow').classList.remove('active');
  }
  composer.style.display = 'flex';
  updateHeaderActions();
  await loadMessages();
  closeSidebar();
}

// ══════════════════════════════════════════════════
//  消息
// ══════════════════════════════════════════════════

async function loadMessages() {
  if (!currentRoom) return;
  oldestMsgTs = null;
  noMoreMessages = false;
  loadingOlder = false;
  const msgs = await api(`/rooms/${currentRoom.id}/messages?limit=100`);
  if (msgs && msgs.length) {
    oldestMsgTs = msgs[0].created_at;
    noMoreMessages = msgs.length < 100;
  } else {
    noMoreMessages = true;
  }
  renderMessages(msgs);
  scrollToBottom(true);
}

async function loadOlderMessages() {
  if (!currentRoom || noMoreMessages || loadingOlder || !oldestMsgTs) return;
  loadingOlder = true;
  // 记住当前滚动高度以便加载后保持位置
  const prevHeight = messagesEl.scrollHeight;
  const msgs = await api(`/rooms/${currentRoom.id}/messages?limit=50&before=${oldestMsgTs}`);
  if (!msgs || !msgs.length) {
    noMoreMessages = true;
    loadingOlder = false;
    return;
  }
  if (msgs.length < 50) noMoreMessages = true;
  oldestMsgTs = msgs[0].created_at;
  // 将旧消息插入到顶部
  const fragment = document.createDocumentFragment();
  msgs.forEach(m => {
    if (m.id) crMessagesById[m.id] = m;
    const div = document.createElement('div');
    div.innerHTML = msgHTML(m);
    fragment.appendChild(div.firstElementChild);
  });
  messagesEl.prepend(fragment);
  // 保持滚动位置
  messagesEl.scrollTop = messagesEl.scrollHeight - prevHeight;
  loadingOlder = false;
}

function renderMessages(msgs) {
  crMessagesById = {};
  if (!msgs || !msgs.length) {
    messagesEl.innerHTML = `
      <div class="empty-state">
        <div class="icon">${currentRoom.type === 'connor_1v1' ? '🤖' : '👥'}</div>
        <div>${currentRoom.type === 'connor_1v1' ? `和 ${esc(crConnorName)} 开始私聊吧` : '三人群聊，开始吧'}</div>
      </div>`;
    return;
  }
  msgs.forEach(m => { if (m.id) crMessagesById[m.id] = m; });
  messagesEl.innerHTML = msgs.map(m => msgHTML(m)).join('');
}

function msgHTML(m) {
  const sender = m.sender || 'user';

  // 系统事件消息（点歌、闹钟等）
  if (sender === 'system') {
    return `<div class="system-event-msg" data-msg-id="${m.id || ''}">${esc(m.content || '')}</div>`;
  }

  const name = crName(sender);
  const avatar = AVATARS[sender] || AVATARS.user;
  const time = timeStr(m.created_at);

  // 用户消息按单换行拆，AI消息按双换行拆
  const isUser = sender === 'user';
  const raw = m.content || '';

  // 判断是否为纯语音消息（只有语音附件，content 是转写文本或为空）
  const hasVoiceAtt = Array.isArray(m.attachments) && m.attachments.some(a => typeof a === 'object' && a.type === 'voice');
  const isVoiceOnly = hasVoiceAtt && (!raw || m.attachments.some(a => typeof a === 'object' && a.type === 'voice' && a.transcript === raw));

  // 检测是否为纯表情包消息
  const isStickerOnly = /^\s*\[(?:STICKER|表情)[：:\s]*[^\]]+\]\s*$/.test(raw.trim());
  // 统一使用 escWithImages 解析表情包、图片和转账卡片
  const fmt = escWithImages;
  let bubblesHtml = '';
  if (!isVoiceOnly) {
    // 转账标签前后强制换行，确保卡片独占一个气泡
    const splitRaw = raw.replace(/(\[转账(?:给[^\uff1a:]+?)?[：:]\s*-?\d+(?:\.\d+)?\s*元\])/g, '\n$1\n');
    const parts = splitRaw.split(isUser ? /\n+/ : /\n{2,}/).filter(p => p.trim());
    if (parts.length > 1) {
      bubblesHtml = '<div class="bubbles">' + parts.map(p => `<div class="bubble${/^\s*\[(?:STICKER|表情)[：:\s]*[^\]]+\]\s*$/.test(p.trim()) ? ' sticker-only' : ''}">${fmt(p)}</div>`).join('') + '</div>';
    } else if (raw.trim()) {
      bubblesHtml = `<div class="bubble${isStickerOnly ? ' sticker-only' : ''}">${fmt(raw)}</div>`;
    }
  }

  // 渲染附件图片
  const toyHtml = renderToyAttachments(m.attachments);
  const attHtml = renderAttachments(m.attachments);

  const msgId = m.id || '';
  const actionHtml = isUser
    ? `<button onclick="editChatroomMsg('${msgId}');closeMsgMenus()">编辑</button>`
    : `<button onclick="regenerateChatroomMsg('${msgId}');closeMsgMenus()">重新生成</button>`;
  const menuHtml = msgId ? `
    <div class="msg-menu-wrap">
      <button class="msg-menu-btn" onclick="toggleMsgMenu(event)">⋯</button>
      <div class="msg-menu-dropdown">
        ${actionHtml}
        <button class="danger" onclick="deleteMsg('${msgId}', this)">删除</button>
      </div>
    </div>` : '';

  const senderLine = sender !== 'user'
    ? `<div class="sender-line"><span class="sender-label ${sender}">${esc(name)}</span>${menuHtml}</div>`
    : (menuHtml ? `<div class="sender-line user-line">${menuHtml}</div>` : '');

  const ttsBtn = !isUser && msgId ? `<button class="tts-replay-btn" onclick="crReplayTTS('${msgId}')" title="重听语音">🔊</button>` : '';

  return `
    <div class="message-row ${sender}" data-msg-id="${msgId}">
      <div class="msg-body">
        <div class="msg-avatar-col">
          <img class="avatar" src="${avatar}" alt="${name}">
          ${ttsBtn}
        </div>
        <div class="msg-content">
          ${senderLine}
          ${bubblesHtml}
          ${toyHtml}
          ${attHtml}
        </div>
      </div>
      <div class="message-meta">${time}</div>
    </div>`;
}

/* ── 消息菜单 ── */
function toggleMsgMenu(e) {
  e.stopPropagation();
  const dropdown = e.currentTarget.nextElementSibling;
  // 关闭所有其他下拉
  document.querySelectorAll('.msg-menu-dropdown.show').forEach(d => { if (d !== dropdown) d.classList.remove('show'); });
  dropdown.classList.toggle('show');
}

function closeMsgMenus() {
  document.querySelectorAll('.msg-menu-dropdown.show').forEach(d => d.classList.remove('show'));
}

async function deleteMsg(msgId, btnEl) {
  try {
    await fetch(`${API}/messages/${msgId}`, { method: 'DELETE' });
    delete crMessagesById[msgId];
    const row = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (row) row.remove();
  } catch (e) { console.error('删除失败', e); }
}

function removeRowsAfter(row, includeSelf = false) {
  if (!row) return;
  let n = includeSelf ? row : row.nextElementSibling;
  while (n) {
    const next = n.nextElementSibling;
    const id = n.getAttribute?.('data-msg-id');
    if (id) delete crMessagesById[id];
    n.remove();
    n = next;
  }
}

async function consumeChatroomSSE(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try { handleSSE(JSON.parse(line.slice(6))); } catch {}
    }
  }
}

function editChatroomMsg(msgId) {
  const msg = crMessagesById[msgId];
  if (!msg || msg.sender !== 'user' || isSending || isAiChatting) return;
  const row = document.querySelector(`[data-msg-id="${msgId}"]`);
  const bubble = row?.querySelector('.bubble');
  if (!bubble) return;
  row.classList.add('editing');
  bubble.innerHTML = `
    <textarea class="edit-textarea" id="edit_${msgId}"></textarea>
    <div class="edit-actions">
      <button class="edit-cancel" onclick="cancelChatroomEdit()">取消</button>
      <button class="edit-save" onclick="saveChatroomEdit('${msgId}')">确认</button>
    </div>`;
  const ta = document.getElementById(`edit_${msgId}`);
  ta.value = msg.content || '';
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  ta.oninput = function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 160) + 'px';
  };
  ta.focus();
}

function cancelChatroomEdit() {
  loadMessages();
}

async function saveChatroomEdit(msgId) {
  const ta = document.getElementById(`edit_${msgId}`);
  const msg = crMessagesById[msgId];
  if (!ta || !msg || isSending || isAiChatting) return;
  const content = ta.value.trim();
  if (!content) { toast('内容不能为空'); return; }

  isSending = true;
  sendBtn.disabled = true;
  msg.content = content;
  const row = document.querySelector(`[data-msg-id="${msgId}"]`);
  removeRowsAfter(row, false);
  if (row) {
    const div = document.createElement('div');
    div.innerHTML = msgHTML(msg);
    row.replaceWith(div.firstElementChild);
  }

  try {
    const resp = await fetch(`${API}/messages/${msgId}/edit-resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        model: chatroomModel,
        connor_model: chatroomConnorModel,
        tts_enabled: crTtsEnabled,
        tts_aion_voice: crTtsAionVoice,
        tts_connor_voice: crTtsConnorVoice,
        whisper_mode: crWhisperMode,
      }),
    });
    await consumeChatroomSSE(resp);
  } catch (err) {
    toast('编辑重发失败: ' + err.message);
    await loadMessages();
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    endStreamingBubble();
    inputEl.focus();
  }
}

async function regenerateChatroomMsg(msgId) {
  const msg = crMessagesById[msgId];
  if (!msg || msg.sender === 'user' || isSending || isAiChatting) return;
  isSending = true;
  sendBtn.disabled = true;
  const row = document.querySelector(`[data-msg-id="${msgId}"]`);
  removeRowsAfter(row, true);
  try {
    const resp = await fetch(`${API}/messages/${msgId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chatroomModel,
        connor_model: chatroomConnorModel,
        tts_enabled: crTtsEnabled,
        tts_aion_voice: crTtsAionVoice,
        tts_connor_voice: crTtsConnorVoice,
        whisper_mode: crWhisperMode,
      }),
    });
    await consumeChatroomSSE(resp);
  } catch (err) {
    toast('重新生成失败: ' + err.message);
    await loadMessages();
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    endStreamingBubble();
  }
}

// 点击空白处关闭下拉菜单
document.addEventListener('click', () => {
  document.querySelectorAll('.msg-menu-dropdown.show').forEach(d => d.classList.remove('show'));
});

function appendMessage(m) {
  if (m?.id) crMessagesById[m.id] = m;
  // 移除空状态
  const empty = messagesEl.querySelector('.empty-state');
  if (empty) empty.remove();
  // 移除 typing 指示器
  const typing = messagesEl.querySelector('.typing-indicator');
  if (typing) typing.remove();

  const div = document.createElement('div');
  div.innerHTML = msgHTML(m);
  const row = div.firstElementChild;
  messagesEl.appendChild(row);
  if (m?.id && crMemoryRecordMsgIds.has(m.id)) crApplyMemoryHint(m.id);
  scrollToBottom(m.sender === 'user');
  return row;
}

function reconcileLocalUserEcho(msg) {
  if (!msg || msg.sender !== 'user') return false;
  if (msg.id) crMessagesById[msg.id] = msg;
  const localRow = messagesEl.querySelector('.message-row.user[data-local-echo="1"]');
  if (!localRow) return false;

  const div = document.createElement('div');
  div.innerHTML = msgHTML(msg);
  localRow.replaceWith(div.firstElementChild);
  return true;
}

function appendTyping(who) {
  const existing = messagesEl.querySelector('.typing-indicator');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.textContent = `${who} 回复中...`;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function updateTypingStatus(who, statusText) {
  const indicator = messagesEl.querySelector('.typing-indicator');
  if (indicator) {
    indicator.textContent = `${who} ${statusText}`;
  } else {
    appendTyping(who);
    const el = messagesEl.querySelector('.typing-indicator');
    if (el) el.textContent = `${who} ${statusText}`;
  }
}

function appendAiChatStatus(text) {
  const existing = messagesEl.querySelector('.ai-chat-status');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.className = 'ai-chat-status';
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
}

function removeAiChatStatus() {
  const existing = messagesEl.querySelector('.ai-chat-status');
  if (existing) existing.remove();
}

// ── 流式消息累积 ──
let streamingBubble = null;
let streamingText = '';
let pendingStreamSender = null;
let pendingStreamId = null;

function startStreamingBubble(sender, id) {
  streamingText = '';
  const name = crName(sender);
  const avatar = AVATARS[sender] || AVATARS.user;

  // 移除 typing
  const typing = messagesEl.querySelector('.typing-indicator');
  if (typing) typing.remove();

  const row = document.createElement('div');
  row.className = `message-row ${sender}`;
  row.id = `streaming-${id}`;
  row.innerHTML = `
    <div class="msg-body">
      <div class="msg-avatar-col">
        <img class="avatar" src="${avatar}" alt="${name}">
      </div>
      <div class="msg-content">
        <div class="sender-label ${sender}">${esc(name)}</div>
        <div class="bubble"></div>
      </div>
    </div>
    <div class="message-meta">${timeStr(Date.now() / 1000)}</div>`;
  messagesEl.appendChild(row);
  streamingBubble = row.querySelector('.bubble');
  scrollToBottom();
}

function feedStreamingChunk(text) {
  if (!streamingBubble) return;
  streamingText += text;
  streamingBubble.textContent = streamingText;
  scrollToBottom();
}

function endStreamingBubble(attachments) {
  // 先获取流式行的引用（后面 replaceChild 可能破坏 streamingBubble 的 DOM 位置）
  const streamRow = streamingBubble ? streamingBubble.closest('.message-row') : null;

  // 流结束后，按双换行拆分成多个气泡，并解析 [[image:...]] 和转账卡片
  if (streamingBubble && streamingText) {
    // 转账标签前后强制换行，确保卡片独占一个气泡
    const splitText = streamingText.replace(/(\[转账(?:给[^\uff1a:]+?)?[：:]\s*-?\d+(?:\.\d+)?\s*元\])/g, '\n\n$1\n\n');
    const parts = splitText.split(/\n{2,}/).filter(p => p.trim());
    if (parts.length > 1) {
      const parent = streamingBubble.parentElement;
      const container = document.createElement('div');
      container.className = 'bubbles';
      parts.forEach(p => {
        const b = document.createElement('div');
        b.className = 'bubble';
        b.innerHTML = escWithImages(p);
        container.appendChild(b);
      });
      parent.replaceChild(container, streamingBubble);
      // 附件图片追加到多气泡容器后面
      const attHtml = renderAttachments(attachments);
      if (attHtml) container.insertAdjacentHTML('afterend', attHtml);
    } else {
      // 单气泡也解析 [[image:...]]
      streamingBubble.innerHTML = escWithImages(streamingText);
      // 附件图片追加到气泡后面
      const attHtml = renderAttachments(attachments);
      if (attHtml) streamingBubble.insertAdjacentHTML('afterend', attHtml);
    }
  }
  // 为流式气泡添加 TTS 重听按钮 + data-msg-id
  if (streamRow && streamRow.id && streamRow.id.startsWith('streaming-')) {
    const msgId = streamRow.id.replace('streaming-', '');
    streamRow.setAttribute('data-msg-id', msgId);
    const avatarCol = streamRow.querySelector('.msg-avatar-col');
    if (avatarCol && !avatarCol.querySelector('.tts-replay-btn')) {
      avatarCol.insertAdjacentHTML('beforeend', `<button class="tts-replay-btn" onclick="crReplayTTS('${msgId}')" title="重听语音">🔊</button>`);
    }
    if (crMemoryRecordMsgIds.has(msgId)) crApplyMemoryHint(msgId);
    crShowToyCapsule(msgId, crToyCommandsFromAttachments(attachments));
  }
  streamingBubble = null;
  streamingText = '';
}

// ── [MEMORY] 记忆录入提示 ──
const crMemoryRecordMsgIds = new Set();
const crMemoryRecordContent = {};

function crShowMemoryRecordHint(msgId, content) {
  if (!msgId) return;
  crMemoryRecordMsgIds.add(msgId);
  if (content) {
    crMemoryRecordContent[msgId] = crMemoryRecordContent[msgId]
      ? `${crMemoryRecordContent[msgId]}\n${content}`
      : content;
  }
  crApplyMemoryHint(msgId);
}

function crApplyMemoryHint(msgId) {
  const row = document.getElementById(`streaming-${msgId}`) || document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!row) return;
  const avatarCol = row.querySelector('.msg-avatar-col');
  if (!avatarCol || avatarCol.querySelector('.memory-record-hint')) return;
  const hint = document.createElement('span');
  hint.className = 'memory-record-hint';
  hint.textContent = '💡';
  hint.title = '已记录到记忆库';
  hint.onclick = (e) => {
    e.stopPropagation();
    crShowMemoryRecordCard(msgId);
  };
  avatarCol.appendChild(hint);
}

function crShowMemoryRecordCard(msgId) {
  const content = crMemoryRecordContent[msgId];
  if (!content) return;
  const overlay = document.createElement('div');
  overlay.className = 'mr-card-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `<div class="mr-card-popup">
    <div class="mr-card-label">-- 已记录到记忆库 --</div>
    <button class="mr-card-close" onclick="this.closest('.mr-card-overlay').remove()">x</button>
    <div class="mr-card-text">${esc(content)}</div>
  </div>`;
  document.body.appendChild(overlay);
}

// ══════════════════════════════════════════════════
//  发送消息
// ══════════════════════════════════════════════════

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  // 先把当前输入加入队列，再触发发送
  _crAddToQueue();
  await _crTriggerSend();
});

// ── 气泡队列 ──

function _crResetTimer() {
  if (_crAutoSendTimer) { clearTimeout(_crAutoSendTimer); _crAutoSendTimer = null; }
}

function _crStartTimer() {
  _crResetTimer();
  if (_crBubbleQueue.length === 0 && _crAttachQueue.length === 0) return;
  _crAutoSendTimer = setTimeout(() => _crTriggerSend(), 20000);
}

function _crAddToQueue() {
  const text = inputEl.value.trim();
  const hasAtts = pendingAttachments.length > 0;
  if (!text && !hasAtts) return false;
  if (text) {
    _crBubbleQueue.push(text);
    inputEl.value = '';
    resizeInput();
  }
  if (hasAtts) {
    _crAttachQueue.push(...pendingAttachments);
    pendingAttachments = [];
    renderPreview();
  }
  _crStartTimer();
  _crRenderQueuePreview();
  return true;
}

function _crRenderQueuePreview() {
  let area = document.getElementById('crQueuePreview');
  if (!area) return;
  const total = _crBubbleQueue.length + _crAttachQueue.length;
  if (total === 0) { area.innerHTML = ''; area.style.display = 'none'; return; }
  area.style.display = 'flex';
  area.innerHTML = _crBubbleQueue.map((t, i) => {
    // 如果是表情包，显示 emoji 标记
    const label = /^\[STICKER:/.test(t) ? '🙂 ' + t.replace(/^\[STICKER:|]$/g, '') : esc(t);
    return `<div class="cr-queue-item"><span>${label}</span><button onclick="_crRemoveQueue(${i})">✕</button></div>`;
  }).join('') + _crAttachQueue.map((a, i) =>
    `<div class="cr-queue-item"><span>📎 ${esc(a.name || '图片')}</span><button onclick="_crRemoveAttachQueue(${i})">✕</button></div>`
  ).join('');
}

function _crRemoveQueue(i) {
  _crBubbleQueue.splice(i, 1);
  _crRenderQueuePreview();
  if (_crBubbleQueue.length === 0 && _crAttachQueue.length === 0) _crResetTimer();
  else _crStartTimer();
}

function _crRemoveAttachQueue(i) {
  _crAttachQueue.splice(i, 1);
  _crRenderQueuePreview();
  if (_crBubbleQueue.length === 0 && _crAttachQueue.length === 0) _crResetTimer();
  else _crStartTimer();
}

async function _crTriggerSend() {
  _crResetTimer();
  // 把输入框剩余内容也加进去
  const leftover = inputEl.value.trim();
  if (leftover || pendingAttachments.length > 0) {
    if (leftover) { _crBubbleQueue.push(leftover); inputEl.value = ''; resizeInput(); }
    if (pendingAttachments.length > 0) { _crAttachQueue.push(...pendingAttachments); pendingAttachments = []; renderPreview(); }
  }

  if (_crBubbleQueue.length === 0 && _crAttachQueue.length === 0) return;

  const combinedText = _crBubbleQueue.join('\n');
  const attachments = _crAttachQueue.map(a => a.url);
  _crBubbleQueue = [];
  _crAttachQueue = [];
  _crRenderQueuePreview();

  if (!currentRoom || isSending) return;
  isSending = true;
  sendBtn.disabled = true;

  playSend();
  const localRow = appendMessage({ sender: 'user', content: combinedText, created_at: Date.now() / 1000, attachments });
  if (localRow) localRow.dataset.localEcho = '1';
  pendingUserEcho = {
    content: combinedText,
    attachmentsJson: JSON.stringify(attachments || []),
    expiresAt: Date.now() + 12000,
  };

  try {
    const resp = await fetch(`${API}/rooms/${currentRoom.id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: combinedText, model: chatroomModel, connor_model: chatroomConnorModel, attachments, tts_enabled: crTtsEnabled, tts_aion_voice: crTtsAionVoice, tts_connor_voice: crTtsConnorVoice, whisper_mode: crWhisperMode }),
    });

    await consumeChatroomSSE(resp);
  } catch (err) {
    toast('发送失败: ' + err.message);
  } finally {
    isSending = false;
    sendBtn.disabled = false;
    endStreamingBubble();
    inputEl.focus();
  }
}

function handleSSE(data) {
  switch (data.type) {
    case 'aion_start':
      appendTyping(crName('aion'));
      // 延迟创建流式气泡，等第一个 chunk 到达时再创建
      pendingStreamSender = 'aion';
      pendingStreamId = data.id;
      break;
    case 'aion_status':
      updateTypingStatus(crName('aion'), data.text);
      break;
    case 'aion_chunk':
      if (pendingStreamSender && !streamingBubble) {
        startStreamingBubble(pendingStreamSender, pendingStreamId);
        pendingStreamSender = null;
        pendingStreamId = null;
      }
      feedStreamingChunk(data.content);
      break;
    case 'aion_done':
      pendingStreamSender = null;
      pendingStreamId = null;
      // 用服务端清理后的干净文本替换流式累积的原始文本（包含工具指令）
      if (data.message && data.message.content != null && streamingBubble) {
        streamingText = data.message.content;
      }
      endStreamingBubble(data.message && data.message.attachments);
      playRecv();
      break;
    case 'connor_start':
      appendTyping(crName('connor'));
      pendingStreamSender = 'connor';
      pendingStreamId = data.id;
      break;
    case 'connor_status':
      updateTypingStatus(crName('connor'), data.text);
      break;
    case 'connor_chunk':
      if (pendingStreamSender && !streamingBubble) {
        startStreamingBubble(pendingStreamSender, pendingStreamId);
        pendingStreamSender = null;
        pendingStreamId = null;
      }
      feedStreamingChunk(data.content);
      break;
    case 'connor_done':
      pendingStreamSender = null;
      pendingStreamId = null;
      // 用服务端清理后的干净文本替换流式累积的原始文本
      if (data.message && data.message.content != null && streamingBubble) {
        streamingText = data.message.content;
      }
      endStreamingBubble(data.message && data.message.attachments);
      // 如果 connor_done 带了 message 且没有流式气泡（兼容旧路径），追加消息
      if (data.message
          && !document.getElementById(`streaming-${data.message.id}`)
          && !document.querySelector(`[data-msg-id="${data.message.id}"]`)) {
        appendMessage(data.message);
      }
      playRecv();
      break;
    case 'round_start':
      appendAiChatStatus(`AI 互聊 第 ${data.round}/${data.total} 轮`);
      break;
    case 'tts_chunk':
      crEnqueueTTSChunk(data.data.msg_id, data.data.seq, data.data.url);
      break;
    case 'tts_done':
      crFinishTTSForMsg(data.data.msg_id);
      break;
    case 'error':
      toast('错误: ' + data.content);
      break;
    case 'system_msg':
      if (data.message) { appendMessage(data.message); }
      break;
    case 'memory_record':
      crShowMemoryRecordHint(data.msg_id, data.content);
      break;
    case 'music':
      if (data.msg_id && data.cards) {
        crMusicCards[data.msg_id] = data.cards;
        crRenderMusicCards(data.msg_id);
        scrollToBottom();
        if (data.autoplay && data.cards.length) crPlayMusicOnline(data.cards[0].id);
      }
      break;
    case 'toy_command':
      crHandleToyCommand(data);
      break;
    case 'moment_new':
      // 朋友圈动态已移至独立页面
      break;
  }
}

inputEl.addEventListener('input', resizeInput);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    // 纯 Enter：加入气泡队列
    if (!e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      _crAddToQueue();
      return;
    }
    // Shift+Enter 或 Ctrl+Enter：发送
    if (e.shiftKey || e.ctrlKey) {
      e.preventDefault();
      _crAddToQueue();
      _crTriggerSend();
    }
  }
});

// ══════════════════════════════════════════════════
//  AI 互聊
// ══════════════════════════════════════════════════

async function triggerAiChat() {
  if (!currentRoom || currentRoom.type !== 'group' || isSending || isAiChatting || isReplyOnce) return;
  isAiChatting = true;
  aiChatBtn.disabled = true;
  aiChatBtn.textContent = '⏳ 互聊中...';

  try {
    const resp = await fetch(`${API}/rooms/${currentRoom.id}/ai-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: chatroomModel, connor_model: chatroomConnorModel, tts_enabled: crTtsEnabled, tts_aion_voice: crTtsAionVoice, tts_connor_voice: crTtsConnorVoice }),
    });

    await consumeChatroomSSE(resp);
  } catch (err) {
    toast('AI 互聊失败: ' + err.message);
  } finally {
    isAiChatting = false;
    aiChatBtn.disabled = false;
    aiChatBtn.textContent = '💬 让他们聊';
    endStreamingBubble();
    removeAiChatStatus();
  }
}

async function triggerReplyOnce(speaker) {
  if (!currentRoom || currentRoom.type !== 'group' || isSending || isAiChatting || isReplyOnce) return;
  if (!['aion', 'connor'].includes(speaker)) return;

  isReplyOnce = true;
  isAiChatting = true;
  if (replyAionBtn) replyAionBtn.disabled = true;
  if (replyConnorBtn) replyConnorBtn.disabled = true;
  if (aiChatBtn) aiChatBtn.disabled = true;
  const activeBtn = speaker === 'aion' ? replyAionBtn : replyConnorBtn;
  const oldText = activeBtn ? activeBtn.textContent : '';
  if (activeBtn) activeBtn.textContent = `${crName(speaker)} 回复中...`;

  try {
    const resp = await fetch(`${API}/rooms/${currentRoom.id}/reply-once`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        speaker,
        model: chatroomModel,
        connor_model: chatroomConnorModel,
        tts_enabled: crTtsEnabled,
        tts_aion_voice: crTtsAionVoice,
        tts_connor_voice: crTtsConnorVoice,
        whisper_mode: crWhisperMode,
      }),
    });
    await consumeChatroomSSE(resp);
  } catch (err) {
    toast(`${crName(speaker)} 回复失败: ` + err.message);
  } finally {
    isReplyOnce = false;
    isAiChatting = false;
    if (replyAionBtn) replyAionBtn.disabled = false;
    if (replyConnorBtn) replyConnorBtn.disabled = false;
    if (aiChatBtn) aiChatBtn.disabled = false;
    if (activeBtn) activeBtn.textContent = oldText;
    endStreamingBubble();
    updateHeaderActions();
  }
}

// ══════════════════════════════════════════════════
//  设置
// ══════════════════════════════════════════════════

async function openSettings() {
  if (!currentRoom) { toast('请先选择一个房间'); return; }

  // 先立即打开面板，再异步填充数据（提升感知速度）
  document.getElementById('setTtsEnabled').checked = crTtsEnabled;
  const personaFold = document.getElementById('settingsPersonaFold');
  if (personaFold) personaFold.open = false;
  document.getElementById('settingsOverlay').classList.add('active');

  // 三个请求并行发起，避免串行等待外部服务超时
  const [room, cfg] = await Promise.all([
    api(`/rooms/${currentRoom.id}`),
    api('/config'),
    crLoadTTSVoices(),
  ]);
  applyChatroomNames(cfg);

  document.getElementById('setTitle').value = room.title || '';
  document.getElementById('setAionPersona').value = room.aion_persona || '';
  document.getElementById('setConnorPersona').value = room.connor_persona || '';
  document.getElementById('setContextMin').value = room.context_minutes || 30;
  document.getElementById('setAiRounds').value = room.ai_chat_rounds || 1;
  document.getElementById('setConnorName').value = cfg.connor_name || 'Connor';
  chatroomConnorModel = cfg.connor_model || chatroomConnorModel || 'Codex';
  document.getElementById('setAionModel').innerHTML = renderModelOptions(chatroomModel);
  document.getElementById('setConnorModel').innerHTML = renderModelOptions(chatroomConnorModel);
  document.getElementById('setAionModel').value = chatroomModel || '';
  document.getElementById('setConnorModel').value = chatroomConnorModel || 'Codex';

  // 回复顺序选项：用世界书和配置中的名字
  const aionName = crAiName;
  const connorName = crConnorName;
  document.getElementById('optAion').textContent = `${aionName} 优先`;
  document.getElementById('optConnor').textContent = `${connorName} 优先`;
  chatroomReplyOrder = cfg.reply_order || 'random';
  document.getElementById('setReplyOrder').value = cfg.reply_order || 'random';
  updateHeaderActions();

  // connor_1v1 隐藏群聊专属设置
  const isConnor1v1 = room.type === 'connor_1v1';
  document.getElementById('fieldAionPersona').style.display = isConnor1v1 ? 'none' : '';
  document.getElementById('fieldAiRounds').style.display = isConnor1v1 ? 'none' : '';
  document.getElementById('fieldReplyOrder').style.display = isConnor1v1 ? 'none' : '';
  document.getElementById('fieldAionModel').style.display = isConnor1v1 ? 'none' : '';
}

function closeSettings() {
  document.getElementById('settingsOverlay').classList.remove('active');
}

async function saveSettings() {
  if (!currentRoom) return;

  // 保存房间设置
  await api(`/rooms/${currentRoom.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      title: document.getElementById('setTitle').value,
      aion_persona: document.getElementById('setAionPersona').value,
      connor_persona: document.getElementById('setConnorPersona').value,
      context_minutes: parseInt(document.getElementById('setContextMin').value) || 30,
      ai_chat_rounds: parseInt(document.getElementById('setAiRounds').value) || 1,
    }),
  });

  // 保存 Connor 配置
  const nextConnorName = document.getElementById('setConnorName')?.value || crConnorName;
  const nextReplyOrder = document.getElementById('setReplyOrder').value || 'random';
  chatroomModel = document.getElementById('setAionModel')?.value || chatroomModel;
  chatroomConnorModel = document.getElementById('setConnorModel')?.value || chatroomConnorModel || 'Codex';
  await api('/config', {
    method: 'PUT',
    body: JSON.stringify({
      connor_name: nextConnorName || undefined,
      connor_model: chatroomConnorModel,
      aion_model: chatroomModel,
      tts_aion_voice: document.getElementById('setTtsAionVoice').value,
      tts_connor_voice: document.getElementById('setTtsConnorVoice').value,
      reply_order: nextReplyOrder,
    }),
  });
  applyChatroomNames({ connor_name: nextConnorName });
  await loadMessages();
  checkConnor();

  // 同步本地变量
  crTtsAionVoice = document.getElementById('setTtsAionVoice').value;
  crTtsConnorVoice = document.getElementById('setTtsConnorVoice').value;
  chatroomReplyOrder = nextReplyOrder;
  updateHeaderActions();

  // 刷新
  currentRoom.title = document.getElementById('setTitle').value;
  roomTitleEl.textContent = currentRoom.title;
  await loadRooms();
  closeSettings();
  toast('已保存');
}

async function triggerDigest() {
  if (!currentRoom) return;
  toast('正在总结记忆...');
  const result = await api(`/rooms/${currentRoom.id}/digest`, { method: 'POST' });
  toast(result.message || '总结完成');
  loadMemories();
}

// ══════════════════════════════════════════════════
//  记忆库
// ══════════════════════════════════════════════════

function openMemory() {
  if (!currentRoom) { toast('请先选择一个房间'); return; }
  document.getElementById('memoryOverlay').classList.add('active');
  hideMemForm();
  loadMemories();
  closeSidebar();
}

function closeMemory() {
  document.getElementById('memoryOverlay').classList.remove('active');
}

// 点击遮罩关闭记忆库
document.getElementById('memoryOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'memoryOverlay') closeMemory();
});

async function loadMemories() {
  if (!currentRoom) return;
  const memListEl = document.getElementById('memList');
  try {
    const mems = await api(`/rooms/${currentRoom.id}/memories`);
    if (!Array.isArray(mems) || !mems.length) {
      memListEl.innerHTML = '<div class="mem-empty">暂无记忆，可手动添加或总结生成</div>';
      return;
    }
    memListEl.innerHTML = mems.map(m => {
      const date = new Date(m.created_at * 1000).toLocaleDateString();
      const kw = m.keywords ? `关键词: ${esc(m.keywords)}` : '';
      const hasSource = m.source_start_ts && m.source_end_ts;
      return `
        <div class="mem-item" data-id="${m.id}">
          <div class="mem-content">${esc(m.content)}</div>
          <div class="mem-meta">
            <span>${date}</span>
            <span>重要度: ${m.importance}</span>
            ${kw ? `<span>${kw}</span>` : ''}
            <div class="mem-actions">
              ${hasSource ? `<button onclick="viewMemSource('${m.id}')" title="查看原文">📜</button>` : ''}
              <button onclick="editMemory('${m.id}')" title="编辑">✏️</button>
              <button class="del" onclick="deleteMemory('${m.id}')" title="删除">✕</button>
            </div>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    memListEl.innerHTML = `<div class="mem-empty">加载失败: ${err.message}</div>`;
  }
}

function showAddMemory() {
  document.getElementById('memEditId').value = '';
  document.getElementById('memContent').value = '';
  document.getElementById('memKeywords').value = '';
  document.getElementById('memImportance').value = '0.5';
  document.getElementById('memForm').style.display = 'block';
  document.getElementById('memContent').focus();
}

function hideMemForm() {
  document.getElementById('memForm').style.display = 'none';
}

async function editMemory(memId) {
  const mems = await api(`/rooms/${currentRoom.id}/memories`);
  const mem = (Array.isArray(mems) ? mems : []).find(m => m.id === memId);
  if (!mem) { toast('找不到该记忆'); return; }

  document.getElementById('memEditId').value = memId;
  document.getElementById('memContent').value = mem.content || '';
  document.getElementById('memKeywords').value = mem.keywords || '';
  document.getElementById('memImportance').value = mem.importance ?? 0.5;
  document.getElementById('memForm').style.display = 'block';
  document.getElementById('memContent').focus();
}

async function saveMemory() {
  if (!currentRoom) return;
  const editId = document.getElementById('memEditId').value;
  const content = document.getElementById('memContent').value.trim();
  if (!content) { toast('内容不能为空'); return; }

  const body = {
    content,
    keywords: document.getElementById('memKeywords').value.trim(),
    importance: parseFloat(document.getElementById('memImportance').value) || 0.5,
  };

  try {
    let result;
    if (editId) {
      result = await api(`/memories/${editId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      result = await api(`/rooms/${currentRoom.id}/memories`, { method: 'POST', body: JSON.stringify(body) });
    }
    if (result && result.error) {
      toast('保存失败: ' + result.error);
      return;
    }
    toast(editId ? '记忆已更新' : '记忆已添加');
    hideMemForm();
    loadMemories();
  } catch (err) {
    toast('保存失败: ' + err.message);
  }
}

async function deleteMemory(memId) {
  if (!confirm('确定删除此记忆？')) return;
  await api(`/memories/${memId}`, { method: 'DELETE' });
  toast('已删除');
  loadMemories();
}

async function viewMemSource(memId) {
  const overlay = document.getElementById('memSourceOverlay');
  const listEl = document.getElementById('memSourceList');
  overlay.style.display = 'block';
  listEl.innerHTML = '<div class="mem-empty">加载中...</div>';
  try {
    const result = await api(`/memories/${memId}/source`);
    if (!result.ok || !result.messages || !result.messages.length) {
      listEl.innerHTML = `<div class="mem-empty">${result.message || '没有找到原文记录'}</div>`;
      return;
    }
    listEl.innerHTML = result.messages.map(m => {
      const t = m.created_at ? new Date(m.created_at * 1000).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
      return `<div style="margin-bottom:10px; padding:8px; background:var(--bubble-other); border-radius:8px;">
        <div style="font-size:12px; color:var(--text2); margin-bottom:4px;">
          <strong>${esc(m.name)}</strong> <span style="margin-left:6px;">${esc(t)}</span>
        </div>
        <div style="white-space:pre-wrap; word-break:break-word; font-size:13px;">${esc(m.content)}</div>
      </div>`;
    }).join('');
  } catch(e) {
    listEl.innerHTML = '<div class="mem-empty">加载失败</div>';
  }
}

function closeMemSource() {
  document.getElementById('memSourceOverlay').style.display = 'none';
}

// 点击遮罩关闭设置
document.getElementById('settingsOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'settingsOverlay') closeSettings();
});

// ══════════════════════════════════════════════════
//  Connor 状态
// ══════════════════════════════════════════════════

async function checkConnor() {
  try {
    const result = await api('/connor-status');
    const online = result.online;
    connorDot.className = `connor-dot ${online ? 'online' : ''}`;
    connorStatusEl.textContent = `${crConnorName}: ${online ? '在线' : '离线'}`;
  } catch {
    connorDot.className = 'connor-dot';
    connorStatusEl.textContent = `${crConnorName}: 离线`;
  }
}

// ══════════════════════════════════════════════════
//  侧栏
// ══════════════════════════════════════════════════

function openSidebar() { sidebar.classList.add('open'); backdrop.classList.add('active'); }
function closeSidebar() { sidebar.classList.remove('open'); backdrop.classList.remove('active'); }
menuBtn.addEventListener('click', openSidebar);
backdrop.addEventListener('click', closeSidebar);

// ══════════════════════════════════════════════════
//  导航
// ══════════════════════════════════════════════════

function goHome() {
  window.location.href = '/';
}

function crOpenDiary() {
  window.location.href = '/diary';
}

function renderEmptyChat() {
  roomTitleEl.textContent = '聊天室';
  currentRoom = null;
  composer.style.display = 'none';
  updateHeaderActions();
  messagesEl.innerHTML = `
    <div class="empty-state">
      <div class="icon">💬</div>
      <div>选择或创建一个聊天室开始吧</div>
    </div>`;
}

// ══════════════════════════════════════════════════
//  WebSocket 实时同步
// ══════════════════════════════════════════════════

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'ping' }));
  };

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'pong') return;

      if (data.type === 'tts_chunk' && data.data) {
        crEnqueueTTSChunk(data.data.msg_id, data.data.seq, data.data.url);
      }

      if (data.type === 'tts_done' && data.data) {
        crFinishTTSForMsg(data.data.msg_id);
      }

      if (data.type === 'memory_record' && data.data && !isSending && !isAiChatting) {
        crShowMemoryRecordHint(data.data.msg_id, data.data.content);
      }

      if (data.type === 'chatroom_msg_created' && currentRoom) {
        const msg = data.data;
        if (msg.room_id === currentRoom.id) {
          // 避免重复：流式回复本身已有 streaming 行；异步跟进消息即使还在发送中也要显示。
          const existing = document.getElementById(`streaming-${msg.id}`);
          if (!existing && !messagesEl.querySelector(`[data-msg-id="${msg.id}"]`)) {
            if (!reconcileLocalUserEcho(msg)) {
              appendMessage(msg);
              playRecv();
            }
          }
        }
      }

      if (data.type === 'chatroom_msg_deleted' && currentRoom) {
        const d = data.data;
        if (d.room_id === currentRoom.id) {
          delete crMessagesById[d.id];
          const row = document.querySelector(`[data-msg-id="${d.id}"]`);
          if (row) row.remove();
        }
      }

      if (data.type === 'chatroom_msg_updated' && currentRoom) {
        const msg = data.data;
        if (msg.room_id === currentRoom.id) {
          crMessagesById[msg.id] = msg;
          const row = document.querySelector(`[data-msg-id="${msg.id}"]`);
          if (row) {
            const div = document.createElement('div');
            div.innerHTML = msgHTML(msg);
            row.replaceWith(div.firstElementChild);
          }
        }
      }

      if (data.type === 'chatroom_room_created' || data.type === 'chatroom_room_deleted' || data.type === 'chatroom_room_updated') {
        loadRooms();
      }

      // 音乐广播（来自 WS broadcast）— 仅在非发送状态下处理（发送时 SSE 已处理）
      if (data.type === 'music' && data.data && !isSending && !isAiChatting) {
        const d = data.data;
        if (d.msg_id && d.cards) {
          crMusicCards[d.msg_id] = d.cards;
          crRenderMusicCards(d.msg_id);
          scrollToBottom();
          if (d.autoplay && d.cards.length) crPlayMusicOnline(d.cards[0].id);
        }
      }

      // 玩具指令广播
      if (data.type === 'toy_command' && data.data) {
        crHandleToyCommand(data.data);
      }

      // Connor 钱包余额变动 → 自动刷新钱包面板
      if (data.type === 'connor_wallet_update') {
        if (document.getElementById('crWalletPanelOverlay').classList.contains('show')) {
          crOpenWalletPanel();
        }
      }
    } catch {}
  };

  ws.onclose = () => setTimeout(connectWS, 3000);
  ws.onerror = () => ws.close();
}

// ══════════════════════════════════════════════════
//  图片上传 & 预览 & 查看器
// ══════════════════════════════════════════════════

function renderAttachments(atts) {
  if (!atts || !atts.length) return '';
  let html = '';
  atts.forEach(item => {
    const url = typeof item === 'string' ? item : (item.url || '');
    const type = (typeof item === 'object' && item.type) || '';
    if (type === 'toy') {
      return;
    } else if (type === 'voice') {
      const dur = item.duration || 0;
      const durStr = dur < 60 ? `${Math.round(dur)}"` : `${Math.floor(dur/60)}'${Math.round(dur%60)}"`;
      const waveBars = Array.from({length: 6}, () => `<span style="height:${4 + Math.random()*14}px"></span>`).join('');
      html += `<div class="voice-bubble" onclick="crPlayVoice(this,'${esc(url)}')">
        <span class="vb-play">▶</span>
        <span class="vb-wave">${waveBars}</span>
        <span class="vb-dur">${durStr}</span>
      </div>`;
      if (item.transcript) html += `<div class="vb-transcript">${esc(item.transcript)}</div>`;
    } else if (url) {
      html += `<img src="${esc(url)}" onclick="openImageViewer(this.src)">`;
    }
  });
  return html ? '<div class="msg-media">' + html + '</div>' : '';
}

async function handleChatroomFileSelect(input) {
  for (const file of input.files) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch(`${API}/upload`, { method: 'POST', body: fd });
      const data = await res.json();
      if (data.error) { toast(data.error); continue; }
      pendingAttachments.push(data);
    } catch (err) {
      toast('上传失败: ' + err.message);
    }
  }
  input.value = '';
  renderPreview();
}

function renderPreview() {
  const area = document.getElementById('previewArea');
  if (!pendingAttachments.length) { area.className = 'preview-area'; area.innerHTML = ''; return; }
  area.className = 'preview-area has-files';
  area.innerHTML = pendingAttachments.map((a, i) => {
    return `<div class="preview-item"><img src="${a.url}"><button class="preview-remove" onclick="removeChatroomAttachment(${i})">✕</button></div>`;
  }).join('');
}

function removeChatroomAttachment(i) {
  pendingAttachments.splice(i, 1);
  renderPreview();
}

function openImageViewer(src) {
  const viewer = document.getElementById('imageViewer');
  document.getElementById('viewerImg').src = src;
  viewer.classList.add('active');
}

function closeImageViewer() {
  document.getElementById('imageViewer').classList.remove('active');
}

// 文件选择绑定
document.getElementById('fileInput').addEventListener('change', function() {
  handleChatroomFileSelect(this);
});

// 粘贴图片
inputEl.addEventListener('paste', async (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue;
    e.preventDefault();
    const file = item.getAsFile();
    if (!file) continue;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch(`${API}/upload`, { method: 'POST', body: fd });
      const data = await res.json();
      if (data.error) { toast(data.error); continue; }
      pendingAttachments.push(data);
      renderPreview();
    } catch (err) {
      toast('粘贴上传失败: ' + err.message);
    }
  }
});

// ESC 关闭图片查看器
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeImageViewer();
});

// ══════════════════════════════════════════════════
//  转义
// ══════════════════════════════════════════════════

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/** 渲染 [转账给XXX：N元] 或 [转账：N元] 为微信风格转账卡片 */
function renderTransferCards(html) {
  const transferRe = /\[\u8f6c\u8d26(?:\u7ed9([^\uff1a:]+?))?[\uff1a:]\s*(-?\d+(?:\.\d+)?)\s*\u5143\]/g;
  return html.replace(transferRe, (match, recipient, amount) => {
    const val = parseFloat(amount);
    const isNeg = val < 0;
    const absVal = Math.abs(val);
    const targetName = recipient ? recipient.trim() : '';
    if (isNeg) {
      return `<div class="transfer-card deduct"><div class="transfer-card-icon-wrap"><svg viewBox="0 0 40 40" width="28" height="28"><circle cx="20" cy="20" r="18" fill="none" stroke="#fff" stroke-width="2.5"/><line x1="14" y1="14" x2="26" y2="26" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><line x1="26" y1="14" x2="14" y2="26" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg></div><div class="transfer-card-body"><div class="transfer-card-amount">¥${absVal}</div><div class="transfer-card-desc">钱包扣除${targetName ? '（' + targetName + '）' : ''}</div></div><div class="transfer-card-footer">扣除</div></div>`;
    } else {
      const descText = targetName ? `转账给${targetName}` : '发起了一笔转账';
      return `<div class="transfer-card"><div class="transfer-card-icon-wrap"><svg viewBox="0 0 40 40" width="28" height="28"><circle cx="20" cy="20" r="18" fill="none" stroke="#fff" stroke-width="2.5"/><path d="M12 17h12M24 17l-3-3" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M28 23H16M16 23l3 3" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div><div class="transfer-card-body"><div class="transfer-card-amount">¥${absVal}</div><div class="transfer-card-desc">${descText}</div></div><div class="transfer-card-footer">转账</div></div>`;
    }
  });
}

/** 转义文本并渲染转账卡片（用户消息） */
function escWithTransfer(str) {
  if (!str) return '';
  return renderTransferCards(esc(str));
}

/** 将文本中的 [[image:...]] 标记渲染为 <img>，[转账：N元] 渲染为卡片，其余部分转义 */
function escWithImages(str) {
  if (!str) return '';
  // 合并正则：匹配 [STICKER:xxx]/[表情:xxx]、[[image:xxx]]、[转账给XXX：N元]/[转账：N元]（支持负数）
  const re = /\[(?:STICKER|表情)[：:\s]*([^\]]+)\]|\[\[image:(\S+?)\]\]|\[转账(?:给([^\uff1a:]+?))?[：:]\s*(-?\d+(?:\.\d+)?)\s*元\]/g;
  let result = '';
  let lastIdx = 0;
  let match;
  while ((match = re.exec(str)) !== null) {
    const before = str.slice(lastIdx, match.index);
    if (before) result += esc(before);

    if (match[1] !== undefined) {
      // [STICKER:xxx] / [表情:xxx]
      const n = match[1].trim();
      const realFile = _stickerFuzzyFind(n);
      if (realFile) {
        const safeUrl = STICKER_BASE + encodeURIComponent(realFile);
        result += `<span class="msg-sticker" onclick="openImageViewer('${safeUrl}')" title="${esc(n)}"><img src="${safeUrl}" onerror="this.onerror=null;this.style.display='none';this.parentElement.textContent='[表情: ${esc(n)}]'" alt="${esc(n)}"></span>`;
      } else {
        result += `<span style="font-size:13px;color:var(--text3,#b0a39a)">[表情: ${esc(n)}]</span>`;
      }
    } else if (match[2] !== undefined) {
      // [[image:xxx]]
      let imgUrl = match[2];
      if (imgUrl.startsWith('/uploads/')) imgUrl = '/cr-uploads/' + imgUrl.slice('/uploads/'.length);
      result += `<img class="cr-inline-img" src="${esc(imgUrl)}" onclick="openImageViewer(this.src)" loading="lazy">`;
    } else if (match[4] !== undefined) {
      // [转账给XXX：N元] 或 [转账：N元]
      result += _buildTransferCardHtml(match[3], match[4]);
    }
    lastIdx = re.lastIndex;
  }
  const tail = str.slice(lastIdx);
  if (tail) result += esc(tail);
  return result;
}

function _buildTransferCardHtml(recipient, amount) {
  const val = parseFloat(amount);
  const isNeg = val < 0;
  const absVal = Math.abs(val);
  const targetName = recipient ? recipient.trim() : '';
  if (isNeg) {
    return `<div class="transfer-card deduct"><div class="transfer-card-icon-wrap"><svg viewBox="0 0 40 40" width="28" height="28"><circle cx="20" cy="20" r="18" fill="none" stroke="#fff" stroke-width="2.5"/><line x1="14" y1="14" x2="26" y2="26" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><line x1="26" y1="14" x2="14" y2="26" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg></div><div class="transfer-card-body"><div class="transfer-card-amount">¥${absVal}</div><div class="transfer-card-desc">钱包扣除${targetName ? '（' + targetName + '）' : ''}</div></div><div class="transfer-card-footer">扣除</div></div>`;
  } else {
    const descText = targetName ? `转账给${targetName}` : '发起了一笔转账';
    return `<div class="transfer-card"><div class="transfer-card-icon-wrap"><svg viewBox="0 0 40 40" width="28" height="28"><circle cx="20" cy="20" r="18" fill="none" stroke="#fff" stroke-width="2.5"/><path d="M12 17h12M24 17l-3-3" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M28 23H16M16 23l3 3" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div><div class="transfer-card-body"><div class="transfer-card-amount">¥${absVal}</div><div class="transfer-card-desc">${descText}</div></div><div class="transfer-card-footer">转账</div></div>`;
  }
}

/** 模糊匹配表情包名称 */
function _stickerFuzzyFind(name) {
  if (!name) return null;
  if (_stickerFileMap[name]) return _stickerFileMap[name];
  const cleaned = name.replace(/\s+/g, '');
  if (_stickerFileMap[cleaned]) return _stickerFileMap[cleaned];
  for (const [k, v] of Object.entries(_stickerFileMap)) {
    if (k.replace(/\s+/g, '') === cleaned) return v;
    if (k.includes(cleaned) || cleaned.includes(k)) return v;
  }
  return null;
}

// ══════════════════════════════════════════════════
//  ＋ 展开菜单
// ══════════════════════════════════════════════════

function crTogglePlusMenu() {
  const m = document.getElementById('crPlusMenu');
  m.classList.toggle('show');
}
function crClosePlusMenu() {
  document.getElementById('crPlusMenu').classList.remove('show');
}
document.addEventListener('click', e => {
  const wrap = document.querySelector('.plus-menu-wrap');
  const menu = document.getElementById('crPlusMenu');
  if (menu && (wrap?.contains(e.target) || menu.contains(e.target))) return;
  crClosePlusMenu();
});

// ══════════════════════════════════════════════════
//  Android 原生桥接（iframe 穿透）
// ══════════════════════════════════════════════════
// 聊天室可能在 iframe 中加载，原生桥注入在顶层 WebView，需要穿透访问
function _getNativeBridge(name) {
  try { if (window[name]) return window[name]; } catch(e) {}
  try { if (window.parent && window.parent[name]) return window.parent[name]; } catch(e) {}
  try { if (window.top && window.top[name]) return window.top[name]; } catch(e) {}
  return null;
}

// ══════════════════════════════════════════════════
//  拍照功能
// ══════════════════════════════════════════════════

let _crCamOverlay = null;
let _crCamStream = null;
let _crCamUseNative = false;
let _crCamNativeTimer = null;
let _crCamFacing = 'environment';

function crOpenCamera() {
  if (_crCamOverlay) _crCamOverlay.remove();
  _crCamFacing = 'environment';
  _crCamOverlay = document.createElement('div');
  _crCamOverlay.className = 'camera-overlay show';
  _crCamOverlay.innerHTML = `
    <div class="camera-preview">
      <video id="crCamVideo" autoplay playsinline muted></video>
      <img id="crCamImg" style="display:none">
    </div>
    <div class="camera-bar">
      <button class="cam-close-btn" onclick="crCloseCamera()">✕</button>
      <button class="cam-shutter-btn" onclick="crCapturePhoto()">📷</button>
      <button class="cam-flip-btn" onclick="crFlipCam()">🔄</button>
    </div>
  `;
  document.body.appendChild(_crCamOverlay);
  _crStartCam();
}

async function _crStartCam() {
  try {
    _crCamStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _crCamFacing, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    const vid = document.getElementById('crCamVideo');
    if (vid) { vid.srcObject = _crCamStream; vid.style.transform = _crCamFacing === 'user' ? 'scaleX(-1)' : 'none'; vid.style.display = 'block'; vid.play().catch(()=>{}); }
    const img = document.getElementById('crCamImg');
    if (img) img.style.display = 'none';
    _crCamUseNative = false;
    return;
  } catch (e) { console.warn('[CR-Camera] getUserMedia failed:', e); }
  const _cam = _getNativeBridge('AionCamera');
  if (_cam) {
    const ok = _cam.start(_crCamFacing === 'user' ? 'user' : 'environment');
    if (ok) {
      _crCamUseNative = true;
      const vid = document.getElementById('crCamVideo');
      const img = document.getElementById('crCamImg');
      if (vid) vid.style.display = 'none';
      if (img) { img.style.display = 'block'; img.style.transform = _crCamFacing === 'user' ? 'scaleX(-1)' : 'none'; }
      _crPollCamFrame();
      return;
    }
  }
  alert('无法打开摄像头');
  crCloseCamera();
}

function _crPollCamFrame() {
  const _cam = _getNativeBridge('AionCamera');
  if (!_crCamUseNative || !_cam) return;
  const frame = _cam.getFrame();
  if (frame) { const img = document.getElementById('crCamImg'); if (img) img.src = 'data:image/jpeg;base64,' + frame; }
  _crCamNativeTimer = requestAnimationFrame(_crPollCamFrame);
}

function _crStopCam() {
  if (_crCamNativeTimer) { cancelAnimationFrame(_crCamNativeTimer); _crCamNativeTimer = null; }
  if (_crCamUseNative) { const _cam = _getNativeBridge('AionCamera'); if (_cam) _cam.stop(); _crCamUseNative = false; }
  if (_crCamStream) { _crCamStream.getTracks().forEach(t => t.stop()); _crCamStream = null; }
}

function crCloseCamera() {
  _crStopCam();
  if (_crCamOverlay) { _crCamOverlay.remove(); _crCamOverlay = null; }
}

async function crFlipCam() {
  _crCamFacing = _crCamFacing === 'environment' ? 'user' : 'environment';
  if (_crCamUseNative) {
    const _cam = _getNativeBridge('AionCamera');
    if (_cam) _cam.flip();
    const img = document.getElementById('crCamImg');
    if (img) img.style.transform = _crCamFacing === 'user' ? 'scaleX(-1)' : 'none';
  } else {
    _crStopCam();
    await _crStartCam();
  }
}

async function crCapturePhoto() {
  let dataUrl = null;
  if (_crCamUseNative) {
    const _cam = _getNativeBridge('AionCamera');
    if (_cam) { const b64 = _cam.capture(); if (b64) dataUrl = 'data:image/jpeg;base64,' + b64; }
  } else if (_crCamStream) {
    const videoEl = document.getElementById('crCamVideo');
    if (videoEl) {
      const canvas = document.createElement('canvas');
      canvas.width = videoEl.videoWidth || 640;
      canvas.height = videoEl.videoHeight || 480;
      canvas.getContext('2d').drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    }
  }
  if (!dataUrl) { alert('拍照失败'); return; }
  crCloseCamera();
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  const fd = new FormData();
  fd.append('file', blob, 'photo_' + Date.now() + '.jpg');
  try {
    const res = await fetch(`${API}/upload`, { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) { toast(data.error); return; }
    pendingAttachments.push(data);
    renderPreview();
  } catch (err) { toast('上传失败: ' + err.message); }
}

// ══════════════════════════════════════════════════
//  语音消息
// ══════════════════════════════════════════════════

let _crVoiceMode = false;
let _crVoiceRecording = false;
let _crVoiceMediaRecorder = null;
let _crVoiceStream = null;
let _crVoiceChunks = [];
let _crVoiceStartTime = 0;
let _crVoiceTimerInterval = null;
let _crVoiceOverlay = null;
let _crVoiceCancelled = false;
let _crVoiceNativeChunks = [];
let _crVoiceUseNative = false;

// 语音消息播放
let _crVoiceAudio = null;
function crPlayVoice(el, url) {
  if (_crVoiceAudio && el.classList.contains('playing')) {
    _crVoiceAudio.pause(); _crVoiceAudio = null;
    el.classList.remove('playing'); el.querySelector('.vb-play').textContent = '▶';
    return;
  }
  document.querySelectorAll('.voice-bubble.playing').forEach(b => {
    b.classList.remove('playing'); b.querySelector('.vb-play').textContent = '▶';
  });
  if (_crVoiceAudio) { _crVoiceAudio.pause(); _crVoiceAudio = null; }
  _crVoiceAudio = new Audio(url);
  el.classList.add('playing'); el.querySelector('.vb-play').textContent = '⏸';
  _crVoiceAudio.play().catch(()=>{});
  _crVoiceAudio.onended = () => { el.classList.remove('playing'); el.querySelector('.vb-play').textContent = '▶'; _crVoiceAudio = null; };
}

function crToggleVoiceMode() {
  _crVoiceMode = !_crVoiceMode;
  const composerEl = document.getElementById('composer');
  const voiceRow = document.getElementById('crVoiceModeRow');
  if (_crVoiceMode) {
    composerEl.style.display = 'none';
    voiceRow.classList.add('active');
    _crInitVoiceHoldBtn();
  } else {
    if (currentRoom) composerEl.style.display = 'flex';
    voiceRow.classList.remove('active');
  }
}

function _crInitVoiceHoldBtn() {
  const btn = document.getElementById('crVoiceHoldBtn');
  if (btn._inited) return;
  btn._inited = true;
  btn.addEventListener('mousedown', e => { e.preventDefault(); _crVoiceStartRecord(e); });
  document.addEventListener('mousemove', e => { if (_crVoiceRecording) _crVoiceTrackPointer(e); });
  document.addEventListener('mouseup', e => { if (_crVoiceRecording) _crVoiceStopRecord(e); });
  btn.addEventListener('touchstart', e => { e.preventDefault(); _crVoiceStartRecord(e.touches[0]); }, {passive:false});
  document.addEventListener('touchmove', e => { if (_crVoiceRecording) _crVoiceTrackPointer(e.touches[0]); }, {passive:false});
  document.addEventListener('touchend', e => { if (_crVoiceRecording) _crVoiceStopRecord(e.changedTouches[0]); });
  document.addEventListener('touchcancel', e => { if (_crVoiceRecording) { _crVoiceCancelled = true; _crVoiceStopRecord(e.changedTouches?.[0]); } });
}

async function _crVoiceStartRecord(evt) {
  if (_crVoiceRecording || isSending) return;
  _crVoiceRecording = true;
  _crVoiceCancelled = false;
  _crVoiceChunks = [];
  _crVoiceNativeChunks = [];
  _crVoiceStartTime = Date.now();

  _crVoiceOverlay = document.createElement('div');
  _crVoiceOverlay.className = 'voice-record-overlay active';
  _crVoiceOverlay.innerHTML = `
    <div class="vr-bg"></div>
    <div class="vr-trash-zone" id="crVrTrash">🗑️</div>
    <div class="vr-timer" id="crVrTimer">0:00</div>
    <div class="vr-hint" id="crVrHint">↑ 上滑取消</div>
  `;
  document.body.appendChild(_crVoiceOverlay);

  _crVoiceTimerInterval = setInterval(() => {
    const sec = Math.floor((Date.now() - _crVoiceStartTime) / 1000);
    const m = Math.floor(sec / 60), s = sec % 60;
    const timer = document.getElementById('crVrTimer');
    if (timer) timer.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }, 200);

  const btn = document.getElementById('crVoiceHoldBtn');
  btn.classList.add('recording'); btn.textContent = '松开 发送';

  _crVoiceUseNative = false;

  // Android WebView：直接用原生录音桥（绕过 HTTPS 限制）
  // 注意：聊天室可能在 iframe 中加载，AionAudio 注入在顶层 WebView
  const _AionAudio = _getNativeBridge('AionAudio');
  if (_AionAudio) {
    _crVoiceUseNative = true; _crVoiceNativeChunks = [];
    window._voiceNativeOnChunk = (b64) => { _crVoiceNativeChunks.push(b64); };
    // 同时在顶层窗口注册回调（AudioBridge 的 evaluateJavascript 在顶层执行）
    try { if (window.top !== window) window.top._voiceNativeOnChunk = window._voiceNativeOnChunk; } catch(e) {}
    try { if (window.parent !== window) window.parent._voiceNativeOnChunk = window._voiceNativeOnChunk; } catch(e) {}
    const ok = _AionAudio.start();
    if (!ok) { toast('麦克风启动失败'); _crVoiceCleanup(); return; }
    return;
  }

  // 浏览器：使用 getUserMedia + MediaRecorder
  try {
    _crVoiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = _crGetVoiceMime();
    _crVoiceMediaRecorder = new MediaRecorder(_crVoiceStream, mime ? { mimeType: mime } : undefined);
    _crVoiceMediaRecorder.ondataavailable = e => { if (e.data.size > 0) _crVoiceChunks.push(e.data); };
    _crVoiceMediaRecorder.start();
  } catch (e) {
    console.warn('[CR-Voice] getUserMedia failed:', e);
    alert('无法访问麦克风');
    _crVoiceCleanup();
  }
}

function _crGetVoiceMime() {
  if (typeof MediaRecorder !== 'undefined') {
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
    if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  }
  return '';
}

function _crVoiceTrackPointer(evt) {
  const trash = document.getElementById('crVrTrash');
  const hint = document.getElementById('crVrHint');
  if (!trash) return;
  const r = trash.getBoundingClientRect();
  const dist = Math.sqrt((evt.clientX - r.left - r.width/2)**2 + (evt.clientY - r.top - r.height/2)**2);
  if (dist < 60) {
    trash.classList.add('hover'); if (hint) hint.textContent = '松开 取消'; _crVoiceCancelled = true;
  } else {
    trash.classList.remove('hover'); if (hint) hint.textContent = '↑ 上滑取消'; _crVoiceCancelled = false;
  }
}

async function _crVoiceStopRecord(evt) {
  if (!_crVoiceRecording) return;
  _crVoiceRecording = false;
  const duration = (Date.now() - _crVoiceStartTime) / 1000;

  if (evt) {
    const trash = document.getElementById('crVrTrash');
    if (trash) {
      const r = trash.getBoundingClientRect();
      const dist = Math.sqrt((evt.clientX - r.left - r.width/2)**2 + (evt.clientY - r.top - r.height/2)**2);
      if (dist < 60) _crVoiceCancelled = true;
    }
  }

  if (_crVoiceCancelled || duration < 0.5) { _crVoiceCleanup(); return; }

  let audioBlob;
  if (_crVoiceUseNative) {
    const _aa = _getNativeBridge('AionAudio');
    if (_aa) try { _aa.stop(); } catch(e) {}
    audioBlob = _crBuildWav(_crVoiceNativeChunks);
  } else {
    if (_crVoiceMediaRecorder && _crVoiceMediaRecorder.state !== 'inactive') {
      audioBlob = await new Promise(resolve => {
        _crVoiceMediaRecorder.onstop = () => { resolve(new Blob(_crVoiceChunks, { type: _crVoiceMediaRecorder.mimeType || 'audio/webm' })); };
        _crVoiceMediaRecorder.stop();
      });
    }
  }

  _crVoiceCleanup();
  if (!audioBlob || audioBlob.size < 100) { toast('录音数据为空，请重试'); return; }
  await _crVoiceSend(audioBlob, duration);
}

function _crVoiceCleanup() {
  if (_crVoiceTimerInterval) { clearInterval(_crVoiceTimerInterval); _crVoiceTimerInterval = null; }
  if (_crVoiceOverlay) { _crVoiceOverlay.remove(); _crVoiceOverlay = null; }
  if (_crVoiceStream) { _crVoiceStream.getTracks().forEach(t => t.stop()); _crVoiceStream = null; }
  if (_crVoiceMediaRecorder) { try { _crVoiceMediaRecorder.stop(); } catch {} _crVoiceMediaRecorder = null; }
  if (_crVoiceUseNative) { const _aa = _getNativeBridge('AionAudio'); if (_aa) try { _aa.stop(); } catch {} }
  _crVoiceRecording = false; _crVoiceChunks = []; _crVoiceNativeChunks = [];
  const btn = document.getElementById('crVoiceHoldBtn');
  if (btn) { btn.classList.remove('recording'); btn.textContent = '按住 说话'; }
}

function _crBuildWav(chunks) {
  let totalLen = 0;
  const bufs = chunks.map(b64 => {
    const bin = atob(b64); const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    totalLen += buf.length; return buf;
  });
  const sampleRate = 16000, numCh = 1, bps = 16;
  const header = new ArrayBuffer(44), v = new DataView(header);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o+i, s.charCodeAt(i)); };
  ws(0,'RIFF'); v.setUint32(4, 36+totalLen, true); ws(8,'WAVE'); ws(12,'fmt ');
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,numCh,true);
  v.setUint32(24,sampleRate,true); v.setUint32(28,sampleRate*numCh*bps/8,true);
  v.setUint16(32,numCh*bps/8,true); v.setUint16(34,bps,true); ws(36,'data'); v.setUint32(40,totalLen,true);
  const wav = new Uint8Array(44+totalLen); wav.set(new Uint8Array(header), 0);
  let off = 44; for (const buf of bufs) { wav.set(buf, off); off += buf.length; }
  return new Blob([wav], { type: 'audio/wav' });
}

async function _crVoiceSend(audioBlob, duration) {
  if (!currentRoom || isSending) return;

  // 1. 上传音频
  const ext = audioBlob.type.includes('wav') ? 'wav' : (audioBlob.type.includes('mp4') ? 'mp4' : 'webm');
  const fd = new FormData();
  fd.append('file', audioBlob, `voice_${Date.now()}.${ext}`);
  let uploadRes;
  try {
    const res = await fetch(`${API}/upload`, { method: 'POST', body: fd });
    uploadRes = await res.json();
    if (uploadRes.error) { toast(uploadRes.error); return; }
  } catch (e) { toast('语音上传失败'); return; }

  // 2. 转写
  const fd2 = new FormData();
  fd2.append('file', audioBlob, `voice.${ext}`);
  let transcript = '';
  for (let _try = 0; _try < 2; _try++) {
    try {
      const body = _try === 0 ? fd2 : (() => { const f = new FormData(); f.append('file', audioBlob, `voice.${ext}`); return f; })();
      const res = await fetch('/api/voice/transcribe', { method: 'POST', body });
      const r = await res.json();
      transcript = r.text || '';
      if (transcript) break;
    } catch (e) { console.warn(`[CR-Voice] Transcribe attempt ${_try+1} failed:`, e); }
  }

  // 3. 构建语音附件并发送
  const voiceAtt = { type: 'voice', url: uploadRes.url, duration: Math.round(duration * 10) / 10, transcript };

  isSending = true;
  sendBtn.disabled = true;

  const attachments = [voiceAtt.url];
  const voiceAttachmentsFull = [voiceAtt];
  playSend();
  const localRow = appendMessage({ sender: 'user', content: '', created_at: Date.now()/1000, attachments: voiceAttachmentsFull });
  if (localRow) localRow.dataset.localEcho = '1';

  try {
    const resp = await fetch(`${API}/rooms/${currentRoom.id}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: transcript || '',
        model: chatroomModel,
        attachments,
        voice_attachments: voiceAttachmentsFull,
        tts_enabled: crTtsEnabled,
        tts_aion_voice: crTtsAionVoice,
        tts_connor_voice: crTtsConnorVoice
      }),
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try { handleSSE(JSON.parse(line.slice(6))); } catch {}
      }
    }
  } catch (err) { toast('发送失败: ' + err.message); }
  finally {
    isSending = false;
    sendBtn.disabled = false;
    endStreamingBubble();
    inputEl.focus();
  }
}

// ══════════════════════════════════════════════════
//  密语时刻（BLE 玩具控制）
// ══════════════════════════════════════════════════

const CR_TOY_SERVICE_UUID = 0xEE01, CR_TOY_WRITE_UUID = 0xEE03, CR_TOY_NOTIFY_UUID = 0xEE02;
let crToyDevice = null, crToyServer = null, crToyWriteChar = null, crToyConnected = false;
let crToyActivePreset = -1;
let crToyPresets = [];

// BLE 状态跨页面同步（BroadcastChannel）
const crBleCh = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('toy_ble_state') : null;
function crBleNotify(connected) { if (crBleCh) crBleCh.postMessage({ connected }); }
if (crBleCh) crBleCh.onmessage = function(ev) {
  crToyConnected = !!ev.data.connected;
  crToyUpdateUI();
  if (crToyConnected) crToyLog('已连接（来自其他页面）', 'wl-sys');
  else crToyLog('已断开（来自其他页面）', 'wl-err');
};

// 原生 BLE 回调（Android APK）
window.toyNativeBle = window.toyNativeBle || {};
const _origOnConn = window.toyNativeBle.onConnected;
const _origOnDisc = window.toyNativeBle.onDisconnected;
window.toyNativeBle.onConnected = function() { crToyConnected = true; crToyUpdateUI(); crToyLog('已连接 ♡', 'wl-sys'); crBleNotify(true); if (_origOnConn) _origOnConn(); };
window.toyNativeBle.onDisconnected = function() { crToyConnected = false; crToyUpdateUI(); crToyLog('断开', 'wl-err'); crBleNotify(false); if (_origOnDisc) _origOnDisc(); };

const CR_TOY_MOTORS = [
  { label:'震动', gearsSpec:'0001', modeSpec:'0002',
    modes:[{id:1,name:'全身酥麻'},{id:2,name:'渐入佳境'},{id:3,name:'循序渐进'},{id:4,name:'欢呼雀跃'}] },
  { label:'电流', gearsSpec:'0003', modeSpec:'0004',
    modes:[{id:1,name:'温柔涟漪'},{id:2,name:'娇舌搅动'},{id:3,name:'风驰快感'},{id:4,name:'浪潮不断'}] },
  { label:'吮吸', gearsSpec:'0007', modeSpec:'0008',
    modes:[{id:1,name:'连绵不绝'},{id:2,name:'深海暗涌'},{id:3,name:'爆裂冲刺'},{id:4,name:'浪潮不断'}] },
];
const CR_TOY_PNAMES = ['微风轻拂','春水初生','暗流涌动','如梦似幻','情潮渐涨','烈焰焚身','极乐之巅','魂飞魄散','失控'];
const CR_TOY_PICONS = ['🌸','💧','🌊','✨','🔥','💥','⚡','💀','🌀'];
const CR_TOY_DEF_PRESETS = [
  { motors:[{on:0,mode:1,speed:10},{on:0,mode:1,speed:0},{on:1,mode:1,speed:10}] },
  { motors:[{on:0,mode:1,speed:20},{on:0,mode:1,speed:10},{on:1,mode:3,speed:20}] },
  { motors:[{on:0,mode:2,speed:30},{on:0,mode:1,speed:20},{on:1,mode:2,speed:30}] },
  { motors:[{on:0,mode:2,speed:45},{on:0,mode:2,speed:25},{on:1,mode:4,speed:40}] },
  { motors:[{on:0,mode:3,speed:60},{on:1,mode:2,speed:20},{on:1,mode:2,speed:50}] },
  { motors:[{on:1,mode:3,speed:10},{on:1,mode:3,speed:30},{on:1,mode:4,speed:60}] },
  { motors:[{on:1,mode:2,speed:20},{on:1,mode:4,speed:40},{on:1,mode:4,speed:80}] },
  { motors:[{on:1,mode:1,speed:30},{on:1,mode:3,speed:80},{on:1,mode:3,speed:100}] },
  { motors:[{on:1,mode:4,speed:40},{on:1,mode:3,speed:90},{on:1,mode:3,speed:100}] },
];

function crToyLoadPresets() {
  try { const s = localStorage.getItem('sosexy_presets_v3'); if (s) { crToyPresets = JSON.parse(s); return; } } catch(e) {}
  crToyPresets = JSON.parse(JSON.stringify(CR_TOY_DEF_PRESETS));
}
function crToySavePresets() { localStorage.setItem('sosexy_presets_v3', JSON.stringify(crToyPresets)); }

function crToyLog(msg, cls='') {
  const a = document.getElementById('crToyLogArea'); if (!a) return;
  const d = document.createElement('div'); d.className = cls;
  d.textContent = `[${new Date().toLocaleTimeString('zh-CN',{hour12:false})}] ${msg}`;
  a.appendChild(d); a.scrollTop = a.scrollHeight;
}

function crToyHexToBytes(h) { const b=[]; for(let i=0;i<h.length;i+=2) b.push(parseInt(h.substr(i,2),16)); return b; }
function crToyToHex2(n) { return n.toString(16).padStart(2,'0'); }
function crToyBuildDualCmd(s1,v1,s2,v2) { return '02'+s1+'11'+crToyToHex2(v1)+s2+'11'+crToyToHex2(v2); }
function crToyBuildStopCmd() { return '03000111000003110000071100'; }
function crToySleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function crToySendData2(hexCmd) {
  if (window.AionBle && window.AionBle.isConnected()) {
    crToyLog('→ ' + hexCmd, 'wl-send');
    window.AionBle.sendData(hexCmd);
    return;
  }
  if (!crToyWriteChar) { crToyLog('未连接','wl-err'); return; }
  const full = '00' + hexCmd;
  crToyLog('→ ' + hexCmd, 'wl-send');
  const data = crToyHexToBytes(full), chunks = [];
  for (let i = 0; i < data.length; i += 18) chunks.push(data.slice(i, i+18));
  const rnd = Math.floor(Math.random() * 255), pkts = [];
  for (let i = 0; i < chunks.length; i++) pkts.push([rnd, i+1, ...chunks[i]]);
  if (chunks.length > 0 && chunks[chunks.length-1].length === 18) pkts.push([rnd, chunks.length+1]);
  for (let i = 0; i < pkts.length; i++) {
    const p = new Uint8Array(pkts[i]);
    try {
      if (crToyWriteChar.properties.write) await crToyWriteChar.writeValueWithResponse(p);
      else await crToyWriteChar.writeValueWithoutResponse(p);
    } catch(e) { crToyLog('写入失败:'+e.message,'wl-err'); return; }
    if (pkts.length > 1 && i < pkts.length-1) await crToySleep(30);
  }
}

async function crToyApplyPreset(p) {
  for (let i = 0; i < 3; i++) {
    const m = p.motors[i], mo = CR_TOY_MOTORS[i];
    await crToySendData2(crToyBuildDualCmd(mo.modeSpec, m.mode||1, mo.gearsSpec, m.on ? m.speed : 0));
    await crToySleep(80);
  }
}

async function crToyActivatePreset(idx) {
  crToyActivePreset = idx; crToyRenderGrid();
  const p = crToyPresets[idx];
  crToyLog('⚡ ' + CR_TOY_PNAMES[idx], 'wl-sys');
  await crToyApplyPreset(p);
}

function crToyStopAll() {
  crToyActivePreset = -1;
  crToySendData2(crToyBuildStopCmd());
  crToyLog('⏹ 停止', 'wl-sys');
  crToyRenderGrid();
}

// AI 指令处理器（供 WS/SSE toy_command 事件调用）
function toyExecCmd(cmd) {
  cmd = cmd.trim().toUpperCase();
  if (cmd === 'STOP' || cmd === '0') { crToyStopAll(); return; }
  const n = parseInt(cmd);
  if (n >= 1 && n <= 9) { crToyActivatePreset(n - 1); return; }
  crToyLog('无效指令:' + cmd, 'wl-err');
}

function crToyRenderGrid() {
  const g = document.getElementById('crToyPresetGrid'); if (!g) return;
  g.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const d = document.createElement('div');
    d.className = 'whisper-p-btn' + (i === crToyActivePreset ? ' active' : '');
    d.innerHTML = `<span class="wp-icon">${CR_TOY_PICONS[i]}</span><span class="wp-name">${CR_TOY_PNAMES[i]}</span><button class="wp-edit" onclick="event.stopPropagation();crToyOpenEditor(${i})">⚙</button>`;
    d.onclick = () => { if (crToyConnected || (window.AionBle && window.AionBle.isConnected())) crToyActivatePreset(i); else crToyLog('请先连接','wl-err'); };
    g.appendChild(d);
  }
}

function crToyUpdateUI() {
  const dot = document.getElementById('crToyDot'), label = document.getElementById('crToyConnLabel'), btn = document.getElementById('crToyConnBtn');
  if (dot) dot.className = 'whisper-dot ' + (crToyConnected ? 'on' : 'off');
  if (label) label.textContent = crToyConnected ? (crToyDevice?.name || '已连接') : '未连接';
  if (btn) btn.textContent = crToyConnected ? '断开' : '连接';
}

async function crToyToggleConnect() {
  if (crToyConnected) { crToyDisconnect(); return; }
  if (window.AionBle) { window.AionBle.connect(); return; }
  if (!navigator.bluetooth) { crToyLog('此浏览器不支持 Web Bluetooth','wl-err'); return; }
  try {
    crToyLog('搜索中...', 'wl-sys');
    crToyDevice = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'SOSEXY' }], optionalServices: [CR_TOY_SERVICE_UUID] });
    crToyLog(crToyDevice.name || '已找到设备', 'wl-sys');
    crToyDevice.addEventListener('gattserverdisconnected', () => { crToyConnected = false; crToyWriteChar = null; crToyUpdateUI(); crToyLog('断开','wl-err'); });
    crToyServer = await crToyDevice.gatt.connect();
    const svc = await crToyServer.getPrimaryService(CR_TOY_SERVICE_UUID);
    crToyWriteChar = await svc.getCharacteristic(CR_TOY_WRITE_UUID);
    try { const nc = await svc.getCharacteristic(CR_TOY_NOTIFY_UUID); await nc.startNotifications(); } catch(e) {}
    crToyConnected = true;
    crToyUpdateUI();
    crToyLog('已连接 ♡', 'wl-sys');
    crBleNotify(true);
  } catch(e) { crToyLog('连接失败:'+e.message, 'wl-err'); }
}

function crToyDisconnect() {
  crToyStopAll();
  if (window.AionBle) { window.AionBle.disconnect(); }
  else if (crToyDevice && crToyDevice.gatt.connected) { crToyDevice.gatt.disconnect(); }
  crToyConnected = false; crToyWriteChar = null;
  crToyUpdateUI(); crToyLog('已断开', 'wl-sys');
  crBleNotify(false);
}

function crOpenWhisper() {
  crToyLoadPresets();
  // 检查原生 BLE 桥接的实际连接状态（从 Aion 页面连接的也能用）
  if (window.AionBle && typeof window.AionBle.isConnected === 'function') {
    crToyConnected = window.AionBle.isConnected();
  }
  crToyRenderGrid();
  crToyUpdateUI();
  document.getElementById('crWhisperModeToggle').checked = crWhisperMode;
  document.getElementById('crWhisperModal').classList.add('show');
}
function crCloseWhisper() { document.getElementById('crWhisperModal').classList.remove('show'); }

// ══════════════════════════════════════════════════
//  Connor 钱包
// ══════════════════════════════════════════════════

let crTransferTarget = 'connor'; // 'connor' | 'aion'

function crOpenTransferDialog() {
  crTransferTarget = 'connor';
  document.getElementById('crTransferTargetConnor').textContent = crConnorName;
  document.getElementById('crTransferTargetAion').textContent = crAiName;
  document.getElementById('crTransferTargetConnor').classList.add('active');
  document.getElementById('crTransferTargetAion').classList.remove('active');
  document.getElementById('crTransferDialogTitle').textContent = `给【${crConnorName}】转账`;
  document.getElementById('crTransferAmountInput').value = '';
  document.getElementById('crTransferDialogOverlay').classList.add('show');
  setTimeout(() => document.getElementById('crTransferAmountInput').focus(), 100);
}

function crSwitchTransferTarget(target) {
  crTransferTarget = target;
  const name = target === 'aion' ? crAiName : crConnorName;
  document.getElementById('crTransferDialogTitle').textContent = `给【${name}】转账`;
  document.getElementById('crTransferTargetConnor').classList.toggle('active', target === 'connor');
  document.getElementById('crTransferTargetAion').classList.toggle('active', target === 'aion');
}

function crCloseTransferDialog() {
  document.getElementById('crTransferDialogOverlay').classList.remove('show');
}

function crConfirmTransfer() {
  const val = document.getElementById('crTransferAmountInput').value.trim();
  if (!val || isNaN(Number(val)) || Number(val) === 0) return;
  const n = Number(val);
  const targetName = crTransferTarget === 'aion' ? crAiName : crConnorName;
  const tag = `[转账给${targetName}：${n}元]`;
  const cur = inputEl.value;
  inputEl.value = cur ? cur + ' ' + tag : tag;
  resizeInput();
  crCloseTransferDialog();
  inputEl.focus();
}

async function crOpenWalletPanel() {
  document.getElementById('crWalletPanelOverlay').classList.add('show');
  closeSidebar();
  try {
    const [balRes, txRes] = await Promise.all([
      fetch('/api/connor-wallet/balance').then(r => r.json()),
      fetch('/api/connor-wallet/transactions?limit=50').then(r => r.json())
    ]);
    document.getElementById('crWalletBalanceValue').textContent = `¥${(balRes.balance || 0).toFixed(2)}`;
    const list = document.getElementById('crWalletTxList');
    if (!txRes || txRes.length === 0) {
      list.innerHTML = '<div class="wallet-tx-empty">暂无转账记录</div>';
    } else {
      list.innerHTML = txRes.map(tx => {
        const isAi = tx.record_type === 'connor_wallet_ai';
        const d = new Date(tx.created_at * 1000);
        const timeStr = `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        const sign = tx.amount >= 0 ? '+' : '';
        const cls = tx.amount >= 0 ? 'positive' : 'negative';
        const uName = '用户';
        let desc = tx.description || (isAi ? `${crConnorName}转账` : `${uName}转账`);
        return `<div class="wallet-tx-item"><div><div class="wallet-tx-desc">${esc(desc)}</div><div class="wallet-tx-time">${timeStr}</div></div><div class="wallet-tx-amount ${cls}">${sign}${tx.amount.toFixed(2)}</div></div>`;
      }).join('');
    }
  } catch(e) {
    document.getElementById('crWalletTxList').innerHTML = '<div class="wallet-tx-empty">加载失败</div>';
  }
}

function crCloseWalletPanel() {
  document.getElementById('crWalletPanelOverlay').classList.remove('show');
}

function crOnWhisperModeChange() {
  crWhisperMode = document.getElementById('crWhisperModeToggle').checked;
  crToyLog(crWhisperMode ? '🔮 密语模式已开启' : '🔮 密语模式已关闭', 'wl-sys');
}

// ── 预设编辑器 ──
function crToyOpenEditor(idx) {
  const p = crToyPresets[idx];
  let h = `<h3>${CR_TOY_PICONS[idx]} ${CR_TOY_PNAMES[idx]}</h3>`;
  for (let mi = 0; mi < 3; mi++) {
    const ms = p.motors[mi], mo = CR_TOY_MOTORS[mi];
    h += `<div class="toy-me-block"><div class="toy-me-head"><span>${mo.label}</span>
    <label class="toggle-switch" style="transform:scale(.8)"><input type="checkbox" id="crteo${mi}" ${ms.on?'checked':''}><span class="toggle-slider"></span></label>
    </div><div class="toy-chip-row" id="crtem${mi}">
    ${mo.modes.map(md => `<span class="toy-chip${md.id===ms.mode?' sel':''}" data-mid="${md.id}" onclick="crToyESel(${mi},${md.id})">${md.name}</span>`).join('')}
    </div><div class="toy-ed-speed"><label>速度</label>
    <input type="range" min="0" max="100" value="${ms.speed}" id="crtes${mi}" oninput="document.getElementById('crtev${mi}').textContent=this.value">
    <span class="toy-ed-sv" id="crtev${mi}">${ms.speed}</span></div></div>`;
  }
  h += `<div class="toy-sheet-btns"><button class="toy-sb-cancel" onclick="crToyCloseEditor()">取消</button><button class="toy-sb-save" onclick="crToySaveEd(${idx})">保存</button></div>`;
  document.getElementById('crToyEditContent').innerHTML = h;
  document.getElementById('crToyEditorOverlay').classList.add('show');
}

function crToyESel(mi, mid) {
  document.querySelectorAll(`#crtem${mi} .toy-chip`).forEach(c => c.classList.toggle('sel', parseInt(c.dataset.mid) === mid));
}

function crToySaveEd(idx) {
  const p = crToyPresets[idx];
  for (let mi = 0; mi < 3; mi++) {
    p.motors[mi].on = document.getElementById(`crteo${mi}`).checked ? 1 : 0;
    const sc = document.querySelector(`#crtem${mi} .toy-chip.sel`);
    if (sc) p.motors[mi].mode = parseInt(sc.dataset.mid);
    p.motors[mi].speed = parseInt(document.getElementById(`crtes${mi}`).value);
  }
  crToySavePresets(); crToyCloseEditor(); crToyRenderGrid();
  crToyLog(`预设${idx+1}已保存`, 'wl-sys');
}

function crToyCloseEditor() { document.getElementById('crToyEditorOverlay').classList.remove('show'); }

// ══════════════════════════════════════════════════
//  初始化
// ══════════════════════════════════════════════════

(async function init() {
  // 从服务端加载 TTS 配置，所有窗口共享同一份
  try {
    const cfg = await api('/config');
    applyChatroomNames(cfg);
    crTtsEnabled = !!cfg.tts_enabled;
    crTtsAionVoice = cfg.tts_aion_voice || '';
    crTtsConnorVoice = cfg.tts_connor_voice || '';
    chatroomConnorModel = cfg.connor_model || 'Codex';
    chatroomReplyOrder = cfg.reply_order || 'random';
  } catch(e) {}
  await fetchCurrentModel();
  await loadRooms();
  // 默认打开最后一次聊天的房间
  if (!currentRoom && rooms.length > 0) {
    await selectRoom(rooms[0].id);
  }
  checkConnor();
  setInterval(checkConnor, 30000);
  connectWS();
  resizeInput();
})();

// ══════════════════════════════════════════════════
//  表情包面板
// ══════════════════════════════════════════════════

const STICKER_CAT_RULES_CR = [
  { cat: '开心', kw: ['开心','太开心','欢呼','活力','好','嘻嘻','OK','嚣张','得意','骄傲','傻乐','太可爱','可爱'] },
  { cat: '伤心', kw: ['哭','泪','失落','孤单','委屈','心碎','难过','悲','泫然','失魂','抑郁','落泪'] },
  { cat: '生气', kw: ['生气','气鼓','气到','怒','火冒','无语','挺无语','滚','嫌弃','判决','死刑','全都死','刀','打你','愤'] },
  { cat: '撒娇', kw: ['撒娇','卖萌','贴贴','抱抱','蹭','哄我','快哄','要抱','宝宝','哦','想你','宝生'] },
  { cat: '心动', kw: ['心动','心跳','眼冒爱心','亲亲','kiss','结婚','爱你','送你','赠你','献上','玫瑰','花花','脸红','面红','害羞','舔'] },
  { cat: '惊讶', kw: ['惊','震惊','吓','惊掉','问号','懵','怎么回事','不明所以','呆住','呆滞','大吃'] },
  { cat: '思考', kw: ['思考','停止思考','大脑','记','等待','在学','在干嘛','忙','慢'] },
  { cat: '可爱', kw: ['小猫','小狗','猫','狗','小动物','萌','歪头','偏头','眨眼','wink','撒花'] },
  { cat: '其他', kw: [] }
];

let _stickerPanelOpen = false;

function _categorizeStickerName(name) {
  for (const rule of STICKER_CAT_RULES_CR) {
    if (rule.cat === '其他') continue;
    if (rule.kw.some(k => name.includes(k))) return rule.cat;
  }
  return '其他';
}

async function _loadStickers() {
  if (_stickerLoaded) return;
  _stickerLoaded = true;
  try {
    const res = await fetch('/api/stickers/list');
    if (!res.ok) throw new Error('404');
    const data = await res.json();
    _stickerList = data.stickers || [];
    for (const s of _stickerList) {
      _stickerFileMap[s.name] = s.file;
    }
  } catch(e) {
    _stickerList = [];
    console.warn('[Stickers] 无法从后端加载表情包列表');
  }
  _stickerCategories = {};
  for (const s of _stickerList) {
    const cat = _categorizeStickerName(s.name);
    if (!_stickerCategories[cat]) _stickerCategories[cat] = [];
    _stickerCategories[cat].push(s);
  }
  try { _recentStickers = JSON.parse(localStorage.getItem('aion_recent_stickers') || '[]'); } catch(e) { _recentStickers = []; }
  _renderStickerTabs();
  _renderStickerGrid(_activeStickerTab);
}

function _renderStickerTabs() {
  const tabBar = document.getElementById('stickerTabBar');
  if (!tabBar) return;
  const cats = Object.keys(_stickerCategories).filter(c => _stickerCategories[c].length > 0);
  const allTabs = ['recent', 'all', ...cats];
  const tabLabels = { recent: '最近', all: '全部' };
  tabBar.innerHTML = allTabs.map(t =>
    `<button class="sticker-tab ${t === _activeStickerTab ? 'active' : ''}" onclick="event.stopPropagation(); switchStickerTab('${t}')">${tabLabels[t] || t}</button>`
  ).join('');
}

function switchStickerTab(tab) {
  _activeStickerTab = tab;
  _renderStickerTabs();
  _renderStickerGrid(tab);
}

function _renderStickerGrid(tab) {
  const grid = document.getElementById('stickerGrid');
  if (!grid) return;
  let stickers;
  if (tab === 'recent') stickers = _recentStickers;
  else if (tab === 'all') stickers = _stickerList;
  else stickers = _stickerCategories[tab] || [];

  if (stickers.length === 0) {
    grid.innerHTML = `<div class="sticker-empty">${tab === 'recent' ? '还没有最近使用的表情包' : '暂无表情包'}</div>`;
    return;
  }
  grid.innerHTML = stickers.map(s =>
    `<div class="sticker-item" onclick="event.stopPropagation(); sendSticker('${esc(s.file)}','${esc(s.name)}')" title="${esc(s.name)}">
      <img src="${STICKER_BASE}${esc(s.file)}" alt="${esc(s.name)}" loading="lazy">
      <span class="sticker-name">${esc(s.name)}</span>
    </div>`
  ).join('');
}

async function sendSticker(file, name) {
  closeStickerPanel();
  if (!currentRoom) return;

  // 更新最近使用
  const sticker = { file, name };
  _recentStickers = [sticker, ..._recentStickers.filter(s => s.file !== file)].slice(0, 12);
  try { localStorage.setItem('aion_recent_stickers', JSON.stringify(_recentStickers)); } catch(e) {}

  // 如果输入框有内容，先把当前内容加入队列
  const curText = inputEl.value.trim();
  if (curText) {
    _crBubbleQueue.push(curText);
    inputEl.value = '';
    resizeInput();
  }
  // 表情包作为独立一条加入队列（不直接发送）
  _crBubbleQueue.push(`[STICKER:${name}]`);
  _crRenderQueuePreview();
  _crStartTimer();
}

function toggleStickerPanel() {
  if (_stickerPanelOpen) { closeStickerPanel(); return; }
  openStickerPanel();
}

function openStickerPanel() {
  _stickerPanelOpen = true;
  const panel = document.getElementById('stickerPanel');
  if (panel) panel.classList.add('show');
  if (!_stickerLoaded) _loadStickers();
  const btn = document.getElementById('stickerBtn');
  if (btn) btn.style.color = 'var(--accent, #e07850)';
}

function closeStickerPanel() {
  _stickerPanelOpen = false;
  const panel = document.getElementById('stickerPanel');
  if (panel) panel.classList.remove('show');
  const btn = document.getElementById('stickerBtn');
  if (btn) btn.style.color = '';
}

// 点击其他地方关闭表情包面板
document.addEventListener('click', function(e) {
  if (!_stickerPanelOpen) return;
  const panel = document.getElementById('stickerPanel');
  const btn = document.getElementById('stickerBtn');
  if (panel && panel.contains(e.target)) return;
  if (btn && btn.contains(e.target)) return;
  closeStickerPanel();
});

// 启动时预加载表情包文件名映射（用于渲染历史消息中的表情包）
async function _preloadStickerMap() {
  try {
    const res = await fetch('/api/stickers/list');
    if (!res.ok) return;
    const data = await res.json();
    const list = data.stickers || [];
    for (const s of list) {
      _stickerFileMap[s.name] = s.file;
    }
    console.log('[StickerMap] 已加载', Object.keys(_stickerFileMap).length, '个表情包映射');
  } catch(e) { console.warn('[StickerMap] 预加载失败:', e); }
}
_preloadStickerMap();
