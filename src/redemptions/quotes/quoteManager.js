// src/redemptions/quotes/quoteManager.js
const fs = require('fs');
const path = require('path');
const config = require('../../config/config');

class QuoteManager {
    constructor() {
        this.quotesFile = path.join(config.dataPath, 'quotes.json');
        this.loadQuotes();
    }

    loadQuotes() {
        try {
            if (fs.existsSync(this.quotesFile)) {
                const fileContent = fs.readFileSync(this.quotesFile, 'utf8');
                this.quotes = fileContent.trim() ? JSON.parse(fileContent) : [];
            } else {
                this.quotes = [];
                this.saveQuotes();
            }
        } catch (error) {
            console.error('❌ Error loading quotes:', error);
            this.quotes = [];
            this.saveQuotes();
        }
    }

    saveQuotes() {
        try {
            fs.writeFileSync(this.quotesFile, JSON.stringify(this.quotes, null, 2));
        } catch (error) {
            console.error('❌ Error saving quotes:', error);
        }
    }

    addQuote(quoteData) {
        const quoteId = this.quotes.length + 1;
        const newQuote = {
            id: quoteId,
            quote: quoteData.quote,
            author: quoteData.author,
            savedBy: quoteData.savedBy,
            savedAt: new Date().toISOString(),
        };

        this.quotes.push(newQuote);
        this.saveQuotes();
        return quoteId;
    }

    getQuoteById(id) {
        const quote = this.quotes.find(q => q.id === id);
        return quote || null;
    }

    getRandomQuote() {
        if (this.quotes.length === 0) {
            return null;
        }
        return this.quotes[Math.floor(Math.random() * this.quotes.length)];
    }

    getTotalQuotes() {
        return this.quotes.length;
    }
}

module.exports = QuoteManager;