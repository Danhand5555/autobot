const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { CaptchaBridge } = require('./bridge/CaptchaBridge');
const { TTMDiscovery } = require('./discovery');

puppeteer.use(StealthPlugin());

const CHROME_DEBUG_PORT = 9222;
const CHROME_DEBUG_URL = `http://127.0.0.1:${CHROME_DEBUG_PORT}`;

async function connectToExistingBrowser() {
    try {
        const res = await fetch(`${CHROME_DEBUG_URL}/json/version`);
        const data = await res.json();
        const browser = await puppeteer.connect({
            browserWSEndpoint: data.webSocketDebuggerUrl,
            defaultViewport: null,
        });
        console.log("\x1b[32m[SYSTEM] Connected to your Chrome browser!\x1b[0m");
        return browser;
    } catch (e) {
        return null;
    }
}

async function launchFreshBrowser(config) {
    const BROWSER_DATA_DIR = path.join(__dirname, '..', 'browser-data');
    console.log("[SYSTEM] Launching new browser...");
    const browser = await puppeteer.launch({
        headless: !config.headful,
        defaultViewport: null,
        args: [
            '--start-maximized',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--no-first-run',
            '--metrics-recording-only',
        ],
        userDataDir: BROWSER_DATA_DIR
    });
    return browser;
}

async function runBot() {
    const totalStart = Date.now();
    const configPath = path.join(__dirname, '..', 'config.json');
    if (!fs.existsSync(configPath)) {
        console.error("Please create a config.json file in the root directory!");
        process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Try existing Chrome first, fallback to launching new one
    let browser = await connectToExistingBrowser();
    let isExistingBrowser = !!browser;

    if (!browser) {
        console.log(`\x1b[33m[TIP] For fastest mode, start Chrome with:\x1b[0m`);
        console.log(`  ./start-chrome.sh\n`);
        browser = await launchFreshBrowser(config);
    }

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000); // Tighter timeout

    // Block heavy resources for fresh browser only
    if (!isExistingBrowser && config.lightweight !== false) {
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'font', 'media'].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });
    }

    const captchaBridge = new CaptchaBridge(page);
    const discovery = new TTMDiscovery(page, config);

    // Helper: only pause for CAPTCHA if one is actually detected
    const captchaGuard = async () => {
        if (await discovery.quickCaptchaCheck()) {
            await captchaBridge.waitForHumanResolution("Cloudflare challenge detected!");
        }
    };

    try {
        // 1. Login (auto-skips if already logged in)
        await discovery.login();
        await captchaGuard();

        // 2. Select Concert → Buy Now → Accept T&C
        await discovery.selectShow();

        // 3. Queue check
        if (page.url().includes("queue-it.net")) {
            console.log("\x1b[36m[QUEUE] Waiting room detected. Waiting...\x1b[0m");
            await page.waitForNavigation({ timeout: 0 });
            console.log("[QUEUE] Passed!");
        }
        await captchaGuard();

        // 4. Select Zone
        await discovery.selectZone();

        // 5. Select Seats & Book
        await discovery.selectSeats();

        const totalTime = Date.now() - totalStart;
        console.log(`\n\x1b[32m[SUCCESS] Done in ${totalTime}ms! Complete payment manually.\x1b[0m`);

        await new Promise(() => { }); // Keep open for payment

    } catch (err) {
        console.error("\x1b[31m[ERROR]\x1b[0m", err.message);
        process.stdout.write('\x07');
        console.log("[SYSTEM] Browser remains open for manual intervention.");
    }
}

module.exports = { runBot };
