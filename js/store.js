/* DC Bill Desk — data layer on Supabase.
 *
 * Mimics the small Firestore-style API the app used on claude.ai
 * (window.claude.use('db')), so the app code stays unchanged:
 *   db.doc('col/id').set(data) | .update(patch) | .delete()
 *   db.collection('col').onSnapshot(cb, onError)  -> cb({docs:[{id, data()}]})
 *
 * Storage: one table public.docs(col, id, data jsonb). See supabase/schema.sql.
 * Also owns the login screen and the backup / restore (JSON) menu.
 */
(function () {
  'use strict';
  const CFG = window.DC_CONFIG || {};
  const TABLE = 'docs';
  const BACKUP_FORMAT = 'dc-bill-desk-backup';

  let sb = null;
  const cache = {};      // col -> Map(id -> data)
  const listeners = {};  // col -> Set({cb, err})
  let channel = null;
  let subscribedOnce = false;

  const errOf = (e) => ({ code: (e && (e.code || e.status)) || 'error', message: (e && e.message) || String(e) });
  const clone = (x) => JSON.parse(JSON.stringify(x ?? {}));

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
    const m = new Map(); const step = 1000;
    for (let from = 0; ; from += step) {
      const { data, error } = await sb.from(TABLE).select('id,data').eq('col', col).range(from, from + step - 1);
      if (error) throw errOf(error);
      for (const r of data) m.set(r.id, r.data || {});
      if (data.length < step) break;
    }
    cache[col] = m;
    emit(col);
  }

  function refetchAll() {
    for (const col of Object.keys(listeners)) fetchCol(col).catch((e) => fail(col, e));
  }
  function fail(col, e) { for (const l of listeners[col] || []) if (l.err) l.err(errOf(e)); }

  function ensureChannel() {
    if (channel) return;
    channel = sb.channel('docs-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, (p) => {
        const row = p.eventType === 'DELETE' ? p.old : p.new;
        if (!row || !row.col || !listeners[row.col]) return;
        const m = cache[row.col] || (cache[row.col] = new Map());
        if (p.eventType === 'DELETE') m.delete(row.id); else m.set(row.id, row.data || {});
        emit(row.col);
      })
      .subscribe((status) => {
        // reconnected: resync so changes made while offline aren't missed
        if (status === 'SUBSCRIBED') { if (subscribedOnce) refetchAll(); subscribedOnce = true; }
      });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refetchAll(); });
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
          const { error } = await sb.from(TABLE).upsert({ col, id, data: d });
          if (error) { await fetchCol(col).catch(() => {}); throw errOf(error); }
        },
        async update(patch) {
          const p = clone(patch);
          localPut(col, id, Object.assign(clone(cache[col] && cache[col].get(id)), p));
          const { error } = await sb.rpc('doc_merge', { p_col: col, p_id: id, p_patch: p });
          if (error) { await fetchCol(col).catch(() => {}); throw errOf(error); }
        },
        async delete() {
          localDel(col, id);
          const { error } = await sb.from(TABLE).delete().eq('col', col).eq('id', id);
          if (error) { await fetchCol(col).catch(() => {}); throw errOf(error); }
        },
      };
    },
    collection(col) {
      return {
        onSnapshot(cb, err) {
          const l = { cb, err };
          (listeners[col] || (listeners[col] = new Set())).add(l);
          ensureChannel();
          fetchCol(col).catch((e) => err && err(errOf(e)));
          return () => listeners[col].delete(l);
        },
      };
    },
  };

  /* ---------- login ---------- */
  function loginScreen() {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'auth';
      el.innerHTML = `
        <form class="auth-card" autocomplete="on">
          <h2>DC Bill Desk</h2>
          <p class="auth-sub">เข้าสู่ระบบเพื่อดูและอัปเดตงาน</p>
          <label>อีเมล<input type="email" name="email" autocomplete="username" required></label>
          <label>รหัสผ่าน<input type="password" name="password" autocomplete="current-password" required></label>
          <button class="btn primary" type="submit">เข้าสู่ระบบ</button>
          <p class="auth-msg" role="status"></p>
        </form>`;
      document.body.appendChild(el);
      const f = el.querySelector('form'), msg = el.querySelector('.auth-msg');
      f.email.focus();
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        msg.textContent = 'กำลังเข้าสู่ระบบ…';
        const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
        if (error) { msg.textContent = 'เข้าไม่ได้: ' + (error.message || 'error'); return; }
        el.remove(); resolve(data.session);
      });
    });
  }

  /* ---------- account menu: backup / restore / sign out ---------- */
  function flash(t) {
    let n = document.querySelector('.acct-flash');
    if (!n) { n = document.createElement('div'); n.className = 'acct-flash'; n.setAttribute('role', 'status'); document.body.appendChild(n); }
    n.textContent = t; n.hidden = false; clearTimeout(n._t); n._t = setTimeout(() => { n.hidden = true; }, 4000);
  }

  async function exportAll() {
    const rows = []; const step = 1000;
    for (let from = 0; ; from += step) {
      const { data, error } = await sb.from(TABLE).select('col,id,data').order('col').order('id').range(from, from + step - 1);
      if (error) throw errOf(error);
      rows.push(...data); if (data.length < step) break;
    }
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
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb.from(TABLE).upsert(rows.slice(i, i + 200));
      if (error) throw errOf(error);
    }
    refetchAll();
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

  function mountAccountMenu(session) {
    const host = document.querySelector('header.top'); if (!host) return;
    const d = document.createElement('details');
    d.className = 'acct';
    d.innerHTML = `<summary class="btn ghost" aria-label="บัญชีและข้อมูล">⋯</summary>
      <div class="acct-menu" role="menu">
        <div class="acct-who"></div>
        <button class="btn" data-a="export" role="menuitem">สำรองข้อมูล (JSON)</button>
        <label class="btn" role="menuitem">กู้ข้อมูลจากไฟล์…<input type="file" accept="application/json,.json" hidden></label>
        <button class="btn" data-a="logout" role="menuitem">ออกจากระบบ</button>
      </div>`;
    d.querySelector('.acct-who').textContent = (session.user && session.user.email) || '';
    host.appendChild(d);
    d.addEventListener('click', async (e) => {
      const a = e.target.dataset && e.target.dataset.a; if (!a) return;
      d.open = false;
      if (a === 'export') exportAll().catch((err) => flash('สำรองไม่สำเร็จ: ' + (err.message || err.code)));
      if (a === 'logout') { await sb.auth.signOut(); location.reload(); }
    });
    d.querySelector('input[type=file]').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0]; e.target.value = ''; d.open = false;
      if (f) restoreDialog(f);
    });
  }

  window.DCStore = {
    async connect() {
      if (!window.supabase || !CFG.supabaseUrl || !CFG.supabaseKey) throw new Error('Supabase config missing');
      sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true } });
      let { data: { session } } = await sb.auth.getSession();
      if (!session) session = await loginScreen();
      // signed in but not on the allowlist: RLS would just show an empty app, so say so
      const { data: allowed, error } = await sb.rpc('is_app_user');
      if (error) throw errOf(error);
      if (!allowed) {
        await sb.auth.signOut();
        throw new Error('บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้งาน');
      }
      sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') location.reload(); });
      mountAccountMenu(session);
      return db;
    },
  };
})();
