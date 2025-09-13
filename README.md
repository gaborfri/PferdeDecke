# PferdeDecke PWA

Ziel: Eine installierbare Web‑App (PWA) für iPhone/Browser, die anhand der lokalen Wettervorhersage Kleidungsempfehlungen macht. Alles läuft on‑device, nur die Wetterdaten (Open‑Meteo) und optional das TF.js‑CDN kommen aus dem Netz.

Funktionen
- Wetterdaten (stündlich+täglich): gefühlte/Luft‑Temperatur, Luftfeuchte, Wind/Böen/Richtung, Niederschlagswahrscheinlichkeit/-menge, Regenstunden, UV, Wettercode, Sonnenauf-/untergang.
- Empfehlungen heute/morgen, Zeitpunkt konfigurierbar: Tag (12:00/08:00) oder Nacht (22:00/22:00).
- Konfigurierbare Kleidungskategorien: beliebige Anzahl, Name, Wärmegrad (0–100), „wasserdicht“.
- Sensitivität „ich friere leicht“ (+2 °C auf die gefühlte Temperatur).
- Tägliches Feedback („Was wäre passender gewesen?“) – ein Eintrag pro Tag.
- Optionales on‑device ML: Training mit TF.js; Modell in `localStorage`, Umschalter „ML nutzen“.
- Offline‑fähig via Service Worker (nach erstem Laden; auf iPhone nur mit HTTPS‑Hosting).

Dateien (Ordner `pwa/`)
- `index.html` – App‑Shell, Manifest‑Einbindung, SW‑Registrierung, TF.js‑CDN.
- `styles.css` – Layout/Design.
- `app.js` – Logik: Fetch, Feature‑Vektor, Regeln, Feedback‑Datensatz, ML‑Training/Inference, Konfiguration, Tag/Nacht.
- `manifest.json` – PWA‑Manifest (Name, Farben, Icons, Start‑URL `/pwa/`).
- `sw.js` – Service Worker (Cache‑First, Scope `/pwa/`).
- `icons/` – Platzhalter; bitte 192×192 und 512×512 PNG einfügen.

Nutzung lokal
1) Statischen Server im Repo‑Root starten (wichtig, damit Pfad `/pwa/` passt), z. B.:
   - `npx serve -l 5173 .` oder `python3 -m http.server 5173` (ohne HTTPS)
2) Browser: `http://localhost:5173/pwa/` öffnen. Standort erlauben.
3) iPhone im gleichen WLAN: `http://<dein-mac-ip>:5173/pwa/` in Safari öffnen → Teilen → „Zum Home‑Bildschirm“.

Hinweis iPhone/Offline
- Service Worker benötigt HTTPS (außer auf „localhost“). Über `http://<LAN‑IP>` funktioniert Installation, aber Offline‑Cache u. A2HS‑PWA‑Verhalten sind eingeschränkt.
- Optionen für echtes HTTPS zum Testen:
  - Lokales Zertifikat (z. B. `mkcert`) + `http-server --ssl` und Zertifikat am iPhone vertrauen.
  - Temporärer HTTPS‑Tunnel (z. B. `cloudflared`, `ngrok`, `localtunnel`).

Training (ML)
- Täglich Feedback speichern. Ab ~8 Tagen „Trainieren“ klicken. „ML nutzen“ aktivieren, um Vorhersagen mit Modell zu erhalten. Fallback sind Regeln.

Datenschutz
- Feedback, Modell und Einstellungen liegen im Browser `localStorage`. Kein externer Speicher. Netzverkehr: Open‑Meteo API + TF.js‑CDN.

Grenzen (PWA)
- Keine echten Hintergrund‑Jobs; Aktualisierung beim Öffnen. Web Push optional, erfordert Server.
