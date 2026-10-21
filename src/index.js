// =====================================================================
//  game-rooms: one multiplayer server for all your browser games
//  Cloudflare Worker + Durable Objects (works on the free plan)
//
//  Routes
//    GET  /                      health check
//    GET  /new/:game             a fresh room code
//    GET  /quick/:game?max=8     code of a public room with space (or a new one)
//    GET  /lobby/:game           public rooms of that game
//    WS   /room/:game/:code      join a room (query: name, data, max, public, label, token)
//
//  Accounts and saves (no password: each device gets a secret token;
//  a one-time transfer code moves the account to another device)
//    POST   /account               create an account → {id, token}
//    GET    /account               my account: name, games with saves      (auth)
//    PUT    /account               {name}                                   (auth)
//    POST   /account/reset         sign out every other device              (auth)
//    GET    /save/:game            my save for that game                    (auth)
//    PUT    /save/:game            {data, v?}  v = expected version          (auth)
//    DELETE /save/:game                                                      (auth)
//    POST   /transfer              a one-time code, valid 24 h              (auth)
//    POST   /transfer/claim        {code} → {id, token} on this device
//  auth = header  Authorization: Bearer <id>.<token>
// =====================================================================
import { DurableObject } from "cloudflare:workers";

const VERSION = "1.1.0";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O/1/I
const LIMITS = {
  messageBytes: 16 * 1024,      // biggest single message
  playerData: 1000,             // JSON chars of each player's own data
  stateBytes: 64 * 1024,        // whole shared room state
  perSecond: 120,               // messages per player per second
  maxPlayers: 64,
  reconnectMs: 30_000,          // a dropped player can come back as the same player
  emptyRoomMs: 5 * 60_000,      // an empty room is wiped after this
  saveBytes: 256 * 1024,        // one game's save
  devices: 10,                  // signed-in devices per account
  transferMs: 24 * 3600_000,    // a transfer code lives this long
  claimTries: 10,               // wrong transfer codes per IP per hour
};

const newCode = (n = 5) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => CODE_CHARS[b % CODE_CHARS.length]).join("");
const randId = (p, n = 8) => p + Array.from(crypto.getRandomValues(new Uint8Array(n)), b => (b % 36).toString(36)).join("");
const cleanName = s => String(s ?? "").replace(/[^\p{L}\p{N}_\- .]/gu, "").trim().slice(0, 24) || "Player";
const validGame = g => /^[a-z0-9_-]{1,32}$/i.test(g);
const validCode = c => /^[A-Z0-9]{3,12}$/.test(c);

function cors(env, req) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());
  const origin = req.headers.get("Origin") || "";
  const ok = allowed.includes("*") || allowed.includes(origin);
  return { ok, headers: { "Access-Control-Allow-Origin": allowed.includes("*") ? "*" : (ok ? origin : "null"),
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "content-type,authorization", "Vary": "Origin" } };
}
const json = (data, headers, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

// --------------------------------------------------------------------- Worker
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { ok, headers } = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { headers });
    if (!ok) return json({ error: "origin not allowed" }, headers, 403);

    const [route, game, codeRaw] = url.pathname.split("/").filter(Boolean);
    if (!route) return json({ ok: true, service: "game-rooms", version: VERSION }, headers);
    if (route === "account" || route === "save" || route === "transfer") {
      try { return await accountRoutes(req, env, url, route, game, headers); }
      catch (e) { return json({ error: e.message || "server error" }, headers, e.status || 500); }
    }
    if (!validGame(game || "")) return json({ error: "bad game name (letters, numbers, - _ ; max 32)" }, headers, 400);
    const lobby = env.LOBBY.get(env.LOBBY.idFromName(game.toLowerCase()));

    if (route === "new") return json({ code: newCode() }, headers);
    if (route === "lobby") return json({ rooms: await lobby.list() }, headers);
    if (route === "quick") {
      const max = Math.min(LIMITS.maxPlayers, Math.max(2, +url.searchParams.get("max") || 8));
      return json({ code: await lobby.quick(max) || newCode() }, headers);
    }
    if (route === "room") {
      const code = String(codeRaw || "").toUpperCase();
      if (!validCode(code)) return json({ error: "bad room code" }, headers, 400);
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "expected a websocket" }, headers, 426);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(game.toLowerCase() + ":" + code));
      const fwd = new Request(req, { headers: new Headers(req.headers) });
      fwd.headers.set("X-Game", game.toLowerCase()); fwd.headers.set("X-Code", code);
      return stub.fetch(fwd);
    }
    return json({ error: "not found" }, headers, 404);
  },
};

