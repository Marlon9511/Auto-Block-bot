const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  isJidUser,
  isJidGroup,
  isJidBroadcast,
  isJidStatusBroadcast,
  isJidNewsletter,
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

// Hält alle bekannten Kontakt-JIDs (in PN-Form, z.B. 49...@s.whatsapp.net)
const knownContacts = new Set();

// Zuordnung LID (@lid, Privatsphäre-JID) -> echte PN-JID (@s.whatsapp.net),
// gelernt aus dem Kontakt-Sync
const lidToPn = new Map();

let startedAt = null;

function registerContact(c) {
  if (!c || !c.id) return;
  knownContacts.add(c.id);
  if (c.lid) {
    lidToPn.set(c.lid, c.id);
  }
}

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
    for (const c of contacts) registerContact(c);
    console.log(`📇 ${knownContacts.size} Kontakte initial synchronisiert (davon ${lidToPn.size} mit LID-Zuordnung).`);
  });

  // Neue/aktualisierte Kontakte während der Laufzeit
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) registerContact(c);
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const u of updates) registerContact(u);
  });

  // Löst eine @lid-JID zur echten @s.whatsapp.net-JID auf. Nötig, weil
  // updateBlockStatus() nur PN-JIDs akzeptiert und die Kontaktliste ebenfalls
  // in PN-Form geführt wird.
  async function resolveToPnJid(rawJid, altJid) {
    if (!rawJid) return null;
    if (!rawJid.endsWith('@lid')) {
      return jidNormalizedUser(rawJid);
    }

    // 1) Baileys liefert bei LID-Chats oft direkt die Alt-JID (PN) mit
    if (altJid && altJid.endsWith('@s.whatsapp.net')) {
      return jidNormalizedUser(altJid);
    }

    // 2) Aus dem Kontakt-Sync gelernte Zuordnung
    if (lidToPn.has(rawJid)) {
      return jidNormalizedUser(lidToPn.get(rawJid));
    }

    // 3) Baileys' interner LID<->PN-Store (Signal-Repository), falls von
    //    der installierten Version unterstützt
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(rawJid);
      if (pn) return jidNormalizedUser(pn);
    } catch (_) {
      // ignorieren, Fallback unten greift
    }

    return null; // konnte nicht aufgelöst werden
  }

  // --- Eingehende Nachrichten prüfen ------------------------------------
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid) continue;

        // Nachrichtentypen ausschließen, die man nicht (sinnvoll) blockieren
        // kann: Status-Updates, Broadcast-Listen, Newsletter/Kanäle.
        if (isJidStatusBroadcast?.(jid) || jid === 'status@broadcast') continue;
        if (isJidBroadcast?.(jid)) continue;
        if (isJidNewsletter?.(jid) || jid.endsWith('@newsletter')) continue;

        const isGroup = isJidGroup?.(jid) ?? jid.endsWith('@g.us');
        if (IGNORE_GROUPS && isGroup) continue;

        // Bei Gruppen ist der eigentliche Absender in participant zu finden.
        // "Alt"-Feld: Baileys liefert bei LID-Chats teils direkt die
        // Gegenstück-JID mit (PN, falls remoteJid eine LID ist).
        const rawSenderJid = isGroup ? msg.key.participant : jid;
        const altSenderJid = isGroup ? msg.key.participantAlt : msg.key.remoteJidAlt;
        if (!rawSenderJid) continue;

        let senderJid;

        if (rawSenderJid.endsWith('@lid')) {
          // Privatsphäre-JID -> versuchen, die echte Nummer aufzulösen
          const resolved = await resolveToPnJid(rawSenderJid, altSenderJid);
          if (resolved) {
            senderJid = resolved;
            console.log(`🔗 LID ${rawSenderJid} aufgelöst zu ${senderJid}`);
          } else {
            // Konnte nicht aufgelöst werden: sicherheitshalber NICHT
            // blockieren (könnte ein gespeicherter Kontakt mit LID sein,
            // dessen Zuordnung wir noch nicht kennen), nur loggen.
            console.log(`⚠️  Konnte LID nicht auflösen, überspringe sicherheitshalber: ${rawSenderJid}`);
            continue;
          }
        } else if (isJidUser?.(rawSenderJid) || rawSenderJid.endsWith('@s.whatsapp.net')) {
          senderJid = jidNormalizedUser(rawSenderJid);
        } else {
          // Nicht-blockierbare JID (z.B. exotischer Typ)
          console.log(`ℹ️  Überspringe nicht-blockierbare JID: ${rawSenderJid}`);
          continue;
        }

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

          try {
            await sock.updateBlockStatus(senderJid, 'block');
            console.log(`🚫 Blockiert: ${senderJid}`);
          } catch (blockErr) {
            console.error(`❌ Blockieren von ${senderJid} fehlgeschlagen:`, blockErr?.message || blockErr);
          }
        }
      } catch (err) {
        console.error('Fehler bei der Verarbeitung einer Nachricht:', err);
      }
    }
  });
}

startBot();