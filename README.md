# game-rooms — سيرفر أونلاين لكل ألعابك

سيرفر غرف واحد على Cloudflare (مجاني)، وكل لعبة تسويها تتصل فيه باسمها الخاص.
الغرف بكود، والمضيف يتنقل لحاله لو طلع، واللاعب اللي ينقطع نته يرجع لنفس مكانه خلال 30 ثانية.

```
game-rooms/
  src/index.js      السيرفر (لا تحتاج تعدّل فيه)
  client/net.js     المكتبة اللي تحطها في أي لعبة
  demo/index.html   ساحة تجربة: تمشي مع أصحابك وتتكلمون
  test/test.mjs     اختبار الغرف
  test/accounts.mjs اختبار الحفظ وكود النقل
  wrangler.toml     إعدادات Cloudflare
```

## ١. رفع السيرفر (مرة وحدة بس)
1. سوّ حساب مجاني في https://dash.cloudflare.com
2. نزّل **Node.js** من https://nodejs.org (نسخة LTS) وثبته
3. افتح المجلد `game-rooms` في الـ Terminal (في ويندوز: كليك يمين داخل المجلد ← **Open in Terminal**)
4. اكتب الأوامر هذي بالترتيب:
   ```
   npm install
   npx wrangler login
   npx wrangler deploy
   ```
   - `login` يفتح لك المتصفح، وافق.
   - `deploy` يطلع لك في الآخر رابط مثل:
     `https://game-rooms.اسمك.workers.dev`  ← **هذا رابط سيرفرك، احفظه**

جرّب الرابط في المتصفح، المفروض يطلع: `{"ok":true,"service":"game-rooms"...}`

## ٢. جرّبه مع أصحابك
ارفع مجلد `demo` لحاله على GitHub Pages (أو أي استضافة)، وافتح `index.html`.
اضغط **إعدادات السيرفر** وحط رابط سيرفرك واضغط **فحص**، وبعدها **غرفة جديدة**، وأرسل **نسخ الرابط** لأصحابك.
بدون رابط سيرفر، الصفحة تشتغل بـ **وضع التجربة** مع لاعبين وهميين.

## ٣. استخدامه في أي لعبة
```html
<script src="net.js"></script>
<script>
const SERVER = "https://game-rooms.اسمك.workers.dev";

// غرفة جديدة (أو حط code للانضمام لغرفة موجودة)
const room = await GameNet.join({ server: SERVER, game: "billi", name: "بيلي", max: 4, public: true });
console.log("كود الغرفة:", room.code);

// أرسل حركتك 15 مرة بالثانية
setInterval(() => room.send({ x: me.x, y: me.y, anim: me.anim }), 66);

// استقبل حركة الباقين
room.on("msg", (d, from) => moveOtherPlayer(from, d));
room.on("join", p => addPlayer(p));         // p = {id, name, d}
room.on("leave", id => removePlayer(id));

// أشياء مشتركة تنحفظ في الغرفة (الجولة، الخريطة، النتيجة)
room.setState({ round: 1, map: "forest" });
room.on("state", () => updateScore(room.state));

// لو المضيف هو اللي يقرر (مثلاً يبدأ الجولة)
if (room.isHost) room.setState({ started: true });
</script>
```

| الدالة | وش تسوي |
|---|---|
| `GameNet.join({server, game, code?, name, data?, max?, public?})` | تدخل غرفة، أو تسوي وحدة جديدة لو ما حطيت `code` |
| `GameNet.quick({server, game, name, max})` | تدخلك أي غرفة عامة فيها مكان |
| `GameNet.list(server, game)` | الغرف العامة للعبة |
| `room.send(data, to?)` | رسالة سريعة لكل اللاعبين، أو للاعب واحد |
| `room.setState(patch)` | تغيير مشترك ينحفظ في الغرفة (`null` يحذف) |
| `room.setMe(data)` | تغيّر بياناتك (سكن، فريق، جاهز…) |
| `room.kick(id)` / `room.config({locked, public, max})` | للمضيف بس |
| `room.players` / `room.state` / `room.isHost` / `room.ping` | الحالة الحالية |

**قاعدة مهمة:** الحركة والضربات بـ `send` (سريعة وما تنحفظ).
والأشياء اللي تتغير قليل بـ `setState` (كل تغيير يحسب كتابة، والمجاني 100 ألف كتابة باليوم).

## ٤. حفظ اللعبة في السيرفر (بدون باسوورد)
أول مرة يفتح اللاعب لعبتك ينسوى له حساب لحاله، ومفتاحه يتخزن في جهازه.
لو بغى يكمل من جهاز ثاني، يطلع **كود نقل** (مثل `K7F2-9QXM`) ويكتبه في الجهاز الثاني.
الكود يشتغل مرة وحدة بس، ولمدة 24 ساعة.

```js
const acc = await GameNet.account(SERVER);          // حساب هذا الجهاز (ينسوى أول مرة)

await acc.save("billi", { level: 3, hp: 150, items: ["knife"] });   // حفظ
const save = await acc.load("billi");               // تحميل (null لو ما فيه حفظ)

// نقل لجهاز ثاني
const { code } = await acc.transferCode();          // في الجهاز القديم
const acc2 = await GameNet.claim(SERVER, code);     // في الجهاز الجديد
```

| الدالة | وش تسوي |
|---|---|
| `GameNet.account(server)` | حساب هذا الجهاز، ينسوى أول مرة |
| `acc.save(game, data)` / `acc.load(game)` | حفظ وتحميل، كل لعبة لها حفظها (حد أقصى 256 كيلوبايت) |
| `acc.remove(game)` | يحذف حفظ لعبة |
| `acc.setName(name)` / `acc.info()` | الاسم، والألعاب المحفوظة وعدد الأجهزة |
| `acc.transferCode()` | كود نقل لجهاز ثاني (الكود الجديد يلغي القديم) |
| `GameNet.claim(server, code)` | يفتح الحساب في هذا الجهاز |
| `acc.signOutOthers()` | يطلّع كل الأجهزة الثانية (لو أحد أخذ الكود بالغلط) |

- لو النت مقطوع، `load` يرجع آخر نسخة محفوظة في الجهاز.
- لو أحد جرب أكواد غلط 10 مرات بالساعة، ينقفل عليه لين تخلص الساعة.
- لو اللاعب مسح بيانات المتصفح بدون ما يسوي كود نقل، يروح الحساب. نبّهه في لعبتك.
- السيرفر يحفظ بس ما يتحقق من القيم. يعني لاعب شاطر يقدر يغيّر حفظه (مستوى، فلوس…). عادي في لعبة بين أصحاب.

## الحدود المجانية (Cloudflare)
- 100 ألف طلب باليوم، وكل 20 رسالة تنحسب طلب واحد ≈ مليوني رسالة باليوم
- لو خلصت، السيرفر يوقف لين اليوم الثاني (الساعة 3 الفجر بتوقيت السعودية)، وما ينسحب منك شي
- لو كبرت: خطة Workers المدفوعة 5 دولار بالشهر

## حماية
في `wrangler.toml` غيّر `ALLOWED_ORIGINS` لروابط مواقعك بس، عشان ما أحد يستخدم سيرفرك من موقع ثاني:
```
ALLOWED_ORIGINS = "https://اسمك.github.io"
```
وبعدها `npx wrangler deploy` مرة ثانية.

## تشغيله على جهازك للتجربة
```
npx wrangler dev
```
السيرفر يشتغل على `http://127.0.0.1:8787`، والاختبار: `node test/test.mjs` و `node test/accounts.mjs`