// --------------------------------------------------------------------- Accounts
const B36 = "abcdefghijklmnopqrstuvwxyz0123456789";
const rand36 = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => B36[b % 36]).join("");
const sha = async s => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const accountStub = (env, id) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(id));
const codesStub = env => env.CODES.get(env.CODES.idFromName("codes"));

async function readJSON(req, max) {
  const text = await req.text();
  if (text.length > max) throw fail(413, "too big");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw fail(400, "body is not JSON"); }
}
async function auth(req, env) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer (a[a-z0-9]{15})\.([a-z0-9]{32})$/);
  if (!m) throw fail(401, "not signed in");
  const acc = accountStub(env, m[1]);
  if (!(await acc.check(await sha(m[2])))) throw fail(401, "not signed in");
  return { id: m[1], acc, hash: await sha(m[2]) };
}
async function newDevice(acc, id) {
  const token = rand36(32); await acc.addToken(await sha(token)); return { id, token };
}

async function accountRoutes(req, env, url, route, sub, headers) {
  const M = req.method;
  if (route === "account" && !sub && M === "POST") {
    const id = "a" + rand36(15), acc = accountStub(env, id);
    await acc.create();
    return json(await newDevice(acc, id), headers, 201);
  }
  if (route === "transfer" && sub === "claim" && M === "POST") {
    const { code } = await readJSON(req, 200);
    const clean = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const r = await codesStub(env).claim(clean, req.headers.get("CF-Connecting-IP") || "local");
    if (r.error === "slow") throw fail(429, "too many tries, wait an hour");
    if (r.error) throw fail(404, "wrong or expired code");
    return json(await newDevice(accountStub(env, r.a), r.a), headers);
  }
  const me = await auth(req, env);
  if (route === "account") {
    if (!sub && M === "GET") return json({ id: me.id, ...(await me.acc.info()) }, headers);
    if (!sub && M === "PUT") { const { name } = await readJSON(req, 500); await me.acc.setName(cleanName(name)); return json({ ok: true }, headers); }
    if (sub === "reset" && M === "POST") { await me.acc.reset(me.hash); return json({ ok: true }, headers); }
  }
  if (route === "transfer" && !sub && M === "POST") return json(await codesStub(env).create(me.id), headers);
  if (route === "save") {
    if (!validGame(sub || "")) throw fail(400, "bad game name");
    const game = sub.toLowerCase();
    if (M === "GET") { const s = await me.acc.load(game); return json(s || { data: null, v: 0 }, headers); }
    if (M === "DELETE") { await me.acc.remove(game); return json({ ok: true }, headers); }
    if (M === "PUT") {
      const body = await readJSON(req, LIMITS.saveBytes);
      if (!("data" in body)) throw fail(400, "send {data}");
      const r = await me.acc.save(game, body.data, body.v);
      if (r.conflict) return json({ error: "conflict", v: r.v, at: r.at }, headers, 409);
      return json(r, headers);
    }
  }
  throw fail(404, "not found");
}

