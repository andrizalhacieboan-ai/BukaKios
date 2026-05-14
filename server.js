import express from 'express';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import https from 'node:https';
import { URL } from 'node:url';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Supabase Setup (Hanya untuk menyimpan riwayat transaksi & deposit)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Setup EJS & Public
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Data User Dummy (Karena tidak ada login, data ini yang akan ditampilin di dashboard)
const currentUser = {
  id: 1,
  username: 'Andri',
  role: 'admin',
  balance: 0 // Saldo ini hanya pajangan di UI, saldo asli ada di Okeconnect
};

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

// --- ROUTES ---

// Langsung Redirect ke Dashboard
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// DASHBOARD
app.get('/dashboard', async (req, res) => {
  const { count: totalTrx } = await supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('user_id', currentUser.id);
  res.render('dashboard', { user: currentUser, totalTrx: totalTrx || 0, page: 'dashboard' });
});

// CEK SALDO
app.get('/cek-saldo', async (req, res) => {
  let saldo = null;
  if (req.query.cek === 'true') {
    const params = new URLSearchParams({
      memberID: process.env.MEMBER_ID,
      pin: process.env.PIN,
      password: process.env.PASSWORD
    });
    saldo = await requestTrx(`https://h2h.okeconnect.com/trx/balance?${params.toString()}`);
  }
  res.render('cek-saldo', { user: currentUser, saldo, page: 'saldo' });
});

// HARGA PRODUK
app.get('/harga', async (req, res) => {
  try {
    const jsonString = await requestTrx('https://okeconnect.com/harga/json?id=905ccd028329b0a');
    const products = JSON.parse(jsonString);
    res.render('harga', { user: currentUser, products, page: 'harga' });
  } catch (error) {
    res.render('harga', { user: currentUser, products: [], page: '
