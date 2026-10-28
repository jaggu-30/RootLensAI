# RootLens AI — Phase 1 backend

A local-only simulated banking API. All fault scenarios are predefined in `banking/views.py`; no real bank, internet, or database outage is triggered.

## Run on Windows PowerShell
```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python manage.py makemigrations banking
python manage.py migrate
python manage.py seed_demo
python manage.py runserver
```

Demo logins:
- Admin: `admin` / `RootLensAdmin123!`
- User: `demo_user` / `DemoUser123!`
- Receiver: `demo_user2` / `DemoUser123!`

API is at `http://127.0.0.1:8000/api/`. This is a demo, not a real banking system. Keep it local; do not use real money or deploy with demo credentials.
