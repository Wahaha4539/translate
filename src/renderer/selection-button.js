'use strict';
const button = document.getElementById('selection-translate');
button.addEventListener('click', async () => {
  button.disabled = true;
  try { await window.selectionButton.translate(); } finally { button.disabled = false; }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') void window.selectionButton.dismiss(); });
