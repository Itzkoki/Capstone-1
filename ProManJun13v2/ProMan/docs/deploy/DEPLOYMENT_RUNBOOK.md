# ProMan — Deployment Runbook (AWS VPS)

**Target:** Single AWS VPS (EC2 Ubuntu 22.04 LTS) running Nginx (TLS) → Node/Express → PostgreSQL, with nightly encrypted backups to S3.
**Audience:** Whoever deploys or restores the system.
**Last updated:** 2026-06-14

> This is the implementation plan + step-by-step procedure. Commands assume Ubuntu. Run as a non-root sudo user.

---

## 0. Architecture recap

```
[ Internet ]
     │  HTTPS (TLS 1.3, Let's Encrypt)
     ▼
[ Nginx ]  reverse proxy + TLS termination + HTTP→HTTPS redirect
     │  proxy_pass → http://127.0.0.1:5000
     ▼
[ Node/Express app ]  (managed by PM2, auto-restart on crash/reboot)
     │  serves API + static frontend, runs DB migrations on startup
     ▼
[ PostgreSQL ]  localhost only (not exposed to internet)
     │
     └── nightly:  pg_dump | openssl aes-256  →  S3 bucket (offsite)
```

The app already: serves the frontend statically, runs `runMigrations()` on boot, and has `trust proxy 1` set — so it works correctly behind Nginx.

---

## Phase 1 — Provision the VPS (~20 min)

**Goal:** A reachable Ubuntu box with a fixed IP and a locked-down firewall.

1. **Launch / start the EC2 instance**
   - Ubuntu Server 22.04 LTS, **t3.small or larger** (≥2 GB RAM — Node + PostgreSQL + Nginx together need it).
   - Allocate and associate an **Elastic IP** so the address survives stop/start.

2. **Security Group (AWS firewall)** — inbound rules:
   | Port | Source | Purpose |
   |------|--------|---------|
   | 22 (SSH) | **your IP only** | admin access |
   | 80 (HTTP) | 0.0.0.0/0 | Let's Encrypt + redirect to HTTPS |
   | 443 (HTTPS) | 0.0.0.0/0 | the app |

   **Do NOT** open 5432 (PostgreSQL) or 5000 (Node) to the internet — they stay local.

3. **SSH in and update the box**
   ```bash
   ssh ubuntu@<elastic-ip>
   sudo apt update && sudo apt upgrade -y
   ```

4. **Enable the OS firewall (defense in depth)**
   ```bash
   sudo ufw allow OpenSSH
   sudo ufw allow 'Nginx Full'
   sudo ufw enable
   ```

---

## Phase 2 — Install the stack (~15 min)

**Goal:** Node, PostgreSQL, Nginx, Git, PM2 installed.

