/**
 * The garage: browse cosmetic categories, buy with scrap, equip.
 * Everything here is cosmetic by design — nobody buys an advantage.
 */
import { CATEGORIES, ITEMS, CAT_ICON, getItem } from '../game/cosmetics.js';
import { Profile } from '../core/storage.js';
import { Audio } from '../core/audio.js';
import { fmtNum, hexCss } from '../core/util.js';
import { escapeHtml } from './hud.js';

const $ = (id) => document.getElementById(id);

export class Garage {
  constructor(onChange) {
    this.onChange = onChange;
    this.cat = 'paint';
    this._buildTabs();
    this.render();
  }

  _buildTabs() {
    const nav = $('garage-tabs');
    nav.innerHTML = CATEGORIES.map((c) => `
      <button class="garage-tab" data-cat="${c.id}">${CAT_ICON[c.id] || ''} ${c.name}</button>
    `).join('');
    nav.querySelectorAll('.garage-tab').forEach((el) => {
      el.addEventListener('click', () => {
        Audio.ui('click');
        this.cat = el.dataset.cat;
        this.render();
      });
    });
  }

  render() {
    document.querySelectorAll('.garage-tab').forEach((el) => {
      el.classList.toggle('active', el.dataset.cat === this.cat);
    });

    const items = ITEMS[this.cat] || [];
    const equipped = Profile.loadout[this.cat];
    const scrap = Profile.scrap;

    $('garage-items').innerHTML = items.map((item) => {
      const owned = Profile.owns(this.cat, item.id);
      const isOn = equipped === item.id;
      const afford = scrap >= item.cost;
      const cls = ['item-card'];
      if (isOn) cls.push('equipped');
      if (!owned) cls.push('locked');
      if (!owned && !afford) cls.push('cant-afford');

      return `
        <div class="${cls.join(' ')}" data-id="${item.id}">
          ${isOn ? '<div class="item-badge">ON</div>' : ''}
          <div class="item-swatch" style="${swatchStyle(this.cat, item)}">${swatchGlyph(this.cat, item)}</div>
          <div class="item-name">${escapeHtml(item.name)}</div>
          <div class="item-cost ${owned ? 'owned' : ''}">
            ${owned ? (isOn ? 'EQUIPPED' : 'OWNED') : `${fmtNum(item.cost)} SCRAP`}
          </div>
        </div>`;
    }).join('');

    $('garage-items').querySelectorAll('.item-card').forEach((el) => {
      el.addEventListener('click', () => this._pick(el.dataset.id));
      el.addEventListener('mouseenter', () => Audio.ui('hover'));
    });

    $('garage-scrap').textContent = fmtNum(scrap);
  }

  _pick(id) {
    const owned = Profile.owns(this.cat, id);
    if (!owned) {
      const item = getItem(this.cat, id);
      if (Profile.scrap < item.cost) {
        Audio.ui('click');
        this._flash(id, 'Not enough scrap');
        return;
      }
      Profile.buy(this.cat, id);
      Audio.ui('buy');
    } else {
      Audio.ui('click');
    }
    Profile.equip(this.cat, id);
    this.render();
    this.onChange?.();
  }

  _flash(id, msg) {
    const el = $('garage-items').querySelector(`[data-id="${id}"] .item-cost`);
    if (!el) return;
    const old = el.textContent;
    el.textContent = msg;
    el.style.color = '#ff3b52';
    setTimeout(() => { el.textContent = old; el.style.color = ''; }, 1200);
  }
}

function swatchStyle(cat, item) {
  if (cat === 'paint') {
    const c = item.color === null ? 0x8a9099 : item.color;
    return `background:linear-gradient(135deg,${hexCss(c)},${hexCss(c)}66)`;
  }
  if (cat === 'underglow' || cat === 'trail') {
    if (item.color == null) return 'background:rgba(255,255,255,.05)';
    return `background:radial-gradient(circle at 50% 70%,${hexCss(item.color)},transparent 72%)`;
  }
  if (cat === 'wheels') {
    return `background:radial-gradient(circle,${hexCss(item.rim)} 0 34%,#14161a 36%)`;
  }
  if (cat === 'finish') {
    const c = item.forceColor ?? 0xb9c2cf;
    const shine = (item.metal ?? 0) > 0.7 ? 'linear-gradient(135deg,#fff,#7d8794 40%,#fff 60%,#5b6470)' : `linear-gradient(135deg,${hexCss(c)},${hexCss(c)}55)`;
    return `background:${shine}`;
  }
  return 'background:rgba(255,255,255,.05)';
}

function swatchGlyph(cat, item) {
  if (cat === 'livery') return { stripes: '||', checker: '▨', flames: '🔥', camo: '▩', hazard: '⚠', splatter: '✷', circuit: '⌗', none: '—' }[item.id] || '';
  if (cat === 'spoiler') return { none: '—', ducktail: '▁', gt: '⊤', monster: '⊼', dual: '≡' }[item.id] || '';
  if (cat === 'roof') return { none: '—', scoop: '◠', lights: '≡', fin: '◣', spikes: '⋀⋀', siren: '◉' }[item.id] || '';
  if (cat === 'bumper') return { stock: '—', rambar: '▬', spikes: '▲▲', plow: '◤', wedge: '◢' }[item.id] || '';
  return '';
}
