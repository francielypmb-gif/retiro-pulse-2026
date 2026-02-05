require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const QRCode = require('qrcode');

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = 3333;

app.use(cors());
app.use(express.json());

// ================= BANCO =================

const db = new sqlite3.Database('./database.db');

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
      checkin INTEGER DEFAULT 0
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
      asaas_payment_id TEXT
    )
  `);

});

// ================= CONFIG EVENTO =================

const TOTAL_VAGAS = 115;

// ================= UTIL =================

function normalizarCPF(cpf) {
  return (cpf || '').replace(/\D/g, '');
}

// ================= ASAAS =================

const ASAAS = {
  baseUrl: process.env.ASAAS_BASE_URL,
  key: process.env.ASAAS_API_KEY
};

async function asaas(path, opts = {}) {

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

// ================= VAGAS =================

app.get('/vagas', (req, res) => {

  db.get(
    "SELECT COUNT(*) AS pagos FROM inscritos WHERE status='quitado'",
    (err, row) => {

      if (err) return res.status(500).json({ erro: true });

      const pagos = row?.pagos || 0;

      res.json({
        total: TOTAL_VAGAS,
        pagos,
        restantes: TOTAL_VAGAS - pagos
      });

    }
  );

});

// ================= INSCRIÇÃO =================

app.post('/inscricao', async (req, res) => {

  try {

    const { nome, cpf, nascimento, email, telefone, frequentaPV, campus } = req.body;

    const cpfNorm = normalizarCPF(cpf);

    const qr = await QRCode.toDataURL(cpfNorm + "-" + Date.now());

    db.run(`
      INSERT INTO inscritos
      (nome, cpf, cpf_norm, nascimento, email, telefone, frequentaPV, campus, status, qrcode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?)
    `,
      [nome, cpf, cpfNorm, nascimento, email, telefone, frequentaPV, campus, qr],
      function (err) {

        if (err) return res.status(500).json({ erro: err.message });

        res.json({ id: this.lastID });

      });

  } catch (e) {
    res.status(500).json({ erro: "Erro inscrição" });
  }

});

// ================= BOLETOS =================

app.post('/pagamentos/asaas/boletos/:id', async (req, res) => {

  try {

    const inscritoId = req.params.id;

    const inscrito = await new Promise((resolve) => {
      db.get("SELECT * FROM inscritos WHERE id=?", [inscritoId], (_, row) => resolve(row));
    });

    const customer = await asaas('/customers', {
      method: 'POST',
      body: {
        name: inscrito.nome,
        cpfCnpj: inscrito.cpf_norm,
        email: inscrito.email
      }
    });

    const pay = await asaas('/payments', {
      method: 'POST',
      body: {
        customer: customer.id,
        billingType: 'BOLETO',
        value: 320,
        dueDate: '2026-04-01'
      }
    });

    res.json({
      parcelas: [{
        parcela: 1,
        valor: 320,
        vencimento: '2026-04-01',
        boleto_url: pay.bankSlipUrl
      }]
    });

  } catch (e) {
    res.status(500).send(e.message);
  }

});

// ================= PIX =================

app.post('/pagamentos/asaas/pix/:id', async (req, res) => {

  try {

    const inscritoId = req.params.id;

    const inscrito = await new Promise((resolve) => {
      db.get("SELECT * FROM inscritos WHERE id=?", [inscritoId], (_, row) => resolve(row));
    });

    const customer = await asaas('/customers', {
      method: 'POST',
      body: {
        name: inscrito.nome,
        cpfCnpj: inscrito.cpf_norm,
        email: inscrito.email
      }
    });

    const pay = await asaas('/payments', {
      method: 'POST',
      body: {
        customer: customer.id,
        billingType: 'PIX',
        value: 320
      }
    });

    res.json({
      ok: true,
      qrPayload: pay.pixQrCode.payload,
      qrImageBase64: pay.pixQrCode.encodedImage
    });

  } catch (e) {
    res.status(500).send(e.message);
  }

});

// ================= START =================

app.listen(PORT, () => {
  console.log("🔥 Servidor rodando");
});
