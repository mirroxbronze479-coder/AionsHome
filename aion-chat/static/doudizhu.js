const $ = (id) => document.getElementById(id);

const playerNames = {
  user: "Ithil",
  aion: "Aion",
  connor: "Connor",
};

const playerAvatars = {
  aion: "/public/gropicon1.png",
  connor: "/public/codexicon.png",
};

const phaseNames = {
  preview: "看牌确认",
  bidding: "叫地主",
  playing: "出牌中",
  game_over: "本局结束",
};

const suitMap = {
  S: "♠",
  H: "♥",
  C: "♣",
  D: "♦",
};

let gameState = null;
let selectedCards = new Set();
let aiBusy = false;
let aiTimer = null;
let gameSocket = null;
let fxContext = null;
let ttsQueue = [];
let ttsPlaying = false;
let suppressNextDealFx = false;

const fxFiles = {
  deal: "/public/card/新开局的洗牌声.mp3",
  play: "/public/card/出牌.mp3",
  bomb: "/public/card/炸弹.mp3",
  win: "/public/card/结局赢了.mp3",
  lose: "/public/card/结局输了.mp3",
  turn: "/public/card/轮到你了.mp3",
  switch: "/public/card/换人出牌.mp3",
};

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  return resp.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function playFx(kind) {
  const file = fxFiles[kind];
  if (file) {
    const audio = new Audio(file);
    audio.volume = 0.78;
    audio.play().catch(() => playSyntheticFx(kind));
    return;
  }
  playSyntheticFx(kind);
}

function playSyntheticFx(kind) {
  try {
    fxContext = fxContext || new (window.AudioContext || window.webkitAudioContext)();
    const now = fxContext.currentTime;
    const osc = fxContext.createOscillator();
    const gain = fxContext.createGain();
    const tones = {
      deal: [420, 560, 0.09],
      play: [620, 760, 0.07],
      turn: [880, 660, 0.11],
      win: [540, 720, 0.16],
      lose: [420, 300, 0.16],
      bomb: [130, 70, 0.2],
    };
    const [start, end, duration] = tones[kind] || tones.play;
    osc.type = "sine";
    osc.frequency.setValueAtTime(start, now);
    osc.frequency.exponentialRampToValueAtTime(end, now + duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(fxContext.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  } catch (_) {
    // Audio can be blocked before the first user gesture.
  }
}

function playTTSUrl(url) {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    audio.onended = resolve;
    audio.onerror = resolve;
    audio.play().catch(resolve);
  });
}

async function drainTTSQueue() {
  if (ttsPlaying) return;
  ttsPlaying = true;
  try {
    while (ttsQueue.length) {
      const next = ttsQueue.shift();
      await playTTSUrl(next.url);
    }
  } finally {
    ttsPlaying = false;
  }
}

function enqueueTTSChunk(data) {
  if (!data?.msg_id?.startsWith("ddz_") || !data.url) return;
  ttsQueue.push({ url: data.url, seq: data.seq || 0 });
  ttsQueue.sort((a, b) => a.seq - b.seq);
  drainTTSQueue();
}

function connectGameSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  gameSocket = new WebSocket(`${proto}://${location.host}/ws`);
  gameSocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "tts_chunk") enqueueTTSChunk(msg.data);
    } catch (_) {}
  };
  gameSocket.onclose = () => {
    setTimeout(connectGameSocket, 3000);
  };
}

function parseCard(card) {
  if (card === "BJ") return { rank: "小王", suit: "", color: "joker" };
  if (card === "RJ") return { rank: "大王", suit: "", color: "joker" };
  const suit = card.slice(-1);
  const rank = card.slice(0, -1);
  return {
    rank,
    suit: suitMap[suit] || "",
    color: suit === "H" || suit === "D" ? "red" : "black",
  };
}

function cardHTML(card, options = {}) {
  const info = parseCard(card);
  const classes = ["card", info.color];
  if (options.back) classes.push("back");
  if (options.selectable) classes.push("selectable");
  if (options.selected) classes.push("selected");
  const attr = options.selectable ? ` data-card="${card}"` : "";
  const style = options.style ? ` style="${options.style}"` : "";
  if (options.back) return `<div class="${classes.join(" ")}"${style}></div>`;
  return `
    <div class="${classes.join(" ")}"${attr}${style}>
      <span class="rank">${info.rank}</span>
      <span class="suit">${info.suit}</span>
    </div>
  `;
}

