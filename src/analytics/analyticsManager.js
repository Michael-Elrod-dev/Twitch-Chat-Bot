// src/analytics/analyticsManager.js
const DbManager = require('../analytics/db/dbManager');

class AnalyticsManager {
   constructor() {
       this.dbManager = new DbManager();
   }

   async init() {
       try {
           await this.dbManager.connect();
       } catch (error) {
           console.error('❌ Failed to initialize analytics manager:', error);
           throw error;
       }
   }

   async trackChatMessage(userId, streamId, message) {
       try {
           const sql = `
               INSERT INTO chat_messages (user_id, stream_id, message_time, message_content) 
               VALUES (?, ?, NOW(), ?)
           `;
           await this.dbManager.query(sql, [userId, streamId, message]);
       } catch (error) {
           console.error('❌ Error tracking chat message:', error);
       }
   }

   async startViewerSession(userId, streamId) {
       try {
           const sql = `
               INSERT INTO viewing_sessions (user_id, stream_id, start_time)
               VALUES (?, ?, NOW())
           `;
           await this.dbManager.query(sql, [userId, streamId]);
       } catch (error) {
           console.error('❌ Error starting viewer session:', error);
       }
   }

   async endViewerSession(userId, streamId) {
       try {
           const sql = `
               UPDATE viewing_sessions 
               SET end_time = NOW()
               WHERE user_id = ? AND stream_id = ? AND end_time IS NULL
           `;
           await this.dbManager.query(sql, [userId, streamId]);
       } catch (error) {
           console.error('❌ Error ending viewer session:', error);
       }
   }

   async trackStreamStart(streamId, title, category) {
       try {
           const sql = `
               INSERT INTO streams (stream_id, start_time, title, category)
               VALUES (?, NOW(), ?, ?)
           `;
           await this.dbManager.query(sql, [streamId, title, category]);
       } catch (error) {
           console.error('❌ Error tracking stream start:', error);
       }
   }

   async trackStreamEnd(streamId) {
       try {
           const sql = `
               UPDATE streams 
               SET end_time = NOW()
               WHERE stream_id = ?
           `;
           await this.dbManager.query(sql, [streamId]);
       } catch (error) {
           console.error('❌ Error tracking stream end:', error);
       }
   }
}

module.exports = AnalyticsManager;