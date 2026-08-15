/**
 * Menus, lobby, results and pause. Owns nothing but the DOM — it reports what
 * the player clicked and main.js decides what that means.
 */
import { CAR_TYPES, getCar } from '../game/carTypes.js';
import { MODES, PHASE } from '../net/protocol.js';
import { Profile, BestRun } from '../core/storage.js';
import { Audio } from '../core/audio.js';
import { fmtNum, hexCss, playerColor } from '../core/util.js';
import { escapeHtml } from './hud.js';

const $ = (id) => document.getElementById(id);

const SCREENS = ['boot', 'menu', 'garage', 'lobby', 'results', 'pause'];

export class Menu {
  constructor(handlers = {}) {
    this.on = handlers;
    this.selectedCar = Profile.get().car || 'ripsaw';
    this.mode = 'derby';
    this.current = 'boot';
    this.botCount = Profile.get().botCount ?? 3;
    this.botDifficulty = Profile.get().botDifficulty || 'normal';

    this._buildCarList();
    this._wire();
    this.refreshScrap();
  }

  // ── screens ────────────────────────────────────────────────
  show(name) {
    for (const s of SCREENS) $(s).classList.toggle('active', s === name);
    this.current = name;
  }

  hideAll() {
    for (const s of SCREENS) $(s).classList.remove('active');
    this.current = null;
  }

  boot(pct, msg) {
    $('boot-fill').style.width = `${pct}%`;
    if (msg) $('boot-msg').textContent = msg;
  }

  // ── car chooser ────────────────────────────────────────────
  _buildCarList() {
    const list = $('car-list');
    list.innerHTML = CAR_TYPES.map((c) => `
      <div class="car-card" data-car="${c.id}">
        <div class="car-swatch" style="background:linear-gradient(135deg,${hexCss(c.color)},${hexCss(c.color)}55)"></div>
        <div class="car-name">${c.name}</div>
        <div class="car-class">${c.klass}</div>
      </div>`).join('');

    list.querySelectorAll('.car-card').forEach((el) => {
      el.addEventListener('click', () => {
        Audio.ui('click');
        this.selectCar(el.dataset.car);
      });
      el.addEventListener('mouseenter', () => Audio.ui('hover'));
    });
  }

  selectCar(id) {
    this.selectedCar = id;
    Profile.setCar(id);
    document.querySelectorAll('.car-card').forEach((el) => {
      el.classList.toggle('active', el.dataset.car === id);
    });
    this._renderStats(getCar(id));
    this.on.carChanged?.(id);
  }

  _renderStats(car) {
    const bars = Object.entries(car.stats).map(([k, v]) => `
      <div class="stat-row">
        <div class="stat-name">${k}</div>
        <div class="stat-bar"><div style="width:${v * 10}%;background:${statColor(v)}"></div></div>
        <div class="stat-num">${v}</div>
      </div>`).join('');
    $('car-stats').innerHTML = `<div class="car-blurb">${escapeHtml(car.blurb)}</div>${bars}`;
  }

  // ── wiring ─────────────────────────────────────────────────
  _wire() {
    const nameInput = $('name-input');
    nameInput.value = Profile.get().name;
    nameInput.addEventListener('input', () => Profile.setName(nameInput.value));

    document.querySelectorAll('.mode-btn').forEach((el) => {
      el.addEventListener('click', () => {
        Audio.ui('click');
        this.setMode(el.dataset.mode);
        this.on.modeChanged?.(el.dataset.mode);
      });
    });

    $('btn-solo').addEventListener('click', () => { Audio.ui('click'); this.on.solo?.(); });
    $('btn-host').addEventListener('click', () => { Audio.ui('click'); this.on.host?.(); });
    $('btn-join').addEventListener('click', () => {
      Audio.ui('click');
      this.on.join?.($('join-code').value);
    });
    $('join-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.on.join?.($('join-code').value);
    });

    $('btn-garage').addEventListener('click', () => { Audio.ui('click'); this.on.garage?.(); });
    $('garage-back').addEventListener('click', () => { Audio.ui('click'); this.show('menu'); });
    $('btn-controls').addEventListener('click', () => { Audio.ui('click'); this.show('pause'); this.pauseFromMenu = true; });
    $('btn-quality').addEventListener('click', () => { Audio.ui('click'); this.on.quality?.(); });

    const BOT_COUNTS = [0, 1, 3, 5, 7];
    $('btn-bots').addEventListener('click', () => {
      Audio.ui('click');
      const i = BOT_COUNTS.indexOf(this.botCount);
      this.botCount = BOT_COUNTS[(i + 1) % BOT_COUNTS.length];
      Profile.setBots(this.botCount, this.botDifficulty);
      this.setMode(this.mode);
    });
    const DIFFS = ['easy', 'normal', 'hard'];
    $('btn-botdiff').addEventListener('click', () => {
      Audio.ui('click');
      const i = DIFFS.indexOf(this.botDifficulty);
      this.botDifficulty = DIFFS[(i + 1) % DIFFS.length];
      Profile.setBots(this.botCount, this.botDifficulty);
      this.setMode(this.mode);
    });
    $('btn-uisize').addEventListener('click', () => { Audio.ui('click'); this.on.uiSize?.(); });

