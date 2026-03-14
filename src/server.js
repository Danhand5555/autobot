/**
 * server.js
 * Express + Socket.IO server for the TTM Bot Dashboard.
 * Serves the frontend and handles bot sessions via WebSocket.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { BotRunner } = require('./botRunner');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// Allowed frontend origins — set CORS_ORIGIN in .env for your Vercel domain
// e.g. CORS_ORIGIN=https://ttm-bot.vercel.app
const ALLOWED_ORIGINS = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
    : ['http://localhost:3000'];

const io = new Server(server, {
    cors: {
        origin: ALLOWED_ORIGINS,
        methods: ['GET', 'POST'],
    },
});

// CORS middleware
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Puppeteer scraper — uses a throw-away temp profile so it never
//   conflicts with the bot's browser-data dir ──────────────────────────
let puppeteer;
try {
    puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
} catch (e) {
    puppeteer = require('puppeteer');
}

const SCRAPE_ARGS = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-gpu', '--disable-dev-shm-usage',
];

function blockAssets(page) {
    page.setRequestInterception(true);
    page.on('request', req => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });
}

// Scrape a single URL — own browser, own tmpDir
async function scrapeWithBrowser(url, extractFn, timeoutMs = 25000) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttm-scrape-'));
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: SCRAPE_ARGS, userDataDir: tmpDir });
        const page = await browser.newPage();
        blockAssets(page);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await new Promise(r => setTimeout(r, 400));
        const finalUrl = page.url();
        if (finalUrl !== url) console.log(`[Scrape] redirected: ${url} → ${finalUrl}`);
        return await page.evaluate(extractFn);
    } finally {
        if (browser) await browser.close().catch(() => {});
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// Scrape multiple URLs in one browser (parallel tabs) — much faster for concert lists
async function scrapeMultiTab(targets, timeoutMs = 25000) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttm-scrape-'));
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true, args: SCRAPE_ARGS, userDataDir: tmpDir });
        const results = await Promise.all(targets.map(async ({ url, extractFn, source }) => {
            const page = await browser.newPage();
            blockAssets(page);
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
                await new Promise(r => setTimeout(r, 400));
                const data = await page.evaluate(extractFn);
                return { source, data };
            } catch (e) {
                console.error(`[scrapeMultiTab] ${url}:`, e.message);
                return { source, data: [] };
            } finally {
                await page.close().catch(() => {});
            }
        }));
        return results;
    } finally {
        if (browser) await browser.close().catch(() => {});
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// ── Simple in-memory cache ────────────────────────────────────────────
const cache = new Map();
function getCache(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
    return entry.value;
}
function setCache(key, value, ttlMs) {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// ── Image proxy — serves TTM images through our server so the
//   frontend doesn't hit mixed-content / CORS blocks ─────────────────
app.get('/api/imgproxy', async (req, res) => {
    const imgUrl = req.query.url;
    if (!imgUrl || !imgUrl.startsWith('https://www.thaiticketmajor.com')) {
        return res.status(400).send('invalid url');
    }
    try {
        const resp = await fetch(imgUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://www.thaiticketmajor.com/',
            },
        });
        if (!resp.ok) return res.status(resp.status).send('upstream error');
        const ct = resp.headers.get('content-type') || 'image/png';
        res.set('Content-Type', ct);
        res.set('Cache-Control', 'public, max-age=3600');
        const buf = await resp.arrayBuffer();
        res.send(Buffer.from(buf));
    } catch (e) {
        res.status(500).send('proxy error');
    }
});

// ── Thai date parser — "วันเปิดจำหน่าย วันเสาร์ที่ 1 กุมภาพันธ์ 2568, 10:00 น." → ISO ──
const THAI_MONTHS = {
    'มกราคม': 1, 'กุมภาพันธ์': 2, 'มีนาคม': 3, 'เมษายน': 4,
    'พฤษภาคม': 5, 'มิถุนายน': 6, 'กรกฎาคม': 7, 'สิงหาคม': 8,
    'กันยายน': 9, 'ตุลาคม': 10, 'พฤศจิกายน': 11, 'ธันวาคม': 12,
};

function parseThaiSaleDate(text) {
    if (!text) return '';
    try {
        // Extract day number, Thai month name, Buddhist year, and time
        const dayMatch = text.match(/ที่\s*(\d{1,2})/);
        const monthMatch = Object.keys(THAI_MONTHS).find(m => text.includes(m));
        const yearMatch = text.match(/(\d{4})/);
        const timeMatch = text.match(/(\d{1,2})[:.:](\d{2})/);

        if (!dayMatch || !monthMatch || !yearMatch) return '';

        const day = parseInt(dayMatch[1]);
        const month = THAI_MONTHS[monthMatch];
        const year = parseInt(yearMatch[1]) - 543; // Buddhist → CE
        const hours = timeMatch ? parseInt(timeMatch[1]) : 10;
        const mins = timeMatch ? parseInt(timeMatch[2]) : 0;

        // Return ISO-ish format for datetime-local input: YYYY-MM-DDTHH:MM
        const pad = n => String(n).padStart(2, '0');
        return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(mins)}`;
    } catch {
        return '';
    }
}

// ── API: concerts ─────────────────────────────────────────────────────
app.get('/api/concerts', async (req, res) => {
    const CACHE_KEY = 'concerts';
    const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    const cached = getCache(CACHE_KEY);
    if (cached) {
        console.log('[API] concerts — serving from cache');
        return res.json(cached);
    }

    const extract = () => {
        const items = [];
        document.querySelectorAll('.event-item').forEach(el => {
            const titleLink = el.querySelector('.box-txt a.title, a.title');
            const imgLink   = el.querySelector('a.box-img');

            const rawHref = (titleLink || imgLink)?.getAttribute('href') || '';
            if (!rawHref || rawHref === '#' || rawHref.endsWith('/concert/') || rawHref.endsWith('/live/')) return;

            const href = rawHref.startsWith('http')
                ? rawHref
                : 'https://www.thaiticketmajor.com' + rawHref;

            const name = (titleLink?.textContent || '').replace(/\s+/g, ' ').trim();
            if (!name || name.length < 2) return;

            const img    = el.querySelector('img');
            const imgSrc = img?.getAttribute('src') || '';
            const imgAbs = imgSrc.startsWith('http') ? imgSrc : (imgSrc ? 'https://www.thaiticketmajor.com' + imgSrc : '');

            const btnEl  = el.querySelector('[class*="btn-"]');
            const status = btnEl ? (btnEl.textContent || '').replace(/\s+/g, ' ').trim() : '';

            const dateEl = el.querySelector('.datetime, [class*="datetime"], [class*="date"]');
            const date   = dateEl ? dateEl.textContent.replace(/\s+/g, ' ').trim() : '';

            items.push({ name, url: href, image: imgAbs, status, date });
        });
        return items;
    };

    try {
        // Scrape concert + live pages in parallel (one browser, two tabs)
        const results = await scrapeMultiTab([
            { url: 'https://www.thaiticketmajor.com/concert/', extractFn: extract, source: 'concert' },
            { url: 'https://www.thaiticketmajor.com/live/',    extractFn: extract, source: 'live'    },
        ]);

        let concerts = [];
        for (const { source, data } of results) {
            concerts.push(...data.map(c => ({ ...c, source })));
        }
        const seen = new Set();
        concerts = concerts.filter(c => !seen.has(c.url) && seen.add(c.url));

        setCache(CACHE_KEY, concerts, CACHE_TTL);
        res.json(concerts);
    } catch (e) {
        console.error('[API] concerts failed:', e.message);
        res.json([]);
    }
});

// ── API: rounds + seatmap ─────────────────────────────────────────────
app.get('/api/rounds', async (req, res) => {
    const concertUrl = req.query.url;
    if (!concertUrl) return res.json({ rounds: [], seatMapUrl: '' });

    const CACHE_KEY = `rounds:${concertUrl}`;
    const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    const cached = getCache(CACHE_KEY);
    if (cached) {
        console.log('[API] rounds — serving from cache');
        return res.json(cached);
    }

    try {
        const result = await scrapeWithBrowser(concertUrl, () => {
            const rounds = [];

            // Each venue block is .event-detail-item inside #section-event-round
            document.querySelectorAll(
                '#section-event-round .event-detail-item, .event-detail-item'
            ).forEach(venue => {
                const venueName = venue.querySelector('.venue')?.textContent.trim() || '';

                venue.querySelectorAll('.box-event-list .body .row').forEach(row => {
                    const btn = row.querySelector('a[onclick*="zones.php"]');
                    if (!btn) return; // sold out / no buy button

                    const onclick = btn.getAttribute('onclick') || '';
                    const match   = onclick.match(/zones\.php\?query=(\d+)(?:&(?:amp;)?rdId=(\d+))?/);
                    if (!match) return;

                    const queryId = match[1];
                    const rdId    = match[2] || null;

                    // Date: first line of .date only (avoid multi-line sale info)
                    const dateEl = row.querySelector('.col-label .date');
                    const rawDate = dateEl?.textContent || '';
                    // Take first non-empty line only
                    const date = rawDate.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';

                    // Time: .item-show inside the button
                    const timeEl = btn.querySelector('.item-show');
                    const time   = timeEl?.textContent.trim() || '';

                    const label = [date, time].filter(Boolean).join(' ');
                    const text  = label || `Round (query=${queryId})`;

                    const bookingUrl = rdId
                        ? `https://booking.thaiticketmajor.com/booking/3m/zones.php?query=${queryId}&rdId=${rdId}`
                        : `https://booking.thaiticketmajor.com/booking/3m/zones.php?query=${queryId}`;

                    rounds.push({ value: rdId || queryId, queryId, rdId, bookingUrl, text, venue: venueName });
                });
            });

            // Seat map: first .fancybox img with img_seat inside the schedule section
            let seatMapUrl = '';
            const seatImgs = document.querySelectorAll(
                '#section-event-round a.fancybox[href*="img_seat"], ' +
                '#section-event-round img[src*="img_seat"]'
            );
            if (seatImgs.length) {
                const el  = seatImgs[0];
                const src = el.getAttribute('href') || el.getAttribute('src') || '';
                seatMapUrl = src.startsWith('http') ? src : 'https://www.thaiticketmajor.com' + src;
            }

            // Sale time: look for "วันเปิดจำหน่าย" or "เปิดจำหน่ายบัตร" text
            let saleText = '';
            const body = document.body?.innerText || '';
            const saleMatch = body.match(/(?:วันเปิดจำหน่าย|เปิดจำหน่ายบัตร[^\n:]*Online\s*:)[^\n]*/i);
            if (saleMatch) saleText = saleMatch[0].trim();

            return { rounds, seatMapUrl, saleText };
        });

        // Deduplicate by bookingUrl
        const seen = new Set();
        const unique = result.rounds.filter(r => !seen.has(r.bookingUrl) && seen.add(r.bookingUrl));

        // Parse Thai sale date into ISO for the datetime-local input
        const saleOpensAt = parseThaiSaleDate(result.saleText || '');

        const payload = { rounds: unique, seatMapUrl: result.seatMapUrl || '', saleOpensAt };
        setCache(CACHE_KEY, payload, CACHE_TTL);
        res.json(payload);
    } catch (err) {
        console.error('[API] rounds error:', err.message);
        res.json({ rounds: [], seatMapUrl: '' });
    }
});

