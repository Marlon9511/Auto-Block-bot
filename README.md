# WhatsApp Auto-Blocker

Blockiert automatisch jeden, der dir schreibt und **nicht** in deinen
gespeicherten Kontakten steht.

## ⚠️ Wichtige Hinweise

- Nutzt die inoffizielle Bibliothek `whatsapp-web.js` (steuert WhatsApp Web
  im Hintergrund per Headless-Chrome). Das verstößt formal gegen die
  WhatsApp-Nutzungsbedingungen – im Alltag nutzen es sehr viele privat,
  ein Restrisiko einer Account-Sperre besteht aber.
- Der Bot muss **dauerhaft laufen**, um zu funktionieren (kein Cloud-Dienst,
  läuft auf deinem eigenen Rechner/Server).
- Blockierte Kontakte werden **sofort und ohne Rückfrage** blockiert –
  teste erst mit `DRY_RUN = true` in `index.js`.
- Gruppen werden standardmäßig ignoriert (`IGNORE_GROUPS = true`), sonst
  würden auch unbekannte Gruppenmitglieder blockiert.

## Installation

```bash
npm install
```

## Start

```bash
npm start
```

Beim ersten Start erscheint ein QR-Code im Terminal. Scanne ihn in der
WhatsApp-App unter **Einstellungen → Verknüpfte Geräte → Gerät verknüpfen**.
Danach bleibt die Session lokal gespeichert (Ordner `.wwebjs_auth`), du musst
den QR-Code nicht erneut scannen, solange der Ordner erhalten bleibt.

## Konfiguration (in `index.js`)

| Variable        | Bedeutung                                                    |
|-----------------|---------------------------------------------------------------|
| `DRY_RUN`       | `true` = nur loggen, wen er blockieren würde, ohne zu blockieren |
| `WHITELIST`     | Nummern, die nie blockiert werden sollen                     |
| `IGNORE_GROUPS` | Gruppen-Nachrichten von der Prüfung ausnehmen                |

## Dauerhaft laufen lassen

Empfohlen mit [pm2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start index.js --name wa-blocker
pm2 save
pm2 startup
```

## Wie erkennt der Bot "bekannte" Kontakte?

Über `contact.isMyContact` – das ist `true`, wenn die Nummer in deinem
Telefon-Adressbuch gespeichert ist und mit WhatsApp synchronisiert wurde.
