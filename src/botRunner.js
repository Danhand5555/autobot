/**
 * botRunner.js
 * Wraps the bot flow with a log callback for real-time streaming to the dashboard.
 */

require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const {
    CapSolver,
    AntiTurnstileTaskProxyLess,
    ReCaptchaV2TaskProxyLess,
    ReCaptchaV2EnterpriseTaskProxyLess,
    ReCaptchaV3TaskProxyLess,
} = require('@captcha-libs/capsolver');
const path = require('path');

// Set TTM_FAST_MODE=1 to skip stealth plugin for max speed
if (process.env.TTM_FAST_MODE !== '1') puppeteer.use(StealthPlugin());

const capSolver = process.env.CAPSOLVER_KEY
    ? new CapSolver({ clientKey: process.env.CAPSOLVER_KEY })
    : null;

const os = require('os');

const IS_LINUX = os.platform() === 'linux';
const CHROME_DEBUG_PORT = 9222;
const CHROME_DEBUG_URL = `http://127.0.0.1:${CHROME_DEBUG_PORT}`;

// macOS paths — on Linux VM the bundled Chromium is used automatically
const BROWSER_PATHS = IS_LINUX ? {} : {
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    operagx: '/Applications/Opera GX.app/Contents/MacOS/Opera',
    brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
};

class BotRunner {
    constructor(config, emit) {
        this.config = config;
        this.emit = emit;
        this.browser = null;
        this.page = null;
        this.stopped = false;
    }

    log(msg, type = 'info') {
        const ts = new Date().toLocaleTimeString('th-TH');
        this.emit('log', { type, message: msg, time: ts });
    }

