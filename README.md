# GeoStamp

GeoStamp lets you pick a photo, add a custom place title, address, latitude/longitude, date, time and timezone, preview the stamp, and download a JPG with GPS and date EXIF data. Everything runs client-side in the browser; no photos are uploaded.

**Live site:** https://riosn3047l.github.io/Geo/

## Enable GitHub Pages

1. Go to **Settings → Pages**.
2. Under **Source**, choose **GitHub Actions**.
3. The `Deploy to GitHub Pages` workflow deploys on every push to `main` (or `master`). You can also run it manually from the **Actions** tab.

## Change name & icon

- Edit `config.js` directly, or
- Set repo Variables `APP_NAME` and `APP_ICON_URL` (**Settings → Secrets and variables → Actions → Variables**). The deploy workflow rewrites `config.js` from these. See `.env.example` for the names and format.

## Run locally

```sh
python3 -m http.server
```

Then open http://localhost:8000.

## Credits

- Imagery: Esri
- Geocoding: OpenStreetMap Nominatim
- Maps: Leaflet
- EXIF writing: piexifjs
