const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const path = require('path');
const EnhancedWatcher = require('./enhanced-watcher');

// Rate limiting for API protection
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});

// Create watcher instance
const watcher = new EnhancedWatcher({
    filePath: 'test.log',
    maxLines: 1000,
    compression: true,
    rotationSize: 5 * 1024 * 1024, // 5MB
    watchInterval: 1000
});

// Middleware
app.use(express.json());
app.use(limiter);
app.use(express.static('public')); // Serve static files from public directory

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        memory: process.memoryUsage(),
        logStats: watcher.getStats()
    });
});

// Main log endpoint
app.get(['/log', '/logs'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket connection handling
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    
    // Send initial data
    const initialData = {
        lines: watcher.store.getAll(),
        stats: watcher.getStats()
    };
    socket.emit('init', initialData);

    // Handle real-time updates
    watcher.on('update', (data) => {
        socket.emit('update-log', data);
    });

    // Handle file rotation events
    watcher.on('fileRotated', (newPath) => {
        socket.emit('file-rotated', { newPath });
    });

    // Handle errors
    watcher.on('error', (error) => {
        socket.emit('error', { message: error.message });
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

// Start the watcher
watcher.start().catch(err => {
    console.error('Failed to start watcher:', err);
    process.exit(1);
});

// Start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});