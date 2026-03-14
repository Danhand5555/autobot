/**
 * queue-mock.js
 * Local Queue-it simulator for testing the bot's queue handling code.
 *
 * Start:  npm run test:queue
 * Then in the dashboard, click [ TEST QUEUE ] or set bookingUrl to
 *   http://localhost:3001/mock-concert
 *
 * Flow:
 *   /mock-concert  →  302 to /queue-it-sim  →  (countdown)  →  /mock-booking
 *   The bot sees "queue-it" in the URL and enters the queue polling loop.
 *   After the countdown finishes the page redirects to /mock-booking which
 *   has the same selectors the real TTM booking page uses (area, .seatuncheck,
 *   #booknow) so the bot can exercise the full flow.
 *
 * Env vars:
 *   QUEUE_SECONDS  – total queue wait in seconds (default 15)
 *   QUEUE_START    – starting queue position     (default 248)
 *   MOCK_PORT      – port to listen on           (default 3001)
 */

const http = require('http');
const url  = require('url');

const PORT        = parseInt(process.env.MOCK_PORT)    || 3001;
const QUEUE_SEC   = parseInt(process.env.QUEUE_SECONDS) || 15;
const QUEUE_START = parseInt(process.env.QUEUE_START)   || 248;

function html(body, title = 'Queue-it Mock') {
    return `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>${title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1a2e;color:#eee;font-family:Arial,Helvetica,sans-serif;display:flex;
     align-items:center;justify-content:center;min-height:100vh;text-align:center}
.wrap{max-width:480px;padding:40px}
h1{font-size:22px;margin-bottom:12px}
p{font-size:14px;color:#aaa;margin-bottom:8px}
.pos{font-size:64px;font-weight:bold;color:#f5a623;margin:24px 0 8px}
.eta{font-size:16px;color:#ccc;margin-bottom:20px}
.progress-bar-wrap{background:#333;border-radius:4px;height:8px;width:100%;overflow:hidden;margin-bottom:10px}
.progress-bar{background:#f5a623;height:100%;width:0%;transition:width 0.8s ease}
.note{font-size:12px;color:#666;margin-top:20px}
/* booking page styles */
.zone-map{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin:16px 0}
.seatuncheck{display:inline-block;width:36px;height:36px;background:#2a5;color:#fff;
             border-radius:4px;line-height:36px;cursor:pointer;font-size:12px;transition:background .15s}
.seatuncheck:hover{background:#3c7}
.seatuncheck.selected{background:#f5a623}
#booknow{margin-top:20px;padding:12px 32px;background:#f5a623;color:#000;border:none;
         font-size:16px;font-weight:bold;cursor:pointer;border-radius:4px}
</style></head><body>${body}</body></html>`;
}