function renderCards(el, cards, options = {}) {
  el.innerHTML = cards.map((card) => cardHTML(card, options)).join("");
}

function latestSpeech(player) {
  const history = [...(gameState?.history || [])].reverse();
  const item = history.find((h) => h.player === player && h.speech);
  return item?.speech || "";
}

function opponentOrder() {
  const order = gameState.order?.length ? gameState.order : ["user", "aion", "connor"];
  return order.filter((player) => player !== "user");
}

function setUserSeat() {
  const p = gameState.players.user;
  $("userRole").textContent = p.role === "landlord" ? "地主" : "农民";
  $("userCount").textContent = p.handCount;
}

function setOpponentSeat(slot, player) {
  const p = gameState.players[player];
  const panel = $(`seat-${slot}-panel`);
  panel.dataset.player = player;
  $(`${slot}Avatar`).src = playerAvatars[player];
  $(`${slot}Name`).textContent = playerNames[player];
  $(`${slot}Role`).textContent = p.role === "landlord" ? "地主" : "农民";
  $(`${slot}Count`).textContent = p.handCount;
  const speech = latestSpeech(player);
  const speechEl = $(`${slot}Speech`);
  speechEl.textContent = speech;
  speechEl.title = speech;
}

function renderSeats() {
  const [left = "aion", right = "connor"] = opponentOrder();
  setOpponentSeat("left", left);
  setOpponentSeat("right", right);
  setUserSeat();
}

function clearSelectionMissingFromHand() {
  const hand = new Set(gameState?.players?.user?.hand || []);
  for (const card of [...selectedCards]) {
    if (!hand.has(card)) selectedCards.delete(card);
  }
}

function renderBottom() {
  const bottomEl = $("bottomCards");
  if (gameState.bottomCards?.length) {
    renderCards(bottomEl, gameState.bottomCards);
    return;
  }
  bottomEl.innerHTML = Array.from({ length: gameState.bottomCount || 3 }, () => cardHTML("", { back: true })).join("");
}

function renderLastPlay() {
  const title = $("lastPlayTitle");
  const played = $("playedCards");
  if (gameState.winner) {
    title.textContent = `${playerNames[gameState.winner]} 出完了`;
    played.innerHTML = "";
    return;
  }
  if (!gameState.lastPlay) {
    title.textContent = gameState.phase === "preview"
      ? "牌已发好"
      : gameState.phase === "bidding"
        ? "等待叫地主"
        : "新一轮，重新出牌";
    played.innerHTML = "";
    return;
  }
  title.textContent = `${gameState.lastPlay.name}：${gameState.lastPlay.label}`;
  renderCards(played, gameState.lastPlay.cards || []);
}

function renderDiscardPile() {
  const pile = $("discardPile");
  const cards = gameState.playedCards || [];
  const recent = cards.slice(-36);
  pile.innerHTML = recent
    .map((card, index) => cardHTML(card, {
      style: `--discard-i:${index};--discard-rot:${((index * 17) % 27) - 13}deg;--discard-x:${(index * 29) % 92}%;--discard-y:${(index * 19) % 78}%;`,
    }))
    .join("");
}

function renderHand() {
  const handEl = $("userHand");
  const hand = gameState.players.user.hand || [];
  const displayCards = [...hand].reverse();
  handEl.innerHTML = displayCards
    .map((card, index) => cardHTML(card, {
      selectable: gameState.currentPlayer === "user" && gameState.phase === "playing",
      selected: selectedCards.has(card),
      style: `--card-col:${index % 10};--card-row:${Math.floor(index / 10)};`,
    }))
    .join("");
}

function renderControls() {
  const userTurn = gameState.currentPlayer === "user";
  const isPreview = gameState.phase === "preview";
  const isBidding = gameState.phase === "bidding";
  const isPlaying = gameState.phase === "playing";

  $("previewActions").style.display = isPreview ? "flex" : "none";
  $("bidActions").style.display = isBidding && userTurn ? "flex" : "none";
  $("playActions").style.display = isPlaying && userTurn ? "flex" : "none";

  document.querySelectorAll("#bidActions button").forEach((btn) => {
    const bid = Number(btn.dataset.bid);
    btn.disabled = aiBusy || (bid > 0 && bid <= gameState.currentBid);
  });

  $("passBtn").disabled = aiBusy || !gameState.lastPlay || gameState.lastPlay.player === "user";
  $("playBtn").disabled = aiBusy || selectedCards.size === 0;
  $("hintBtn").disabled = aiBusy;

  $("startGameBtn").disabled = aiBusy;
  $("redealBtn").disabled = aiBusy;

  if (isPreview) {
    $("statusLine").textContent = "先看手牌，满意就开局；不满意可以重新发。";
  } else if (gameState.phase === "game_over") {
    $("statusLine").textContent = gameState.winner === "user" ? "你赢了，这局打得漂亮。" : `${playerNames[gameState.winner]} 赢了，再来一局抢回来。`;
  } else if (aiBusy) {
    $("statusLine").textContent = `${playerNames[gameState.currentPlayer]} 正在想牌...`;
  } else if (userTurn) {
    $("statusLine").textContent = isBidding ? "轮到你叫分。" : "轮到你出牌。";
  } else {
    $("statusLine").textContent = `等 ${playerNames[gameState.currentPlayer]}。`;
  }
}

