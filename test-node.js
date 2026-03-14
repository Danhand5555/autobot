const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    try {
        console.log("Launching test browser config without stealth error maybe...");
        const browser = await puppeteer.launch({headless: true, args: ["--start-maximized"]});
        let page = await browser.newPage();
        console.log("Navigating to ttm URL...");
        await page.goto("https://www.thaiticketmajor.com/concert/national-unity-concert.html", {waitUntil: 'networkidle2', timeout: 30000});
        
        let url = page.url();
        console.log("Landed on URL:", url);
        
        let title = await page.title();
        console.log("Page title:", title);

        await browser.close();
    } catch(err) {
        console.error("error:", err);
    }
})();
