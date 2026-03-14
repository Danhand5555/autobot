import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
puppeteer.use(StealthPlugin());

puppeteer.launch({headless: true}).then(async b => {
    try {
        const pages = await b.pages();
        const p = pages.length > 0 ? pages[0] : await b.newPage();
        
        console.log("Going to TTM concert...");
        // TTM base url as per reserve.py
        await p.goto('https://www.thaiticketmajor.com/concert/', {waitUntil: 'domcontentloaded'});
        console.log("URL ended up at:", p.url());
        console.log("Title is:", await p.title());

    } catch(err) {
       console.error("Test failed: ", err); 
    } finally {
       await b.close();
    }
});
