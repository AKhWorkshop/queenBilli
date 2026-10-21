// Accounts + saves test:  node test/accounts.mjs http://127.0.0.1:8787
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const GameNet = require("../client/net.js");
const S = process.argv[2] || "http://127.0.0.1:8787";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + m); };
const status = async (p) => { try { await p; return 200; } catch (e) { return e.status || -1; } };

// 1) a new account on "device A"
const A = await GameNet.account(S);
ok(/^a[a-z0-9]{15}$/.test(A.id), `account created: ${A.id}`);
await A.setName("Billi");
let info = await A.info();
ok(info.name === "Billi" && info.devices === 1, "name saved, 1 device");

// 2) save and load
ok((await A.load("billi")) === null, "no save yet → null");
const s1 = await A.save("billi", { level: 3, hp: 150, items: ["knife"] });
ok(s1.v === 1, "first save is version 1");
const back = await A.load("billi");
ok(back.level === 3 && back.items[0] === "knife", "load returns what was saved");
await A.save("racing", { best: 61.2 });
info = await A.info();
ok(Object.keys(info.games).sort().join() === "billi,racing" && info.games.billi.v === 1, "each game has its own save");

// 3) version check (two devices editing at once)
await A.load("billi");                                   // knows v1
await A.save("billi", { level: 4 });                     // v2
A._ver.billi = 1;                                        // pretend this device is behind
ok(await status(A.save("billi", { level: 9 }, { force: false })) === 409, "stale save refused with 409 when force:false");
ok((await A.load("billi")).level === 4, "save not overwritten by the stale one");

// 4) size limit
ok(await status(A.save("big", { blob: "x".repeat(300 * 1024) })) === 413, "save over 256 KB refused");

// 5) transfer to "device B"
const { code, expires } = await A.transferCode();
ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code) && expires > Date.now(), `transfer code ${code}`);
const B = await GameNet.claim(S, code.toLowerCase().replace("-", " "));
ok(B.id === A.id, "device B now has the same account");
ok((await B.load("billi")).level === 4, "device B sees the saves");
ok(await status(GameNet.claim(S, code)) === 404, "a code works only once");
info = await B.info(); ok(info.devices === 2, "account has 2 devices");

// 6) a new code replaces the old one
const c1 = (await A.transferCode()).code, c2 = (await A.transferCode()).code;
ok(await status(GameNet.claim(S, c1)) === 404, "older code stops working when a new one is made");
const C = await GameNet.claim(S, c2); ok(C.id === A.id, "newest code works");

// 7) sign out other devices
await B.signOutOthers();
ok(await status(A.info()) === 401 && await status(C.info()) === 401, "other devices signed out");
ok((await B.info()).devices === 1, "this device still signed in");

// 8) bad tokens and guessing
ok(await status(fetch(S + "/save/billi").then(r => { if (!r.ok) throw { status: r.status }; })) === 401, "no token → 401");
let last = 0;
for (let i = 0; i < 12; i++) last = await status(GameNet.claim(S, "ZZZZ-ZZZZ"));
ok(last === 429, "too many wrong codes → 429 (wait an hour)");

// 9) delete a save
await B.remove("racing"); info = await B.info();
ok(!("racing" in info.games) && (await B.load("racing")) === null, "save deleted");

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
