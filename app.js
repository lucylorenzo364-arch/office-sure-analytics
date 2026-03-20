const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const clickQueue = require('./queue');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files (dashboard.html, etc.)
app.use(express.static('.'));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.query('SELECT NOW()', (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Database connected successfully');
});

app.set('db', pool);

// ---------- Helper: generate JWT ----------
const generateToken = (user) => {
  return jwt.sign(
    { id: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// ---------- Middleware: authenticateToken ----------
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// ---------- AUTH ROUTES ----------
app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, hashedPassword]
    );
    const user = result.rows[0];
    const token = generateToken(user);
    res.status(201).json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = generateToken(user);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/profile', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// ---------- DOMAIN ROUTES ----------
app.post('/api/domains', authenticateToken, async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'Domain is required' });

  try {
    const result = await pool.query(
      'INSERT INTO domains (user_id, domain) VALUES ($1, $2) RETURNING *',
      [req.user.id, domain]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      res.status(409).json({ error: 'Domain already exists' });
    } else {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

app.get('/api/domains', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM domains WHERE user_id = $1 ORDER BY id',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- LINK ROUTES ----------
app.post('/api/links', authenticateToken, async (req, res) => {
  const { domain_id, alias, destination_url, campaign } = req.body;
  if (!domain_id || !alias || !destination_url) {
    return res.status(400).json({ error: 'domain_id, alias, and destination_url are required' });
  }

  try {
    const domainCheck = await pool.query(
      'SELECT id FROM domains WHERE id = $1 AND user_id = $2',
      [domain_id, req.user.id]
    );
    if (domainCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Domain not owned by you' });
    }

    const result = await pool.query(
      `INSERT INTO links (user_id, domain_id, alias, destination_url, campaign)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.id, domain_id, alias, destination_url, campaign || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      res.status(409).json({ error: 'Alias already in use for this domain' });
    } else {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

app.get('/api/links', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, d.domain, COUNT(c.id) as click_count
       FROM links l
       JOIN domains d ON l.domain_id = d.id
       LEFT JOIN clicks c ON l.id = c.link_id
       WHERE l.user_id = $1
       GROUP BY l.id, d.domain
       ORDER BY l.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- UPDATE LINK (PUT) ----------
app.put('/api/links/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { alias, destination_url, campaign } = req.body;
  const userId = req.user.id;

  try {
    const linkCheck = await pool.query(
      'SELECT * FROM links WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (linkCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Link not found or not owned by you' });
    }

    let updates = [];
    let values = [];
    let paramIndex = 1;

    if (alias) {
      updates.push(`alias = $${paramIndex++}`);
      values.push(alias);
    }
    if (destination_url) {
      updates.push(`destination_url = $${paramIndex++}`);
      values.push(destination_url);
    }
    if (campaign !== undefined) {
      updates.push(`campaign = $${paramIndex++}`);
      values.push(campaign);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const query = `UPDATE links SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

    const result = await pool.query(query, values);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      res.status(409).json({ error: 'Alias already in use for this domain' });
    } else {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

// ---------- DASHBOARD STATS ROUTES ----------
app.get('/api/stats/summary', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const totalResult = await pool.query(
      `SELECT COUNT(*) FROM clicks
       WHERE link_id IN (SELECT id FROM links WHERE user_id = $1)`,
      [userId]
    );
    const totalClicks = parseInt(totalResult.rows[0].count);

    const botResult = await pool.query(
      `SELECT COUNT(*) FROM clicks
       WHERE link_id IN (SELECT id FROM links WHERE user_id = $1) AND is_bot = true`,
      [userId]
    );
    const botClicks = parseInt(botResult.rows[0].count);

    const humanClicks = totalClicks - botClicks;

    const uniqueResult = await pool.query(
      `SELECT COUNT(DISTINCT ip) FROM clicks
       WHERE link_id IN (SELECT id FROM links WHERE user_id = $1)`,
      [userId]
    );
    const uniqueVisitors = parseInt(uniqueResult.rows[0].count);

    res.json({ totalClicks, botClicks, humanClicks, uniqueVisitors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/stats/timeline', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT DATE(timestamp) as day, COUNT(*) as count
       FROM clicks
       WHERE link_id IN (SELECT id FROM links WHERE user_id = $1)
         AND timestamp >= NOW() - INTERVAL '30 days'
       GROUP BY day
       ORDER BY day ASC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/stats/countries', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT country, COUNT(*) as count
       FROM clicks
       WHERE link_id IN (SELECT id FROM links WHERE user_id = $1)
         AND country IS NOT NULL
       GROUP BY country
       ORDER BY count DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/stats/bot-ratio', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT is_bot, COUNT(*) as count
       FROM clicks
       WHERE link_id IN (SELECT id FROM links WHERE user_id = $1)
       GROUP BY is_bot`,
      [userId]
    );
    const data = { human: 0, bot: 0 };
    result.rows.forEach(row => {
      if (row.is_bot) data.bot = parseInt(row.count);
      else data.human = parseInt(row.count);
    });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- TOP LINKS FOR TODAY ----------
app.get('/api/stats/top-links/today', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT l.alias, d.domain,
              COUNT(*) FILTER (WHERE c.is_bot = false) AS human_clicks,
              COUNT(*) FILTER (WHERE c.is_bot = true) AS bot_clicks,
              COUNT(*) AS total_clicks
       FROM clicks c
       JOIN links l ON c.link_id = l.id
       JOIN domains d ON l.domain_id = d.id
       WHERE l.user_id = $1
         AND DATE(c.timestamp) = CURRENT_DATE
       GROUP BY l.id, d.domain
       ORDER BY total_clicks DESC
       LIMIT 5`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- TOP LINKS FOR YESTERDAY ----------
app.get('/api/stats/top-links/yesterday', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      `SELECT l.alias, d.domain,
              COUNT(*) FILTER (WHERE c.is_bot = false) AS human_clicks,
              COUNT(*) FILTER (WHERE c.is_bot = true) AS bot_clicks,
              COUNT(*) AS total_clicks
       FROM clicks c
       JOIN links l ON c.link_id = l.id
       JOIN domains d ON l.domain_id = d.id
       WHERE l.user_id = $1
         AND DATE(c.timestamp) = CURRENT_DATE - INTERVAL '1 day'
       GROUP BY l.id, d.domain
       ORDER BY total_clicks DESC
       LIMIT 5`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------- REDIRECT ENDPOINT ----------
app.get('/:alias', async (req, res) => {
  const { alias } = req.params;
  const host = req.get('host');

  try {
    const linkResult = await pool.query(
      `SELECT l.*, d.domain
       FROM links l
       JOIN domains d ON l.domain_id = d.id
       WHERE d.domain = $1 AND l.alias = $2`,
      [host, alias]
    );
    if (linkResult.rows.length === 0) {
      return res.status(404).send('Link not found');
    }
    const link = linkResult.rows[0];

    const clickId = uuidv4();

    await clickQueue.add({
      clickId,
      linkId: link.id,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      referer: req.get('Referer'),
      timestamp: new Date().toISOString(),
    });

    res.redirect(302, link.destination_url);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ---------- TEST ROUTE ----------
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ success: true, time: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('Link Analytics API is running!');
});

// ---------- START SERVER (HTTP) ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});