import express from 'express';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import https from 'node:https';
import { URL } from 'node:url';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Supabase Setup
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Setup EJS & Public
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Session Setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// --- CORE HTTP REQUEST ---
const requestTrx = (targetUrl) => {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'Accept-Encoding': 'gzip, deflate', 'Connection': 'Keep-Alive' },
    };
    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return requestTrx(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        const cb = (err, decoded) => err ? reject(err) : resolve(decoded.toString('utf-8'));
        if (encoding === 'gzip') zlib.gunzip(buffer, cb);
        else if (encoding === 'deflate') zlib.inflate(buffer, cb);
        else resolve(buffer.toString('utf-8'));
      });
    });
    req.on('error', reject);
    req.end();
  });
};

// Middleware Auth
const requireLogin = (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  next();
};

// --- ROUTES ---

// Login
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const { data: user } = await supabase.from('users').select('*').eq('username', username).single();
  
  if (user && await bcrypt.compare(password, user.password)) {
    req.session.user = user;
    res.redirect('/');
  } else {
    res.render('login', { error: 'Username atau Password salah!' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Dashboard
app.get('/dashboard', requireLogin, async (req, res) => {
  const { count: totalTrx } = await supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('user_id', req.session.user.id);
  res.render('dashboard', { user: req.session.user, totalTrx: totalTrx || 0, page: 'dashboard' });
});

// Cek Saldo Okeconnect
app.get('/cek-saldo', requireLogin, async (req, res) => {
  let saldo = null;
  if (req.query.cek === 'true') {
    const params = new URLSearchParams({
      memberID: process.env.MEMBER_ID,
      pin: process.env.PIN,
      password: process.env.PASSWORD
    });
    saldo = await requestTrx(`https://h2h.okeconnect.com/trx/balance?${params.toString()}`);
  }
  res.render('cek-saldo', { user: req.session.user, saldo, page: 'saldo' });
});

// Harga Produk 
app.get('/harga', requireLogin, async (req, res) => {
  try {
    const jsonString = await requestTrx('https://okeconnect.com/harga/json?id=905ccd028329b0a');
    const products = JSON.parse(jsonString);
    res.render('harga', { user: req.session.user, products, page: 'harga' });
  } catch (error) {
    res.render('harga', { user: req.session.user, products: [], page: 'harga', error: 'Gagal memuat data harga' });
  }
});

// Deposit
app.get('/deposit', requireLogin, async (req, res) => {
  const { data: deposits } = await supabase.from('deposits').select('*').eq('user_id', req.session.user.id).order('created_at', { ascending: false });
  res.render('deposit', { user: req.session.user, deposits: deposits || [], page: 'deposit' });
});

app.post('/deposit', requireLogin, async (req, res) => {
  const { amount } = req.body;
  if (amount > 0) {
    await supabase.from('deposits').insert([{
      user_id: req.session.user.id,
      amount: amount,
      status: 'PENDING'
    }]);
  }
  res.redirect('/deposit');
});

// Buat Transaksi
app.get('/buat-transaksi', requireLogin, (req, res) => {
  res.render('buat-transaksi', { user: req.session.user, result: null, page: 'trx' });
});

app.post('/buat-transaksi', requireLogin, async (req, res) => {
  const { product, dest } = req.body;
  const refID = `AND${Date.now()}`;
  
  const params = new URLSearchParams({
    product, dest, refID,
    memberID: process.env.MEMBER_ID,
    pin: process.env.PIN,
    password: process.env.PASSWORD
  });

  const rawResult = await requestTrx(`https://h2h.okeconnect.com/trx?${params.toString()}`);
  
  await supabase.from('transactions').insert([{
    user_id: req.session.user.id,
    ref_id: refID,
    product, dest,
    status: 'PENDING',
    message: rawResult
  }]);

  res.render('buat-transaksi', { user: req.session.user, result: rawResult, page: 'trx' });
});

// Callback Okeconnect
app.get('/callback', async (req, res) => {
  const { refid, message } = req.query;
  if (refid) {
    await supabase.from('transactions').update({ 
      status: message.includes('GAGAL') ? 'GAGAL' : 'SUKSES', 
      message: message 
    }).eq('ref_id', refid);
  }
  res.send('OK');
});

// Riwayat
app.get('/riwayat', requireLogin, async (req, res) => {
  const { data: history } = await supabase.from('transactions').select('*').eq('user_id', req.session.user.id).order('created_at', { ascending: false });
  res.render('riwayat', { user: req.session.user, history: history || [], page: 'riwayat' });
});


export default app;