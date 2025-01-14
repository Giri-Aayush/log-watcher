const events = require('events');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

// Circular Buffer implementation for efficient memory usage
class CircularBuffer {
    constructor(size) {
        this.size = size;
        this.data = new Array(size);
        this.head = 0;
        this.tail = 0;
        this.isFull = false;
    }

    push(item) {
        this.data[this.head] = item;
        this.head = (this.head + 1) % this.size;
        if (this.head === this.tail) {
            this.tail = (this.tail + 1) % this.size;
            this.isFull = true;
        }
    }

    getAll() {
        if (this.head === this.tail && !this.isFull) return [];
        
        const result = [];
        let current = this.tail;
        while (current !== this.head) {
            if (this.data[current]) {  // Only add if data exists
                result.push(this.data[current]);
            }
            current = (current + 1) % this.size;
        }
        return result;
    }
}

class EnhancedWatcher extends events.EventEmitter {
    constructor(options = {}) {
        super();
        this.filePath = options.filePath || 'test.log';
        this.maxLines = options.maxLines || 1000;
        this.bufferSize = options.bufferSize || 16384; // 16KB buffer
        this.compressionEnabled = options.compression || false;
        this.rotationSize = options.rotationSize || 5 * 1024 * 1024; // 5MB
        this.store = new CircularBuffer(this.maxLines);
        this.watchInterval = options.watchInterval || 1000;
        this.logStats = {
            totalLines: 0,
            errorCount: 0,
            warningCount: 0,
            lastUpdate: Date.now(),
            averageUpdateInterval: 0
        };
    }

    // Efficient log parsing with streaming
    parseLogLine(line) {
        try {
            // Update stats based on log type
            if (line.includes('[ERROR]')) {
                this.logStats.errorCount++;
            } else if (line.includes('[WARNING]')) {
                this.logStats.warningCount++;
            }
            
            return {
                content: line,
                timestamp: line.match(/^\d+/)?.[0] || Date.now(),
                type: line.includes('[ERROR]') ? 'ERROR' : 
                      line.includes('[WARNING]') ? 'WARNING' : 'INFO',
                hash: crypto.createHash('md5').update(line).digest('hex')
            };
        } catch (err) {
            console.error('Error parsing log line:', err);
            return null;
        }
    }

    // Keep all the other methods exactly as they were in the original
    // File size checking and rotation
    async checkFileRotation() {
        try {
            const stats = await fs.promises.stat(this.filePath);
            if (stats.size >= this.rotationSize) {
                const timestamp = Date.now();
                const newPath = `${this.filePath}.${timestamp}`;
                
                await fs.promises.rename(this.filePath, newPath);
                if (this.compressionEnabled) {
                    this.compressFile(newPath);
                }
                
                await fs.promises.writeFile(this.filePath, '');
                this.emit('fileRotated', newPath);
            }
        } catch (err) {
            console.error('Error during file rotation:', err);
        }
    }

    // Compress rotated logs
    async compressFile(filePath) {
        const gzip = zlib.createGzip();
        const source = fs.createReadStream(filePath);
        const destination = fs.createWriteStream(`${filePath}.gz`);
        
        return new Promise((resolve, reject) => {
            source.pipe(gzip).pipe(destination)
                .on('finish', () => {
                    fs.unlink(filePath, err => {
                        if (err) reject(err);
                        else resolve();
                    });
                })
                .on('error', reject);
        });
    }

    // Get file size efficiently
    getFileSize() {
        try {
            const stats = fs.statSync(this.filePath);
            return stats.size;
        } catch (err) {
            console.error('Error getting file size:', err);
            return 0;
        }
    }

    // Efficient file reading with streams
    async readLastLines(count) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            const stream = fs.createReadStream(this.filePath, {
                encoding: 'utf8',
                start: Math.max(0, this.getFileSize() - this.bufferSize)
            });

            stream.on('data', chunk => chunks.push(chunk));
            stream.on('error', reject);
            stream.on('end', () => {
                const content = chunks.join('');
                const lines = content.split('\n').filter(Boolean).slice(-count);
                resolve(lines);
            });
        });
    }

    // Main watch method with error handling and recovery
    async watch() {
        try {
            const currentSize = this.getFileSize();
            if (currentSize === 0) return;

            const newLines = await this.readLastLines(10);
            const parsedLines = [];
            
            for (const line of newLines) {
                const parsedLine = this.parseLogLine(line);
                if (parsedLine) {
                    this.store.push(parsedLine);
                    parsedLines.push(parsedLine);
                    this.logStats.totalLines++;
                }
            }

            // Update statistics
            const now = Date.now();
            this.logStats.averageUpdateInterval = 
                (this.logStats.averageUpdateInterval + (now - this.logStats.lastUpdate)) / 2;
            this.logStats.lastUpdate = now;

            if (parsedLines.length > 0) {
                this.emit('update', {
                    lines: parsedLines,
                    stats: this.logStats
                });
            }

            await this.checkFileRotation();
        } catch (err) {
            console.error('Error in watch cycle:', err);
            this.emit('error', err);
        }
    }

    // Start watching with automatic recovery
    async start() {
        try {
            // Initial load
            const initialLines = await this.readLastLines(this.maxLines);
            for (const line of initialLines) {
                const parsedLine = this.parseLogLine(line);
                if (parsedLine) {
                    this.store.push(parsedLine);
                    this.logStats.totalLines++;
                }
            }

            // Set up watching
            this.watcher = fs.watch(this.filePath, { persistent: true }, async (eventType) => {
                if (eventType === 'change') {
                    await this.watch();
                }
            });

            // Heartbeat checking
            this.heartbeat = setInterval(() => {
                if (Date.now() - this.logStats.lastUpdate > this.watchInterval * 3) {
                    this.emit('watcherStalled');
                    this.restart();
                }
            }, this.watchInterval);

            // Emit initial data
            this.emit('update', {
                lines: this.store.getAll(),
                stats: this.logStats
            });

            this.emit('started');
        } catch (err) {
            console.error('Error starting watcher:', err);
            this.emit('error', err);
        }
    }

    // Graceful shutdown
    async stop() {
        if (this.watcher) {
            this.watcher.close();
        }
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
        }
        this.emit('stopped');
    }

    // Auto-restart on failure
    async restart() {
        await this.stop();
        await this.start();
        this.emit('restarted');
    }

    // Get current statistics
    getStats() {
        return {
            ...this.logStats,
            currentBufferSize: this.store.getAll().length,
            maxBufferSize: this.maxLines,
            fileSize: this.getFileSize()
        };
    }
}

module.exports = EnhancedWatcher;