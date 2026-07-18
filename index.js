const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// ---- Konfiguration -------------------------------------------------

// true  = wirklich blockieren
// false = nur simulieren (Dry-Run), zeigt im Log an, wen er blockieren WÜRDE
const DRY_RUN = false;

// Nummern, die NIE blockiert werden sollen (Format: "49XXXXXXXXXX@s.whatsapp.net")
const WHITELIST = [
  // "49123456789@s.whatsapp.net",
];

// Gruppen-Nachrichten ignorieren (empfohlen, sonst würden auch
// Gruppenmitglieder ohne Kontakteintrag blockiert)
const IGNORE_GROUPS = true;

// Wie lange nach dem Start gewartet wird, bevor überhaupt geprüft/blockiert
// wird. Verhindert Fehlblockierungen, solange die Kontaktliste noch nicht
// vollständig synchronisiert ist.
const STARTUP_GRACE_MS = 15000;

// ---------------------------------------------------------------------

const logger = pino({ level: 'silent' }); // auf 'info' oder 'debug' stellen zum Fehlersuchen

// Hält alle bekannten Kontakt-JIDs
const knownContacts = new Set();
let startedAt = null;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  // Aktuelle WhatsApp-Web-Protokollversion holen. Das ist der häufigste
  // Grund für sofortige Verbindungsabbrüche: Läuft Baileys mit einer
  // veralteten/hart codierten Version, wirft WhatsApp die Verbindung
  // sofort wieder raus.
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`ℹ️  Nutze WA-Web-Version ${version.join('.')} (aktuellste: ${isLatest})`);

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS('Desktop'),
    printQRInTerminal: false, // wir rendern den QR-Code selbst
  });

  // --- Verbindung & QR-Code -------------------------------------------
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scanne diesen QR-Code mit WhatsApp (Einstellungen > Verknüpfte Geräte):');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const boomError = new Boom(lastDisconnect?.error);
      const statusCode = boomError?.output?.statusCode;
      const reasonName = Object.keys(DisconnectReason).find(
        (k) => DisconnectReason[k] === statusCode
      ) || 'unbekannt';

      console.warn(`⚠️  Verbindung getrennt. Status: ${statusCode} (${reasonName})`);
      console.warn(`    Grund: ${boomError?.message}`);

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (statusCode === DisconnectReason.loggedOut) {
        console.warn('    → Ausgeloggt. Lösche den Ordner "auth_info" und starte neu, um dich per QR-Code erneut anzumelden.');
      } else if (statusCode === DisconnectReason.badSession) {
        console.warn('    → Ungültige Session. Lösche den Ordner "auth_info" und starte neu.');
      } else if (statusCode === DisconnectReason.connectionReplaced) {
        console.warn('    → Verbindung wurde durch ein anderes verknüpftes Gerät ersetzt.');
      } else if (statusCode === DisconnectReason.restartRequired) {
        console.log('    → Neustart nach Erstverbindung erforderlich (normal), verbinde erneut ...');
      } else {
        console.warn('    → Verbinde erneut ...');
      }

      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      startedAt = Date.now();
      console.log('✅ Bot ist verbunden und läuft. Synchronisiere Kontakte ...');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // --- Kontakte mitschneiden -------------------------------------------
  // Initialer Sync beim Login
  sock.ev.on('contacts.set', ({ contacts }) => {
    for (const c of contacts) knownContacts.add(c.id);
    console.log(`📇 ${knownContacts.size} Kontakte initial synchronisiert.`);
  });

  // Neue/aktualisierte Kontakte während der Laufzeit
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) knownContacts.add(c.id);
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const u of updates) {
      if (u.id) knownContacts.add(u.id);
    }
  });

  // --- Eingehende Nachrichten prüfen ------------------------------------
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid) continue;

        const isGroup = jid.endsWith('@g.us');
        const isStatus = jid === 'status@broadcast';
        if (isStatus) continue;
        if (IGNORE_GROUPS && isGroup) continue;

        // Bei Gruppen ist der eigentliche Absender in participant zu finden
        const senderJid = isGroup ? msg.key.participant : jid;
        if (!senderJid) continue;

        if (WHITELIST.includes(senderJid)) continue;

        // Sicherheitsabstand nach dem Start, bis Kontakte synchronisiert sind
        if (!startedAt || Date.now() - startedAt < STARTUP_GRACE_MS) {
          console.log(`⏳ Ignoriere Nachricht während der Startphase von ${senderJid}`);
          continue;
        }

        const isKnownContact = knownContacts.has(senderJid);

        if (!isKnownContact) {
          if (DRY_RUN) {
            console.log(`[DRY RUN] Würde blockieren: ${senderJid}`);
            continue;
          }

          await sock.updateBlockStatus(senderJid, 'block');
          console.log(`🚫 Blockiert: ${senderJid}`);
        }
      } catch (err) {
        console.error('Fehler bei der Verarbeitung einer Nachricht:', err);
      }
    }
  });
}

startBot();