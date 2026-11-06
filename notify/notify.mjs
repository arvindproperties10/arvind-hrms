// Srigandha Properties HRMS — notification job (runs every 10 minutes on GitHub Actions).
//  • approvers: a new leave / permission request is waiting
//  • employees: their request was approved or rejected
//  • employees: not checked in by 10:00 on a working day (once a day)
//  • employees: 8 hours done — remember to check out (once a day)
//  • employees: no check-out yesterday — ask for a forgot check-out (once per day missed)
// Needs the FIREBASE_SA secret (the Firebase service-account key, as JSON). Without it the job does nothing.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const SA = process.env.FIREBASE_SA;
if (!SA) { console.log("FIREBASE_SA secret is not set yet — nothing to do."); process.exit(0); }
initializeApp({ credential: cert(JSON.parse(SA)) });
const db = getFirestore(), fcm = getMessaging();
const DRY = process.env.DRY_RUN === "1";
const APP_URL = "https://arvindproperties10.github.io/arvind-hrms/";

// ---- time in India ----
const IST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function ist(t = new Date()) { const o = {}; IST.formatToParts(t).forEach(p => o[p.type] = p.value); return { date: `${o.year}-${o.month}-${o.day}`, mins: (+o.hour % 24) * 60 + +o.minute }; }
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = d => new Date(d + "T12:00:00Z").getUTCDay();   // 0 Sun … 2 Tue
const hm12 = m => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${m < 720 ? "AM" : "PM"}`;
const toDate = v => v?.toDate ? v.toDate() : new Date(v);
const WEEKLY_OFF = 2, FLEX_FROM = 9 * 60 + 30, GRACE = 10 * 60 + 15, HOURS = 8 * 60;
const reqOut = inM => Math.min(Math.max(inM, FLEX_FROM), GRACE) + HOURS;
const PERM_NAME = { late: "late arrival", early: "early leave", in: "forgot check-in", out: "forgot check-out", back: "backdated check-in" };

// ---- test mode (run by hand with a login's id): one test message to that login's phones, nothing else ----
if (process.env.TEST_TO) {
  const t = await db.collection("pushTokens").where("uid", "==", process.env.TEST_TO).get();
  const tokens = t.docs.map(d => d.id);
  if (!tokens.length) { console.log("test: this login has no phone with notifications turned on"); process.exit(0); }
  const r = await fcm.sendEachForMulticast({ tokens, data: { title: "Test: notifications are working ✅", body: "This is a test from Srigandha Properties HRMS. Reminders and approvals will arrive like this.", tag: "test", url: APP_URL }, webpush: { headers: { Urgency: "high", TTL: "3600" } } });
  r.responses.forEach((x, i) => { if (!x.success) console.log("test: phone", i + 1, "failed:", x.error?.code || "unknown"); });
  console.log(`test: sent to ${tokens.length} phone(s) · ${r.successCount} delivered · ${r.failureCount} failed`);
  process.exit(0);
}

const now = ist(process.env.TEST_NOW ? new Date(process.env.TEST_NOW) : new Date()), today = now.date;   // TEST_NOW is only for testing

// ---- what has already been sent (one small document) ----
const stateRef = db.doc("meta/notify");
const stateSnap = await stateRef.get();
const firstRun = !stateSnap.exists;
const sent = stateSnap.exists ? (stateSnap.data().sent || {}) : {};
const cutoff = addDays(today, -4);
for (const [k, v] of Object.entries(sent)) if (v < cutoff) delete sent[k];   // forget old keys
const was = k => !!sent[k], mark = k => { sent[k] = today; };

// ---- people and their phones (loaded only when something needs sending) ----
let USERS = null, TOKENS = null;
async function people() {
  if (USERS) return;
  const [u, t] = await Promise.all([db.collection("users").get(), db.collection("pushTokens").get()]);
  USERS = u.docs.map(d => ({ uid: d.id, ...d.data() })).filter(x => x.active !== false);
  TOKENS = {}; t.docs.forEach(d => { const uid = d.data().uid; (TOKENS[uid] = TOKENS[uid] || []).push(d.id); });
}
const approvers = () => USERS.filter(u => u.role === "owner" || u.approveLeave === true);
const usersOfEmp = empId => USERS.filter(u => u.empId === empId);
const outbox = [];   // {uids, title, body, tag, url}
const queue = (us, title, body, tag, url = APP_URL) => { const uids = [...new Set(us.map(u => u.uid))]; if (uids.length) outbox.push({ uids, title, body, tag, url }); };

// ---- 1. new requests → approvers ;  2. decisions → the employee ----
const [pendL, pendP, decL, decP] = await Promise.all([
  db.collection("leaves").where("status", "==", "pending").get(),
  db.collection("perms").where("status", "==", "pending").get(),
  db.collection("leaves").where("decidedOn", ">=", addDays(today, -1)).get(),
  db.collection("perms").where("decidedOn", ">=", addDays(today, -1)).get()
]);
const fresh = [];
for (const d of pendL.docs) { const k = `rq_l_${d.id}`; if (!was(k)) fresh.push({ k, kind: "leave", ...d.data() }); }
for (const d of pendP.docs) { const k = `rq_p_${d.id}`; if (!was(k)) fresh.push({ k, kind: "perm", ...d.data() }); }
const decided = [];
for (const d of decL.docs) { const x = d.data(); const k = `dc_l_${d.id}_${x.status}`; if ((x.status === "approved" || x.status === "rejected") && !was(k)) decided.push({ k, kind: "leave", ...x }); }
for (const d of decP.docs) { const x = d.data(); const k = `dc_p_${d.id}_${x.status}`; if (x.type !== "forgive" && (x.status === "approved" || x.status === "rejected") && !was(k)) decided.push({ k, kind: "perm", ...x }); }

if (firstRun) {   // first run: don't announce everything that's already waiting
  fresh.forEach(x => mark(x.k)); decided.forEach(x => mark(x.k)); fresh.length = 0; decided.length = 0;
}

let EMPS = null;
async function emps() { if (!EMPS) { const s = await db.collection("employees").get(); EMPS = {}; s.docs.forEach(d => EMPS[d.id] = d.data()); } return EMPS; }
const empName = (E, id, fallback) => (E[id]?.name || fallback || "An employee");

if (fresh.length || decided.length) {
  await people(); const E = await emps();
  for (const x of fresh) {
    const who = empName(E, x.empId, x.name);
    const what = x.kind === "leave" ? `${x.type === "CO" ? "comp off" : "leave"} for ${x.days || 1} day${(x.days || 1) === 1 ? "" : "s"} from ${x.from}` : `${PERM_NAME[x.type] || "permission"} on ${x.date}`;
    const toWhom = E[x.empId]?.test ? USERS.filter(u => u.role === "owner") : approvers();   // test accounts: only the owner hears about them
    queue(toWhom, `New request from ${who}`, `${who} asked for ${what}. Tap to review.`, x.k, APP_URL + "#leave");
    mark(x.k);
  }
  for (const x of decided) {
    const what = x.kind === "leave" ? (x.type === "CO" ? "comp off" : "leave") + ` from ${x.from}` : `${PERM_NAME[x.type] || "permission"} on ${x.date}`;
    queue(usersOfEmp(x.empId), `Request ${x.status}`, `Your ${what} was ${x.status}${x.decidedBy ? ` by ${x.decidedBy}` : ""}.`, x.k, APP_URL + "#myleave");
    mark(x.k);
  }
}

// ---- 3–5. reminders (working hours only) ----
if (now.mins >= 9 * 60 && now.mins < 23 * 60) {
  const hol = new Set((await db.collection("holidays").get()).docs.map(d => d.data().date).filter(Boolean));
  const isOff = d => dow(d) === WEEKLY_OFF || hol.has(d);
  const yday = (() => { let d = addDays(today, -1); for (let i = 0; i < 7 && isOff(d); i++) d = addDays(d, -1); return d; })();
  const ciSnap = await db.collection("checkins").where("date", ">=", yday).get();
  const ci = {}; ciSnap.docs.forEach(d => ci[d.id] = d.data());
  const E = await emps(); await people();
  const active = Object.entries(E).filter(([, e]) => (e.status || "Active") !== "Exited" && (!e.joined || e.joined <= today));
  const leaves = (await db.collection("leaves").where("to", ">=", yday).get()).docs.map(d => d.data()).filter(l => l.status === "approved");
  const onLeave = (id, d) => leaves.some(l => l.empId === id && l.from <= d && l.to >= d);
  const permsY = (await db.collection("perms").where("date", "==", yday).get()).docs.map(d => d.data());

  for (const [id, e] of active) {
    const us = usersOfEmp(id); if (!us.length) continue;
    const c = ci[`${today}_${id}`];
    // 3. not checked in by 10:00 on a working day (until noon)
    if (!isOff(today) && !c && !onLeave(id, today) && now.mins >= 600 && now.mins < 720) {
      const k = `ci_${today}_${id}`;
      if (!was(k)) { queue(us, "You haven't checked in yet", `Good morning ${(e.name || "").split(" ")[0]} — tap to check in. Late after 10:15 AM.`, k, APP_URL + "#checkin"); mark(k); }
    }
    // 4. 8 hours done, still checked in
    if (c?.in?.t && !c.out) {
      const inM = ist(toDate(c.in.t)).mins, due = reqOut(inM);
      const k = `co_${today}_${id}`;
      if (now.mins >= due && now.mins < 23 * 60 && !was(k)) { queue(us, "Your 8 hours are done", `You checked in at ${hm12(inM)}. Remember to check out.`, k, APP_URL + "#checkin"); mark(k); }
    }
    // 5. no check-out on the last working day (sent from 9 AM)
    const y = ci[`${yday}_${id}`];
    if (y?.in?.t && !y.out && !permsY.some(p => p.empId === id && p.type === "out" && p.status !== "rejected")) {
      const k = `nco_${yday}_${id}`;
      if (!was(k)) { queue(us, "No check-out yesterday", `You didn't check out on ${yday}, so it counts as a half day. Ask for a forgot check-out within 2 days.`, k, APP_URL + "#myleave"); mark(k); }
    }
  }
}

