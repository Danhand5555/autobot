/**
 * discovery.js
 * Contains logic specific to navigating the ThaiTicketMajor DOM.
 * Optimized for speed — minimal waits, smart detection.
 */

class TTMDiscovery {
    constructor(page, config) {
        this.page = page;
        this.config = config;
    }

    async login() {
        const t = Date.now();

        // First check: go to main page and see if already logged in
        console.log("[LOGIN] Checking login status...");
        await this.page.goto('https://www.thaiticketmajor.com/index.html', { waitUntil: 'domcontentloaded' });

        // Auto-click splash page if present
        const splashBtn = await this.page.$('a.btn-enter-site');
        if (splashBtn) {
            console.log("[LOGIN] Splash → clicking through...");
            await splashBtn.click();
            await this.page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => { });
        }

        // Check if already logged in
        const isLoggedIn = await this.page.evaluate(() => {
            const body = document.body.innerText || '';
            // If we see user-specific Thai text, we're logged in
            return body.includes('ข้อมูลส่วนตัว') || body.includes('ออกจากระบบ') ||
                !document.querySelector('.btn-signin');
        }).catch(() => false);

        if (isLoggedIn) {
            console.log(`\x1b[32m[LOGIN] Already logged in! (${Date.now() - t}ms)\x1b[0m`);
            return;
        }

        // Go DIRECTLY to the login page URL (skip unreliable button click)
        console.log("[LOGIN] Navigating to login page...");
        const redir = encodeURIComponent(this.config.concertUrl || '/index.html');
        await this.page.goto(
            `https://event.thaiticketmajor.com/user/signin.php?redir=${redir}`,
            { waitUntil: 'domcontentloaded' }
        );

        // Fill credentials
        await this.page.waitForSelector('input[name="username"]', { timeout: 5000 });
        await this.page.type('input[name="username"]', this.config.email, { delay: 0 });
        await this.page.type('input[name="password"]', this.config.password, { delay: 0 });

        // Click the submit button
        await this.page.click('button.btn-red.btn-signin');
        await this.page.waitForNavigation({ waitUntil: 'domcontentloaded' });
        console.log(`\x1b[32m[LOGIN] Logged in! (${Date.now() - t}ms)\x1b[0m`);
    }

    async selectShow() {
        const t = Date.now();
        console.log(`[FLOW] Opening concert page...`);
        await this.page.goto(this.config.concertUrl, { waitUntil: 'domcontentloaded' });

        // Click Buy Now if present
        try {
            await this.page.waitForSelector('.btn-red.btn-buynow', { timeout: 3000 });
            await this.page.evaluate(() => {
                const btn = document.querySelector('.btn-red.btn-buynow');
                if (btn) btn.click();
            });
            console.log("[FLOW] Clicked Buy Now.");
            await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => { });
        } catch (e) {
            console.log("[FLOW] No Buy Now button. Proceeding...");
        }

        // Handle T&C page
        if (this.page.url().includes("verify_condition")) {
            console.log("[FLOW] Accepting terms...");
            await this.page.waitForSelector('#rdagree', { timeout: 3000 });
            await this.page.click('#rdagree');
            await this.page.click('#btn_verify');
            await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => { });
        }
        console.log(`[FLOW] Show selected. (${Date.now() - t}ms)`);
    }

    async selectZone() {
        const t = Date.now();
        console.log(`[FLOW] Selecting zone: ${this.config.zone}`);
        await this.page.waitForFunction(() => document.querySelectorAll('area').length > 0, { timeout: 10000 });

        const zoneFound = await this.page.evaluate((targetZone) => {
            const areas = document.querySelectorAll('area');
            for (const area of areas) {
                if ((area.getAttribute('href') || '').includes(targetZone)) {
                    area.click();
                    return true;
                }
            }
            return false;
        }, this.config.zone);

        if (zoneFound) {
            console.log(`[FLOW] Zone ${this.config.zone} clicked. (${Date.now() - t}ms)`);
        } else {
            console.log(`[WARNING] Zone ${this.config.zone} not found!`);
        }
    }

    async selectSeats() {
        const t = Date.now();
        console.log(`[FLOW] Finding ${this.config.seats} seat(s)...`);
        await this.page.waitForSelector('.seatuncheck', { timeout: 10000 });

        const seatsSelected = await this.page.evaluate((numSeats) => {
            const seats = document.querySelectorAll('.seatuncheck');
            if (seats.length < numSeats) return false;
            for (let i = 0; i < numSeats; i++) seats[i].click();
            return true;
        }, this.config.seats);

        if (seatsSelected) {
            console.log(`[FLOW] ${this.config.seats} seats selected! (${Date.now() - t}ms)`);
            try {
                await this.page.waitForSelector('#booknow', { timeout: 2000 });
                await this.page.click('#booknow');
                console.log("[FLOW] Clicked Book Now!");
            } catch (e) {
                console.log("[WARNING] Could not find #booknow button.");
            }
        } else {
            console.log("[WARNING] Not enough seats available.");
        }
    }

    /**
     * Quick inline CAPTCHA check — no separate CaptchaBridge call needed.
     * Returns true if a challenge was detected (bot should pause).
     */
    async quickCaptchaCheck() {
        const hasCaptcha = await this.page.evaluate(() => {
            return !!document.querySelector('#cf-please-wait') ||
                !!document.querySelector('.cf-turnstile') ||
                !!document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
                document.title.includes('Just a moment');
        }).catch(() => false);
        return hasCaptcha;
    }
}

module.exports = { TTMDiscovery };
