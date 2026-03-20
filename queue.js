const Bull = require('bull');
const { Pool } = require('pg');
const maxmind = require('maxmind');
const geolite2 = require('geolite2-redist');
require('dotenv').config();

// Redis configuration (local Memurai)
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
};

const clickQueue = new Bull('click processing', { redis: redisConfig });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Load GeoIP databases (no sign‑up needed)
let cityLookup, asnLookup;
(async () => {
  try {
    await geolite2.downloadDbs(); // downloads the latest DBs if not present
    cityLookup = await geolite2.open('GeoLite2-City', (path) => maxmind.open(path));
    asnLookup = await geolite2.open('GeoLite2-ASN', (path) => maxmind.open(path));
    console.log('✅ GeoIP databases loaded.');
  } catch (err) {
    console.error('❌ Failed to load GeoIP databases:', err.message);
  }
})();

// Basic bot detection
function isBot(ip, userAgent, asn) {
  // datacenter ASNs (you can expand this list)
  const datacenterAsns = [16509, 14618, 15169, 14061, 20473, 16276, 24940];
  if (asn && datacenterAsns.includes(asn)) return true;

  if (!userAgent) return true;
  const botPatterns = /bot|crawler|spider|scanner|headless|phantom|selenium|wget|curl|python|java/i;
  if (botPatterns.test(userAgent)) return true;

  return false;
}

// Process clicks
clickQueue.process(async (job) => {
  const { clickId, linkId, ip, userAgent, referer, timestamp } = job.data;

  let country = null, city = null, asn = null;
  if (cityLookup && ip) {
    try {
      const cityResult = cityLookup.get(ip);
      if (cityResult) {
        country = cityResult.country?.isoCode || null;
        city = cityResult.city?.names?.en || null;
      }
    } catch (err) {
      console.error(`GeoIP city lookup failed for IP ${ip}:`, err.message);
    }
  }
  if (asnLookup && ip) {
    try {
      const asnResult = asnLookup.get(ip);
      if (asnResult) {
        asn = asnResult.autonomous_system_number || null;
      }
    } catch (err) {
      console.error(`GeoIP ASN lookup failed for IP ${ip}:`, err.message);
    }
  }

  const bot = isBot(ip, userAgent, asn);

  try {
    await pool.query(
      `INSERT INTO clicks (click_id, link_id, ip, user_agent, referer, timestamp, country, city, asn, is_bot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [clickId, linkId, ip, userAgent, referer, timestamp, country, city, asn, bot]
    );
    console.log(`✅ Click ${clickId} saved (${country}, bot: ${bot}).`);
  } catch (err) {
    console.error('❌ Failed to save click:', err);
    throw err;
  }
});

clickQueue.on('completed', (job) => console.log(`📦 Job ${job.id} completed.`));
clickQueue.on('failed', (job, err) => console.error(`💥 Job ${job.id} failed:`, err));

module.exports = clickQueue;