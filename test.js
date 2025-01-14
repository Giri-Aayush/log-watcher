const fs = require('fs');

// Log types and their corresponding messages
const logTypes = {
    INFO: [
        "User logged in successfully",
        "Database connection established",
        "Cache updated",
        "Request processed successfully",
        "File upload completed"
    ],
    WARNING: [
        "High memory usage detected",
        "API request slow response",
        "Database connection pool running low",
        "Cache miss rate increasing",
        "Disk space running low"
    ],
    ERROR: [
        "Database query failed",
        "API endpoint returned 500",
        "File processing error",
        "Authentication failed",
        "Network connection timeout"
    ]
};

let counter = 1;

// Generate a random log entry
function generateLogEntry() {
    const types = Object.keys(logTypes);
    const type = types[Math.floor(Math.random() * types.length)];
    const messages = logTypes[type];
    const message = messages[Math.floor(Math.random() * messages.length)];
    const timestamp = Date.now();
    
    return `${timestamp} [${type}] ${message} (ID: ${counter})`;
}

// Initialize log file
const initialLog = generateLogEntry();
fs.writeFileSync("test.log", initialLog, (err) => {
    if(err) throw err;
    console.log("Test file initialized");
});

counter++;

// Generate new logs every second
setInterval(() => {
    const logEntry = generateLogEntry();
    fs.appendFile("test.log", "\n" + logEntry, (err) => {
        if(err) console.error(err);
        console.log("Log updated:", logEntry);
    });
    counter++;
}, 1000);

// Additional periodic events
setInterval(() => {
    // Generate a burst of related logs occasionally
    if (Math.random() < 0.1) { // 10% chance every 5 seconds
        const burstType = Math.random() < 0.5 ? 'ERROR' : 'WARNING';
        const timestamp = Date.now();
        const relatedLogs = [
            `${timestamp} [${burstType}] Initial ${burstType.toLowerCase()} detected (ID: ${counter++})`,
            `${timestamp + 1} [${burstType}] Additional details for previous ${burstType.toLowerCase()} (ID: ${counter++})`,
            `${timestamp + 2} [${burstType}] ${burstType} resolution attempted (ID: ${counter++})`
        ];
        
        fs.appendFile("test.log", "\n" + relatedLogs.join("\n"), (err) => {
            if(err) console.error(err);
            console.log("Burst logs added");
        });
    }
}, 5000);