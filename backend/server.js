// ==========================
// backend/server.js
// ==========================
require('dotenv').config();

console.log('[ENV] ASAAS_BASE_URL:', process.env.ASAAS_BASE_URL || '(default)');
console.log('[ENV] ASAAS_API_KEY:', (process.env.ASAAS_API_KEY || '').slice(0, 12) + '...');

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const QRCode = require('qrcode');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = 3333;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================
// BANCO
// ==========================
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) {
    console.error("❌ Erro ao abrir banco:", err);
  } else {
    console.log("✅ Banco conectado");
    criarTabelas();
  }
});

function criarTabelas() {

  db.serialize(() => {

    db.run(`
      CREATE TABLE IF NOT EXISTS inscritos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT,
        cpf TEXT,
        cpf_norm TEXT,
        nascimento TEXT,
        email TEXT,
        telefone TEXT,
        frequentaPV TEXT,
        campus TEXT,
        status TEXT,
        qrcode TEXT,
        checkin INTEGER DEFAULT 0,
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS parcelas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inscrito_id INTEGER,
        parcela INTEGER,
        valor_cents INTEGER,
        vencimento TEXT,
        status TEXT,
        boleto_url TEXT,
        asaas_payment_id TEXT,
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE INDEX IF NOT EXISTS idx_inscritos_cpf_norm 
      ON inscritos(cpf_norm)
    `);

    console.log("✅ Tabelas verificadas/criadas");

  });
}

// ==========================
// UTIL
// ==========================
function normalizarCPF(cpf) {
  return (cpf || '').replace(/\D/g, '');
}

// ==========================
// ASAAS CONFIG
// ==========================
const ASAAS = {
  baseUrl: process.env.ASAAS_BASE_URL || 'https://sandbox.asaas.com/api/v3',
  key: process.env.ASAAS_API_KEY || ''
};

async function asaas(path, opts = {}) {

  if (!ASAAS.key) throw new Error('ASAAS_API_KEY não configurada');

  const res = await fetch(`${ASAAS.baseUrl}${path}`, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'access_token': ASAAS.key
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });

  const text = await res.text();

  if (!res.ok) throw new Error(text);

  return JSON.parse(text);
}

async function getOrCreateCustomer({ nome, email, cpf }) {

  const found = await asaas(`/customers?cpfCnpj=${cpf}`);

  if (found?.data?.length) return found.data[0];

  return asaas('/customers', {
    method: 'POST',
    body: { name: nome, email, cpfCnpj: cpf }
  });

}

// ==========================
// ROTAS
// ==========================
app.get('/', (req, res) => {
  res.send("🔥 Backend Retiro 2026 rodando!");
});

// ==========================
// INSCRIÇÃO
// ==========================
app.post('/inscricao', async (req, res) => {

  try {

    const { nome, cpf, nascimento, email, telefone } = req.body;

    if (!nome || !cpf || !email) {
      return res.status(400).json({ erro: "Campos obrigatórios" });
    }

    const cpfNorm = normalizarCPF(cpf);

    const qr = await QRCode.toDataURL(cpfNorm + "-" + Date.now());

    db.run(`
      INSERT INTO inscritos
      (nome, cpf, cpf_norm, nascimento, email, telefone, status, qrcode)
      VALUES (?, ?, ?, ?, ?, ?, 'pendente', ?)
    `,
      [nome, cpf, cpfNorm, nascimento, email, telefone, qr],
      function (err) {

        if (err) return res.status(500).json({ erro: err.message });

        res.json({
          id: this.lastID,
          mensagem: "Inscrição criada"
        });

      });

  } catch (e) {

    console.error(e);
    res.status(500).json({ erro: "Erro ao criar inscrição" });

  }

});

// ==========================
// START
// ==========================
app.listen(PORT, () => {
  console.log(`🔥 Servidor rodando em http://localhost:${PORT}`);
});
