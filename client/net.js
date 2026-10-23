/* =====================================================================
   net.js — client for the game-rooms server (any game, any engine)

   <script src="net.js"></script>            → window.GameNet
   or:  import GameNet from "./net.js"        (also works as an ES module)

   const room = await GameNet.join({
     server: "https://game-rooms.YOURNAME.workers.dev",
     game:   "billi",          // one name per game
     code:   "ABCD5",          // leave out to create a new room
     name:   "Billi",
     data:   { skin: 2 },      // your own player data (small)
     max: 4, public: true,     // only used by whoever creates the room
   });

   room.on("join",   p => ...)           // someone joined        p = {id, name, d}
   room.on("leave",  id => ...)          // someone left
   room.on("msg",    (d, from) => ...)   // a game message
   room.on("state",  (patch, by) => ...) // shared room state changed (room.state is already updated)
   room.on("player", p => ...)           // someone changed their data
   room.on("host",   id => ...)          // a new host
   room.on("status", s => ...)           // "online" | "reconnecting" | "closed"

   room.send({ x, y })                   // to everyone else (fast, not saved)
   room.send({ hit: 10 }, playerId)      // to one player
   room.setState({ round: 2 })           // shared + saved in the room; null deletes a key
   room.setMe({ skin: 3 })               // change my own data
   room.id, room.code, room.players (Map), room.state, room.isHost, room.ping (ms)

   ---- saves (no password; the account lives on this device) ----
   const acc  = await GameNet.account(SERVER);        // makes one the first time
   await acc.save("billi", { level: 3, hp: 150 });    // cloud save for that game
   const data = await acc.load("billi");              // null if nothing saved yet
   const { code } = await acc.transferCode();         // "K7F2-9QXM", one use, 24 h
   await GameNet.claim(SERVER, "K7F2-9QXM");          // on the other device
   ===================================================================== */