    $('btn-ready').addEventListener('click', () => { Audio.ui('click'); this.on.ready?.(); });
    $('btn-leave').addEventListener('click', () => { Audio.ui('click'); this.on.leave?.(); });
    $('copy-link').addEventListener('click', () => {
      const link = $('room-link').textContent;
      navigator.clipboard?.writeText(link).then(() => {
        $('copy-link').textContent = 'COPIED';
        setTimeout(() => { $('copy-link').textContent = 'COPY LINK'; }, 1600);
      }).catch(() => { /* clipboard blocked; the text is on screen anyway */ });
    });

    $('results-continue').addEventListener('click', () => { Audio.ui('click'); this.on.resultsDone?.(); });
    $('results-replay').addEventListener('click', () => { Audio.ui('click'); this.on.watchRun?.(); });
    $('pause-resume').addEventListener('click', () => {
      Audio.ui('click');
      if (this.pauseFromMenu) { this.pauseFromMenu = false; this.show('menu'); }
      else this.on.resume?.();
    });
    $('pause-quit').addEventListener('click', () => {
      Audio.ui('click');
      this.pauseFromMenu = false;
      this.on.quit?.();
    });

    this.selectCar(this.selectedCar);
    this.setMode(this.mode);
  }

  setMode(mode) {
    this.mode = mode;
    document.querySelectorAll('.mode-btn').forEach((el) => {
      el.classList.toggle('active', el.dataset.mode === mode);
    });
    // Solo means something different per mode: a derby needs opponents, a
    // trick run does not.
    if (mode === 'tricks') {
      $('solo-label').textContent = 'SOLO TRICK RUN';
      $('solo-desc').textContent = '3 minutes alone - beat your best score';
      $('bot-row').classList.add('hidden');
    } else if (this.botCount > 0) {
      $('solo-label').textContent = `BATTLE ${this.botCount} BOT${this.botCount > 1 ? 'S' : ''}`;
      $('solo-desc').textContent = 'single player smash derby';
      $('bot-row').classList.remove('hidden');
    } else {
      $('solo-label').textContent = 'FREE ROAM';
      $('solo-desc').textContent = 'practice alone, no timer';
      $('bot-row').classList.remove('hidden');
    }
    $('btn-bots').textContent = this.botCount === 0 ? 'BOTS: OFF' : `BOTS: ${this.botCount}`;
    $('btn-botdiff').textContent = this.botDifficulty.toUpperCase();
    $('btn-botdiff').disabled = this.botCount === 0;
    this.refreshBestRun();
  }

  /** The personal-best card under the play buttons. */
  refreshBestRun() {
    const el = $('best-run');
    const run = BestRun.get();
    if (!run || !run.score) {
      el.className = 'best-run empty';
      el.innerHTML = `<div class="br-none">No trick run recorded yet.<br>Set the mode to <b>TRICK BATTLE</b> and take a solo run.</div>`;
      return;
    }
    const when = new Date(run.date);
    const dateText = Number.isNaN(when.getTime()) ? '' : when.toLocaleDateString();
    const car = getCar(run.car).name;
    el.className = 'best-run';
    el.innerHTML = `
      <div>
        <div class="br-score">${fmtNum(run.score)}</div>
        <div class="br-meta">${escapeHtml(car)}${dateText ? ' &middot; ' + escapeHtml(dateText) : ''}</div>
      </div>
      ${run.frames > 0 ? '<button id="btn-watch-best" class="btn sm">WATCH</button>' : ''}`;
    const btn = $('btn-watch-best');
    if (btn) btn.addEventListener('click', () => { Audio.ui('click'); this.on.watchBest?.(); });
  }

  setQualityLabel(q) {
    $('btn-quality').textContent = `QUALITY: ${q.toUpperCase()}`;
  }

  setUiScaleLabel(userScale, applied) {
    const pct = Math.round(userScale * 100);
    $('btn-uisize').textContent = applied
      ? `UI SIZE: ${pct}%  (${Math.round(applied * 100)}% actual)`
      : `UI SIZE: ${pct}%`;
  }

  netMessage(text, kind = '') {
    const el = $('net-msg');
    el.textContent = text;
    el.className = `net-msg ${kind}`;
  }

  lobbyMessage(text, kind = '') {
    const el = $('lobby-msg');
    el.textContent = text;
    el.className = `net-msg ${kind}`;
  }

  // ── replay overlay ─────────────────────────────────────────
  showReplayBar(titleHtml) {
    $('replay-title').innerHTML = titleHtml;
    $('replay-bar').classList.add('active');
  }

  hideReplayBar() { $('replay-bar').classList.remove('active'); }

  setReplayProgress(pct) { $('replay-fill').style.width = `${Math.max(0, Math.min(100, pct))}%`; }

  refreshScrap() {
    $('scrap-count').textContent = fmtNum(Profile.scrap);
    $('garage-scrap').textContent = fmtNum(Profile.scrap);
  }

  // ── lobby ──────────────────────────────────────────────────
  showLobby(room, link) {
    $('room-code').textContent = room;
    const { url, reach } = typeof link === 'string' ? { url: link, reach: 'anywhere' } : link;
    $('room-link').textContent = url;
    const note = $('room-reach');
    if (reach === 'anywhere') {
      note.className = 'room-reach ok';
      note.textContent = 'This link works for anyone, anywhere.';
    } else if (reach === 'lan') {
      note.className = 'room-reach warn';
      note.textContent = 'Same wifi only. For friends elsewhere, run a tunnel (see the README) and reload this page on the public address.';
    } else {
      note.className = 'room-reach warn';
      note.textContent = 'This machine only.';
    }
    this.show('lobby');
  }

  updateLobby(players, myId, mode, phase, left) {
    $('lobby-players').innerHTML = [...players.values()].map((p) => `
      <div class="lobby-player">
        <div class="lp-dot" style="background:${hexCss(playerColor(p.slot))}"></div>
        <div>${escapeHtml(p.name)}${p.id === myId ? ' <span style="opacity:.5">(you)</span>' : ''}</div>
        <div class="lp-car">${escapeHtml(getCar(p.car).name)}</div>
        <div class="lp-ready${p.ready ? '' : ' waiting'}">${p.ready ? 'READY' : 'waiting'}</div>
      </div>`).join('');

    const cfg = MODES[mode] || MODES.derby;
    const me = players.get(myId);
    const alone = players.size < 2;
    let suffix = '';
    if (phase === PHASE.COUNTDOWN) suffix = `  -  starting in ${Math.ceil(left)}`;
    else if (alone) suffix = '  -  waiting for someone to join';
    else if (me?.ready) suffix = '  -  waiting for everyone to be ready';
    $('lobby-mode').textContent = cfg.name + suffix;

    $('btn-ready').textContent = me?.ready ? 'NOT READY' : 'READY';
    $('btn-ready').classList.toggle('primary', !me?.ready);
    // readying up alone would just leave you waiting; say so
    $('btn-ready').disabled = alone && !me?.ready;
    if (alone) {
      this.lobbyMessage('Send the link above. The round starts once everyone here is ready.');
    } else {
      this.lobbyMessage('');
    }
  }

  // ── results ────────────────────────────────────────────────
  showResults({ title, board, myId, rewards, unlocked, scoreLabel, record, best, canReplay }) {
    $('results-title').innerHTML =
      (record ? '<div class="record-badge">NEW PERSONAL BEST</div>' : '') +
      `<div>${escapeHtml(title)}</div>`;
    $('results-replay').style.display = canReplay ? '' : 'none';
    $('results-board').innerHTML = board.map((r, i) => `
      <div class="result-row${i === 0 ? ' first' : ''}${r.id === myId ? ' me' : ''}">
        <div class="rr-place">${i + 1}</div>
        <div class="rr-dot" style="background:${hexCss(playerColor(r.slot ?? 0))}"></div>
        <div class="rr-name">${escapeHtml(r.name)}</div>
        <div class="rr-stat">${r.wrecks ? `${r.wrecks} wrecked` : ''}</div>
        <div class="rr-score">${fmtNum(r.score)} <span style="font-size:10px;opacity:.6">${scoreLabel}</span></div>
      </div>`).join('');

    const lines = rewards.map((r) => `<div class="reward-line"><span>${escapeHtml(r.label)}</span><b>+${fmtNum(r.amount)}</b></div>`).join('');
    const total = rewards.reduce((n, r) => n + r.amount, 0);
    $('results-rewards').innerHTML = `
      ${best !== undefined ? `<div class="reward-line"><span>Personal best</span><b>${fmtNum(best)}</b></div>` : ''}
      ${lines}
      <div class="reward-line reward-total"><span>SCRAP EARNED</span><b>+${fmtNum(total)}</b></div>
      ${unlocked?.length ? `<div class="reward-unlock">New in the garage: ${unlocked.map(escapeHtml).join(', ')}</div>` : ''}
    `;
    this.show('results');
  }
}

function statColor(v) {
  if (v >= 8) return 'linear-gradient(90deg,#46e08a,#7dffb4)';
  if (v >= 6) return 'linear-gradient(90deg,#ffd23f,#ffe887)';
  if (v >= 4) return 'linear-gradient(90deg,#ff6a1f,#ff9d5c)';
  return 'linear-gradient(90deg,#ff3b52,#ff8093)';
}
