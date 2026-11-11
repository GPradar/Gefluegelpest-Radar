# Geflügelpest-Radar

**App:** https://gpradar.github.io/gefluegelpest-radar/ – auf Android in Chrome öffnen → „App installieren“.

Die Falldaten (`data/outbreaks.json`) werden täglich automatisch aktualisiert. Kreisgrenzen erzeugt der Workflow „Kreisgrenzen aktualisieren“ (Tab *Actions*).

Web-App (PWA) für Geflügelhalter in Deutschland: Ausbrüche der Geflügelpest (HPAI) nach Landkreisen, Warnungen für das eigene Gebiet (neuer Fall **und** Aufhebung der Sperrzone), Statistik und Biosicherheit. Keine externen Bibliotheken, keine Kartenkacheln, keine Build-Tools.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html`, `styles.css`, `app.js` | die App |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Installierbarkeit, Offline-Modus, Benachrichtigungen |
| `data/outbreaks.json` | die Falldaten (aktuell **fiktive Demo-Daten**) |
| `data/kreise.geojson` | Kreisgrenzen (muss einmalig ergänzt werden, s. u.) |
| `admin.html` | einfache Oberfläche zur Datenpflege |

## Lokal starten

```bash
cd gefluegelpest-radar
python3 -m http.server 8000
# Browser: http://localhost:8000
```

(Direkt per Doppelklick auf `index.html` funktioniert es nicht, weil Browser `fetch` von lokalen Dateien blockieren.)

## Kreisgrenzen einbinden (einmalig)

Die App lädt zuerst `data/kreise.geojson`, sonst als Fallback die Kreisgrenzen von opendatasoft („georef-germany-kreis“, basiert auf BKG-Daten, Datenlizenz Deutschland – Namensnennung 2.0, also auch kommerziell nutzbar mit Quellenangabe).

Empfohlen: Datei einmal herunterladen und selbst ausliefern (schneller, unabhängig):

```
https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/georef-germany-kreis/exports/geojson?lang=de
```

→ als `data/kreise.geojson` speichern. Ist sie zu groß (> 5 MB), auf https://mapshaper.org mit „Simplify“ auf ca. 5–10 % verkleinern.
Die App erkennt den Kreisschlüssel automatisch aus den Feldern `krs_code`, `AGS`, `RS` oder `ags`; andere Quellen (z. B. BKG VG2500, in GeoJSON umgewandelt) funktionieren also auch.

## Online stellen (kostenlos)

1. Ordner in ein GitHub-Repository legen.
2. Bei **Netlify** oder **Cloudflare Pages** das Repository verbinden (kein Build-Befehl, Ausgabeordner = Projektwurzel).
3. Fertig: HTTPS-Adresse, installierbar auf Android und iPhone („Zum Home-Bildschirm“).

Jede Datenänderung = neuer Commit von `data/outbreaks.json` → automatisch live.

## Daten pflegen

`/admin.html` öffnen → Fälle hinzufügen oder Aufhebungsdatum eintragen → JSON kopieren → als `data/outbreaks.json` speichern und committen.
Vor dem Livegang: Demo-Fälle löschen und Haken „Demo-Daten“ entfernen. `admin.html` ist nicht geschützt, verändert aber nichts auf dem Server; trotzdem später per Passwortschutz (z. B. Cloudflare Access) absichern.

Quellen für echte Daten:
- **Ausbrüche:** TSIS des FLI (https://tsis.fli.de), Pressemitteilungen der Landkreise und Landesministerien.
- **Aufhebungen:** stehen fast nur in den **Allgemeinverfügungen der Landkreise** (Aufhebung von Schutz- und Überwachungszone). Ohne Datum schätzt die App „frühestens ca. 30 Tage nach Feststellung“ und kennzeichnet das als Schätzung.

## Wie Warnungen funktionieren

- Gebiet = eigener Landkreis + alle Fälle im eingestellten Umkreis (Entfernung zum Kreismittelpunkt bzw. zur optionalen Koordinate `lat`/`lon` eines Falls).
- Die App merkt sich den letzten Stand auf dem Gerät. Beim Öffnen und danach alle 30 Minuten wird verglichen: neuer aktiver Fall → Warnung, Fall von „aktiv“ auf „aufgehoben“ → Entwarnung.
- **Stufe 1 (jetzt):** Meldungen, wenn die App geöffnet ist oder im Hintergrund läuft.
- **Stufe 2 (nächster Schritt):** echte Push-Nachrichten bei geschlossener App. Dafür braucht es einen kleinen Server (z. B. Cloudflare Worker mit Cron + Web Push/VAPID), der bei jeder Datenänderung die betroffenen Abonnenten benachrichtigt. `sw.js` ist dafür schon vorbereitet (`push`-Handler). Auf dem iPhone geht Web Push nur, wenn die App zum Home-Bildschirm hinzugefügt wurde (ab iOS 16.4).

## Vor dem Livegang (Pflicht)

- **Impressum und Datenschutzerklärung** ergänzen (Standortnutzung erwähnen: Standort wird nur auf dem Gerät gespeichert, auf ca. 100 m gerundet).
- **Haftungsausschluss**: keine amtliche Information, maßgeblich sind die Allgemeinverfügungen.
- **Nutzungsrechte** für übernommene Daten klären (z. B. Anfrage an tsn@fli.de bzw. BMLEH), bevor Geld verdient wird.
- Quellenangabe Kreisgrenzen: „© GeoBasis-DE / BKG“ (ist in der App enthalten).

## Datenformat `outbreaks.json`

```json
{
  "meta": { "demo": false, "stand": "2026-11-03T18:00:00+01:00" },
  "faelle": [
    { "id": "gp-20261027-03453-a1b2", "ags": "03453", "kategorie": "gefluegel",
      "tierart": "Puten", "subtyp": "H5N1", "festgestellt_am": "2026-10-27",
      "aufgehoben_am": null, "quelle": "https://…", "lat": 52.85, "lon": 8.02 }
  ]
}
```

`id` nie wiederverwenden: die Warnlogik erkennt Fälle an ihrer ID.
