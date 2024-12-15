const fs = require('fs');
const path = require('path');

class QueueManager {
    constructor() {
        this.queueFile = path.join(__dirname, '..', '..', 'data', 'pendingQueue.json');        this.loadQueue();
    }

    loadQueue() {
        try {
            if (fs.existsSync(this.queueFile)) {
                const fileContent = fs.readFileSync(this.queueFile, 'utf8');
                // Check if file is empty or malformed
                if (!fileContent.trim()) {
                    this.pendingTracks = [];
                    this.saveQueue(); // Initialize with empty array
                } else {
                    this.pendingTracks = JSON.parse(fileContent);
                }
            } else {
                this.pendingTracks = [];
                this.saveQueue(); // Create new file with empty array
            }
        } catch (error) {
            console.error('Error loading queue file:', error);
            this.pendingTracks = [];
            this.saveQueue(); // Recover by creating new file
        }
    }

    saveQueue() {
        try {
            fs.writeFileSync(this.queueFile, JSON.stringify(this.pendingTracks, null, 2));
        } catch (error) {
            console.error('Error saving queue:', error);
        }
    }

    addToPendingQueue(track) {
        this.pendingTracks.push({
            ...track,
            addedAt: new Date().toISOString()
        });
        this.saveQueue();
    }

    clearQueue() {
        this.pendingTracks = [];
        this.saveQueue();
    }

    getPendingTracks() {
        return this.pendingTracks;
    }
}

module.exports = QueueManager;