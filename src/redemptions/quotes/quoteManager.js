// src/redemptions/quotes/quoteManager.js
class QuoteManager {
    constructor() {
        this.dbManager = null;
    }

    async init(dbManager) {
        this.dbManager = dbManager;
    }

    async addQuote(quoteData) {
        try {
            const sql = `
                INSERT INTO quotes (quote_text, author, saved_by, saved_at, user_id)
                VALUES (?, ?, ?, NOW(), ?)
            `;
            const result = await this.dbManager.query(sql, [
                quoteData.quote,
                quoteData.author,
                quoteData.savedBy,
                quoteData.userId
            ]);
            
            return result.insertId;
        } catch (error) {
            console.error('❌ Error adding quote to database:', error);
            throw error;
        }
    }

    async getQuoteById(id) {
        try {
            const sql = `
                SELECT quote_id as id, quote_text as quote, author, saved_by as savedBy, saved_at as savedAt, user_id as userId
                FROM quotes
                WHERE quote_id = ?
            `;
            const results = await this.dbManager.query(sql, [id]);
            
            if (results.length === 0) {
                return null;
            }
            
            return results[0];
        } catch (error) {
            console.error('❌ Error getting quote by ID:', error);
            return null;
        }
    }

    async getRandomQuote() {
        try {
            const sql = `
                SELECT quote_id as id, quote_text as quote, author, saved_by as savedBy, saved_at as savedAt, user_id as userId
                FROM quotes
                ORDER BY RAND()
                LIMIT 1
            `;
            const results = await this.dbManager.query(sql);
            
            if (results.length === 0) {
                return null;
            }
            
            return results[0];
        } catch (error) {
            console.error('❌ Error getting random quote:', error);
            return null;
        }
    }

    async getTotalQuotes() {
        try {
            const sql = `SELECT COUNT(*) as count FROM quotes`;
            const results = await this.dbManager.query(sql);
            
            return results[0].count;
        } catch (error) {
            console.error('❌ Error getting total quotes count:', error);
            return 0;
        }
    }
}

module.exports = QuoteManager;