    async connectToExistingBrowser() {
        // On Linux VM or headless mode, never try to attach — always launch fresh
        const browserKey = this.config.browser || (IS_LINUX ? 'headless' : 'chrome');
        if (IS_LINUX || browserKey === 'headless') return null;

        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 3000);
            const res = await fetch(`${CHROME_DEBUG_URL}/json/version`, { signal: controller.signal });
            clearTimeout(t);
            const data = await res.json();
            return await puppeteer.connect({
                browserWSEndpoint: data.webSocketDebuggerUrl,
                defaultViewport: null,
            });
        } catch (e) {
            return null;
        }
    }

    async launchFreshBrowser() {
        const BROWSER_DATA_DIR = path.join(__dirname, '..', 'browser-data');
        const browserKey = this.config.browser || (IS_LINUX ? 'headless' : 'chrome');
        const isHeadless = browserKey === 'headless' || IS_LINUX;
        const executablePath = BROWSER_PATHS[browserKey];

        const args = [
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--no-first-run',
            '--metrics-recording-only',
        ];
        // VM-specific flags
        if (IS_LINUX) {
            args.push('--no-sandbox', '--disable-setuid-sandbox', '--single-process');
        } else {
            args.push('--start-maximized');
        }

        const opts = {
            headless: isHeadless,
            defaultViewport: null,
            args,
            userDataDir: BROWSER_DATA_DIR,
        };

        if (executablePath) opts.executablePath = executablePath;

        this.log(`Launching ${isHeadless ? 'headless' : browserKey}...`, 'system');
        return await puppeteer.launch(opts);
    }

    // Navigate and wait for domcontentloaded, return false if stopped
    async goto(url, timeout = 30000) {
        if (this.stopped) return false;
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        return !this.stopped;
    }

    async run() {
        const totalStart = Date.now();
        const config = this.config;
        const fastMode = config.fastMode === true || config.fastMode === 'true';

        try {
            // === CONNECT / LAUNCH BROWSER ===
            this.log('Connecting to browser...', 'system');
            this.browser = await this.connectToExistingBrowser();

            if (this.browser) {
                this.log('Connected to existing browser.', 'success');
            } else {
                this.log('No browser found — launching new one...', 'warn');
                this.browser = await this.launchFreshBrowser();
            }

            if (this.stopped) return;

            this.page = await this.browser.newPage();
            this.page.setDefaultNavigationTimeout(30000);

            // Block images, fonts, media and known tracker domains for speed.
            // Exception: images from booking.thaiticketmajor.com are allowed — that's the seat map.
            await this.page.setRequestInterception(true);
            const BLOCKED_TYPES = ['stylesheet', 'font', 'media', 'ping'];
            const BLOCKED_IMAGE_DOMAINS = [
                'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
                'googlesyndication.com', 'facebook.com', 'facebook.net',
                'hotjar.com', 'clarity.ms', 'youtube.com',
                // Block images from the main site (banners, promos) but NOT booking subdomain
                'thaiticketmajor.com/images', 'thaiticketmajor.com/upload',
            ];
            const BLOCKED_DOMAINS = [
                'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
                'googlesyndication.com', 'facebook.com', 'facebook.net',
                'hotjar.com', 'clarity.ms', 'youtube.com',
            ];
            this.page.on('request', (req) => {
                const type = req.resourceType();
                const u = req.url();
                if (BLOCKED_TYPES.includes(type)) { req.abort(); return; }
                if (BLOCKED_DOMAINS.some(d => u.includes(d))) { req.abort(); return; }
                // Block images except from the booking subdomain (seat map lives there)
                if (type === 'image' && !u.includes('booking.thaiticketmajor.com')) {
                    req.abort(); return;
                }
                req.continue();
            });

            // === LOGIN (skip when running against mock server) ===
            if (config.testMode) {
                this.log('TEST MODE — skipping login', 'system');
            } else {
                const loginStart = Date.now();
                this.log('Checking login status...', 'info');

                const redir = encodeURIComponent(config.concertUrl || '/index.html');
                const loginURL = `https://event.thaiticketmajor.com/user/signin.php?redir=${redir}`;
                if (!await this.goto(loginURL, 20000)) return;

                const isLoggedIn = !this.page.url().includes('signin');

                if (isLoggedIn) {
                    this.log(`Already logged in! (${Date.now() - loginStart}ms)`, 'success');
                } else {
                    this.log('Filling credentials...', 'info');
                    await this.page.waitForSelector('input[name="username"]', { timeout: 15000 });
                    await this.page.evaluate((email, password) => {
                        document.querySelector('input[name="username"]').value = email;
                        document.querySelector('input[name="password"]').value = password;
                    }, config.email, config.password);
                    await this.page.click('button.btn-red.btn-signin');
                    await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
                    this.log(`Logged in! (${Date.now() - loginStart}ms)`, 'success');
                }

                await this.captchaGuard();
                if (this.stopped) return;
            }

            // === TIMED ENTRY — wait until sale opens ===
            if (config.saleOpensAt) {
                const target = new Date(config.saleOpensAt).getTime();
                if (!isNaN(target) && target > Date.now()) {
                    this.log(`Sale opens at ${config.saleOpensAt} — standing by...`, 'info');
                    this.emit('status', 'standby');

                    // Keepalive: ping TTM every 10 min to prevent session expiry during long waits
                    const KEEPALIVE_INTERVAL = 10 * 60 * 1000;
                    let lastKeepalive = Date.now();

                    while (!this.stopped) {
                        const remaining = target - Date.now();
                        if (remaining <= 0) break;

                        // Emit countdown every 500ms to the UI
                        const s = Math.floor(remaining / 1000) % 60;
                        const m = Math.floor(remaining / 60000) % 60;
                        const h = Math.floor(remaining / 3600000);
                        const pad = n => String(n).padStart(2, '0');
                        const countdown = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
                        this.emit('countdown', countdown);

                        // Session keepalive — fetch a lightweight TTM endpoint in-page
                        if (Date.now() - lastKeepalive >= KEEPALIVE_INTERVAL && this.page) {
                            try {
                                await this.page.evaluate(() =>
                                    fetch('https://event.thaiticketmajor.com/user/checklogin.php', {
                                        credentials: 'include',
                                        cache: 'no-store',
                                    }).catch(() => {})
                                );
                                this.log('Session keepalive ping sent', 'system');
                            } catch { /* page might be navigated away — non-fatal */ }
                            lastKeepalive = Date.now();
                        }

                        const sleepMs = Math.min(remaining, 500);
                        await new Promise(r => setTimeout(r, sleepMs));
                    }

                    if (this.stopped) return;
                    this.emit('countdown', null);
                    this.log('SALE OPENED — firing!', 'success');
                    this.emit('status', 'running');
                }
            }

            // === NAVIGATE TO BOOKING PAGE ===
            const showStart = Date.now();

            if (config.testMode) {
                this.log('TEST MODE — navigating to mock concert...', 'system');
                if (!await this.goto(config.concertUrl, 15000)) return;
            } else if (config.bookingUrl) {
                this.log('Jumping to booking page...', 'info');
                if (!await this.goto(config.bookingUrl, 15000)) return;
            } else {
                this.log('Opening concert page...', 'info');
                if (!await this.goto(config.concertUrl, 15000)) return;

                try {
                    await this.page.waitForSelector('.btn-red.btn-buynow', { timeout: 2000 });
                    await this.page.evaluate(() => {
                        document.querySelector('.btn-red.btn-buynow')?.click();
                    });
                    this.log('Clicked Buy Now!', 'info');
                    await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
                } catch (e) {
                    this.log('No Buy Now button, proceeding...', 'info');
                }
            }

            if (this.stopped) return;

            // === T&C ===
            if (this.page.url().includes('verify_condition')) {
                this.log('Accepting T&C...', 'info');
                try {
                    await this.page.waitForSelector('#rdagree', { timeout: 3000 });
                    await this.page.evaluate(() => {
                        document.querySelector('#rdagree')?.click();
                        document.querySelector('#btn_verify')?.click();
                    });
                    await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
                    this.log('T&C accepted!', 'success');
                } catch (e) {
                    this.log('Could not accept T&C automatically', 'warn');
                }
            }

            // === QUEUE — poll URL + scrape position ===
            if (this.isQueueUrl(this.page.url())) {
                this.log('IN QUEUE — waiting for your turn...', 'warn');
                this.emit('status', 'queue');

                let lastPos = '';
                let passedQueue = false;
                let consecutiveErrors = 0;

                while (!this.stopped) {
                    // Guard against page being closed mid-loop
                    if (!this.page) break;

                    let currentUrl;
                    try { currentUrl = this.page.url(); } catch { break; }

                    // Exited queue — URL no longer matches queue patterns
                    if (!this.isQueueUrl(currentUrl)) {
                        passedQueue = true;
                        break;
                    }

                    // Scrape queue position / ETA / progress from Queue-it's DOM.
                    // IDs confirmed from Queue-it's official sample theme (customtheme.zip).
                    const queueInfo = await this.page.evaluate(() => {
                        // Queue number — official IDs + common fallbacks
                        const posEl = document.querySelector(
                            '[id*="QueueNumber"], [id*="UsersInLineAheadOfYou"], ' +
                            '#MainPart_lbQueueNumberText, #MainPart_lbUsersInLineAheadOfYouText, ' +
                            '#MainPart_LblYourNumber, .queue-position, [id*="position"], ' +
                            '.qc-body__message, [class*="waiting"] h1, [class*="waiting"] h2'
                        );
                        // Wait time — official + fallbacks
                        const etaEl = document.querySelector(
                            '#MainPart_LblExpectedWaitingTime, [id*="ExpectedWait"], ' +
                            '.wait-time, [class*="waittime"], [class*="wait-time"], ' +
                            '.time-box'
                        );
                        // Progress bar — official theme uses .progressbar inside holder
                        const progressEl = document.querySelector(
                            '#MainPart_ulProgressbarBox_Holder_Processbar, ' +
                            '#divProgressBar, .progressbar, .progress-bar, [class*="progress"]'
                        );
                        const progress = progressEl
                            ? (progressEl.style?.width || progressEl.getAttribute('aria-valuenow') || '')
                            : '';

                        return {
                            pos: posEl?.textContent.replace(/\s+/g, ' ').trim() || '',
                            eta: etaEl?.textContent.replace(/\s+/g, ' ').trim() || '',
                            progress,
                        };
                    }).catch(() => {
                        consecutiveErrors++;
                        return { pos: '', eta: '', progress: '' };
                    });

                    // If evaluate keeps failing the page likely redirected (context destroyed)
                    if (consecutiveErrors >= 3) {
                        try {
                            const url = this.page.url();
                            if (!this.isQueueUrl(url)) { passedQueue = true; break; }
                        } catch { break; }
                        consecutiveErrors = 0;
                    }

                    // Build status line
                    const parts = [];
                    if (queueInfo.pos) parts.push(queueInfo.pos);
                    if (queueInfo.eta) parts.push(`ETA: ${queueInfo.eta}`);
                    if (queueInfo.progress) parts.push(`${queueInfo.progress}`);
                    const statusLine = parts.join(' | ') || 'waiting...';

                    if (statusLine !== lastPos) {
                        this.log(`QUEUE > ${statusLine}`, 'warn');
                        this.emit('queue-status', { pos: queueInfo.pos, eta: queueInfo.eta, progress: queueInfo.progress });
                        lastPos = statusLine;
                    }

                    // Wait 2s — race a sleep against navigation so we detect exit immediately
                    await Promise.race([
                        new Promise(r => setTimeout(r, 2000)),
                        this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
                    ]);
                }

                if (this.stopped) return;
                if (passedQueue) {
                    this.emit('queue-status', null);
                    this.log(`Passed the queue! (${Date.now() - showStart}ms)`, 'success');
                    this.emit('status', 'running');
                }
            }

            // === SELECT ROUND (fallback if no bookingUrl) ===
            if (!config.bookingUrl && config.round && String(config.round).trim()) {
                const roundInput = String(config.round).trim();
                this.log(`📅 Selecting round: ${roundInput}`, 'info');
                try {
                    await this.page.waitForSelector('select#rdId', { timeout: 5000 });
                    const roundSelected = await this.page.evaluate((target) => {
                        const sel = document.querySelector('select#rdId');
                        if (!sel) return false;
                        const targetLower = target.toLowerCase();
                        for (const opt of sel.options) {
                            const idx = Array.from(sel.options).indexOf(opt);
                            if (opt.value === target ||
                                opt.text.toLowerCase().includes(targetLower) ||
                                (parseInt(target) && idx === parseInt(target) - 1)) {
                                sel.value = opt.value;
                                sel.dispatchEvent(new Event('change', { bubbles: true }));
                                return opt.text;
                            }
                        }
                        return false;
                    }, roundInput);

                    if (roundSelected) {
                        this.log(`✅ Round selected: ${roundSelected}`, 'success');
                        await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
                    } else {
                        this.log(`⚠️ Round "${roundInput}" not found, using default`, 'warn');
                    }
                } catch (e) {
                    this.log('ℹ️ No round selector found', 'info');
                }
            }

            this.log(`🎵 On booking page! (${Date.now() - showStart}ms)`, 'success');
            await this.captchaGuard();
            if (this.stopped) return;

            // === SELECT ZONE ===
            const zoneStart = Date.now();
            const zone = (config.zone || '').toUpperCase().replace(/\s+/g, '');
            this.log(`🗺️ Selecting zone: ${zone}`, 'info');

            // Retry zone map load up to 3 times — a slow page after queue exit is common
            const ZONE_RETRIES = 3;
            let zoneMapLoaded = false;
            for (let attempt = 1; attempt <= ZONE_RETRIES; attempt++) {
                try {
                    await this.page.waitForFunction(
                        () => document.querySelectorAll('area').length > 0,
                        { timeout: fastMode ? 5000 : 10000, polling: 50 }
                    );
                    zoneMapLoaded = true;
                    break;
                } catch (e) {
                    if (attempt < ZONE_RETRIES && !this.stopped) {
                        this.log(`Zone map not ready (attempt ${attempt}/${ZONE_RETRIES}) — reloading...`, 'warn');
                        await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                        await new Promise(r => setTimeout(r, 800));
                    }
                }
            }

            if (!zoneMapLoaded) {
                this.log('❌ Zone map not found after retries — check booking URL', 'error');
                this.emit('status', 'error');
                return;
            }

            const zoneFound = await this.page.evaluate((targetZone) => {
                const areas = document.querySelectorAll('area');
                for (const area of areas) {
                    const href = (area.getAttribute('href') || '').toUpperCase().replace(/\s+/g, '');
                    if (href.includes(targetZone)) {
                        area.click();
                        return true;
                    }
                }
                return false;
            }, zone);

            if (!zoneFound) {
                this.log(`❌ Zone ${zone} not found!`, 'error');
                this.emit('status', 'error');
                return;
            }

            this.log(`✅ Zone ${zone} clicked! (${Date.now() - zoneStart}ms)`, 'success');

            // Race navigation against seat map appearing — proceed as soon as either fires
            await Promise.race([
                this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
                this.page.waitForSelector('.seatuncheck', { timeout: 10000 }).catch(() => {}),
            ]);

            if (this.stopped) return;

            // === SELECT SEATS ===
            const seatStart = Date.now();
            const numSeats = parseInt(config.seats) || 2;
            const seatMode = config.seatMode || 'any';
            const preferSeats = (config.preferSeats || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

            if (seatMode === 'prefer' && preferSeats.length > 0) {
                this.log(`⭐ Looking for preferred seats: ${preferSeats.join(', ')}`, 'info');
            } else {
                this.log(`🎲 Finding ${numSeats} available seat(s)...`, 'info');
            }

            try {
                await this.page.waitForSelector('.seatuncheck', { timeout: fastMode ? 5000 : 10000 });
            } catch (e) {
                this.log('❌ No available seats found on seat map', 'error');
                this.emit('status', 'error');
                return;
            }

            const seatsSelected = await this.page.evaluate(({ numSeats, seatMode, preferSeats }) => {
                const allSeats = Array.from(document.querySelectorAll('.seatuncheck'));

                if (seatMode === 'prefer' && preferSeats.length > 0) {
                    let found = 0;
                    for (const seat of allSeats) {
                        const seatId = (seat.id || seat.title || seat.innerText || seat.getAttribute('data-seat') || '').toUpperCase().trim();
                        if (preferSeats.includes(seatId)) {
                            seat.click();
                            found++;
                            if (found >= numSeats) break;
                        }
                    }
                    if (found > 0) return found;
                }

                if (allSeats.length < numSeats) return 0;
                for (let i = 0; i < numSeats; i++) allSeats[i].click();
                return numSeats;
            }, { numSeats, seatMode, preferSeats });

            if (!seatsSelected) {
                this.log(`❌ Not enough seats available (need ${numSeats})`, 'error');
                this.emit('status', 'error');
                return;
            }

            this.log(`✅ ${seatsSelected} seat(s) selected! (${Date.now() - seatStart}ms)`, 'success');

            // Click Book Now
            try {
                await this.page.waitForSelector('#booknow', { timeout: 2000 });
                await this.page.click('#booknow');
                this.log('🎉 Clicked Book Now!', 'success');
                // Wait for navigation to payment page
                await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
            } catch (e) {
                this.log('⚠️ Could not find #booknow button — check page', 'warn');
            }

            // Capture the payment/checkout URL and send it to the UI
            if (this.page && !this.stopped) {
                const paymentUrl = this.page.url();
                if (paymentUrl && !paymentUrl.includes('zones.php')) {
                    this.emit('payment-url', paymentUrl);
                    this.log('Payment page ready — tap the link in the dashboard!', 'success');
                }
            }

            const totalTime = Date.now() - totalStart;
            this.log(`🎉 DONE in ${totalTime}ms! Complete your payment in the browser.`, 'success');
            this.emit('status', 'success');

            this.log('⏳ Waiting for you to finish payment... (tap Stop when done)', 'info');
            while (!this.stopped) {
                await new Promise(r => setTimeout(r, 3000));
            }

        } catch (err) {
            if (this.stopped) return;
            this.log(`❌ Error: ${err.message}`, 'error');
            this.emit('status', 'error');

            this.log('⏳ Browser stays open — fix manually or tap Stop', 'info');
            while (!this.stopped) {
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }

    isQueueUrl(url) {
        if (!url) return false;
        return url.includes('queue-it.net') ||
               url.includes('queue-it') ||
               url.includes('queue.thaiticketmajor');
    }

    async captchaGuard() {
        if (!this.page || this.stopped) return;

        // Detect what type of captcha is present
        const captchaInfo = await this.page.evaluate(() => {
            // Cloudflare Turnstile
            const turnstile = document.querySelector('.cf-turnstile, [data-sitekey]');
            if (turnstile || document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
                document.querySelector('#cf-please-wait') || document.title.includes('Just a moment')) {
                const sitekey = turnstile?.getAttribute('data-sitekey') || '';
                return { type: 'turnstile', sitekey };
            }
            // reCaptcha v2
            const rc2 = document.querySelector('.g-recaptcha, iframe[src*="recaptcha/api2"], iframe[src*="recaptcha/enterprise"]');
            if (rc2) {
                const sitekey = document.querySelector('.g-recaptcha')?.getAttribute('data-sitekey') ||
                    (rc2.src?.match(/[?&]k=([^&]+)/)?.[1]) || '';
                const isEnterprise = rc2.src?.includes('enterprise') || false;
                return { type: isEnterprise ? 'recaptchav2enterprise' : 'recaptchav2', sitekey };
            }
            // reCaptcha v3 (badge or grecaptcha.execute calls)
            if (window.grecaptcha && document.querySelector('.grecaptcha-badge')) {
                const scripts = Array.from(document.querySelectorAll('script[src*="recaptcha"]'));
                const match = scripts[0]?.src?.match(/[?&]render=([^&]+)/);
                const sitekey = match?.[1] || '';
                return { type: 'recaptchav3', sitekey };
            }
            return null;
        }).catch(() => null);

        if (!captchaInfo) return;

        this.log(`🛡️ CAPTCHA detected: ${captchaInfo.type}`, 'warn');

        // Auto-solve if CapSolver is configured
                if (capSolver && captchaInfo.sitekey) {
                try {
                    this.log('🤖 Auto-solving via CapSolver...', 'system');
                    this.emit('status', 'captcha');
                    const pageUrl = this.page.url();
                    let token = '';

                    if (captchaInfo.type === 'turnstile') {
                        const result = await capSolver.solve(
                            new AntiTurnstileTaskProxyLess({ websiteURL: pageUrl, websiteKey: captchaInfo.sitekey })
                        );
                        token = result.solution?.token || '';
                    } else if (captchaInfo.type === 'recaptchav2enterprise') {
                        const result = await capSolver.solve(
                            new ReCaptchaV2EnterpriseTaskProxyLess({ websiteURL: pageUrl, websiteKey: captchaInfo.sitekey })
                        );
                        token = result.solution?.gRecaptchaResponse || '';
                    } else if (captchaInfo.type === 'recaptchav2') {
                        const result = await capSolver.solve(
                            new ReCaptchaV2TaskProxyLess({ websiteURL: pageUrl, websiteKey: captchaInfo.sitekey })
                        );
                        token = result.solution?.gRecaptchaResponse || '';
                    } else if (captchaInfo.type === 'recaptchav3') {
                        const result = await capSolver.solve(
                            new ReCaptchaV3TaskProxyLess({ websiteURL: pageUrl, websiteKey: captchaInfo.sitekey, pageAction: 'login' })
                        );
                        token = result.solution?.gRecaptchaResponse || '';
                    }

                if (token) {
                    // Inject solved token into page
                    await this.page.evaluate((t, ctype) => {
                        if (ctype === 'turnstile') {
                            // Set hidden input and trigger callback
                            const input = document.querySelector('input[name="cf-turnstile-response"]');
                            if (input) input.value = t;
                            // Fire turnstile callback if registered
                            const widget = document.querySelector('.cf-turnstile');
                            const cb = widget?.getAttribute('data-callback');
                            if (cb && window[cb]) window[cb](t);
                        } else {
                            // reCaptcha — set textarea and trigger callback
                            const ta = document.querySelector('#g-recaptcha-response, [name="g-recaptcha-response"]');
                            if (ta) { ta.value = t; ta.style.display = 'block'; }
                            if (window.grecaptcha?.getResponse) {
                                // find callback from widget config
                                try {
                                    const cfg = window.___grecaptcha_cfg?.clients;
                                    if (cfg) {
                                        Object.values(cfg).forEach(c => {
                                            Object.values(c).forEach(v => {
                                                if (v?.callback) v.callback(t);
                                            });
                                        });
                                    }
                                } catch {}
                            }
                        }
                    }, token, captchaInfo.type);

                    this.log('✅ CAPTCHA solved automatically!', 'success');
                    this.emit('status', 'running');
                    await new Promise(r => setTimeout(r, 800));
                    return;
                }
            } catch (e) {
                this.log(`⚠️ CapSolver error: ${e.message || e} — falling back to manual`, 'warn');
            }
        }

        // Manual fallback — pause and wait for user to solve in browser
        this.log('🛡️ Solve the CAPTCHA in the browser window.', 'error');
        this.emit('status', 'captcha');

        while (!this.stopped) {
            await new Promise(r => setTimeout(r, 1500));
            const still = await this.page.evaluate(() => {
                return !!document.querySelector('#cf-please-wait') ||
                    !!document.querySelector('.cf-turnstile') ||
                    !!document.querySelector('.g-recaptcha') ||
                    !!document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
                    document.title.includes('Just a moment');
            }).catch(() => false);
            if (!still) break;
        }

        if (this.stopped) return;
        this.log('✅ CAPTCHA resolved!', 'success');
        this.emit('status', 'running');
    }

    stop() {
        this.stopped = true;
        this.log('🛑 Bot stopped.', 'warn');
        if (this.page) {
            this.page.close().catch(() => {});
            this.page = null;
        }
    }
}

module.exports = { BotRunner };