function renderActiveSeats() {
  $("seat-left-panel").classList.toggle("active", $("seat-left-panel").dataset.player === gameState.currentPlayer);
  $("seat-right-panel").classList.toggle("active", $("seat-right-panel").dataset.player === gameState.currentPlayer);
  $("seat-user").classList.toggle("active", gameState.currentPlayer === "user");
}

function renderSettlement() {
  const modal = $("settlementModal");
  if (gameState.phase !== "game_over" || !gameState.settlement) {
    modal.hidden = true;
    $("settlementStatus").textContent = "";
    $("announceBtn").disabled = false;
    return;
  }
  const settle = gameState.settlement;
  const remaining = settle.remainingCounts || {};
  const loserText = gameState.order
    .filter((p) => p !== settle.winner)
    .map((p) => `${playerNames[p]} 剩 ${remaining[p] || 0} 张`)
    .join("，");
  const walletLines = settle.wallet?.lines?.length ? ` 钱包：${settle.wallet.lines.join("；")}。` : "";
  modal.hidden = false;
  $("settlementTitle").textContent = `${settle.winnerName} 赢了`;
  $("settlementMeta").textContent = `地主：${settle.landlordName}。${loserText || "没有剩牌。"}。${walletLines}`;
}

function maybePlayStateFx(previous, nextState) {
  if (!previous) return;
  if (previous.id !== nextState.id) {
    if (suppressNextDealFx) {
      suppressNextDealFx = false;
      return;
    }
    playFx("deal");
    return;
  }
  const prevHistory = previous.history?.length || 0;
  const nextHistory = nextState.history?.length || 0;
  if (previous.phase !== "game_over" && nextState.phase === "game_over") {
    playFx(nextState.winner === "user" ? "win" : "lose");
    return;
  }
  if (prevHistory < nextHistory) {
    const latest = nextState.history?.[nextState.history.length - 1];
    if (latest?.event === "play") {
      const lastType = nextState.lastPlay?.type;
      playFx(lastType === "bomb" || lastType === "rocket" ? "bomb" : "play");
    }
  }
  if (previous.currentPlayer !== nextState.currentPlayer && !["preview", "game_over"].includes(nextState.phase)) {
    playFx(nextState.currentPlayer === "user" ? "turn" : "switch");
  }
}

function render() {
  if (!gameState) return;
  document.body.dataset.phase = gameState.phase;
  clearSelectionMissingFromHand();
  $("phaseText").textContent = phaseNames[gameState.phase] || "牌局中";
  $("turnHint").textContent = gameState.phase === "preview"
    ? "确认后由你先叫地主。"
    : gameState.phase === "game_over"
    ? "本局已经结算。"
    : `当前回合：${playerNames[gameState.currentPlayer] || "未知"}`;

  renderSeats();
  renderBottom();
  renderLastPlay();
  renderDiscardPile();
  renderHand();
  renderControls();
  renderActiveSeats();
  renderSettlement();
  scheduleAiIfNeeded();
}

function setState(nextState) {
  const previous = gameState;
  gameState = nextState;
  render();
  maybePlayStateFx(previous, nextState);
}

async function loadState() {
  const data = await api("/api/doudizhu/state");
  if (data.ok) setState(data.state);
}

