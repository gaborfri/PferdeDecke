# PferdeDecke – PWA

Eine installierbare Web‑App (PWA), die anhand der lokalen Wettervorhersage eine Empfehlung für die passende Pferdedecke gibt. Die App nutzt ein kleines On‑Device‑Machine‑Learning‑Modell, das aus deinem Feedback lernt und die Vorschläge im Zeitverlauf personalisiert. Wetterdaten kommen von Open‑Meteo, die Berechnung läuft im Browser.

**Hauptfunktionen**
- Wetterdaten: gefühlte/Luft‑Temperatur, Wind/Böen/Richtung, Niederschlagswahrscheinlichkeit, Tages‑Niederschlagssumme, Regenstunden, UV, Wettercode.
- Empfehlungen für heute und morgen; Zeitpunkt konfigurierbar (Tag: 12:00/08:00, Nacht: 22:00/22:00).
- Konfigurierbare Decken‑Kategorien mit Wärmegrad (0–100) und „wasserdicht“.
- Feedback pro Tag („Was wäre passender gewesen?“) als Trainingsdaten fürs ML‑Modell.
- On‑Device‑ML mit TensorFlow.js (lokal gebundled), Modell wird in `localStorage` gespeichert, offline nutzbar.
- PWA mit Service Worker: nach dem ersten Laden offlinefähig.

**Projektstruktur**
- `pwa/index.html` – App‑Shell, Manifest, Service‑Worker‑Registrierung, Einbindung TF.js.
- `pwa/styles.css` – Layout und UI.
- `pwa/app.js` – App‑Logik: Wetter‑Fetch, Feature‑Engineering, Regel‑Fallback, Feedback‑Speicher, ML‑Training/Inference, Einstellungen.
- `pwa/manifest.json` – PWA‑Manifest (Start‑URL relativ zu `/pwa/`).
- `pwa/sw.js` – Service Worker (Cache‑Strategie, Scope `/pwa/`).
- `pwa/icons/` – App‑Icons (192×192, 512×512 usw.).
- `index.html` – Startseite für GitHub Pages mit Link zur PWA und Installationshinweisen.
- `.nojekyll` – Deaktiviert Jekyll auf GitHub Pages.

**GitHub Pages**
- Veröffentlicht wird die PWA im Unterordner `pwa/`. Die Root‑Seite `index.html` verlinkt dorthin und erklärt die Installation.
- Wichtig: Pfade in der PWA sind relativ (`./...`), Manifest `start_url` ist `./`, damit der Start unter `/pwa/` korrekt funktioniert.

**Lokal starten**
1) Statischen Server im Repo‑Root starten, z. B. `npx serve -l 5173 .` oder `python3 -m http.server 5173`.
2) Browser öffnen: `http://localhost:5173/pwa/` und Standort erlauben.
3) iPhone im gleichen WLAN: `http://<dein-mac-ip>:5173/pwa/` in Safari öffnen → Teilen → „Zum Home‑Bildschirm“.

**Hinweise (iPhone/Offline)**
- Service Worker benötigt HTTPS (außer auf `localhost`). Über LAN‑IP ist das Offline‑Verhalten eingeschränkt.
- TF.js ist lokal eingebunden und wird gecached; ML funktioniert offline. Wetterdaten werden online nachgeladen; offline siehst du die letzten gespeicherten Werte.

**Training (ML)**
- Sammle Feedback. Ab ca. 8 Tagen retrainiert die App automatisch nach jeweils drei neuen Feedback-Tagen. Das ML-Modell priorisiert danach die Empfehlungen; Fallback bleiben die Regeln.

**Datenschutz**
- Feedback, Modell und Einstellungen bleiben lokal im Browser (`localStorage`). Extern nur Open‑Meteo API‑Aufrufe.

**Bekannte Details/UX**
- Regen‑Chip zeigt Prozent, ggf. Regenstunden und Tages‑Summe. Nummer und Einheit bleiben nun zusammen in einer Zeile (kein Umbruch zwischen Zahl und „mm“/„h“).
