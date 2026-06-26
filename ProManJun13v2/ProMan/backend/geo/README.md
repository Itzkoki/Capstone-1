# GeoLite2 IP Geolocation Database

`geoService.js` performs **offline** IP → city/country lookups using MaxMind's
`GeoLite2-City.mmdb`. This file is **not committed to git** (it's large and
MaxMind updates it ~twice a week). It must be provisioned **on the server**.

The app degrades gracefully: if `GeoLite2-City.mmdb` is missing, geolocation is
simply disabled — audit logs still record IPs, just without city/country. So the
system runs fine before the DB is installed; it just won't resolve locations.

Expected location (read by `geoService.js`):

```
backend/geo/GeoLite2-City.mmdb
```

## One-time setup on the server (Ubuntu / EC2)

1. Create a **free** MaxMind account: https://www.maxmind.com/en/geolite2/signup
   Then generate a **License Key** (Account → Manage License Keys).

2. Install the official updater:

   ```bash
   sudo apt-get update && sudo apt-get install -y geoipupdate
   ```

3. Configure `/etc/GeoIP.conf` with your credentials and the City edition:

   ```
   AccountID YOUR_ACCOUNT_ID
   LicenseKey YOUR_LICENSE_KEY
   EditionIDs GeoLite2-City
   ```

4. Download the database:

   ```bash
   sudo geoipupdate
   ```

5. Copy (or symlink) it to the path the app reads:

   ```bash
   cp /usr/share/GeoIP/GeoLite2-City.mmdb \
      /path/to/ProMan/backend/geo/GeoLite2-City.mmdb
   ```

6. Restart the backend. You should see in the logs:

   ```
   🌍 geoService: GeoLite2-City database loaded.
   ```

## Keeping it fresh (recommended)

MaxMind updates the database about twice a week. Add a weekly cron job:

```bash
# /etc/cron.weekly/geoipupdate-proman  (chmod +x)
#!/bin/sh
geoipupdate && \
  cp /usr/share/GeoIP/GeoLite2-City.mmdb \
     /path/to/ProMan/backend/geo/GeoLite2-City.mmdb
```

## Local development

For local testing you can download the same `GeoLite2-City.mmdb` from your
MaxMind account and drop it into `backend/geo/` manually. It will be ignored by
git (see `.gitignore` → `*.mmdb`).
