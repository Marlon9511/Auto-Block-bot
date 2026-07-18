const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// ---- Konfiguration -------------------------------------------------

// true  = wirklich blockieren
// false = nur simulieren (Dry-Run), zeigt im Log an, wen er blockieren WÜRDE
const DRY_RUN = false;

// Nummern, die NIE blockiert werden sollen (Format: "49XXXXXXXXXX@c.us")
const WHITELIST = [
  // "49123456789@c.us",
];

// Gruppen-Nachrichten ignorieren (empfohlen, sonst würden auch
// Gruppenmitglieder ohne Kontakteintrag blockiert)
const IGNORE_GROUPS = true;

// ---------------------------------------------------------------------

const client = new Client({
  authStrategy: new LocalAuth(), // speichert die Session lokal, kein erneuter QR-Scan nötig
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', (qr) => {
  console.log('Scanne diesen QR-Code mit WhatsApp (Einstellungen > Verknüpfte Geräte):');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ Bot ist verbunden und läuft. Wartet auf Nachrichten ...');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Authentifizierung fehlgeschlagen:', msg);
});

client.on('disconnected', (reason) => {
  console.warn('⚠️  Verbindung getrennt:', reason);
});

client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();

    // Gruppen ggf. ignorieren
    if (IGNORE_GROUPS && chat.isGroup) return;

    const contact = await msg.getContact();
    const senderId = contact.id._serialized;

    // Whitelist prüfen
    if (WHITELIST.includes(senderId)) return;

    // isMyContact = true, wenn die Nummer im synchronisierten
    // Adressbuch/Kontakte gespeichert ist
    const isKnownContact = contact.isMyContact;

    if (!isKnownContact) {
      const name = contact.pushname || contact.number || senderId;

      if (DRY_RUN) {
        console.log(`[DRY RUN] Würde blockieren: ${name} (${senderId})`);
        return;
      }

      await contact.block();
      console.log(`🚫 Blockiert: ${name} (${senderId})`);
    }
  } catch (err) {
    console.error('Fehler bei der Verarbeitung einer Nachricht:', err);
  }
});

client.initialize();