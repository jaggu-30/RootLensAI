# PayNova + RootLens AI — Local Hackathon Demo

PayNova is the user-facing demo payment app. RootLens AI is the separate admin incident monitoring and investigation workspace. All money and faults are simulated locally; no bank, real account, or external fault injection is used.

## Requirements
- Python 3.10+
- Node.js 20+

## 1. Start Django (PowerShell)
Open PowerShell in this folder, then run:

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python manage.py migrate
python manage.py seed_demo
python manage.py runserver
```

Keep the backend terminal open at http://127.0.0.1:8000/.

## 2. Start React (second PowerShell terminal)
From the project root:

```powershell
cd frontend
npm install
npm run dev
```

Open the Vite URL, usually http://127.0.0.1:5173/.

If npm reports that the esbuild install script needs approval, run `npm install-scripts approve esbuild` and then `npm run dev`.

## Demo accounts
- Admin: `admin` / `RootLensAdmin123!`
- User: `demo_user` / `DemoUser123!`
- Receiver: `demo_user2` / `DemoUser123!`
- Other 18 members: `member03` through `member20`, password `DemoUser123!`

The seed command creates 20 demo users plus one admin. Phone numbers are generated in the demo format and shown in the recipient picker/admin account list.

## Expected flow
1. Sign in as a PayNova demo user and send a payment to any listed member.
2. The backend randomly selects either a normal transfer or a predefined simulated fault. The user cannot choose the fault.
3. A faulted payment enters a pending state, creates an incident, and is automatically recovered after about 3 seconds when the admin incident feed is polling (well within the 10-second demo target). The receiver is credited once during recovery.
4. Sign in as `admin` in a separate browser profile/incognito window. The admin sees incident warnings, all demo accounts, and the incident center.
5. When a recovered incident is detected, the floating prompt asks whether the admin wants to know why. Investigate opens the corresponding RootLens AI evidence view.
6. Review the saved evidence and hypothesis, apply/verify the fix conceptually, and retain the report for recurrence comparison.

## Predefined faults
Delayed receiver credit, stale balance display, network timeout, database connection failure, duplicate request, payment service interruption, confirmation queue backlog, and bad configuration. These are scenario labels/evidence emitted by our own backend code, not actual crashes or external network failures.

## Notes
- This is a local demo prototype, not a real banking app.
- Automatic recovery is performed by the demo incident feed after a short delay. Keep the admin page open while testing so it polls the incident endpoint.
- An initial banking migration is included, so `migrate` creates the account, transfer, and incident tables without needing to generate migrations manually. Run the frontend build and Django checks locally after dependency installation; dependencies are not vendored in this archive.
- Change the seeded demo passwords and development secret before any deployment; do not expose this debug server to the public internet.