// ---- welcome: confirms to each newly connected phone that notifications work ----
{
  await people();
  for (const [uid, toks] of Object.entries(TOKENS)) for (const t of toks) {
    const k = `wl_${t.slice(-24)}`; if (was(k)) continue; mark(k);
    if (firstRun) continue;
    outbox.push({ uids: [uid], only: t, title: "Notifications are on ✅", body: "You'll get reminders and updates from Srigandha Properties HRMS here.", tag: "welcome", url: APP_URL });
  }
}

// ---- send ----
let ok = 0, bad = 0; const dead = new Set();
if (outbox.length) await people();
for (const m of outbox) {
  const tokens = m.only ? [m.only] : m.uids.flatMap(uid => TOKENS[uid] || []);
  if (!tokens.length) continue;
  if (DRY) { console.log("[dry run]", m.title, "→", tokens.length, "phone(s)"); continue; }
  const r = await fcm.sendEachForMulticast({ tokens, data: { title: m.title, body: m.body, tag: m.tag, url: m.url }, webpush: { headers: { Urgency: "high", TTL: "21600" } } });
  r.responses.forEach((x, i) => { if (x.success) ok++; else { bad++; const c = x.error?.code || ""; if (/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(c)) dead.add(tokens[i]); } });
}
for (const t of dead) await db.doc("pushTokens/" + t).delete().catch(() => {});
await stateRef.set({ sent, lastRun: FieldValue.serverTimestamp(), lastIST: `${today} ${hm12(now.mins)}` });
await people();
{ const withPh = USERS.filter(u => (TOKENS[u.uid] || []).length), emp = withPh.filter(u => u.empId).length;   // counts only: this log is public
  const orphan = Object.keys(TOKENS).filter(uid => !USERS.some(u => u.uid === uid)).length;
  console.log(`phones registered: ${Object.values(TOKENS).flat().length} · logins with a phone: ${withPh.length} (${emp} linked to an employee) of ${USERS.length}${orphan ? ` · ${orphan} phone(s) on logins that are off or missing` : ""}`); }
console.log(`${today} ${hm12(now.mins)} · ${outbox.length} message(s) · ${ok} delivered · ${bad} failed · ${dead.size} old phone(s) removed${firstRun ? " · first run (existing requests skipped)" : ""}`);
