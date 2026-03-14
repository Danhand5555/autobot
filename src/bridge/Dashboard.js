const { runBot } = require('../index');

function startDashboard() {
    console.log("=====================================");
    console.log("   🎫 THAITICKETMAJOR SNIPER BOT 🎫   ");
    console.log("=====================================\n");
    console.log("Starting bot process...\n");

    runBot().catch(err => {
        console.error("Fatal Error in Bot:", err);
        process.exit(1);
    });
}

if (require.main === module) {
    startDashboard();
}

module.exports = { startDashboard };
