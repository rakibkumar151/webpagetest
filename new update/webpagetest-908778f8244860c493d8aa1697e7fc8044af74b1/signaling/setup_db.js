const { createClient } = require('@libsql/client');

const db = createClient({ 
    url: 'libsql://chet-users-rakia.aws-ap-south-1.turso.io', 
    authToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJleHAiOjE3OTA5OTYyNjIsImlhdCI6MTc5MDM5MTQ2MiwiaWQiOiIwMWEwZGI4YS0yMTAxLTcyYmUtOTQzNS1hZTQzNzdlZDVjMjIiLCJraWQiOiJjdnFSY0RDVUFBRDU1R2FYMW1xdC0yMm0wYy1QVXk1dlVHZk5IMENmVE5BIiwicmlkIjoiMGZjM2YwMTEtMzkwOC00N2NjLTgyMTAtNGFlODY0MjU5YmNiIn0.YFfKiJLUSolpMctdRNSwOT3nepxLmx_wxmdCItOAQ9lCARADhKNOlq7ZqY0ZV0bZI73l3mg1GWegII3quNA_BQ' 
});

async function main() {
    try {
        console.log('Creating email_domain_rules table...');
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
