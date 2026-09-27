/* DC Bill Desk — data layer on Supabase (single user, no login).
 *
 * Mimics the small Firestore-style API the app used on claude.ai
 * (window.claude.use('db')), so the app code stays unchanged:
 *   db.doc('col/id').set(data) | .update(patch) | .delete()
 *   db.collection('col').onSnapshot(cb, onError)  -> cb({docs:[{id, data()}]})
 *
 * Access: every call goes through a desk_* RPC carrying a secret "desk key"
 * (see supabase/schema.sql). The key arrives once via the private link
 * (…/#k=<key>), is kept in localStorage, and is never part of this repo.
 * Also owns the key screen and the backup / restore (JSON) menu.
 */
(function () {
  'use strict';
  const CFG = window.DC_CONFIG || {};
  const KEY_STORE = 'dbd.deskKey';
  const BACKUP_FORMAT = 'dc-bill-desk-backup';
  const POLL_MS = 60000;

  let sb = null, key = null;
  const cache = {};      // col -> Map(id -> data)
  const listeners = {};  // col -> Set({cb, err})
  let syncing = false;

  const errOf = (e) => ({ code: (e && (e.code || e.status)) || 'error', message: (e && e.message) || String(e) });
  const clone = (x) => JSON.parse(JSON.stringify(x ?? {}));

  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, Object.assign({ p_key: key }, args));
    if (error) throw errOf(error);
    return data;
  }

  function splitPath(path) {
    const p = String(path).split('/');
    if (p.length !== 2 || !p[0] || !p[1]) throw new Error('bad doc path: ' + path);
    return p;
  }

  function emit(col) {
    const set = listeners[col]; if (!set) return;
    const m = cache[col] || new Map();
    const snap = { docs: [...m.entries()].map(([id, d]) => ({ id, data: () => clone(d) })) };
    for (const l of set) { try { l.cb(snap); } catch (e) { console.error(e); } }
  }

  async function fetchCol(col) {
    const rows = await rpc('desk_list', { p_col: col });
    const m = new Map(); for (const r of rows) m.set(r.id, r.data || {});
    const before = JSON.stringify([...(cache[col] || new Map())]);
    cache[col] = m;
    if (JSON.stringify([...m]) !== before) emit(col);   // skip re-render when nothing changed
  }
  function fail(col, e) { for (const l of listeners[col] || []) if (l.err) l.err(errOf(e)); }

  // no realtime (it can't check the desk key): resync when the tab comes back and every minute
  async function syncAll() {
    if (syncing || document.hidden) return;
    syncing = true;
    try { await Promise.all(Object.keys(listeners).map((c) => fetchCol(c).catch((e) => fail(c, e)))); }
    finally { syncing = false; }
  }
  let started = false;
  function startSync() {
    if (started) return; started = true;
    document.addEventListener('visibilitychange', syncAll);
    window.addEventListener('focus', syncAll);
    setInterval(syncAll, POLL_MS);
  }

  // local latency compensation, like Firestore: UI updates before the round trip
  function localPut(col, id, data) { (cache[col] || (cache[col] = new Map())).set(id, data); emit(col); }
  function localDel(col, id) { cache[col] && cache[col].delete(id); emit(col); }

  const db = {
    doc(path) {
      const [col, id] = splitPath(path);
      return {
        async set(data) {
          const d = clone(data);
          localPut(col, id, d);
          try { await rpc('desk_set', { p_col: col, p_id: id, p_data: d }); }
          catch (e) { await fetchCol(col).catch(() => {}); throw e; }
        },
        async update(patch) {
          const p = clone(patch);
          localPut(col, id, Object.assign(clone(cache[col] && cache[col].get(id)), p));
          try { await rpc('desk_merge', { p_col: col, p_id: id, p_patch: p }); }
          catch (e) { await fetchCol(col).catch(() => {}); throw e; }
        },
        async delete() {
          localDel(col, id);
          try { await rpc('desk_delete', { p_col: col, p_id: id }); }
          catch (e) { await fetchCol(col).catch(() => {}); throw e; }
        },
      };
    },
    collection(col) {
      return {
        onSnapshot(cb, err) {
          const l = { cb, err };
          (listeners[col] || (listeners[col] = new Set())).add(l);
          startSync();
          fetchCol(col).then(() => emit(col)).catch((e) => err && err(errOf(e)));
          return () => listeners[col].delete(l);
        },
      };
    },
  };

  /* ---------- desk key ---------- */
  const lsGet = () => { try { return localStorage.getItem(KEY_STORE); } catch (e) { return null; } };
  const lsSet = (v) => { try { v ? localStorage.setItem(KEY_STORE, v) : localStorage.removeItem(KEY_STORE); } catch (e) {} };

  // take #k=<key> from the private link, then strip it from the address bar / history
  function keyFromHash() {
    const m = /(?:^#|&)k=([^&]+)/.exec(location.hash || '');
    if (!m) return null;
    history.replaceState(null, '', location.pathname + location.search);
    return decodeURIComponent(m[1]);
  }

  async function valid(k) {
    const { data, error } = await sb.rpc('desk_check', { p_key: k });
    if (error) { if (error.code === '42501') return false; throw errOf(error); }
    return data === true;
  }

  function keyScreen(message) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'auth';
      el.innerHTML = `
        <form class="auth-card" autocomplete="off">
          <h2>DC Bill Desk</h2>
          <p class="auth-sub">เครื่องนี้ยังไม่มีคีย์ — เปิดจากลิงก์ส่วนตัว หรือวางลิงก์/คีย์ตรงนี้ (ทำครั้งเดียวต่อเครื่อง)</p>
          <label>ลิงก์ส่วนตัว หรือคีย์<input name="k" autocomplete="off" spellcheck="false" required></label>
          <button class="btn primary" type="submit">เปิด</button>
          <p class="auth-msg" role="status"></p>
        </form>`;
      document.body.appendChild(el);
      const f = el.querySelector('form'), msg = el.querySelector('.auth-msg');
      if (message) msg.textContent = message;
      f.k.focus();
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        let v = f.k.value.trim();
        const m = /[#&]k=([^&\s]+)/.exec(v); if (m) v = decodeURIComponent(m[1]);
        msg.textContent = 'กำลังตรวจ…';
        try {
          if (!(await valid(v))) { msg.textContent = 'คีย์ไม่ถูกต้อง'; return; }
        } catch (err) { msg.textContent = 'ต่อฐานข้อมูลไม่ได้: ' + err.message; return; }
        el.remove(); resolve(v);
      });
    });
  }

  /* ---------- menu: backup / restore / forget key ---------- */
  function flash(t) {
    let n = document.querySelector('.acct-flash');
    if (!n) { n = document.createElement('div'); n.className = 'acct-flash'; n.setAttribute('role', 'status'); document.body.appendChild(n); }
    n.textContent = t; n.hidden = false; clearTimeout(n._t); n._t = setTimeout(() => { n.hidden = true; }, 4000);
  }

  async function exportAll() {
    const rows = await rpc('desk_dump', {});
    const collections = {};
    for (const r of rows) (collections[r.col] || (collections[r.col] = {}))[r.id] = r.data;
    const out = { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), count: rows.length, collections };
    const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dc-bill-desk-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    flash('ดาวน์โหลดไฟล์สำรองแล้ว (' + rows.length + ' รายการ)');
  }

  function parseBackup(obj) {
    if (!obj || obj.format !== BACKUP_FORMAT || typeof obj.collections !== 'object') throw new Error('ไม่ใช่ไฟล์สำรองของ DC Bill Desk');
    const rows = [];
    for (const [col, docs] of Object.entries(obj.collections)) {
      if (!/^[A-Za-z0-9_-]+$/.test(col) || typeof docs !== 'object') throw new Error('collection ไม่ถูกต้อง: ' + col);
      for (const [id, data] of Object.entries(docs)) {
        if (!id || id.includes('/') || typeof data !== 'object' || data === null) throw new Error('เอกสารไม่ถูกต้อง: ' + col + '/' + id);
        rows.push({ col, id, data });
      }
    }
    return rows;
  }

  async function importRows(rows) {
    for (let i = 0; i < rows.length; i += 200) await rpc('desk_import', { p_rows: rows.slice(i, i + 200) });
    await syncAll();
  }

  function restoreDialog(file) {
    const wrap = document.createElement('div');
    wrap.className = 'auth';
    wrap.innerHTML = `<div class="auth-card"><h2>กู้ข้อมูลจากไฟล์</h2><p class="auth-sub"></p>
      <p class="auth-msg"></p><div class="auth-row"><button class="btn" data-x="no">ยกเลิก</button>
      <button class="btn primary" data-x="yes" disabled>นำเข้า</button></div></div>`;
    document.body.appendChild(wrap);
    const sub = wrap.querySelector('.auth-sub'), msg = wrap.querySelector('.auth-msg'), yes = wrap.querySelector('[data-x=yes]');
    sub.textContent = file.name;
    let rows = null;
    file.text().then((t) => {
      rows = parseBackup(JSON.parse(t));
      const by = {}; for (const r of rows) by[r.col] = (by[r.col] || 0) + 1;
      msg.textContent = 'พบ ' + rows.length + ' รายการ — ' + Object.entries(by).map(([c, n]) => c + ' ' + n).join(', ') +
        '. รายการที่ id ซ้ำจะถูกเขียนทับ รายการอื่นที่มีอยู่แล้วไม่ถูกลบ';
      yes.disabled = false;
    }).catch((e) => { msg.textContent = 'อ่านไฟล์ไม่ได้: ' + (e.message || e); });
    wrap.addEventListener('click', async (e) => {
      const x = e.target.dataset && e.target.dataset.x; if (!x) return;
      if (x === 'no') { wrap.remove(); return; }
      yes.disabled = true; msg.textContent = 'กำลังนำเข้า…';
      try { await importRows(rows); wrap.remove(); flash('นำเข้าแล้ว ' + rows.length + ' รายการ'); }
      catch (err) { msg.textContent = 'นำเข้าไม่สำเร็จ: ' + (err.message || err.code); yes.disabled = false; }
    });
  }

  function mountMenu() {
    const host = document.querySelector('header.top'); if (!host) return;
    const d = document.createElement('details');
    d.className = 'acct';
    d.innerHTML = `<summary class="btn ghost" aria-label="ข้อมูลและการตั้งค่า">⋯</summary>
      <div class="acct-menu" role="menu">
        <button class="btn" data-a="export" role="menuitem">สำรองข้อมูล (JSON)</button>
        <label class="btn" role="menuitem">กู้ข้อมูลจากไฟล์…<input type="file" accept="application/json,.json" hidden></label>
        <button class="btn" data-a="forget" role="menuitem">ลืมคีย์ในเครื่องนี้</button>
      </div>`;
    host.appendChild(d);
    d.addEventListener('click', (e) => {
      const a = e.target.dataset && e.target.dataset.a; if (!a) return;
      d.open = false;
      if (a === 'export') exportAll().catch((err) => flash('สำรองไม่สำเร็จ: ' + (err.message || err.code)));
      if (a === 'forget') { lsSet(null); location.reload(); }
    });
    d.querySelector('input[type=file]').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0]; e.target.value = ''; d.open = false;
      if (f) restoreDialog(f);
    });
  }

  window.DCStore = {
    async connect() {
      if (!window.supabase || !CFG.supabaseUrl || !CFG.supabaseKey) throw new Error('Supabase config missing');
      sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const fromLink = keyFromHash();
      let k = fromLink || lsGet(), note = '';
      if (k && !(await valid(k))) { k = null; note = fromLink ? 'ลิงก์นี้ใช้ไม่ได้แล้ว' : 'คีย์ในเครื่องนี้ใช้ไม่ได้แล้ว'; }
      if (!k) k = await keyScreen(note);
      key = k; lsSet(k);
      mountMenu();
      return db;
    },
  };
})();