// ── API: cache bust ───────────────────────────────────────────────────
app.delete('/api/cache', (req, res) => {
    cache.clear();
    console.log('[API] cache cleared');
    res.json({ ok: true });
});

// ── API: bot status ───────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    res.json({ running: activeBot !== null });
});

// ── Socket.IO bot control ─────────────────────────────────────────────
let activeBot = null;
let botOwnerSocketId = null;

io.on('connection', (socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    socket.emit('status', activeBot ? 'running' : 'idle');

    socket.on('start-bot', (config) => {
        if (activeBot) {
            socket.emit('log', { type: 'warn', message: 'Bot is already running!', time: new Date().toLocaleTimeString('th-TH') });
            return;
        }

        console.log(`[BOT] Starting for: ${config.email}`);
        botOwnerSocketId = socket.id;
        io.emit('status', 'running');

        const emit = (event, data) => io.emit(event, data);

        activeBot = new BotRunner(config, emit);
        activeBot.run().then(() => {
            activeBot = null;
            botOwnerSocketId = null;
            io.emit('status', 'idle');
        }).catch((err) => {
            emit('log', { type: 'error', message: `Fatal: ${err.message}`, time: new Date().toLocaleTimeString('th-TH') });
            emit('status', 'error');
            activeBot = null;
            botOwnerSocketId = null;
        });
    });

    socket.on('stop-bot', () => {
        if (activeBot) {
            activeBot.stop();
            activeBot = null;
            botOwnerSocketId = null;
            io.emit('status', 'idle');
        }
    });

    socket.on('disconnect', () => {
        console.log(`[WS] Client disconnected: ${socket.id}`);
        if (activeBot && botOwnerSocketId === socket.id) {
            console.log('[BOT] Owner disconnected — stopping bot');
            activeBot.stop();
            activeBot = null;
            botOwnerSocketId = null;
            io.emit('status', 'idle');
        }
    });
});

// ── Start server ──────────────────────────────────────────────────────
function getLocalIP() {
    try {
        const nets = os.networkInterfaces();
        if (!nets) return 'localhost';
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if (net.family === 'IPv4' && !net.internal) return net.address;
            }
        }
    } catch (e) {
        console.warn('[Server] Could not get network interfaces:', e.message);
    }
    return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('\n====================================');
    console.log('  TTM TICKET BOT DASHBOARD');
    console.log('====================================\n');
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Network: http://${ip}:${PORT}`);
    console.log(`\n  Open the Network URL on your phone!\n`);
});
