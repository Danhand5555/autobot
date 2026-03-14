const readline = require('readline');

class CaptchaBridge {
    constructor(page) {
        this.page = page;
    }

    /**
     * Prompts the user in the terminal to solve the CAPTCHA and press enter to continue.
     */
    async waitForHumanResolution(message = "CAPTCHA detected! Please solve it in the browser window.") {
        console.log(`\n\x1b[31m[ACTION REQUIRED]\x1b[0m ${message}`);
        // Beep sound
        process.stdout.write('\x07');
        console.log("\x1b[33mPress ENTER here in the terminal once you have solved it and the page has loaded.\x1b[0m\n");

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        return new Promise((resolve) => {
            rl.question('', () => {
                rl.close();
                console.log("[RESUMING] Resuming bot execution...");
                resolve();
            });
        });
    }

    /**
     * Automatically checks if a common CAPTCHA is visible (like Cloudflare or reCAPTCHA).
     */
    async checkAndHandle() {
        // Cloudflare Turnstile or similar challenges
        const isCloudflare = await this.page.evaluate(() => {
            return !!document.querySelector('#cf-please-wait') ||
                !!document.querySelector('.cf-turnstile') ||
                !!document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
                document.title.includes('Just a moment');
        }).catch(() => false);

        if (isCloudflare) {
            await this.waitForHumanResolution("Cloudflare challenge detected! Please pass the verification in the browser.");
        }
    }
}

module.exports = { CaptchaBridge };