1. **Node.js 20 LTS**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   node -v   # expect v20.x
   ```

2. **PostgreSQL**
   ```bash
   sudo apt install -y postgresql postgresql-contrib
   sudo systemctl enable --now postgresql
   ```

3. **Nginx + Git + tools**
   ```bash
   sudo apt install -y nginx git openssl
   ```

4. **PM2** (keeps Node running, restarts on crash/reboot)
   ```bash
   sudo npm install -g pm2
   ```

---

## Phase 3 — Database setup (~10 min)

**Goal:** A dedicated DB and least-privilege DB user.

1. **Create the database and app user**
   ```bash
   sudo -u postgres psql
   ```
   ```sql
   CREATE DATABASE proman_db;
   CREATE USER proman_app WITH PASSWORD '<strong-random-password>';
   GRANT ALL PRIVILEGES ON DATABASE proman_db TO proman_app;
   \q
   ```
   - Use a long random password (e.g. `openssl rand -base64 24`). This goes in `.env` as `DB_PASSWORD`.
   - The app's `runMigrations()` creates all tables/columns on first startup — **no manual schema import needed** for a fresh DB. (For a *restore*, see Phase 8.)

2. **Confirm PostgreSQL listens on localhost only** (default). Do not change `listen_addresses` to `*`.

---

## Phase 4 — Deploy the app code (~10 min)

**Goal:** Code on the box, dependencies installed, config in place.

1. **Clone from GitHub** (repo is private — use a Personal Access Token or deploy key)
   ```bash
   cd /var/www
   sudo mkdir -p proman && sudo chown $USER:$USER proman
   git clone https://github.com/Itzkoki/CapstoneProject.git proman
   cd proman/ProManJun13v2/ProMan/backend
   ```
   > Tip: for unattended pulls, add a **read-only Deploy Key** (repo → Settings → Deploy keys) instead of your account password.

2. **Install backend dependencies** (production only)
   ```bash
   npm ci --omit=dev
   ```

3. **Create the production `.env`** (this file is git-ignored — it never came from the repo)
   ```bash
   cp .env.example .env
   nano .env
   ```
   Fill in real values:
   ```
   PORT=5000
   DB_HOST=localhost
   DB_PORT=5432
   DB_USER=proman_app
   DB_PASSWORD=<the password from Phase 3>
   DB_NAME=proman_db
   JWT_SECRET=<run: openssl rand -hex 32>
   JWT_EXPIRES_IN=1h
   SENDGRID_API_KEY=<real key>
   SENDGRID_FROM_EMAIL=<verified sender>
   # + any Twilio / other keys the app uses
   ```
   - **Generate a fresh strong `JWT_SECRET`** — never reuse the placeholder.
   - `chmod 600 .env` so only the owner can read it.

---

## Phase 5 — Run the app under PM2 (~5 min)

**Goal:** Node running on `127.0.0.1:5000`, auto-restart on crash and reboot.

1. **Start it**
   ```bash
   pm2 start server.js --name proman
   pm2 logs proman --lines 30      # confirm: "Connected to PostgreSQL", migrations ran, server on :5000
   ```

2. **Make it survive reboots**
   ```bash
   pm2 save
   pm2 startup            # run the command it prints (sets up the systemd service)
   ```

At this point the app runs locally but isn't reachable from the internet yet — Nginx is next.

---

## Phase 6 — Nginx reverse proxy + TLS 1.3 (~15 min)

**Goal:** Public HTTPS with a real certificate; HTTP redirects to HTTPS.

1. **Create the site config** `/etc/nginx/sites-available/proman`:
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;

       location / {
           proxy_pass         http://127.0.0.1:5000;
           proxy_http_version 1.1;
           proxy_set_header   Host $host;
           proxy_set_header   X-Real-IP $remote_addr;
           proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header   X-Forwarded-Proto $scheme;
       }
       client_max_body_size 12m;   # matches app's 10mb JSON limit + headroom
   }
   ```
   The `X-Forwarded-*` headers are why `trust proxy 1` is set in the app — keeps client IPs correct for rate-limiting and audit logs.

2. **Enable it**
   ```bash
   sudo ln -s /etc/nginx/sites-available/proman /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

3. **Get a TLS cert (Let's Encrypt) — auto-configures HTTPS + redirect**
   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d your-domain.com
   ```
   Certbot rewrites the config to add `listen 443 ssl`, the cert paths, and an HTTP→HTTPS redirect. Auto-renewal is installed by default (`systemctl status certbot.timer`).

4. **Enable TLS 1.3 + HSTS.** In the certbot-managed server block (or `/etc/nginx/snippets/`):
   ```nginx
   ssl_protocols TLSv1.3 TLSv1.2;
   ssl_prefer_server_ciphers off;
   add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
   ```
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

5. **DNS:** point your domain's A record at the Elastic IP before running certbot (certbot validates over HTTP on port 80).

✅ The site is now live at `https://your-domain.com`.

---

## Phase 7 — Encrypted backups to S3 (~20 min)

**Goal:** Nightly encrypted DB dump, offsite, with retention. (Implements Phase 4 of the Data Protection plan.)

1. **Create an S3 bucket** with versioning + default encryption (SSE-S3/KMS) and a private bucket policy. Create an IAM user with write-only access to just that bucket; put its keys in `/etc/proman/backup.env` (chmod 600).

2. **Install AWS CLI**
   ```bash
   sudo apt install -y awscli
   ```

