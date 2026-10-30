# mood-ring: Daily Health Check-in

A private daily mental and physical health log that runs entirely on GitHub, with no server or computer that needs to stay on.

- **The app** is a home-screen web app hosted on GitHub Pages, with a check-in form and a dashboard.
- **Reminders** come from a scheduled GitHub Action that sends a normal iPhone notification at 9:00 PM, plus a nudge at 10:30 PM if you haven't checked in yet.
- **Your data** is encrypted on your device with your passphrase (AES-256-GCM, PBKDF2-SHA256 with 600k iterations) and saved to `data/log.enc.json`. This repo is public, but it only ever holds ciphertext.

## What's public and what isn't

| Public | Private |
|---|---|
| The code, the question list in `config.json` | Every answer and note, which are encrypted |
| Which days you checked in (commit messages "Check-in for YYYY-MM-DD") | Your passphrase, which is never stored or uploaded |
| Your devices' push endpoints (useless without the private key) | The `VAPID_PRIVATE_KEY` repo secret |

**If you lose the passphrase, the data can't be recovered.** Keep it in a password manager.

## Setup

1. **Settings → Pages**: set Source to *Deploy from a branch*, Branch to `main` and `/ (root)`.
2. Open `https://inyourfacer.github.io/mood-ring/setup.html` on a computer and follow steps 1–3 (token, passphrase, notification keys).
3. On the iPhone, open `https://inyourfacer.github.io/mood-ring/` in Safari, tap **Share → Add to Home Screen**, open it from the Home Screen, then go to **⚙ Setup** and do steps 1, 2 and 4.
4. Test it: **Actions → Daily reminder → Run workflow**.

## Changing things

- **Questions**: edit `config.json`. Types are `scale`, `number`, `tags`, `yesno` and `text`. Keep each `id` the same once it has data. Add `"lower_is_better": true` for measures like stress.
- **Reminder times**: change `reminders` in `config.json` *and* the matching cron lines in `.github/workflows/remind.yml`. Each time needs two UTC lines, one for daylight saving and one for standard time.
- **Timing**: GitHub often starts scheduled jobs 5–30 minutes late.
