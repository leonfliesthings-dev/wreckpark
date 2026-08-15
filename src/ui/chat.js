/**
 * Room chat. The server already relays messages; this is the front of it.
 *
 * Typing must never leak into the driving controls, so the input is a real
 * <input> — Input.sample() ignores key events aimed at form fields.
 */
import { escapeHtml } from './hud.js';
import { hexCss, playerColor } from '../core/util.js';

const $ = (id) => document.getElementById(id);
const FADE_AFTER = 11000;
const MAX_LINES = 7;

export class Chat {
  constructor(onSend) {
    this.onSend = onSend;
    this.root = $('chat');
    this.log = $('chat-log');
    this.input = $('chat-input');
    this.typing = false;

    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.input.value.trim();
        this.input.value = '';
        this.close();
        if (text) this.onSend?.(text);
      } else if (e.key === 'Escape') {
        this.input.value = '';
        this.close();
      }
    });
    // clicking away closes the box rather than leaving it hanging open
    this.input.addEventListener('blur', () => { if (this.typing) this.close(); });
  }

  setVisible(v) { this.root.classList.toggle('active', !!v); }

  open() {
    if (this.typing) return;
    this.typing = true;
    this.root.classList.add('typing');
    this.input.focus();
  }

  close() {
    if (!this.typing) return;
    this.typing = false;
    this.root.classList.remove('typing');
    this.input.blur();
  }

  add(name, text, slot = 0) {
    this._push(`<b style="color:${hexCss(playerColor(slot))}">${escapeHtml(name)}</b> ${escapeHtml(text)}`);
  }

  system(text) {
    this._push(escapeHtml(text), true);
  }

  _push(html, system = false) {
    const el = document.createElement('div');
    el.className = system ? 'chat-msg system' : 'chat-msg';
    el.innerHTML = html;
    this.log.appendChild(el);
    while (this.log.children.length > MAX_LINES) this.log.firstChild.remove();
    setTimeout(() => {
      el.classList.add('fading');
      setTimeout(() => el.remove(), 700);
    }, FADE_AFTER);
  }

  clear() { this.log.innerHTML = ''; }
}
