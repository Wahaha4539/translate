'use strict';
const api = window.screenCapture;
const selection = document.getElementById('selection');
const hint = document.getElementById('hint');
let start;
let rect;
let busy = false;
let ready = false;
const point = event => ({ x: Math.max(0, Math.min(innerWidth, event.clientX)), y: Math.max(0, Math.min(innerHeight, event.clientY)) });
function update(event) {
  const end = point(event);
  rect = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) };
  Object.assign(selection.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  document.getElementById('dimensions').textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
}
document.addEventListener('pointerdown', event => {
  if (!ready || busy || event.button !== 0 || hint.contains(event.target)) return;
  start = point(event);
  document.body.setPointerCapture(event.pointerId);
  document.body.classList.add('selecting');
  selection.hidden = false;
  update(event);
});
document.addEventListener('pointermove', event => { if (start) update(event); });
document.addEventListener('pointerup', async event => {
  if (!start || event.button !== 0) return;
  update(event);
  start = null;
  document.body.releasePointerCapture(event.pointerId);
  if (rect.width < 8 || rect.height < 8) { document.getElementById('message').textContent = '选区太小，请重新拖动'; return; }
  busy = true;
  try {
    const result = await api.finish(rect);
    if (!result?.ok) { busy = false; document.getElementById('message').textContent = result?.error || '请重新框选'; }
  } catch { busy = false; }
});
document.addEventListener('pointercancel', () => { start = null; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') void api.cancel(); });
document.addEventListener('contextmenu', event => { event.preventDefault(); void api.cancel(); });
document.getElementById('cancel').addEventListener('click', () => api.cancel());
api.image().then(async data => {
  if (!data) { await api.cancel(); return; }
  const image = document.getElementById('screen');
  image.src = data.image;
  document.getElementById('capture-model').textContent = `发送到 ${data.model}`;
  await image.decode();
  ready = true;
}).catch(() => api.cancel());
