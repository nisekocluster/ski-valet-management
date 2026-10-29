/* ==========================================================================
   Ski Valet — client sync layer (shared by index.html and admin.html)

   The apps keep working on an in-memory DB object exactly as before; save()
   now diffs it against the last server state and pushes only what changed to
   PostgreSQL (/api/sync). Other devices' changes arrive by polling.
   Nothing is written to localStorage / sessionStorage.
   ========================================================================== */
"use strict";

/* ---------- API helper ---------- */
async function API(path, body, method){
  const opts = {method: method || (body !== undefined ? "POST" : "GET"), credentials: "same-origin", cache: "no-store", headers: {}};
  if(body !== undefined){ opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  let r;
  try{ r = await fetch(path, opts); }
  catch(e){ const err = new Error("No connection to the server"); err.offline = true; throw err; }
  let data = null; try{ data = await r.json(); }catch(_){}
  if(!r.ok){
    const err = new Error((data && data.error) || ("Server error " + r.status));
    err.status = r.status; err.data = data;
    if(r.status === 401 && SkiSync._opts && SkiSync._opts.onAuthLost) SkiSync._authLost();
    throw err;
  }
  return data;
}

/* ---------- ids: unique across devices without asking the server ---------- */
let _lastId = 0;
function newId(){
  let n = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  if(n <= _lastId) n = _lastId + 1;
  _lastId = n; return n;
}

const SkiSync = (() => {
  const COLS = ["rooms","storages","cards","equipment","users","history","prechecks"];
  const POLL_MS = 5000;
  let S = fresh();
  let LAYOUT = [];                         // default hall layout, sent by the server on a full load
  function fresh(){
    const o = {epoch:null, rev:0, synced:{}, revs:{}, hist:new Set(), inflight:null, dirty:false,
      snap:null, timer:null, retry:0, retryTimer:null, running:false};
    COLS.forEach(c => { o.synced[c] = new Map(); o.revs[c] = new Map(); });
    return o;
  }

  /* stable JSON: sorted keys, null/undefined treated as "absent" */
  function canon(v){
    if(v === null || v === undefined) return "null";
    if(typeof v !== "object") return JSON.stringify(v);
    if(Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    return "{" + Object.keys(v).filter(k => v[k] !== null && v[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  const strip = raw => { const o = Object.assign({}, raw); const rv = o._rev; delete o._rev; return [o, rv]; };
  function replaceIn(target, src){ Object.keys(target).forEach(k => { if(!(k in src)) delete target[k]; }); Object.assign(target, src); }
  const histSort = (a,b) => (b.timestamp||0) - (a.timestamp||0) || (b.id||0) - (a.id||0);

  /* ---------- status pill ---------- */
  let pill = null, pillTimer = null;
  function status(kind, text){
    clearTimeout(pillTimer);
    if(!pill){
      pill = document.createElement("div");
      pill.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(10px + env(safe-area-inset-bottom,0px));" +
        "z-index:9999;padding:6px 14px;border-radius:999px;font:600 12px/1.4 Inter,system-ui,sans-serif;letter-spacing:.3px;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.4);pointer-events:none;transition:opacity .2s";
      document.body.appendChild(pill);
    }
    if(kind === "ok"){ pill.style.opacity = "0"; return; }
    pill.style.opacity = "1";
    pill.style.background = kind === "offline" ? "#FF4D4D" : kind === "saved" ? "#1E5B3A" : "#1D2C3B";
    pill.style.color = kind === "offline" || kind === "saved" ? "#fff" : "#90A4B8";
    pill.textContent = text;
    if(kind === "saved") pillTimer = setTimeout(() => { pill.style.opacity = "0"; }, 1500);   // the server has it
  }

  /* ---------- load ---------- */
  function loadFull(res){
    const keepRunning = S.running, opts = SkiSync._opts;
    S = fresh(); S.running = keepRunning;
    const db = {};
    COLS.forEach(col => {
      db[col] = ((res.changes || {})[col] || []).map(raw => {
        const [o, rv] = strip(raw);
        if(col === "history") S.hist.add(o.id);
        else { S.synced[col].set(o.id, canon(o)); S.revs[col].set(o.id, rv); }
        return o;
      });
    });
    db.history.sort(histSort);
    S.epoch = res.epoch; S.rev = res.rev;
    if(Array.isArray(res.layout)) LAYOUT = res.layout;
    opts.set(db);
  }

  /* ---------- diff local DB vs last server state ---------- */
  function diff(db){
    const ups = {}, dels = {}, sent = {}, sentHist = [];
    const usersAllowed = !!(SkiSync._opts.canWriteUsers && SkiSync._opts.canWriteUsers());
    let n = 0;
    for(const col of COLS){
      const rows = db[col] || [];
      if(col === "history"){
        for(const h of rows) if(h && h.id != null && !S.hist.has(h.id)){ (ups.history = ups.history || []).push(h); sentHist.push(h.id); n++; }
        continue;
      }
      if(col === "users" && !usersAllowed) continue;
      const syn = S.synced[col], seen = new Set(), m = sent[col] = new Map();
      for(const r of rows){
        if(!r || r.id == null || seen.has(r.id)) continue;
        seen.add(r.id);
        const c = canon(r);
        if(syn.get(r.id) !== c){
          const o = Object.assign({}, r);
          if(S.revs[col].has(r.id)) o._rev = S.revs[col].get(r.id);
          (ups[col] = ups[col] || []).push(o); m.set(r.id, c); n++;
        }
      }
      for(const id of syn.keys()) if(!seen.has(id)){
        (dels[col] = dels[col] || []).push({id, _rev: S.revs[col].get(id)}); m.set(id, null); n++;
      }
    }
    return {ups, dels, sent, sentHist, n};
  }

  /* ---------- merge a server response into the local DB ---------- */
  function applyPull(res, sent = {}, sentHist = []){
    if(res.full){ loadFull(res); notify(true); return; }
    const db = SkiSync._opts.get(); if(!db) return;
    let touched = false;
    sentHist.forEach(id => S.hist.add(id));
    for(const col of COLS){
      const rows = (res.changes || {})[col] || [], gone = (res.deleted || {})[col] || [];
      if(!rows.length && !gone.length) continue;
      const list = db[col] = db[col] || [];
      if(col === "history"){
        const have = new Set(list.map(h => h.id));
        rows.forEach(raw => { const [o] = strip(raw); S.hist.add(o.id); if(!have.has(o.id)){ list.push(o); touched = true; } });
        list.sort(histSort);
        continue;
      }
      const syn = S.synced[col], revs = S.revs[col], sm = sent[col];
      const idx = new Map(list.map((r, i) => [r && r.id, i]));
      const localCanon = id => idx.has(id) ? canon(list[idx.get(id)]) : undefined;
      const sentCanon = id => sm && sm.has(id) ? (sm.get(id) === null ? undefined : sm.get(id)) : "\u0000none";
      for(const raw of rows){
        const [o, rv] = strip(raw), id = o.id, lc = localCanon(id), sc = sentCanon(id);
        const clean = lc === syn.get(id) || lc === sc;
        if(clean){
          if(idx.has(id)) replaceIn(list[idx.get(id)], o); else { list.push(o); idx.set(id, list.length - 1); }
          syn.set(id, canon(o)); revs.set(id, rv); touched = true;
        } else if(sm && sm.has(id)){       // changed again after it was sent: keep local, move the base forward
          syn.set(id, canon(o)); revs.set(id, rv); S.dirty = true;
        } else S.dirty = true;             // edited here AND on another device: next push reports the conflict
      }
      if(gone.length){
        const drop = new Set();
        for(const id of gone){
          const lc = localCanon(id), sc = sentCanon(id);
          if(lc === undefined || lc === syn.get(id) || lc === sc){ drop.add(id); syn.delete(id); revs.delete(id); }
          else S.dirty = true;
        }
        if(drop.size){ db[col] = list.filter(r => !drop.has(r && r.id)); touched = true; }
      }
    }
    // anything we deleted that the server had already removed
    for(const col in sent) for(const [id, c] of sent[col]) if(c === null && !(db[col]||[]).some(r => r && r.id === id)){ S.synced[col].delete(id); S.revs[col].delete(id); }
    S.rev = Math.max(S.rev, res.rev || 0); S.epoch = res.epoch;
    if(touched) notify(false);
  }

  function notify(full){ const f = SkiSync._opts.onRemote; if(f) f(full); }

  /* ---------- push ---------- */
  async function flush(){
    if(!S.running) return;
    if(S.inflight){ S.dirty = true; return; }
    if(S.needReload || (!S.dirty && !S.snap)) return;
    S.dirty = false;
    const db = SkiSync._opts.get(); if(!db) return;
    const d = diff(db);
    const snap = S.snap; S.snap = null;
    if(!d.n){ return; }
    const body = {since: S.rev, epoch: S.epoch, upserts: d.ups, deletes: d.dels};
    if(snap) body.snapshot = snap;
    status("saving", "Saving…");
    S.inflight = (async () => {
      let again = 0;
      try{
        const res = await API("/api/sync", body);
        applyPull(res, d.sent, d.sentHist);
        S.retry = 0; status(S.dirty ? "saving" : "saved", S.dirty ? "Saving…" : "Saved ✓");
      }catch(e){
        if(e.status === 409){
          const msg = e.data && e.data.reason === "conflict" ? "Another device changed the same record at the same time. The latest data is loaded — please check and repeat the action."
            : e.data && e.data.reason === "epoch" ? "The data was restored or replaced from the admin console. The latest data is loaded."
            : (e.message || "The change was rejected") + " — the latest data is loaded.";
          await safeReload(); status("ok");
          const f = SkiSync._opts.onConflict; if(f) f(msg);
        } else if(e.status === 401){ /* handled by onAuthLost */ }
        else if(e.status === 400 || e.status === 403){
          await safeReload(); status("ok");
          const f = SkiSync._opts.onConflict; if(f) f(e.message);
        } else {
          S.dirty = true; if(snap && !S.snap) S.snap = snap;
          S.retry = Math.min(S.retry + 1, 6); again = 1000 * Math.min(30, 2 ** S.retry);
          status("offline", "Not saved yet — retrying. The changes are kept on this screen");
        }
      }finally{
        S.inflight = null;
        if(S.running && S.dirty){ clearTimeout(S.retryTimer); S.retryTimer = setTimeout(flush, again || 0); }
      }
    })();
    return S.inflight;
  }

  async function reload(){
    const res = await API("/api/sync?since=0");
    loadFull(res); notify(true);
  }

  /* after a rejected push the local copy must be replaced; if that fails, retry on the next poll */
  async function safeReload(){ try{ await reload(); }catch(_){ S.needReload = true; S.dirty = false; } }

  async function poll(){
    if(!S.running || S.inflight || document.hidden) return;
    if(S.needReload){ try{ await reload(); S.needReload = false; status("ok"); }catch(_){} return; }
    if(S.dirty){ flush(); return; }
    try{
      const res = await API(`/api/sync?since=${S.rev}&epoch=${encodeURIComponent(S.epoch)}`);
      if(S.inflight || S.dirty) return;              // a local change started meanwhile; next round
      applyPull(res);
      if(S.retry){ S.retry = 0; status("ok"); }
    }catch(e){ if(e.offline){ S.retry = 1; status("offline", "Offline — trying to reconnect"); } }
  }

  document.addEventListener("visibilitychange", () => { if(!document.hidden) poll(); });
  window.addEventListener("online", () => { if(S.dirty) flush(); else poll(); });
  window.addEventListener("beforeunload", e => { if(S.running && (S.dirty || S.inflight)){ e.preventDefault(); e.returnValue = ""; } });

  return {
    _opts: null,
    /* opts: {get, set, onRemote(full), onAuthLost(), onConflict(msg), canWriteUsers()} */
    init(opts){ this._opts = opts; },
    async start(){
      S.running = true;
      await reload();
      clearInterval(S.timer); S.timer = setInterval(poll, POLL_MS);
    },
    stop(){ clearInterval(S.timer); clearTimeout(S.retryTimer); S = fresh(); status("ok"); },
    /* save(): push local changes. snapshotLabel (admin): server snapshots the state before them */
    save(snapshotLabel){ if(snapshotLabel && !S.snap) S.snap = snapshotLabel; S.dirty = true; return flush(); },
    reload,
    refresh(){ return poll(); },
    /* default locations that are not in the hall yet */
    missingLayout(db){
      const norm = v => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const have = new Set(((db && db.storages) || []).map(s => norm(s.storage_number)));
      return LAYOUT.filter(r => !have.has(norm(r.storage_number)));
    },
    /* admin: create the missing default locations on the server */
    async loadLayout(){
      if(S.dirty || S.inflight) await flush();
      const r = await API("/api/admin/load-layout", {});
      await poll();
      return r.created;
    },
    pending(){ return S.dirty || !!S.inflight; },
    _authLost(){ const f = this._opts.onAuthLost; this.stop(); if(f) f(); }
  };
})();
