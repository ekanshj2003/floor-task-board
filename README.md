# Floor Task Board

A phone app for assigning work to Factory, Godown and Office staff, with deadlines, follow-ups and **push notifications on each person's own phone**.

- **New task** → the person gets a notification right away, with the deadline.
- **24 hours before** the deadline → reminder.
- **9 AM on the deadline day** → reminder.
- **1 hour before** → reminder.
- **Deadline passed** → alert to the person *and* to whoever assigned it.
- **Follow-up added / task marked done** → the other person gets notified.

Staff log in with **username + PIN**, **email + password**, or **mobile number + OTP** (optional).

It works on Android (Chrome) and iPhone (Safari, iOS 16.4 or newer, added to the Home Screen). Nothing needs to be published on the Play Store or App Store.

---

## How it fits together

| Part | What it does | Cost |
|---|---|---|
| `docs/` | The app. Hosted on **GitHub Pages**. | Free |
| `supabase/` | Database, logins, and the notification sender. Runs on **Supabase**. | Free plan is enough for a small team |
| `.github/workflows/` | Sends the `supabase/` folder to Supabase automatically. | Free |

---

## Setup (about 30 minutes, once)

### 1. Put the code on GitHub
1. Create a new repository on GitHub, e.g. `floor-task-board`. It can be **private** if you have GitHub Pro; otherwise make it **public** (GitHub Pages on the free plan needs a public repo — no secrets are stored in the code).
2. Upload everything from this zip (keep the folders as they are, including the hidden `.github` folder).

### 2. Create a Supabase project
1. Sign up at **supabase.com** → **New project**.
2. Choose region **Mumbai (ap-south-1)**. Set a **database password** and save it somewhere safe.
3. When it's ready, note down:
   - **Reference ID**: Settings → General (looks like `abcdxyzklmno`)
   - **Project URL** and **anon public key**: Settings → API

### 3. Login settings in Supabase
Authentication → **Sign In / Providers**:
- Turn **off** "Allow new users to sign up" (only your admin can add people).
- Under **Email**, turn **off** "Confirm email".

### 4. Make the notification keys
Open `docs/keys.html` on your computer (double-click it) → **Generate keys**. Keep that page open; you need the three values in the next step.

### 5. Save secrets in GitHub
In your repo: **Settings → Secrets and variables → Actions → New repository secret**. Add these 7:

| Name | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | supabase.com → your avatar → **Access Tokens** → Generate new token |
| `SUPABASE_PROJECT_REF` | the Reference ID from step 2 |
| `SUPABASE_DB_PASSWORD` | the database password from step 2 |
| `VAPID_PUBLIC_KEY` | from keys.html |
| `VAPID_PRIVATE_KEY` | from keys.html |
| `CRON_SECRET` | from keys.html |
| `VAPID_SUBJECT` | `mailto:` plus your email, e.g. `mailto:ekansh@example.com` |

### 6. Deploy the server part
Repo → **Actions** tab → **Deploy Supabase** → **Run workflow**. Wait for the green tick (about 2 minutes).

Then in Supabase → **SQL Editor**, open `supabase/setup_secrets.sql` from this zip, paste it in, replace the two placeholders (your Reference ID and your CRON_SECRET), and press **Run**. This connects the database to the notification sender.

### 7. Point the app at your Supabase
Edit `docs/config.js` on GitHub (pencil icon) and fill in:
- `SUPABASE_URL` – Project URL
- `SUPABASE_ANON_KEY` – anon public key
- `VAPID_PUBLIC_KEY` – from keys.html

Commit the change.

### 8. Turn on GitHub Pages
Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder: **/docs** → Save.
After a minute your app is live at `https://YOUR-GITHUB-NAME.github.io/floor-task-board/`.

### 9. Create your admin login
Supabase → **Authentication → Users → Add user → Create new user**. Enter your email and a password, tick **Auto confirm user**.
**The first account created becomes the admin.**

Open the app link, choose **Email**, and log in.

### 10. Add your team
In the app: **Team** tab → **Add a person**. Give each person a username (e.g. `ramesh`), a 6-digit PIN, their department and role:
- **Staff**: receives tasks, updates status, adds follow-ups.
- **Manager**: also creates, edits, reassigns and deletes tasks.
- **Admin**: also adds and removes people and departments.

Send each person the app link, their username and PIN.

---

## Hierarchy and R/A/C/I

**Reports to.** Every person can have a boss (Team → tap a person → *Reports to*). The **Org chart** tab shows the tree.
- A boss sees all tasks of everyone below them. Admins see everything. Others see only tasks they are part of.
- If a task is late, it **escalates** up the chart from the Responsible person: 4 hours late → their boss, 24 hours → the boss's boss, 48 hours → one more level. Change the timings in `supabase/functions/reminders/index.ts` (`ESCALATE_AFTER_HOURS`).

**R/A/C/I on every task.**

| Role | Who | Gets notified |
|---|---|---|
| **R** Responsible (one) | Does the work | New task + all deadline reminders + overdue |
| **A** Accountable (one) | Owns the result; can mark done | Added + every update + overdue + done |
| **C** Consulted (any number) | Gives input | Added + every update + done |
| **I** Informed (any number) | Kept updated | Added + done |

Staff who are Responsible or Accountable can change the status. Only managers and admins can edit task details.

---

## Installing on staff phones

**Android (Chrome)**
1. Open the app link in Chrome → log in.
2. Tap **Turn on** on the blue banner and allow notifications.
3. Chrome menu (⋮) → **Install app** (or **Add to Home screen**).

**iPhone (Safari, iOS 16.4 or newer)**
1. Open the app link in **Safari** (not Chrome).
2. Tap **Share** → **Add to Home Screen** → Add.
3. Open the app **from the Home Screen icon**, log in, tap **Turn on**, and allow notifications.
   (iPhones only allow notifications for apps opened from the Home Screen.)

Check it works: **Alerts** tab → **Send a test**.

---

## Optional: Mobile number + OTP login
SMS costs money per message, so it's off by default.
1. Supabase → Authentication → Sign In / Providers → **Phone** → enable it and connect an SMS provider (Twilio, MessageBird, Vonage or Textlocal). Indian numbers need DLT registration with the provider.
2. In `docs/config.js` set `ENABLE_MOBILE_OTP: true`.
3. Add each person's mobile number in the Team screen.

---

## Changing things later
- **Reminder times**: `supabase/functions/reminders/index.ts` (`MORNING_HOUR = 9`, 24 h, 1 h). Commit → the Action redeploys.
- **App look and screens**: files in `docs/`. Commit → GitHub Pages updates in a minute.
- **Departments**: Team tab → Departments.

## Troubleshooting
- **No notifications at all** → check step 6 (setup_secrets.sql ran) and that GitHub secrets match keys.html. Supabase → Edge Functions → `notify` → Logs shows errors.
- **"Send a test" says no phone registered** → on that phone, Me → Turn off on this phone, then turn on again.
- **iPhone shows no Turn on button** → the app must be opened from the Home Screen icon, iOS 16.4+.
- **Someone forgot their PIN** → Team → tap their name → enter a new PIN → Save.
- **Locked out after wrong PINs** → wait 15 minutes, or reset the PIN as above.
