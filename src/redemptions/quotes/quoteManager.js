// src/redemptions/quotes/quoteManager.js

const logger = require('../../logger/logger');

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

            logger.info('QuoteManager', 'Quote added successfully', {
                quoteId: result.insertId,
                quote: quoteData.quote,
                author: quoteData.author,
                savedBy: quoteData.savedBy,
                userId: quoteData.userId
            });
            return result.insertId;
        } catch (error) {
            logger.error('QuoteManager', 'Error adding quote to database', {
                error: error.message,
                stack: error.stack,
                quote: quoteData.quote,
                author: quoteData.author
            });
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
                logger.debug('QuoteManager', 'Quote not found by ID', { id });
                return null;
            }

            logger.debug('QuoteManager', 'Quote retrieved by ID', {
                id,
                quote: results[0].quote,
                author: results[0].author
            });
            return results[0];
        } catch (error) {
            logger.error('QuoteManager', 'Error getting quote by ID', {
                error: error.message,
                stack: error.stack,
                id
            });
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
                logger.debug('QuoteManager', 'No quotes available for random selection');
                return null;
            }

            logger.debug('QuoteManager', 'Random quote retrieved', {
                id: results[0].id,
                quote: results[0].quote,
                author: results[0].author
            });
            return results[0];
        } catch (error) {
            logger.error('QuoteManager', 'Error getting random quote', {
                error: error.message,
                stack: error.stack
            });
            return null;
        }
    }

    async getTotalQuotes() {
        try {
            const sql = 'SELECT COUNT(*) as count FROM quotes';
            const results = await this.dbManager.query(sql);

            logger.debug('QuoteManager', 'Total quotes count retrieved', {
                count: results[0].count
            });
            return results[0].count;
        } catch (error) {
            logger.error('QuoteManager', 'Error getting total quotes count', {
                error: error.message,
                stack: error.stack
            });
            return 0;
        }
    }
}

module.exports = QuoteManager;
