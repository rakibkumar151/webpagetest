require('dotenv').config();
const { createClient } = require('@libsql/client');

const db = createClient({ 
    url: process.env.TURSO_URL || 'libsql://chet-users-rakia.aws-ap-south-1.turso.io', 
    authToken: process.env.TURSO_TOKEN 
});

async function main() {
    try {
        console.log('Creating table email_domain_rules...');
        await db.execute(`
            CREATE TABLE IF NOT EXISTS email_domain_rules (
                domain     TEXT PRIMARY KEY,
                rule_type  TEXT NOT NULL DEFAULT 'allow',
                added_at   TEXT DEFAULT (datetime('now'))
            )
        `);
        console.log('Table created!');
        
        console.log('Inserting gmail.com...');
        await db.execute(`INSERT OR IGNORE INTO email_domain_rules (domain, rule_type) VALUES ('gmail.com', 'allow')`);
        console.log('Done!');
    } catch (e) {
        console.error('Error:', e);
    }
}

main();
