// scripts/getFollowers.js

// Simple script to fetch and display all your followers from Twitch API

const DbManager = require('../src/database/dbManager');
const TokenManager = require('../src/tokens/tokenManager');
const fetch = require('node-fetch');
const config = require('../src/config/config');

async function viewFollowers() {
    let dbManager = null;
    let tokenManager = null;

    try {
        console.log('Initializing...\n');

        // Initialize database and tokens
        dbManager = new DbManager();
        await dbManager.connect();

        tokenManager = new TokenManager();
        await tokenManager.init(dbManager);

        console.log('Connected to database and loaded tokens\n');
        console.log('Fetching followers from Twitch API...\n');

        let allFollowers = [];
        let cursor = null;
        let pageCount = 0;

        // Fetch all followers (paginated)
        do {
            pageCount++;

            // Build URL
            let url = `${config.twitchApiEndpoint}/channels/followers?broadcaster_id=${tokenManager.tokens.channelId}&first=100`;
            if (cursor) {
                url += `&after=${cursor}`;
            }

            console.log(`   Fetching page ${pageCount}...`);

            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${tokenManager.tokens.broadcasterAccessToken}`,
                    'Client-Id': tokenManager.tokens.clientId
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`\n❌ Twitch API Error: ${response.status}`);
                console.error(`Response: ${errorText}\n`);

                if (response.status === 403) {
                    console.error('    This likely means your token is missing the "moderator:read:followers" scope.');
                    console.error('    You need to re-authorize with this scope included.\n');
                }

                throw new Error(`Twitch API error: ${response.status}`);
            }

            const data = await response.json();

            if (data.data && data.data.length > 0) {
                allFollowers = allFollowers.concat(data.data);
                console.log(`   ✓ Got ${data.data.length} followers (total so far: ${allFollowers.length})`);
            }

            cursor = data.pagination?.cursor;

            // Small delay to be nice to the API
            if (cursor) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

        } while (cursor);

        console.log(`\nFinished! Found ${allFollowers.length} total followers\n`);

        // Update database with follower data
        console.log('Updating viewers table with follower data...\n');

        let insertedCount = 0;
        let updatedCount = 0;
        let errorCount = 0;

        for (const follower of allFollowers) {
            try {
                // Convert Twitch API timestamp to MySQL DATETIME format
                const followedAt = new Date(follower.followed_at)
                    .toISOString()
                    .slice(0, 19)
                    .replace('T', ' ');

                const result = await dbManager.query(
                    `INSERT INTO viewers (user_id, username, followed_at, last_seen)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        followed_at = COALESCE(followed_at, VALUES(followed_at))`,
                    [follower.user_id, follower.user_login, followedAt, followedAt]
                );

                // Check if row was inserted or updated
                if (result.affectedRows === 1) {
                    insertedCount++;
                } else if (result.affectedRows === 2) {
                    updatedCount++;
                }

            } catch (error) {
                errorCount++;
                console.error(`   ❌ Error processing ${follower.user_login}: ${error.message}`);
            }
        }

        console.log('\n✓ Database update complete!');
        console.log(`   New viewers added: ${insertedCount}`);
        console.log(`   Existing viewers updated: ${updatedCount}`);
        if (errorCount > 0) {
            console.log(`   Errors: ${errorCount}`);
        }
        console.log('');

        // Display summary statistics
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('                      FOLLOWER SUMMARY                         ');
        console.log('═══════════════════════════════════════════════════════════════\n');
        console.log(`Total Followers: ${allFollowers.length}`);
        console.log(`API Pages Fetched: ${pageCount}\n`);

        // Show oldest followers
        console.log('─────────────────────────────────────────────────────────────');
        console.log('OLDEST 5 FOLLOWERS:');
        console.log('─────────────────────────────────────────────────────────────');
        const oldest = [...allFollowers].sort((a, b) =>
            new Date(a.followed_at) - new Date(b.followed_at)
        ).slice(0, 5);

        oldest.forEach((follower, index) => {
            const date = new Date(follower.followed_at);
            console.log(`${index + 1}. ${follower.user_login.padEnd(20)} (${date.toLocaleDateString()})`);
        });

        // Show newest followers
        console.log('\n─────────────────────────────────────────────────────────────');
        console.log('NEWEST 5 FOLLOWERS:');
        console.log('─────────────────────────────────────────────────────────────');
        const newest = [...allFollowers].sort((a, b) =>
            new Date(b.followed_at) - new Date(a.followed_at)
        ).slice(0, 5);

        newest.forEach((follower, index) => {
            const date = new Date(follower.followed_at);
            console.log(`${index + 1}. ${follower.user_login.padEnd(20)} (${date.toLocaleDateString()})`);
        });

        // Show follow timeline
        console.log('\n─────────────────────────────────────────────────────────────');
        console.log('FOLLOW TIMELINE (by year):');
        console.log('─────────────────────────────────────────────────────────────');

        const byYear = {};
        allFollowers.forEach(follower => {
            const year = new Date(follower.followed_at).getFullYear();
            byYear[year] = (byYear[year] || 0) + 1;
        });

        Object.keys(byYear).sort().forEach(year => {
            const count = byYear[year];
            const bar = '█'.repeat(Math.ceil(count / 10));
            console.log(`${year}: ${count.toString().padStart(4)} ${bar}`);
        });

        console.log('\n═══════════════════════════════════════════════════════════════\n');

        // Ask if user wants to export full data
        console.log('💾 Export Options:');
        console.log('   To save all follower data to a JSON file, uncomment the');
        console.log('   export section at the bottom of this script.\n');

        // OPTIONAL: Uncomment this section to export to JSON file
        /*
        const fs = require('fs').promises;
        const path = require('path');

        const exportPath = path.join(__dirname, 'followers_export.json');
        await fs.writeFile(
            exportPath,
            JSON.stringify(allFollowers, null, 2),
            'utf8'
        );
        console.log(`Exported to: ${exportPath}\n`);
        */

        // Close database connection
        await dbManager.close();
        console.log('Done!\n');

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        if (error.stack) {
            console.error('\nStack trace:');
            console.error(error.stack);
        }

        if (dbManager) {
            await dbManager.close();
        }

        process.exit(1);
    }
}

// Run the script
viewFollowers();