(function (root, factory) {
  const lib = factory();
  if (typeof module === "object" && module.exports) module.exports = lib;
  if (root) root.GameNet = lib;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const http = s => s.replace(/\/+$/, "");
  const ws = s => http(s).replace(/^http/, "ws");
  const getJSON = async url => { const r = await fetch(url); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; };

  class Room {
    constructor(opts) {
      this.opts = opts; this.handlers = {}; this.players = new Map(); this.state = {};
      this.id = null; this.code = opts.code; this.host = null; this.info = null;
      this.ping = 0; this.clockOffset = 0; this.token = ""; this.status = "connecting";
      this._retry = 0; this._closedByUser = false;
    }
    on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
    off(ev, fn) { this.handlers[ev] = (this.handlers[ev] || []).filter(f => f !== fn); return this; }
    emit(ev, ...a) { for (const f of this.handlers[ev] || []) { try { f(...a); } catch (e) { console.error(e); } } }
    get isHost() { return this.id && this.id === this.host; }
    get me() { return this.players.get(this.id); }
    serverTime() { return Date.now() + this.clockOffset; }

    _url() {
      const o = this.opts, q = new URLSearchParams({ name: o.name || "Player" });
      if (o.data != null) q.set("data", JSON.stringify(o.data));
      if (o.max) q.set("max", o.max); if (o.public) q.set("public", "1");
      if (o.label) q.set("label", o.label); if (o.stateBy) q.set("stateBy", o.stateBy); if (o.exist && !this.id) q.set("exist", "1");
      if (this.token) q.set("token", this.token);
      return `${ws(o.server)}/room/${encodeURIComponent(o.game)}/${this.code}?${q}`;
    }
    _connect() {
      return new Promise((resolve, reject) => {
        const sock = new WebSocket(this._url()); this.sock = sock; let welcomed = false;
        const timer = setTimeout(() => { if (!welcomed) { try { sock.close(); } catch {} reject(new Error("connection timed out")); } }, 10000);
        sock.onerror = () => { if (!welcomed) { clearTimeout(timer); reject(new Error("could not connect")); } };
        sock.onmessage = e => {
          let m; try { m = JSON.parse(e.data); } catch { return; }
          if (m.t === "welcome") {
            welcomed = true; clearTimeout(timer); this._retry = 0; this.id = m.id; this.token = m.token; this.host = m.host; this.info = m.room;
            this.state = m.state || {}; this.players = new Map(m.players.map(p => [p.id, p]));
            this.clockOffset = m.now - Date.now(); this._setStatus("online"); this._startPing();
            this.emit("welcome", m); resolve(this);
          } else this._handle(m);
          if (m.t === "error" && !welcomed) reject(Object.assign(new Error(m.m), { code: m.code }));
        };
        sock.onclose = ev => {
          clearInterval(this._pingTimer);
          if (!welcomed) { reject(new Error("could not connect")); return; }   // _reconnect() retries on its own
          if (this._closedByUser || ev.code === 4002 || ev.code === 4001) { this._setStatus("closed"); return; }
          this._reconnect();
        };
      });
    }
    _reconnect() {
      if (this._closedByUser) return;
      if (this._retry > 8) { this._setStatus("closed"); return; }
      this._setStatus("reconnecting");
      const wait = Math.min(8000, 500 * 2 ** this._retry++);
      setTimeout(() => this._connect().catch(() => this._reconnect()), wait);
    }
    _setStatus(s) { if (this.status !== s) { this.status = s; this.emit("status", s); } }
    _startPing() {
      clearInterval(this._pingTimer);
      const tick = () => this._raw({ t: "ping", c: performance.now() });
      tick(); this._pingTimer = setInterval(tick, 4000);
    }
    _handle(m) {
      switch (m.t) {
        case "pong": { const rtt = performance.now() - m.c; this.ping = Math.round(this.ping ? this.ping * .7 + rtt * .3 : rtt); this.clockOffset = m.s + rtt / 2 - Date.now(); return this.emit("ping", this.ping); }
        case "msg": return this.emit("msg", m.d, m.from);
        case "join": this.players.set(m.p.id, m.p); return this.emit("join", m.p, m.back);
        case "leave": { const p = this.players.get(m.id); this.players.delete(m.id); return this.emit("leave", m.id, p, m.kicked); }
        case "player": this.players.set(m.p.id, m.p); return this.emit("player", m.p);
        case "state": this._merge(m.d); return this.emit("state", m.d, m.by);
        case "host": this.host = m.id; return this.emit("host", m.id);
        case "room": this.info = m.room; return this.emit("room", m.room);
        case "error": return this.emit("error", m);
      }
    }
    _merge(d) { for (const [k, v] of Object.entries(d || {})) { if (v === null) delete this.state[k]; else this.state[k] = v; } }
    _raw(obj) { if (this.sock && this.sock.readyState === 1) { this.sock.send(JSON.stringify(obj)); return true; } return false; }

    send(d, to) { return this._raw(to ? { t: "msg", d, to } : { t: "msg", d }); }
    setState(patch) { this._merge(patch); return this._raw({ t: "state", d: patch }); }
    setMe(d, name) { const p = this.me; if (p) { p.d = d; if (name) p.name = name; } return this._raw({ t: "me", d, name }); }
    kick(id) { return this._raw({ t: "kick", id }); }
    giveHost(id) { return this._raw({ t: "host", id }); }
    config(c) { return this._raw({ t: "config", d: c }); }   // host: {public, locked, max, stateBy, label}
    leave() { this._closedByUser = true; clearInterval(this._pingTimer); try { this.sock.close(1000); } catch {} this._setStatus("closed"); }
  }

  /* ----------------------------------------------------------- accounts */
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const keyFor = server => "gamenet-account:" + http(server);
  async function call(server, path, { method = "GET", body, auth } = {}) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) headers.authorization = "Bearer " + auth.id + "." + auth.token;
    const r = await fetch(http(server) + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || "HTTP " + r.status), { status: r.status, info: j });
    return j;
  }
  class Account {
    constructor(server, cred) { this.server = server; this.cred = cred; this.id = cred.id; }
    _c(path, o = {}) { return call(this.server, path, { ...o, auth: this.cred }); }
    /** Account info: {id, name, devices, games: {game: {v, at, size}}} */
    info() { return this._c("/account"); }
    setName(name) { return this._c("/account", { method: "PUT", body: { name } }); }
    /** The saved data for that game, or null. A copy is kept on the device too. */
    async load(game) {
      try { const r = await this._c("/save/" + game); this._ver = { ...this._ver, [game]: r.v }; store.set("gamenet-save:" + game, r); return r.data; }
      catch (e) { if (e.status === 401) throw e; const local = store.get("gamenet-save:" + game); return local ? local.data : null; }
    }
    /** Save data (anything JSON, up to 256 KB). Returns {v, at}. */
    async save(game, data, { force = true } = {}) {
      store.set("gamenet-save:" + game, { data, v: (this._ver && this._ver[game]) || 0, at: Date.now() });
      const body = { data }; if (!force && this._ver && game in this._ver) body.v = this._ver[game];
      const r = await this._c("/save/" + game, { method: "PUT", body });
      this._ver = { ...this._ver, [game]: r.v }; return r;
    }
    get user() { return this.cred.user || ""; }
    get admin() { return !!this.cred.admin; }
    changePassword(old, pass) { return this._c("/auth/password", { method: "POST", body: { old, pass } }); }
    setSite(site) { return this._c("/site", { method: "PUT", body: site }); }
    /** admin: one commit to the game's GitHub repo. files: [{path:"public/...", b64 | text | del:true}] */
    commit(files, message) { return this._c("/admin/commit", { method: "POST", body: { files, message } }); }
    remove(game) { store.del("gamenet-save:" + game); return this._c("/save/" + game, { method: "DELETE" }); }
    /** A one-time code to open this account on another device. {code, expires} */
    transferCode() { return this._c("/transfer", { method: "POST" }); }
    /** Sign out every other device (this one stays). */
    signOutOthers() { return this._c("/account/reset", { method: "POST" }); }
    /** Forget the account on this device (it still exists on the server). */
    forget() { store.del(keyFor(this.server)); }
  }

  const GameNet = {
    version: "2.0.0",
    /** Sign in with a name and password (2.0). The account is remembered on this device. */
    async login(server, user, pass) { const cred = await call(server, "/auth/login", { method: "POST", body: { user, pass } }); store.set(keyFor(server), cred); return new Account(server, cred); },
    async register(server, user, pass) { const cred = await call(server, "/auth/register", { method: "POST", body: { user, pass } }); store.set(keyFor(server), cred); return new Account(server, cred); },
    /** The signed-in account on this device, or null (never makes a new one). */
    signedIn(server) { const cred = store.get(keyFor(server)); return cred && cred.user ? new Account(server, cred) : null; },
    signOut(server) { store.del(keyFor(server)); },
    site(server) { return call(server, "/site"); },
    /** This device's account on that server; created the first time. */
    async account(server) {
      let cred = store.get(keyFor(server));
      if (cred) {
        const acc = new Account(server, cred);
        try { await acc.info(); return acc; }
        catch (e) { if (e.status !== 401) return acc; }   // offline: keep it; 401: make a new one
      }
      cred = await call(server, "/account", { method: "POST" });
      store.set(keyFor(server), cred);
      return new Account(server, cred);
    },
    /** Move the account from a transfer code onto this device. */
    async claim(server, code) {
      const cred = await call(server, "/transfer/claim", { method: "POST", body: { code } });
      store.set(keyFor(server), cred);
      return new Account(server, cred);
    },
    /** Join a room. Without `code` a new room is created. */
    async join(opts) {
      if (!opts.server || !opts.game) throw new Error("server and game are required");
      if (!/^[a-z0-9_-]{1,32}$/i.test(opts.game)) throw new Error("game name: letters, numbers, - and _ only (max 32)");
      const code = (opts.code || (await GameNet.newCode(opts.server, opts.game))).toUpperCase();
      return new Room({ ...opts, code, exist: !!opts.code && !opts.create })._connect();   // a typed code must name a room that is already open
    },
    /** Join any public room with space, or open a new public one. */
    async quick(opts) {
      const { code } = await getJSON(`${http(opts.server)}/quick/${encodeURIComponent(opts.game)}?max=${opts.max || 8}`);
      return GameNet.join({ ...opts, code, public: true, create: true });
    },
    async newCode(server, game) { return (await getJSON(`${http(server)}/new/${encodeURIComponent(game)}`)).code; },
    async list(server, game) { return (await getJSON(`${http(server)}/lobby/${encodeURIComponent(game)}`)).rooms; },
  };
  return GameNet;
});