// one per account: device tokens (hashed) and one save per game
export class Account extends DurableObject {
  async meta() { return this._m ??= await this.ctx.storage.get("meta"); }
  async create() {
    if (await this.meta()) throw new Error("exists");
    this._m = { created: Date.now(), name: "", tokens: [], games: {} };
    await this.ctx.storage.put("meta", this._m);
  }
  async check(hash) { const m = await this.meta(); return !!m && m.tokens.some(t => t.h === hash); }
  async addToken(hash) {
    const m = await this.meta(); m.tokens.push({ h: hash, at: Date.now() });
    m.tokens = m.tokens.slice(-LIMITS.devices); await this.ctx.storage.put("meta", m);
  }
  async reset(keep) { const m = await this.meta(); m.tokens = m.tokens.filter(t => t.h === keep); await this.ctx.storage.put("meta", m); }
  async info() { const m = await this.meta(); return { created: m.created, name: m.name, devices: m.tokens.length, games: m.games }; }
  async setName(name) { const m = await this.meta(); m.name = name; await this.ctx.storage.put("meta", m); }
  async load(game) { return (await this.ctx.storage.get("save:" + game)) || null; }
  async save(game, data, expect) {
    const cur = await this.load(game), v = cur ? cur.v : 0;
    if (expect != null && expect !== v) return { conflict: true, v, at: cur && cur.at };
    const rec = { data, v: v + 1, at: Date.now() };
    const m = await this.meta(); m.games[game] = { v: rec.v, at: rec.at, size: JSON.stringify(data).length };
    await this.ctx.storage.put({ ["save:" + game]: rec, meta: m });
    return { v: rec.v, at: rec.at };
  }
  async remove(game) { const m = await this.meta(); delete m.games[game]; await this.ctx.storage.delete("save:" + game); await this.ctx.storage.put("meta", m); }
}

// one for everybody: transfer codes and wrong-guess counters
export class Codes extends DurableObject {
  async create(accountId) {
    const old = await this.ctx.storage.get("a:" + accountId);
    if (old) await this.ctx.storage.delete("c:" + old);
    let code; do { code = newCode(8); } while (await this.ctx.storage.get("c:" + code));
    const until = Date.now() + LIMITS.transferMs;
    await this.ctx.storage.put({ ["c:" + code]: { a: accountId, until }, ["a:" + accountId]: code });
    return { code: code.slice(0, 4) + "-" + code.slice(4), expires: until };
  }
  async claim(code, ip) {
    const k = "ip:" + ip, now = Date.now();
    let t = await this.ctx.storage.get(k);
    if (!t || t.until < now) t = { n: 0, until: now + 3600_000 };
    if (t.n >= LIMITS.claimTries) return { error: "slow" };
    const rec = code.length === 8 ? await this.ctx.storage.get("c:" + code) : null;
    if (!rec || rec.until < now) { t.n++; await this.ctx.storage.put(k, t); return { error: "bad" }; }
    await this.ctx.storage.delete(["c:" + code, "a:" + rec.a]);
    return { a: rec.a };
  }
}

