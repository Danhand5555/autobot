import puppeteer from 'puppeteer-extra';
puppeteer.launch({headless: true, args: [
  '--start-maximized',
  '--window-size=1280,800'
]}).then(async b => {
    try {
        const pages = await b.pages();
        const p = pages.length > 0 ? pages[0] : await b.newPage();
        
        await p.exposeFunction('debugLog', (...msg) => console.log('BROWSER CMD:', ...msg));
        
        console.log("Going to TTM...") 
        await p.goto('https://www.thaiticketmajor.com', {waitUntil: 'domcontentloaded', timeout: 30000}); 
        
        console.log("Saving screenshot..."); 
        await p.screenshot({path: 'ttm.png'}); 
        console.log("Screenshot dumped to ttm.png");
        
        console.log("Page source content string length:", (await p.content()).length);
    } catch(err) {
       console.error("Test failed: ", err); 
    } finally {
       await b.close();
    }
});
