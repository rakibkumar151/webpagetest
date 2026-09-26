const { createClient } = require('@libsql/client');
const db = createClient({
    url: 'libsql://chet-users-rakia.aws-ap-south-1.turso.io',
    authToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJleHAiOjE3OTA5OTYyNjIsImlhdCI6MTc5MDM5MTQ2MiwiaWQiOiIwMWEwZGI4YS0yMTAxLTcyYmUtOTQzNS1hZTQzNzdlZDVjMjIiLCJraWQiOiJjdnFSY0RDVUFBRDU1R2FYMW1xdC0yMm0wYy1QVXk1dlVHZk5IMENmVE5BIiwicmlkIjoiMGZjM2YwMTEtMzkwOC00N2NjLTgyMTAtNGFlODY0MjU5YmNiIn0.YFfKiJLUSolpMctdRNSwOT3nepxLmx_wxmdCItOAQ9lCARADhKNOlq7ZqY0ZV0bZI73l3mg1GWegII3quNA_BQ'
});

async function run() {
    let res = await db.execute("SELECT * FROM users WHERE uid = 'UID1819957'");
    console.log('Rakib Kumar:', res.rows[0]);
    res = await db.execute("SELECT * FROM verified_uids");
    console.log('Verified UIDs:', res.rows);
}
run();