async function newGame() {
  selectedCards.clear();
  $("settlementStatus").textContent = "";
  aiBusy = true;
  playFx("deal");
  if (gameState) renderControls();
  $("statusLine").textContent = "洗牌中...";
  await sleep(1100);
  try {
    const data = await api("/api/doudizhu/new", {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!data.ok) {
      $("statusLine").textContent = data.error || "发牌失败。";
      return;
    }
    suppressNextDealFx = true;
    setState(data.state);
  } finally {
    aiBusy = false;
    render();
  }
}

async function startGame() {
  const data = await api("/api/doudizhu/start", {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!data.ok) {
    $("statusLine").textContent = data.error || "开局失败。";
  }
  if (data.state) setState(data.state);
}

async function bid(value) {
  const data = await api("/api/doudizhu/bid", {
    method: "POST",
    body: JSON.stringify({ bid: value }),
  });
  if (!data.ok) {
    $("statusLine").textContent = data.error || "叫分失败。";
  }
  if (data.state) setState(data.state);
}

async function play(action, cards = []) {
  const data = await api("/api/doudizhu/play", {
    method: "POST",
    body: JSON.stringify({ action, cards }),
  });
  if (!data.ok) {
    $("statusLine").textContent = data.error || "出牌失败。";
  } else {
    selectedCards.clear();
  }
  if (data.state) setState(data.state);
}

async function hint() {
  const data = await api("/api/doudizhu/legal-moves");
  if (!data.ok) {
    $("statusLine").textContent = data.error || "暂时没有提示。";
    return;
  }
  const move = (data.moves || []).find((m) => m.action === "play");
  selectedCards.clear();
  if (!move) {
    $("statusLine").textContent = "这手压不上，可以不出。";
  } else {
    move.cards.forEach((card) => selectedCards.add(card));
    $("statusLine").textContent = `提示：${move.label}`;
  }
  if (data.state) gameState = data.state;
  render();
}

async function announceSettlement() {
  $("announceBtn").disabled = true;
  $("settlementStatus").textContent = "正在发到群聊...";
  const data = await api("/api/doudizhu/announce", {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!data.ok) {
    $("announceBtn").disabled = false;
    $("settlementStatus").textContent = data.error || "同步失败。";
    if (data.state) setState(data.state);
    return;
  }
  $("settlementStatus").textContent = "已发到最新群聊，Aion 和 Connor 会接着回应。";
  if (data.state) setState(data.state);
}

function scheduleAiIfNeeded() {
  clearTimeout(aiTimer);
  if (!gameState || aiBusy) return;
  if (gameState.phase === "game_over") return;
  if (!["aion", "connor"].includes(gameState.currentPlayer)) return;
  aiTimer = setTimeout(runAiLoop, 450);
}

async function runAiLoop() {
  if (!gameState || aiBusy || !["aion", "connor"].includes(gameState.currentPlayer)) return;
  aiBusy = true;
  renderControls();
  try {
    while (gameState && ["aion", "connor"].includes(gameState.currentPlayer) && gameState.phase !== "game_over") {
      const data = await api("/api/doudizhu/ai-step", { method: "POST", body: JSON.stringify({}) });
      if (!data.ok) {
        $("statusLine").textContent = data.error || "AI 回合卡住了。";
        if (data.state) setState(data.state);
        break;
      }
      setState(data.state);
      await sleep(650);
    }
  } finally {
    aiBusy = false;
    render();
  }
}

$("backBtn").addEventListener("click", () => {
  if (window.parent !== window && typeof window.parent.closeSubPage === "function") {
    window.parent.closeSubPage();
  } else {
    window.location.href = "/";
  }
});

$("newGameBtn").addEventListener("click", newGame);
$("startGameBtn").addEventListener("click", startGame);
$("redealBtn").addEventListener("click", newGame);
$("continueBtn").addEventListener("click", newGame);
$("announceBtn").addEventListener("click", announceSettlement);

document.querySelectorAll("#bidActions button").forEach((btn) => {
  btn.addEventListener("click", () => bid(Number(btn.dataset.bid)));
});

$("userHand").addEventListener("click", (event) => {
  const cardEl = event.target.closest(".card.selectable");
  if (!cardEl) return;
  const card = cardEl.dataset.card;
  if (!card) return;
  if (selectedCards.has(card)) selectedCards.delete(card);
  else selectedCards.add(card);
  renderHand();
  renderControls();
});

$("playBtn").addEventListener("click", () => {
  const hand = gameState.players.user.hand || [];
  const cards = hand.filter((card) => selectedCards.has(card));
  play("play", cards);
});

$("passBtn").addEventListener("click", () => play("pass", []));
$("hintBtn").addEventListener("click", hint);

connectGameSocket();
loadState().catch(() => {
  $("statusLine").textContent = "牌桌加载失败。";
});
