/**
 * In-game HUD. Pure DOM — cheap, crisp at any resolution, and far easier to
 * lay out than canvas text.
 */
import { fmtTime, fmtNum, hexCss, playerColor } from '../core/util.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor() {
    this.root = $('hud');
    this.el = {
      mode: $('hud-mode'),
      timer: $('hud-timer'),
      lives: $('hud-lives'),
      scores: $('hud-scores'),
      health: $('health-fill'),
      healthBar: document.querySelector('.bar.health'),
      boost: $('boost-fill'),
      flip: $('flip-pip'),
      speed: $('speed-val'),
      combo: $('combo'),
      comboList: $('combo-list'),
      comboScore: $('combo-score'),
      popups: $('popups'),
      feed: $('feed'),
      announce: $('announce'),
      radar: $('radar'),
      armWeapon: $('arm-weapon'),
      armCounter: $('arm-counter'),
      weaponName: $('weapon-name'),
      weaponFill: $('weapon-fill'),
      weaponAmmo: $('weapon-ammo'),
      counterName: $('counter-name'),
      counterPips: $('counter-pips'),
    };
    this.radarCtx = this.el.radar.getContext('2d');
    this._lastSpeed = -1;
    this._lastTimer = '';
    this._scoreSig = '';
  }

  show() { this.root.classList.add('active'); }

  /** Strips the driving gauges, leaving only popups and announcements. */
  setReplayMode(on) { this.root.classList.toggle('replay', !!on); }
  hide() { this.root.classList.remove('active'); this.hideCombo(); }

  setMode(name) { this.el.mode.textContent = name; }

  setTimer(sec) {
    const s = fmtTime(sec);
    if (s !== this._lastTimer) {
      this._lastTimer = s;
      this.el.timer.textContent = s;
    }
    this.el.timer.classList.toggle('urgent', sec <= 10);
  }

  setLives(n, max) {
    if (max <= 0) { this.el.lives.innerHTML = ''; return; }
    let html = '';
    for (let i = 0; i < max; i++) html += `<div class="life-pip${i < n ? '' : ' lost'}"></div>`;
    this.el.lives.innerHTML = html;
  }

  setHealth(pct) {
    this.el.health.style.width = `${Math.max(0, pct)}%`;
    this.el.healthBar.classList.toggle('warn', pct <= 55 && pct > 25);
    this.el.healthBar.classList.toggle('crit', pct <= 25);
  }

  setBoost(pct) { this.el.boost.style.width = `${Math.max(0, pct)}%`; }

  setFlipReady(v) { this.el.flip.classList.toggle('ready', !!v); }

  /** @param {Armoury} a */
  setArms(a) {
    if (!a) return;
    this.el.weaponName.textContent = a.w.name;
    this.el.weaponAmmo.textContent = a.reloading ? '--' : a.ammo;
    this.el.weaponFill.style.width = `${(a.reloading ? a.reloadFrac : a.ammoFrac) * 100}%`;
    this.el.weaponFill.classList.toggle('reloading', a.reloading);
    this.el.armWeapon.classList.toggle('empty', a.reloading);
    this.el.armWeapon.classList.toggle('ready', a.canFire());

    this.el.counterName.textContent = a.c.name;
    const total = a.c.charges;
    if (this._pipCount !== total) {
      this._pipCount = total;
      this.el.counterPips.innerHTML = Array.from({ length: total },
        () => '<div class="arm-pip"></div>').join('');
    }
    const pips = this.el.counterPips.children;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('spent', i >= a.charges);
    this.el.armCounter.classList.toggle('empty', a.charges === 0);
  }

  setSpeed(kmh) {
    const v = Math.max(0, Math.round(kmh));
    if (v !== this._lastSpeed) {
      this._lastSpeed = v;
      this.el.speed.textContent = v;
    }
  }

  setScores(rows, myId, label = 'PTS') {
    const sig = rows.map((r) => `${r.id}:${r.score}:${r.alive}`).join('|') + label;
    if (sig === this._scoreSig) return;
    this._scoreSig = sig;
    this.el.scores.innerHTML = rows.map((r) => `
      <div class="score-row${r.id === myId ? ' me' : ''}${r.alive ? '' : ' dead'}">
        <div class="score-dot" style="background:${hexCss(playerColor(r.slot))}"></div>
        <div class="score-name">${escapeHtml(r.name)}</div>
        <div class="score-val">${fmtNum(r.score)}</div>
      </div>`).join('');
  }

  // ── trick combo ────────────────────────────────────────────
  showCombo(tricks, total, mult) {
    this.el.combo.classList.add('active');
    this.el.comboList.innerHTML = tricks.slice(-5)
      .map((t) => `<div class="combo-trick">${escapeHtml(t)}</div>`).join('');
    this.el.comboScore.innerHTML =
      `${fmtNum(total)}${mult > 1 ? `<span class="combo-mult">x${mult}</span>` : ''}`;
  }

  hideCombo() { this.el.combo.classList.remove('active'); }

  popup(text, color = '#ffd23f') {
    const d = document.createElement('div');
    d.className = 'popup';
    d.style.color = color;
    d.textContent = text;
    this.el.popups.appendChild(d);
    setTimeout(() => d.remove(), 1200);
  }

  feedItem(html) {
    const d = document.createElement('div');
    d.className = 'feed-item';
    d.innerHTML = html;
    this.el.feed.appendChild(d);
    while (this.el.feed.children.length > 5) this.el.feed.firstChild.remove();
    setTimeout(() => d.remove(), 5200);
  }

  announce(text, color = '#fff') {
    const el = this.el.announce;
    el.textContent = text;
    el.style.color = color;
    el.classList.remove('show');
    void el.offsetWidth;      // restart the animation
    el.classList.add('show');
  }

  // ── radar ──────────────────────────────────────────────────
  drawRadar(me, others, arenaRadius = 125) {
    const ctx = this.radarCtx;
    const W = 180, H = 180, C = W / 2;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(7,8,11,0.55)';
    ctx.beginPath(); ctx.arc(C, C, C - 2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(C, C, C - 2, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(C, C, (C - 2) * 0.5, 0, Math.PI * 2); ctx.stroke();

    if (!me) return;
    const scale = (C - 10) / arenaRadius;

    // rotate the world so "up" on the radar is the way the player faces
    const cos = Math.cos(-me.yaw), sin = Math.sin(-me.yaw);
    const plot = (x, z) => {
      const dx = x - me.x, dz = z - me.z;
      // screen up = -Y, and forward is +Z in world space
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      return [C + rx * scale, C - rz * scale];
    };

    for (const o of others) {
      const [x, y] = plot(o.x, o.z);
      if (Math.hypot(x - C, y - C) > C - 5) continue;
      ctx.fillStyle = o.alive ? hexCss(playerColor(o.slot)) : 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.arc(x, y, o.alive ? 4.5 : 3, 0, Math.PI * 2); ctx.fill();
    }

    // the player, always centred, always pointing up
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(C, C - 7); ctx.lineTo(C - 5, C + 5); ctx.lineTo(C + 5, C + 5);
    ctx.closePath(); ctx.fill();
  }
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
