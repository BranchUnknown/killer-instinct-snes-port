// Command-list icons (KI 2013 style): fist / foot buttons coloured by strength, white direction arrows,
// HOLD / REL / TAP / AIR tags. Everything is inline SVG so the single-file build needs no image files.
(function () {
  'use strict';
  // strength colours: quick = blue, medium = yellow, fierce = red; P / K (any strength) = grey
  const STR = { Q: ['#2f7fc0', '#7cc4f5'], M: ['#c8961c', '#ffd75e'], F: ['#b8282a', '#ff7a6a'], A: ['#55595f', '#a9aeb5'] };
  const FIST = 'M6.2 9.6c0-1.6 1.1-2.6 2.4-2.6.6 0 1.1.2 1.5.5.4-.9 1.2-1.5 2.2-1.5.8 0 1.5.4 1.9 1 .4-.6 1.1-1 1.9-1 1.3 0 2.3 1 2.3 2.3v.6' +
    'c.3-.1.6-.2.9-.2 1.2 0 2.1 1 2.1 2.2v3.4c0 3.6-2.9 6.5-6.5 6.5h-2.1c-3.4 0-6.4-2.4-7-5.8l-.6-3.2c-.2-1.2.6-2.3 1.8-2.5' +
    '.5-.1 1 0 1.4.2V9.6zM10.1 9.4v2.7M14.1 9v3M18 9.3v2.9M7.8 15.2c1.9-.6 3.9-.3 5.4.9';
  const FOOT = 'M7.4 4.3h5.6l.4 8.4c.2 1.3 1 2.1 2.3 2.4l4.6 1.1c1.6.4 2.6 1.4 2.6 2.8 0 1.5-1.1 2.5-2.7 2.5H8.6' +
    'c-2.1 0-3.4-1.4-3.2-3.4l.9-6.6.5-3.3.6-3.9zM16.8 16.2l.3 5.2M19.8 17.2l.2 4.1';
  function button(kind, str) {
    const [dark, light] = STR[str] || STR.A, g = 'g' + kind + str;
    const glyph = kind === 'P' ? FIST : FOOT;
    return '<svg class="mi-btn" viewBox="0 0 28 28" aria-label="' + (str === 'A' ? '' : str) + kind + '">' +
      '<defs><linearGradient id="' + g + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + light + '"/><stop offset="1" stop-color="' + dark + '"/></linearGradient></defs>' +
      '<rect x="1" y="1" width="26" height="26" rx="4" fill="url(#' + g + ')" stroke="#111" stroke-width="1.5"/>' +
      '<rect x="2.5" y="2.5" width="23" height="23" rx="3" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="1"/>' +
      '<path d="' + glyph + '" transform="translate(0.5 0.5)" fill="#fff" stroke="#1a1a1a" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round"/>' +
      (str === 'A' ? '' : '<text x="24.2" y="25.2" text-anchor="end" font-size="8.5" font-weight="900" font-family="Arial Black,Arial,sans-serif" fill="#fff" stroke="#000" stroke-width="2" paint-order="stroke">' + str + '</text>') +
      '</svg>';
  }
  const ANG = { F: 0, DF: 45, D: 90, DB: 135, B: 180, UB: 225, U: 270, UF: 315 };
  function arrow(dir, charge) {
    return '<svg class="mi-arr' + (charge ? ' charge' : '') + '" viewBox="0 0 28 28" aria-label="' + dir + '">' +
      '<g transform="rotate(' + ANG[dir] + ' 14 14)"><path d="M3 10.5h12.5V5L25.5 14l-10 9v-5.5H3z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></g>' +
      (charge ? '<text x="14" y="27" text-anchor="middle" font-size="6.5" font-weight="900" font-family="Arial Black,Arial,sans-serif" fill="#ffd75e" stroke="#000" stroke-width="1.8" paint-order="stroke">HOLD</text>' : '') +
      '</svg>';
  }
  const BUTTONS = { QP: ['P', 'Q'], MP: ['P', 'M'], FP: ['P', 'F'], P: ['P', 'A'], QK: ['K', 'Q'], MK: ['K', 'M'], FK: ['K', 'F'], K: ['K', 'A'] };
  const TAGS = { hold: 'HOLD', release: 'REL', tap: 'TAP', air: 'AIR', '(air)': '(AIR)' };
  function esc(t) { return String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  // input token list -> HTML
  function render(tokens) {
    let h = '';
    for (const t of tokens) {
      if (BUTTONS[t]) h += button(BUTTONS[t][0], BUTTONS[t][1]);
      else if (ANG[t] !== undefined) h += arrow(t);
      else if (t === 'chargeB') h += arrow('B', true);
      else if (t === 'chargeF') h += arrow('F', true);
      else if (TAGS[t]) h += '<span class="mi-tag">' + TAGS[t] + '</span>';
      else if (t === '+') h += '<span class="mi-plus">+</span>';
      else if (t === 'or') h += '<span class="mi-or">or</span>';
      else if (t === '(' || t === ')') h += '<span class="mi-par">' + t + '</span>';
      else if (t === 'Hold') h += '<span class="mi-tag">HOLD</span>';
      else h += '<span class="mi-note">' + esc(t) + '</span>';
    }
    return h;
  }
  // plain-text version for the description panel
  const WORDS = { QP: 'Quick Punch', MP: 'Medium Punch', FP: 'Fierce Punch', P: 'any Punch', QK: 'Quick Kick', MK: 'Medium Kick', FK: 'Fierce Kick', K: 'any Kick',
    U: 'Up', D: 'Down', B: 'Back', F: 'Forward', UB: 'Up-Back', UF: 'Up-Forward', DB: 'Down-Back', DF: 'Down-Forward',
    chargeB: 'hold Back', chargeF: 'hold Forward', hold: 'hold', release: 'release', tap: 'tap', air: 'in the air', '(air)': '(also in the air)' };
  function words(tokens) {
    return tokens.map(t => WORDS[t] || t).join(' ').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/\s+/g, ' ');
  }
  globalThis.KIMoveIcons = { render, words, button, arrow };
})();
