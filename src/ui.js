/*
 * Splitter — small UI helpers: category icons, avatars (emoji / photo), and motion
 * (number count-up, confetti). Every animation respects prefers-reduced-motion.
 */
(function (root) {
  'use strict';

  const reducedMotion = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---------- category icons (20×20, stroked like the rest of the UI) ----------

  const ICON_PATHS = {
    Food: '<path d="M5 3v5a2 2 0 0 0 4 0V3M7 3v14"/><path d="M14 17V3c-2 1-2.6 4-2.6 6.4 0 1 .6 1.6 1.6 1.6H14"/>',
    Travel: '<path d="M4 13.5 5.4 9a2 2 0 0 1 1.9-1.4h5.4A2 2 0 0 1 14.6 9l1.4 4.5"/><path d="M3.5 13.5h13v3h-13z"/><path d="M6 16.5V18M14 16.5V18"/>',
    Stay: '<path d="M3 16V5M3 12h14v4M17 16v-3.5a2.5 2.5 0 0 0-2.5-2.5H9v2"/><circle cx="6" cy="9.5" r="1.4"/>',
    Shopping: '<path d="M5 7h10l-1 10H6z"/><path d="M8 7V6a2 2 0 0 1 4 0v1"/>',
    Entertainment: '<path d="M3 7a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v2a1.5 1.5 0 0 0 0 3v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1.5 1.5 0 0 0 0-3z"/><path d="M12 6v9" stroke-dasharray="1.6 1.8"/>',
    Bills: '<path d="M6 3h8v14l-2-1.5-2 1.5-2-1.5L6 17z"/><path d="M8.2 7h3.6M8.2 10h3.6"/>',
    Other: '<path d="M5 10h.01M10 10h.01M15 10h.01" stroke-width="3.2"/>',
    custom: '<path d="M3 10V4h6l8 8-6 6z"/><path d="M6.5 6.5h.01" stroke-width="2.6"/>',
  };

  /** Inline SVG icon for a category, tinted with the given CSS colour. */
  function categoryIcon(name, color) {
    const paths = ICON_PATHS[name] || ICON_PATHS.custom;
    return `<svg class="cat-icon" viewBox="0 0 20 20" aria-hidden="true" style="color:${color}">${paths}</svg>`;
  }

  // ---------- avatars ----------

  const EMOJIS = ['😀', '😎', '🤓', '🥳', '😇', '🤠', '🧑‍💻', '🧑‍🍳', '🦁', '🐯', '🐼', '🐨',
    '🦊', '🐸', '🐙', '🦄', '🌸', '🌻', '🍕', '☕', '⚽', '🎸', '🚀', '🏖️'];

  const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
  const MAX_PHOTO = 16000; // characters of data URL (~11 KB image)

  /** 'photo' | 'emoji' | null — anything else (or unsafe) is ignored and initials are shown. */
  function avatarKind(value) {
    if (typeof value !== 'string' || !value) return null;
    if (value.length <= MAX_PHOTO && PHOTO_RE.test(value)) return 'photo';
    if (value.length <= 16 && !/[<>&"'\s]/.test(value) && !/^[\x00-\x7f]*$/.test(value)) return 'emoji';
    return null;
  }

  /** Shrink a picked image to a 96×96 centre-cropped JPEG data URL small enough to sync. */
  function resizePhoto(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) return reject(new Error('Pick an image file'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const size = 96;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
        for (const q of [0.82, 0.7, 0.55, 0.4]) {
          const data = canvas.toDataURL('image/jpeg', q);
          if (data.length <= MAX_PHOTO && PHOTO_RE.test(data)) return resolve(data);
        }
        reject(new Error('That photo is too detailed to use — try another'));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
      img.src = url;
    });
  }

  // ---------- motion ----------

  const running = new WeakMap();

  /** Animate a number shown in `el` from `from` to `to` (integers), formatted by `format`. */
  function countTo(el, from, to, format, ms) {
    if (!el) return;
    const prev = running.get(el);
    if (prev) cancelAnimationFrame(prev);
    // Hidden tabs pause animation frames, so show the final value straight away there.
    if (from === to || reducedMotion() || document.hidden) { el.textContent = format(to); return; }
    const start = performance.now();
    const dur = ms || 600;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = format(t === 1 ? to : Math.round(from + (to - from) * eased));
      if (t < 1) running.set(el, requestAnimationFrame(step));
      else running.delete(el);
    };
    el.textContent = format(from);
    running.set(el, requestAnimationFrame(step));
  }

  /** A short burst of orange confetti from the top of the screen. */
  function confetti() {
    if (reducedMotion() || document.hidden) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'confetti';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    const dpr = Math.min(2, root.devicePixelRatio || 1);
    const W = root.innerWidth;
    const H = root.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const colors = ['#EA580C', '#F97316', '#FB923C', '#FED7AA', '#FFFFFF', '#FACC15', '#C2410C'];
    const bits = Array.from({ length: 140 }, (_, i) => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.5,
      y: -20 - Math.random() * 80,
      vx: (Math.random() - 0.5) * 9,
      vy: 2 + Math.random() * 5,
      r: 4 + Math.random() * 5,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: colors[i % colors.length],
      round: i % 3 === 0,
    }));
    const start = performance.now();
    const frame = (now) => {
      const t = now - start;
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = t > 1500 ? Math.max(0, 1 - (t - 1500) / 600) : 1;
      for (const b of bits) {
        b.vy += 0.12;
        b.vx *= 0.99;
        b.x += b.vx;
        b.y += b.vy;
        b.rot += b.vr;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.rot);
        ctx.fillStyle = b.color;
        if (b.round) { ctx.beginPath(); ctx.arc(0, 0, b.r / 2, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(-b.r / 2, -b.r / 4, b.r, b.r / 2);
        ctx.restore();
      }
      if (t < 2100) requestAnimationFrame(frame);
      else canvas.remove();
    };
    requestAnimationFrame(frame);
  }

  /** Play a leave animation on an element, then resolve (immediately with reduced motion). */
  function animateOut(el) {
    if (!el || reducedMotion()) return Promise.resolve();
    el.classList.add('leaving');
    return new Promise((resolve) => setTimeout(resolve, 220));
  }

  root.SplitUI = { reducedMotion, categoryIcon, EMOJIS, avatarKind, resizePhoto, countTo, confetti, animateOut };
})(typeof self !== 'undefined' ? self : this);
