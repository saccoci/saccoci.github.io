// faucet-server.js
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { getPublicKey, finalizeEvent, nip19 } = require('nostr-tools');

const app = express();
app.use(express.json());

const db = new sqlite3.Database('./faucet.db');
db.run(`CREATE TABLE IF NOT EXISTS claims (npub TEXT PRIMARY KEY, last_claim INTEGER)`);

// === CONFIG ===
const FAUCET_NSEC = 'nsec1wn7xa9mh9hjzj25a9tnefk9ad0x475r507snglul2ta43y3ncc3s4xqzpe';  // YOUR FAUCET PRIVATE KEY (keep secret! use env var in prod)
const AMOUNT = '5.00000000';
const COOLDOWN_DAYS = 30;
const RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://nostr.mom'
];
// ==============

let faucetPrivkey;
try {
    faucetPrivkey = nip19.decode(FAUCET_NSEC).data;
} catch (e) {
    console.error('Invalid nsec for faucet');
    process.exit(1);
}

const faucetPubkey = getPublicKey(faucetPrivkey);

async function publishEvent(event) {
    const promises = RELAYS.map(relay => new Promise(resolve => {
        const ws = new WebSocket(relay);
        ws.onopen = () => {
            ws.send(JSON.stringify(['EVENT', event]));
            setTimeout(() => ws.close(), 3000);
            resolve();
        };
        ws.onerror = () => resolve();
        ws.onclose = () => resolve();
    }));
    await Promise.allSettled(promises);
}

function npubToHex(npub) {
    try {
        if (!npub.startsWith('npub1')) return null;
        return nip19.decode(npub).data;
    } catch (e) {
        return null;
    }
}

app.post('/faucet', async (req, res) => {
    const { npub } = req.body;
    if (!npub || typeof npub !== 'string') {
        return res.json({ success: false, error: 'Missing npub' });
    }

    const recipientHex = npubToHex(npub);
    if (!recipientHex) {
        return res.json({ success: false, error: 'Invalid npub' });
    }

    // Rate limit check
    db.get('SELECT last_claim FROM claims WHERE npub = ?', [npub], async (err, row) => {
        if (err) return res.json({ success: false, error: 'DB error' });

        const now = Date.now();
        if (row && now - row.last_claim < COOLDOWN_DAYS * 86400000) {
            const daysLeft = Math.ceil((COOLDOWN_DAYS * 86400000 - (now - row.last_claim)) / 86400000);
            return res.json({ success: false, error: `Please wait ${daysLeft} day(s) before claiming again` });
        }

        // Create transfer event
        const event = {
            kind: 30334,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['protocol', 'nostrcoin'],
                ['p', recipientHex],
                ['amount', AMOUNT]
            ],
            content: 'Faucet payout',
            pubkey: faucetPubkey
        };

        const signedEvent = finalizeEvent(event, faucetPrivkey);

        try {
            await publishEvent(signedEvent);
            db.run('INSERT OR REPLACE INTO claims (npub, last_claim) VALUES (?, ?)', [npub, now]);
            res.json({ success: true, eventId: signedEvent.id });
        } catch (e) {
            console.error('Publish failed:', e);
            res.json({ success: false, error: 'Failed to broadcast transaction' });
        }
    });
});

// Optional: serve faucet.html directly from VPS too (fallback if GitHub Pages slow)
app.use(express.static('public')); // put faucet.html in ./public

const PORT = 3000;
app.listen(PORT, () => console.log(`Nostrcoin faucet backend running on port ${PORT}`));
