// Firebase connection for Arvind Properties HRMS.
// Exposes window.FB with a small database adapter that keeps the same shape the app already uses
// (db.collection(path).doc(id).set/update/get/onSnapshot, db.doc(path), where/orderBy/limit).
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword,
  updatePassword, EmailAuthProvider, reauthenticateWithCredential, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  onSnapshot, query, where, orderBy, limit, serverTimestamp, writeBatch, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDe3dfNIMxB57rTaoXtemxyX045ENMBmew",
  authDomain: "arvind-hrms.firebaseapp.com",
  projectId: "arvind-hrms",
  storageBucket: "arvind-hrms.firebasestorage.app",
  messagingSenderId: "855247025014",
  appId: "1:855247025014:web:9984634398d19775220057"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const fs = initializeFirestore(app, { ignoreUndefinedProperties: true });
setPersistence(auth, browserLocalPersistence).catch(() => {});

// Logins use an Employee ID or a short user ID; Firebase needs an email, so short IDs map to this domain.
const LOGIN_DOMAIN = "hrms.arvindproperties.local";
const loginEmail = id => id.includes("@") ? id.trim().toLowerCase() : `${id.trim().toLowerCase()}@${LOGIN_DOMAIN}`;

// ---- value conversion: Firestore timestamps become ISO strings for the app ----
function conv(v) {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(conv);
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = conv(x); return o; }
  return v;
}
const SENTINEL = "__server_time__";
// Replace the app's "server time" marker with Firestore's server timestamp
function prep(v) {
  if (v === SENTINEL) return serverTimestamp();
  if (Array.isArray(v)) return v.map(prep);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = prep(x); return o; }
  return v;
}
// update() in the app merges nested objects; Firestore needs dotted field paths for that.
function flat(obj, pre = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const p = pre ? `${pre}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).length && v !== SENTINEL) flat(v, p, out);
    else out[p] = prep(v);
  }
  return out;
}
function mapErr(e) {
  const c = e && e.code;
  if (c === "permission-denied") return Object.assign(new Error(e.message), { code: "invalid_argument", fb: c });
  if (c === "not-found") return Object.assign(new Error(e.message), { code: "invalid_argument", fb: c, notFound: true });
  if (c === "resource-exhausted") return Object.assign(new Error(e.message), { code: "quota_exceeded", fb: c });
  return Object.assign(new Error(e && e.message || String(e)), { code: c || "unknown", fb: c });
}
const wrapSnapDoc = s => ({ id: s.id, exists: s.exists(), data: () => conv(s.data()) });
const wrapSnapQ = s => ({ docs: s.docs.map(wrapSnapDoc), size: s.size });
const split = p => p.split("/").filter(Boolean);

function docRef(ref) {
  return {
    id: ref.id, path: ref.path,
    get: () => getDoc(ref).then(wrapSnapDoc, e => { throw mapErr(e); }),
    set: d => setDoc(ref, prep(d)).catch(e => { throw mapErr(e); }),
    update: d => updateDoc(ref, flat(d)).catch(e => { throw mapErr(e); }),
    delete: () => deleteDoc(ref).catch(e => { throw mapErr(e); }),
    onSnapshot: (cb, err) => onSnapshot(ref, s => cb(wrapSnapDoc(s)), e => err && err(mapErr(e))),
    collection: p => colRef(collection(ref, ...split(p)))
  };
}
function qRef(q) {
  return {
    where: (f, op, v) => qRef(query(q, where(f, op === "==" ? "==" : op, v))),
    orderBy: (f, dir) => qRef(query(q, orderBy(f, dir))),
    limit: n => qRef(query(q, limit(n))),
    get: () => getDocs(q).then(wrapSnapQ, e => { throw mapErr(e); }),
    onSnapshot: (cb, err) => onSnapshot(q, s => cb(wrapSnapQ(s)), e => err && err(mapErr(e)))
  };
}
function colRef(c) {
  const w = qRef(c); w.path = c.path;
  w.doc = id => docRef(id === undefined ? doc(c) : doc(c, id));
  w.add = d => addDoc(c, prep(d)).then(r => docRef(r), e => { throw mapErr(e); });
  return w;
}
const db = {
  doc: p => docRef(doc(fs, ...split(p))),
  collection: p => colRef(collection(fs, ...split(p))),
  // atomic multi-document write: ops = [{op:"set"|"update"|"delete", path, data}]
  batch: async ops => {
    for (let i = 0; i < ops.length; i += 400) {
      const b = writeBatch(fs);
      for (const o of ops.slice(i, i + 400)) {
        const r = doc(fs, ...split(o.path));
        if (o.op === "set") b.set(r, prep(o.data)); else if (o.op === "update") b.update(r, flat(o.data)); else b.delete(r);
      }
      await b.commit().catch(e => { throw mapErr(e); });
    }
  },
  SERVER_TIME: SENTINEL
};

// Create a login without signing the current person out (uses a second, temporary connection).
async function createLogin(loginId, password) {
  const tmp = initializeApp(firebaseConfig, "creator-" + Date.now());
  try {
    const a2 = getAuth(tmp);
    const email = loginEmail(loginId);
    const cred = await createUserWithEmailAndPassword(a2, email, password);
    await signOut(a2);
    return { uid: cred.user.uid, email };
  } finally { await deleteApp(tmp).catch(() => {}); }
}
async function login(id, password) {
  const key = id.trim().toLowerCase();
  let email = loginEmail(key);
  if (!key.includes("@")) {
    for (const k of [key, key.replace(/-/g, "")]) {
      try { const s = await getDoc(doc(fs, "logins", k)); if (s.exists() && s.data().email) { email = s.data().email; break; } } catch (_) {}
    }
  }
  return signInWithEmailAndPassword(auth, email, password);
}
async function signUp(email, password) {
  return createUserWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
}
async function ownerExists() {
  try { const s = await getDoc(doc(fs, "meta", "owner")); return s.exists(); } catch (_) { return true; }
}
async function changePassword(current, next) {
  const u = auth.currentUser; if (!u) throw new Error("Not signed in");
  await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, current));
  await updatePassword(u, next);
}

window.FB = {
  db, auth, loginEmail, createLogin, login, changePassword, signUp, ownerExists,
  logout: () => signOut(auth),
  onAuth: cb => onAuthStateChanged(auth, cb),
  config: firebaseConfig
};
window.dispatchEvent(new Event("fb-ready"));
