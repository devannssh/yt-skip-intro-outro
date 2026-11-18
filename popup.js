const $ = s => document.querySelector(s);
chrome.storage.local.get(['cfg', 'tpls'], ({ cfg = {}, tpls = [] }) => {
  const c = { auto: false, sb: true, chapters: true, learn: true, ...cfg };
  for (const k in c) {
    const el = $('#' + k); el.checked = c[k];
    el.onchange = () => { c[k] = el.checked; chrome.storage.local.set({ cfg: c }); };
  }
  render(tpls);
});
function render(tpls) {
  const list = $('#list'); list.textContent = '';
  if (!tpls.length) { list.textContent = 'Nothing learned yet.'; return; }
  tpls.forEach((t, i) => {
    const row = document.createElement('div'); row.className = 'row';
    const label = document.createElement('span');
    label.textContent = `${t.kind} · ${Math.round(t.dur)}s · ${t.channel || 'any channel'}`;
    const del = document.createElement('button'); del.textContent = 'Delete';
    del.onclick = () => { tpls.splice(i, 1); chrome.storage.local.set({ tpls }); render(tpls); };
    row.append(label, del); list.append(row);
  });
}