// --------------------------------------------------------------------- Room
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rate = new Map();
    ctx.blockConcurrencyWhile(async () => {
      this.meta = (await ctx.storage.get("meta")) || null;
      this.state = (await ctx.storage.get("state")) || {};
    });
  }

  // live players, oldest first (attachments survive hibernation)
  players(except) {
    return this.ctx.getWebSockets()
      .filter(w => w !== except)
      .map(w => ({ ws: w, p: w.deserializeAttachment() }))
      .filter(x => x.p && !x.p.left)
      .sort((a, b) => a.p.t - b.p.t);
  }
  pub(p) { return { id: p.id, name: p.name, d: p.d }; }
  roomInfo() { const m = this.meta; return { game: m.game, code: m.code, max: m.max, public: m.public, locked: m.locked, stateBy: m.stateBy, label: m.label }; }
  send(ws, obj) { try { ws.send(typeof obj === "string" ? obj : JSON.stringify(obj)); } catch {} }
  broadcast(obj, except) { const s = JSON.stringify(obj); for (const { ws } of this.players(except)) this.send(ws, s); }
  async saveMeta() { await this.ctx.storage.put("meta", this.meta); }

  async tellLobby() {
    if (!this.meta) return;
    const list = this.players();
    try {
      const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName(this.meta.game));
      await lobby.update({ code: this.meta.code, label: this.meta.label, players: list.length, max: this.meta.max,
        public: this.meta.public && !this.meta.locked, host: list.find(x => x.p.id === this.meta.host)?.p.name || "" });
    } catch {}
  }

  async fetch(req) {
    const url = new URL(req.url), q = url.searchParams;
    const { 0: client, 1: server } = new WebSocketPair();
    const fail = (code, msg) => { server.accept(); this.send(server, { t: "error", code, m: msg }); server.close(4000, code); return new Response(null, { status: 101, webSocket: client }); };

    if (!this.meta) {
      this.meta = { game: req.headers.get("X-Game"), code: req.headers.get("X-Code"), created: Date.now(), host: null,
        max: Math.min(LIMITS.maxPlayers, Math.max(2, +q.get("max") || 8)), public: q.get("public") === "1",
        locked: false, stateBy: q.get("stateBy") === "host" ? "host" : "any", label: q.get("label") ? cleanName(q.get("label")).slice(0, 32) : "" };
      this.state = {};
      await this.saveMeta();
    }

    let data = null;
    try { const raw = q.get("data"); if (raw) { if (raw.length > LIMITS.playerData) return fail("data", "player data too big"); data = JSON.parse(raw); } }
    catch { return fail("data", "player data is not JSON"); }

    // coming back after a drop?
    const token = q.get("token") || "";
    let ghost = null;
    if (token) {
      ghost = await this.ctx.storage.get("ghost:" + token);
      if (ghost && ghost.until < Date.now()) ghost = null;
      for (const { ws, p } of this.players()) if (p.token === token) { ghost = { id: p.id, name: p.name, d: p.d }; p.left = true; ws.serializeAttachment(p); try { ws.close(4001, "replaced"); } catch {} }
    }
    const live = this.players();
    if (!ghost && this.meta.locked) return fail("locked", "room is locked");
    if (!ghost && live.length >= this.meta.max) return fail("full", "room is full");

    const p = ghost
      ? { id: ghost.id, name: ghost.name, d: data ?? ghost.d, token, t: Date.now() }
      : { id: randId("p", 6), name: cleanName(q.get("name")), d: data, token: randId("k", 16), t: Date.now() };
    if (ghost) await this.ctx.storage.delete("ghost:" + token);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(p);
    await this.ctx.storage.deleteAlarm();

    if (!this.meta.host || !live.some(x => x.p.id === this.meta.host)) { this.meta.host = p.id; await this.saveMeta(); }
    this.send(server, { t: "welcome", id: p.id, token: p.token, host: this.meta.host, room: this.roomInfo(),
      players: [...live.map(x => this.pub(x.p)), this.pub(p)], state: this.state, now: Date.now(), back: !!ghost });
    this.broadcast({ t: "join", p: this.pub(p), back: !!ghost }, server);
    await this.tellLobby();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > LIMITS.messageBytes) return;
    const p = ws.deserializeAttachment(); if (!p || p.left) return;
    // simple per-player rate limit
    const now = Date.now(), r = this.rate.get(p.id) || { s: now, n: 0 };
    if (now - r.s > 1000) { r.s = now; r.n = 0; }
    if (++r.n > LIMITS.perSecond) { this.rate.set(p.id, r); return; }
    this.rate.set(p.id, r);

    let m; try { m = JSON.parse(raw); } catch { return; }
    const isHost = p.id === this.meta.host;
    switch (m.t) {
      case "ping": return this.send(ws, { t: "pong", c: m.c, s: now });
      case "msg": {   // game messages: to everyone, or to one / some players
        const out = JSON.stringify({ t: "msg", from: p.id, d: m.d });
        if (m.to) { const to = new Set([].concat(m.to)); for (const x of this.players()) if (to.has(x.p.id)) this.send(x.ws, out); }
        else for (const x of this.players(ws)) this.send(x.ws, out);
        return;
      }
      case "me": {    // update my own player data (skin, team, ready...)
        const s = JSON.stringify(m.d ?? null); if (s.length > LIMITS.playerData) return this.send(ws, { t: "error", code: "data", m: "player data too big" });
        p.d = m.d ?? null; if (m.name) p.name = cleanName(m.name); ws.serializeAttachment(p);
        return this.broadcast({ t: "player", p: this.pub(p) });
      }
      case "state": { // shared room state: merge keys, null deletes a key
        if (this.meta.stateBy === "host" && !isHost) return this.send(ws, { t: "error", code: "host", m: "only the host can change room state" });
        if (!m.d || typeof m.d !== "object") return;
        const next = { ...this.state };
        for (const [k, v] of Object.entries(m.d)) { if (v === null) delete next[k]; else next[k] = v; }
        if (JSON.stringify(next).length > LIMITS.stateBytes) return this.send(ws, { t: "error", code: "state", m: "room state too big" });
        this.state = next; await this.ctx.storage.put("state", next);
        return this.broadcast({ t: "state", d: m.d, by: p.id }, ws);
      }
      case "kick": case "config": case "host": {
        if (!isHost) return this.send(ws, { t: "error", code: "host", m: "only the host can do that" });
        if (m.t === "kick") {
          for (const x of this.players()) if (x.p.id === m.id && x.p.id !== p.id) { this.send(x.ws, { t: "error", code: "kicked", m: "removed by the host" }); await this.leave(x.ws, true); try { x.ws.close(4002, "kicked"); } catch {} }
          return;
        }
        if (m.t === "host") {
          if (!this.players().some(x => x.p.id === m.id)) return;
          this.meta.host = m.id; await this.saveMeta(); this.broadcast({ t: "host", id: m.id }); return this.tellLobby();
        }
        const c = m.d || {};
        if ("public" in c) this.meta.public = !!c.public;
        if ("locked" in c) this.meta.locked = !!c.locked;
        if ("max" in c) this.meta.max = Math.min(LIMITS.maxPlayers, Math.max(2, +c.max || this.meta.max));
        if ("stateBy" in c) this.meta.stateBy = c.stateBy === "host" ? "host" : "any";
        if ("label" in c) this.meta.label = cleanName(c.label).slice(0, 32);
        await this.saveMeta(); this.broadcast({ t: "room", room: this.roomInfo() }); return this.tellLobby();
      }
    }
  }

  async leave(ws, kicked = false) {
    const p = ws.deserializeAttachment(); if (!p || p.left) return;
    p.left = true; try { ws.serializeAttachment(p); } catch {}
    this.rate.delete(p.id);
    if (!kicked) await this.ctx.storage.put("ghost:" + p.token, { id: p.id, name: p.name, d: p.d, until: Date.now() + LIMITS.reconnectMs });
    this.broadcast({ t: "leave", id: p.id, kicked }, ws);
    const rest = this.players(ws);
    if (this.meta.host === p.id) {
      this.meta.host = rest[0]?.p.id || null; await this.saveMeta();
      if (this.meta.host) this.broadcast({ t: "host", id: this.meta.host }, ws);
    }
    if (!rest.length) await this.ctx.storage.setAlarm(Date.now() + LIMITS.emptyRoomMs);
    await this.tellLobby();
  }
  async webSocketClose(ws, code) { await this.leave(ws); try { ws.close(1000); } catch {} }
  async webSocketError(ws) { await this.leave(ws); }

  async alarm() {   // still empty? forget the room
    if (this.players().length) return;
    const game = this.meta?.game, code = this.meta?.code;
    await this.ctx.storage.deleteAll();
    if (game) { try { await this.env.LOBBY.get(this.env.LOBBY.idFromName(game)).update({ code, players: 0 }); } catch {} }
    this.meta = null; this.state = {};
  }
}

// --------------------------------------------------------------------- Lobby (one per game)
export class Lobby extends DurableObject {
  async rooms() { return this._rooms ??= (await this.ctx.storage.get("rooms")) || {}; }
  async update(info) {
    const rooms = await this.rooms();
    if (!info.players || !info.public) delete rooms[info.code];
    else rooms[info.code] = { ...info, at: Date.now() };
    await this.ctx.storage.put("rooms", rooms);
  }
  async list() {
    const rooms = await this.rooms(), now = Date.now();
    return Object.values(rooms).filter(r => now - r.at < 30 * 60_000).sort((a, b) => b.players - a.players);
  }
  async quick(max) {
    const r = (await this.list()).find(r => r.players < r.max && r.max === max) || (await this.list()).find(r => r.players < r.max);
    return r ? r.code : null;
  }
}