3. **Backup script** `/usr/local/bin/proman-backup.sh`:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   source /etc/proman/backup.env          # AWS keys + BACKUP_KEY + DB creds
   STAMP=$(date +%F_%H%M)
   FILE="/tmp/proman_${STAMP}.dump.enc"

   PGPASSWORD="$DB_PASSWORD" pg_dump -U proman_app -h localhost proman_db -Fc \
     | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_KEY > "$FILE"

   aws s3 cp "$FILE" "s3://your-backup-bucket/db/" --sse
   rm -f "$FILE"
   echo "backup ok: $STAMP"
   ```
   ```bash
   sudo chmod +x /usr/local/bin/proman-backup.sh
   ```

4. **Schedule it nightly (cron)** — meets RPO ≤24h:
   ```bash
   sudo crontab -e
   # 2:30 AM daily:
   30 2 * * * /usr/local/bin/proman-backup.sh >> /var/log/proman-backup.log 2>&1
   ```

5. **Retention (30–90 days):** add an S3 **lifecycle rule** to expire objects under `db/` after 90 days. (Don't delete before 30.)

6. **Verify** the first run manually: `sudo /usr/local/bin/proman-backup.sh` and confirm the file appears in S3.

---

## Phase 8 — Restore / Disaster Recovery (RTO 2–4h)

**Goal:** Documented, tested path back to service after a failure. Keep this section current — an untested restore is not a backup.

1. **Provision a fresh box** — repeat Phases 1–2 (or keep an AMI snapshot to skip ahead).
2. **Recreate DB + user** — Phase 3.
3. **Pull the latest encrypted dump from S3**
   ```bash
   aws s3 cp s3://your-backup-bucket/db/<latest>.dump.enc /tmp/restore.dump.enc
   openssl enc -d -aes-256-cbc -pbkdf2 -pass env:BACKUP_KEY \
     -in /tmp/restore.dump.enc -out /tmp/restore.dump
   pg_restore -U proman_app -h localhost -d proman_db --clean --if-exists /tmp/restore.dump
   ```
4. **Restore config** — recreate `.env` and `/etc/proman/backup.env` from your secrets store (these are NOT in Git or backups).
5. **Deploy app + Nginx + TLS** — Phases 4–6.
6. **Smoke test** — log in, load a client record, submit a test intake, confirm audit logs write.
7. **Record the actual time taken** vs the 2–4h RTO target. Run a **restore drill quarterly**.

---

## Routine operations cheat-sheet

| Task | Command |
|------|---------|
| Deploy new code | `cd /var/www/proman && git pull && cd ProManJun13v2/ProMan/backend && npm ci --omit=dev && pm2 restart proman` |
| View app logs | `pm2 logs proman` |
| Restart app | `pm2 restart proman` |
| Reload Nginx after config change | `sudo nginx -t && sudo systemctl reload nginx` |
| Manual backup now | `sudo /usr/local/bin/proman-backup.sh` |
| Check cert renewal | `sudo certbot renew --dry-run` |

---

## Pre-launch checklist

- [ ] Security Group: only 22 (your IP), 80, 443 open
- [ ] `.env` has a fresh `JWT_SECRET` and strong `DB_PASSWORD`, `chmod 600`
- [ ] `.env` is NOT in Git (confirmed — repo only has `.env.example`)
- [ ] PM2 `startup` + `save` done (survives reboot)
- [ ] HTTPS works; HTTP redirects to HTTPS; HSTS header present
- [ ] First S3 backup verified + lifecycle rule set
- [ ] Restore drill done once on a scratch box
- [ ] Secrets (`.env`, `backup.env`) copied into a secrets store, not only on the box

---

## Decisions / notes

- **PostgreSQL on the same box** is fine for launch. Upgrade path if you outgrow it: **AWS RDS** (managed backups, PITR, failover) — app stays on the VPS, only `DB_HOST` changes.
- **No second VPS needed** — S3 is the offsite backup. A hot-standby VPS is only for near-zero-downtime needs beyond the current RTO target.
- **Domain required** for Let's Encrypt TLS. If you don't have one yet, get a cheap domain and point its A record at the Elastic IP before Phase 6.
```