const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;

    // ─── Mock concert page — immediate redirect into queue ───
    if (pathname === '/mock-concert') {
        res.writeHead(302, { Location: '/queue-it-sim' });
        res.end();
        return;
    }

    // ─── Queue-it simulator ─────────────────────────────────
    //  URL contains "queue-it" so the bot's detection triggers.
    if (pathname === '/queue-it-sim') {
        const page = html(`
<div class="wrap">
  <h1>Virtual Waiting Room</h1>
  <p>You are now in line. Please do not refresh this page.</p>

  <div class="pos" id="MainPart_LblYourNumber">${QUEUE_START}</div>

  <div class="eta wait-time" id="MainPart_LblExpectedWaitingTime">
    Estimated wait: calculating...
  </div>

  <div class="progress-bar-wrap">
    <div class="progress-bar" id="divProgressBar" style="width:0%"></div>
  </div>

  <p class="note">Mock Queue-it — ${QUEUE_SEC}s countdown, start pos ${QUEUE_START}</p>
</div>

<script>
const TOTAL   = ${QUEUE_SEC};
const START   = ${QUEUE_START};
const begun   = Date.now();

function tick() {
    const elapsed = (Date.now() - begun) / 1000;
    const pct     = Math.min(elapsed / TOTAL, 1);
    const pos     = Math.max(Math.round(START * (1 - pct)), 0);
    const remSec  = Math.max(Math.ceil(TOTAL - elapsed), 0);
    const mins    = Math.floor(remSec / 60);
    const secs    = remSec % 60;

    document.getElementById('MainPart_LblYourNumber').textContent = pos;
    document.getElementById('MainPart_LblExpectedWaitingTime').textContent =
        'Estimated wait: ' + (mins > 0 ? mins + ' min ' : '') + secs + ' sec';
    document.getElementById('divProgressBar').style.width = (pct * 100).toFixed(1) + '%';

    if (pct >= 1) {
        document.getElementById('MainPart_LblYourNumber').textContent = "It's your turn!";
        document.getElementById('MainPart_LblExpectedWaitingTime').textContent = 'Redirecting...';
        setTimeout(() => { window.location.href = '/mock-booking'; }, 800);
        return;
    }
    setTimeout(tick, 500);
}
tick();
</script>`, 'Queue-it Waiting Room');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page);
        return;
    }

    // ─── Mock booking / zones page (zone map) ─────────────
    if (pathname === '/mock-booking') {
        const zones = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'LM5'];

        const areaHtml = zones.map(z =>
            `<area shape="rect" coords="0,0,100,100" href="zones.php?zone=${z}" title="${z}">`
        ).join('\n');

        const page = html(`
<div class="wrap">
  <h1>Mock Booking — Zone Map</h1>
  <p>Select a zone (bot matches zone name inside area href)</p>

  <map name="zonemap">
    ${areaHtml}
  </map>
  <img usemap="#zonemap" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
       width="1" height="1" style="display:none">

  <div class="zone-map">
    ${zones.map(z => `<span style="padding:6px 14px;border:1px solid #f5a623;color:#f5a623;border-radius:4px;cursor:pointer"
       onclick="window.location.href='zones.php?zone=${z}'">${z}</span>`).join('')}
  </div>
</div>`, 'Mock Booking');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page);
        return;
    }

    // ─── Mock seat selection (after zone click) ─────────────
    if (pathname === '/zones.php') {
        const zone = parsed.query.zone || '??';
        const seats = Array.from({ length: 20 }, (_, i) => `${zone}-${i + 1}`);

        const seatHtml = seats.map(s =>
            `<span class="seatuncheck" id="${s}" title="${s}">${s}</span>`
        ).join(' ');

        const page = html(`
<div class="wrap">
  <h1>Zone ${zone} — Seat Selection</h1>
  <p>Pick your seats (bot clicks .seatuncheck elements)</p>

  <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:16px 0">
    ${seatHtml}
  </div>

  <button id="booknow" onclick="window.location.href='/mock-payment'">BOOK NOW</button>
</div>

<script>
document.querySelectorAll('.seatuncheck').forEach(el => {
    el.addEventListener('click', () => el.classList.toggle('selected'));
});
</script>`, 'Mock Seats');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page);
        return;
    }

    // ─── Mock payment page ──────────────────────────────────
    if (pathname === '/mock-payment') {
        const page = html(`
<div class="wrap">
  <h1 style="color:#2a5">Payment Successful (Mock)</h1>
  <p style="font-size:18px;color:#eee;margin:20px 0">The bot completed the full queue → booking → payment flow.</p>
  <p>URL: <code style="color:#f5a623">${req.url}</code></p>
  <p class="note">This URL is what the bot emits as the payment-url event.</p>
</div>`, 'Mock Payment');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page);
        return;
    }

    // ─── Landing / instructions ─────────────────────────────
    const page = html(`
<div class="wrap">
  <h1>Queue-it Test Server</h1>
  <p style="color:#f5a623;font-size:16px;margin-bottom:16px">Running on port ${PORT}</p>

  <div style="text-align:left;background:#111;padding:16px;border-radius:6px;font-size:13px;line-height:1.8">
    <p><strong>Endpoints:</strong></p>
    <p><code>/mock-concert</code> → redirects to queue (like TTM would)</p>
    <p><code>/queue-it-sim</code> → simulated Queue-it waiting room</p>
    <p><code>/mock-booking</code> → fake booking page with zones + seats</p>
    <p><code>/mock-payment</code> → success page</p>
    <br>
    <p><strong>Config:</strong></p>
    <p>QUEUE_SECONDS=${QUEUE_SEC}  QUEUE_START=${QUEUE_START}</p>
    <br>
    <p><strong>Usage:</strong></p>
    <p>1. Start this server: <code>npm run test:queue</code></p>
    <p>2. In the dashboard, click <code>[ TEST QUEUE ]</code></p>
    <p>3. The bot runs the full flow against this mock</p>
  </div>
</div>`);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page);
});

server.listen(PORT, () => {
    console.log(`\n  Queue-it Mock Server`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Queue: ${QUEUE_START} positions, ${QUEUE_SEC}s wait\n`);
});
