// End-to-end test against a running server:  node test/test.mjs http://127.0.0.1:8787
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const GameNet = require("../client/net.js");
const S = process.argv[2] || "http://127.0.0.1:8787";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + m); };
const waitFor = (room, ev, ms = 3000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout " + ev)), ms); room.on(ev, (...a) => { clearTimeout(t); res(a); }); });

const game = "test" + Date.now() % 100000;
// 1) create + join
const a = await GameNet.join({ server: S, game, name: "Billi", data: { skin: 1 }, max: 3, public: true, label: "غرفة بيلي" });
ok(a.id && a.code.length === 5 && a.isHost, `A created room ${a.code}, is host`);
const bJoin = waitFor(a, "join");
const b = await GameNet.join({ server: S, game, code: a.code, name: "Katara" });
const [pj] = await bJoin;
ok(pj.name === "Katara" && b.players.size === 2 && !b.isHost, "B joined, A saw join, B not host");

// 2) messages
let got = waitFor(b, "msg"); a.send({ x: 5, y: 7 }); let [d, from] = await got;
ok(d.x === 5 && from === a.id, "broadcast message A→B");
got = waitFor(a, "msg"); b.send({ hit: 10 }, a.id); [d, from] = await got;
ok(d.hit === 10 && from === b.id, "direct message B→A");

// 3) shared state
got = waitFor(b, "state"); a.setState({ round: 2, map: "forest" }); await got;
ok(b.state.round === 2 && b.state.map === "forest", "state patch reaches B");
got = waitFor(a, "state"); b.setState({ map: null }); await got;
ok(!("map" in a.state) && a.state.round === 2, "null deletes a state key");

// 4) player data
got = waitFor(a, "player"); b.setMe({ team: "red" }); await got;
ok(a.players.get(b.id).d.team === "red", "player data update");

// 5) lobby + quick match
await sleep(300);
const list = await GameNet.list(S, game);
ok(list.length === 1 && list[0].players === 2 && list[0].label === "غرفة بيلي", `lobby lists the public room (${JSON.stringify(list[0])})`);
const c = await GameNet.quick({ server: S, game, name: "Son", max: 3 });
ok(c.code === a.code && c.players.size === 3, "quick match put C in the same room");

// 6) full room
try { await GameNet.join({ server: S, game, code: a.code, name: "Extra" }); ok(false, "4th player should be refused"); }
catch (e) { ok(e.code === "full", "room full refused (max 3)"); }

// 7) ping
await sleep(500); ok(a.ping >= 0 && a.ping < 1000, `ping measured: ${a.ping} ms`);

// 8) host leaves → new host
const hostB = waitFor(b, "host"); const leftB = waitFor(b, "leave");
a.leave(); const [nh] = await hostB; const [lid] = await leftB;
ok(lid === a.id && nh === b.id && b.isHost, "A left → B is the new host (oldest player)");

// 9) reconnect keeps the same id
const cid = c.id; const leaveSeen = waitFor(b, "leave"); c.sock.close(); await leaveSeen;
const back = await waitFor(c, "status", 6000).then(() => waitFor(c, "welcome", 8000));
ok(c.id === cid && back[0].back === true, "C dropped and came back with the same id");

// 10) host-only actions
got = waitFor(c, "error"); c.config({ locked: true }); const [er] = await got;
ok(er.code === "host", "non-host can't change room config");
got = waitFor(c, "room"); b.config({ locked: true, label: "مقفلة" }); await got;
ok(c.info.locked === true && c.info.label === "مقفلة", "host locked the room");
try { await GameNet.join({ server: S, game, code: a.code, name: "Late" }); ok(false, "locked room should refuse"); }
catch (e) { ok(e.code === "locked", "locked room refuses newcomers"); }
const kicked = waitFor(c, "status"); b.kick(c.id); const [st] = await kicked;
ok(st === "closed" && b.players.size === 1, "host kicked C");

// 11) bad input
try { await GameNet.join({ server: S, game: "bad game!", code: "AAAA", name: "x" }); ok(false, "bad game name accepted"); }
catch { ok(true, "bad game name refused"); }

b.leave();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
