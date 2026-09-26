// Run: TURSO_DB_URL=... TURSO_AUTH_TOKEN=... node check_turso_schema.js
const { createClient } = require('@libsql/client');

const url   = process.env.TURSO_DB_URL;
const token = process.env.TURSO_AUTH_TOKEN;

if (!url || !token) {
    console.error('Set TURSO_DB_URL and TURSO_AUTH_TOKEN env vars');
    process.exit(1);
}

const db = createClient({ url, authToken: token });

(async () => {
    try {
        console.log('\n=== users table columns (PRAGMA) ===');
        const pragma = await db.execute(`PRAGMA table_info(users)`);
        pragma.rows.forEach(r => console.log(`  [${r.cid}] ${r.name} ${r.type} default=${r.dflt_value}`));

        const wantedCols = ['bio', 'tagline', 'location', 'cover_photo', 'is_verified', 'profile_photo'];
        const existing   = pragma.rows.map(r => r.name);
        const missing    = wantedCols.filter(c => !existing.includes(c));

        if (missing.length) {
            console.log('\n❌ MISSING COLUMNS:', missing.join(', '));
            console.log('Running ALTER TABLE to add them...');
            for (const col of missing) {
                const def = col === 'is_verified' ? 'INTEGER DEFAULT 0' : 'TEXT DEFAULT NULL';
                await db.execute(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
                console.log(`  ✅ Added column: ${col}`);
            }
        } else {
            console.log('\n✅ All required columns exist!');
        }

        console.log('\n=== Sample users (first 3) ===');
        const users = await db.execute(`SELECT uid, username, first_name, bio, location, cover_photo FROM users LIMIT 3`);
        users.rows.forEach(r => console.log(JSON.stringify(r)));

    } catch (e) {
        console.error('ERROR:', e.message);
    }
    process.exit(0);
})();
