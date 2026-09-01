/* Neon image editor — crop, rotate, brightness/contrast/saturation/blur.
   Usage: openImageEditor(fileOrBlob, (dataUrl) => {...}) */
(function () {
  let active = null; // { backdrop, cleanup }

  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  function openImageEditor(file, onDone) {
    closeEditor();
    const reader = new FileReader();
    reader.onload = () => build(reader.result, onDone);
    reader.readAsDataURL(file);
  }

  function closeEditor() {
    if (active) { active.cleanup(); active = null; }
  }
  window.openImageEditor = openImageEditor;

  function build(srcDataUrl, onDone) {
    const img = new Image();
    img.onload = () => setup(img);
    img.src = srcDataUrl;
  }

  function setup(img) {
    const backdrop = el('div', 'ed-backdrop');
    const modal = el('div', 'ed-modal', backdrop);
    const head = el('div', 'ed-head', modal);
    head.innerHTML = '<span class="ed-title">✦ EDIT PHOTO</span>';
    const closeX = el('button', 'ed-x', head); closeX.textContent = '✕';

    const stage = el('div', 'ed-stage', modal);
    const view = el('canvas', 'ed-view', stage);
    const overlay = el('canvas', 'ed-overlay', stage);

    const tools = el('div', 'ed-tools', modal);
    const rows = el('div', 'ed-sliders', tools);

    function slider(label, min, max, val, oninput) {
      const w = el('label', 'ed-slider', rows);
      w.innerHTML = '<span>' + label + '</span>';
      const s = el('input', '', w);
      s.type = 'range'; s.min = min; s.max = max; s.value = val;
      s.oninput = () => { oninput(Number(s.value)); render(); };
      return s;
    }

    const filt = { brightness: 100, contrast: 100, saturate: 100, blur: 0 };
    slider('☀ Brightness', 40, 180, 100, (v) => (filt.brightness = v));
    slider('◐ Contrast', 40, 200, 100, (v) => (filt.contrast = v));
    slider('✦ Saturation', 0, 250, 100, (v) => (filt.saturate = v));
    slider('≋ Blur', 0, 12, 0, (v) => (filt.blur = v));

    const btnRow = el('div', 'ed-btns', tools);
    const bCropApply = el('button', 'btn solid', btnRow); bCropApply.textContent = 'Apply crop';
    const bRotL = el('button', 'btn', btnRow); bRotL.textContent = '⟲';
    const bRotR = el('button', 'btn', btnRow); bRotR.textContent = '⟳';
    const bReset = el('button', 'btn', btnRow); bReset.textContent = 'Reset';
    const bCancel = el('button', 'btn danger', btnRow); bCancel.textContent = 'Cancel';
    const bDone = el('button', 'btn good', btnRow); bDone.textContent = 'Use photo ✦';

    document.body.appendChild(backdrop);

    // ---- state ----
    const MAX_BASE = 2200;
    let base = document.createElement('canvas');
    (function initBase() {
      const scale = Math.min(1, MAX_BASE / Math.max(img.naturalWidth, img.naturalHeight));
      base.width = Math.round(img.naturalWidth * scale);
      base.height = Math.round(img.naturalHeight * scale);
      base.getContext('2d').drawImage(img, 0, 0, base.width, base.height);
    })();

    let crop = null;      // {x,y,w,h} in overlay coords
    let dragging = false;
    const VIEW_MAX = 440;

    function fit() {
      const s = Math.min(VIEW_MAX / base.width, VIEW_MAX / base.height, 1);
      view.width = Math.round(base.width * s);
      view.height = Math.round(base.height * s);
      overlay.width = view.width;
      overlay.height = view.height;
      return s;
    }

    function filterStr() {
      return `brightness(${filt.brightness}%) contrast(${filt.contrast}%) saturate(${filt.saturate}%) blur(${filt.blur}px)`;
    }

    function render() {
      const ctx = view.getContext('2d');
      ctx.clearRect(0, 0, view.width, view.height);
      ctx.filter = filterStr();
      ctx.drawImage(base, 0, 0, view.width, view.height);
      ctx.filter = 'none';
      // draw crop overlay dim
      const octx = overlay.getContext('2d');
      octx.clearRect(0, 0, overlay.width, overlay.height);
      if (crop && crop.w > 2 && crop.h > 2) {
        octx.fillStyle = 'rgba(3,5,18,0.62)';
        octx.fillRect(0, 0, overlay.width, overlay.height);
        octx.clearRect(crop.x, crop.y, crop.w, crop.h);
        octx.strokeStyle = '#00f0ff';
        octx.lineWidth = 2;
        octx.shadowColor = '#00f0ff';
        octx.shadowBlur = 8;
        octx.strokeRect(crop.x, crop.y, crop.w, crop.h);
        octx.shadowBlur = 0;
        // thirds grid
        octx.strokeStyle = 'rgba(0,240,255,0.35)';
        octx.lineWidth = 1;
        for (let i = 1; i < 3; i++) {
          octx.beginPath(); octx.moveTo(crop.x + (crop.w * i) / 3, crop.y); octx.lineTo(crop.x + (crop.w * i) / 3, crop.y + crop.h); octx.stroke();
          octx.beginPath(); octx.moveTo(crop.x, crop.y + (crop.h * i) / 3); octx.lineTo(crop.x + crop.w, crop.y + (crop.h * i) / 3); octx.stroke();
        }
      }
    }

    // ---- pointer crop ----
    function pos(e) {
      const r = overlay.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(overlay.width, e.clientX - r.left)),
        y: Math.max(0, Math.min(overlay.height, e.clientY - r.top))
      };
    }
    overlay.style.pointerEvents = 'auto';
    overlay.addEventListener('pointerdown', (e) => {
      dragging = true; const p = pos(e); crop = { x: p.x, y: p.y, w: 0, h: 0 };
      overlay.setPointerCapture(e.pointerId); render();
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!dragging) return; const p = pos(e);
      crop.w = p.x - crop.x; crop.h = p.y - crop.y; render();
    });
    overlay.addEventListener('pointerup', () => {
      dragging = false;
      if (crop) { if (crop.w < 0) { crop.x += crop.w; crop.w = -crop.w; } if (crop.h < 0) { crop.y += crop.h; crop.h = -crop.h; } }
      render();
    });

    // ---- actions ----
    bCropApply.onclick = () => {
      if (!crop || crop.w < 8 || crop.h < 8) return;
      const s = base.width / view.width;
      const cx = Math.round(crop.x * s), cy = Math.round(crop.y * s);
      const cw = Math.max(8, Math.round(crop.w * s)), ch = Math.max(8, Math.round(crop.h * s));
      const next = document.createElement('canvas');
      next.width = cw; next.height = ch;
      next.getContext('2d').drawImage(base, cx, cy, cw, ch, 0, 0, cw, ch);
      base = next; crop = null; render();
    };
    function rotate(dir) {
      const next = document.createElement('canvas');
      next.width = base.height; next.height = base.width;
      const c = next.getContext('2d');
      c.translate(next.width / 2, next.height / 2);
      c.rotate((dir * Math.PI) / 2);
      c.drawImage(base, -base.width / 2, -base.height / 2);
      base = next; crop = null; render();
    }
    bRotL.onclick = () => rotate(-1);
    bRotR.onclick = () => rotate(1);
    bReset.onclick = () => {
      const scale = Math.min(1, MAX_BASE / Math.max(img.naturalWidth, img.naturalHeight));
      base = document.createElement('canvas');
      base.width = Math.round(img.naturalWidth * scale);
      base.height = Math.round(img.naturalHeight * scale);
      base.getContext('2d').drawImage(img, 0, 0, base.width, base.height);
      filt.brightness = 100; filt.contrast = 100; filt.saturate = 100; filt.blur = 0;
      [...rows.querySelectorAll('input')].forEach((s) => { s.value = 100; if (s.previousSibling && s.parentElement.textContent.includes('Blur')) s.value = 0; });
      rows.querySelectorAll('input')[3].value = 0;
      crop = null; render();
    };

    function cleanup() {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
    }
    function onKey(e) { if (e.key === 'Escape') cancel(); }
    function cancel() { closeEditor(); }

    bCancel.onclick = cancel;
    closeX.onclick = cancel;

    bDone.onclick = () => {
      const MAX_OUT = 1600;
      const s = Math.min(1, MAX_OUT / Math.max(base.width, base.height));
      const out = document.createElement('canvas');
      out.width = Math.round(base.width * s);
      out.height = Math.round(base.height * s);
      const c = out.getContext('2d');
      c.filter = filterStr();
      c.drawImage(base, 0, 0, out.width, out.height);
      cleanup();
      active = null;
      onDone(out.toDataURL('image/jpeg', 0.88));
    };

    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) cancel(); });

    render();
    active = { backdrop, cleanup };
  }
})();