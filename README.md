# Arvind Properties HRMS

Attendance with GPS + selfie check-in, leave, payroll, payslips and incentives for Arvind Properties staff.
Runs as a website on GitHub Pages and installs on phones like an app. Data and logins live in Firebase (project `arvind-hrms`).

## Who sees what

| Login | Signs in with | Sees |
|---|---|---|
| Administrator | their email | Everything, including Users & access |
| Staff (HR, CEO…) | a login ID such as `hr.aishwarya` | Only the sections the administrator allows, as view or edit |
| Employee | their Employee ID, e.g. `AP-006` | Check in, own attendance, own leave, own payslips, own incentives |

The server (Firestore rules) enforces these limits, not just the screens.

## Check-in rules

- Places: Head Office (150 m), Site Office (300 m), Home Office (150 m). Anyone can use any of the three.
- Check-in needs location + a selfie; check-out needs location. Time comes from the server, not the phone.
- Shift 10:00 AM – 6:00 PM. In after 10:15 = late. In after 1:00 PM or out before 2:00 PM = half day. Out before 6:00 PM = left early.
- Every 3 late marks in a month = half a day's loss of pay.
- From the "absent marking" start date (Check-ins → Settings), a working day with no check-in, leave or HR mark is Absent.
- A mark set by HR on the Attendance screen overrides the check-in, including any late mark.
- Tuesdays and company holidays are off. Selfies are deleted after 90 days.

## One-time setup

1. **Firestore rules** – Firebase console → Firestore Database → Rules → replace everything with the contents of `firestore.rules` → Publish.
2. **GitHub Pages** – this repository → Settings → Pages → Source: *Deploy from a branch* → Branch `main`, folder `/ (root)` → Save. The site appears at `https://arvindproperties10.github.io/arvind-hrms/` after a minute or two.
3. Open the site → **First time? Set up the administrator account** → enter your name, email and a password. This option disappears once an administrator exists.
4. Users & access → *Bring over data from the old HRMS* → choose `hrms-migration.json` (kept privately, never in this repository).
5. Users & access → add staff logins, then *Create logins for all* employees. A CSV of temporary passwords downloads; hand them out privately. Everyone sets their own password at first sign-in.
6. Run the security self-test: sign in as a test employee and open `…/arvind-hrms/#selftest`. Every line should say **Blocked** (the last three **Allowed**).

## Installing on a phone

- Android (Chrome): open the site → menu ⋮ → **Install app** (or *Add to Home screen*).
- iPhone (Safari): open the site → Share → **Add to Home Screen**.

## Files

- `index.html` – the whole app (screens, rules for attendance, payroll and incentives)
- `fb.js` – Firebase connection and login helpers
- `firestore.rules` – server-side security rules (paste into the Firebase console)
- `manifest.webmanifest`, `sw.js`, `icons/` – install-as-app files
