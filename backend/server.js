// server.js
require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const QRCode = require('qrcode');
// Node 18+ tem fetch nativo
const fetch = (...args) => global.fetch(...args);
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3333;

/* ======================================================================
   CORS INFALÍVEL (dev e prod) + PRE-FLIGHT 204 + OPTIONS EXPLÍCITO
   - SEMPRE inclui Access-Control-Allow-Origin (ecoando o Origin do caller)
   - Responde preflight OPTIONS com 204
   - app.options('*', ...) como rede de segurança
====================================================================== */
function setCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  // Em desenvolvimento/teste, use '*' para não travar por cabeçalhos custom:
  res.setHeader('Access-Control-Allow-Headers', '*');
  // Se for usar cookies/sessões no futuro:
  // res.setHeader('Access-Control-Allow-Credentials', 'true');
}

app.use((req, res, next) => {
  setCors(res, req.headers.origin);

  // Evita cache do preflight em edge/CDN
  if (req.method === 'OPTIONS') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    return res.sendStatus(204);
  }
  return next();
});

// Rota OPTIONS embarcada (garantia adicional)
app.options('*', (req, res) => {
  setCors(res, req.headers.origin);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return res.sendStatus(204);
});

// (opcional) Log sentinela p/ confirmar versão nos logs do Render
console.log('[BOOT] CORS infalível carregado');

app.use(cors());
app.use(express.json());

/* ======================================================================
   CONFIG ASAAS (mantido; não usado no fluxo manual)
====================================================================== */
const ASAAS = {
  baseUrl: process.env.ASAAS_BASE_URL || 'https://sandbox.asaas.com/api/v3',
  key: process.env.ASAAS_API_KEY
};

async function asaas(pathUrl, opts = {}) {
  const res = await fetch(`${ASAAS.baseUrl}${pathUrl}`, {
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

/* ======================================================================
   BANCO
====================================================================== */
const dbPath = path.join(process.cwd(), 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Erro banco:', err);
  else {
    console.log('✅ Banco conectado em:', dbPath);
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
        status TEXT DEFAULT 'pendente',
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
        asaas_payment_id TEXT
      )
    `);

    // Migração tolerante: adiciona 'forma_pagamento' se não existir
    db.all(`PRAGMA table_info(inscritos)`, (e, cols) => {
      if (e) {
        console.warn('[MIGRATION] Não foi possível ler schema de inscritos:', e.message);
        return;
      }
      const hasForma = Array.isArray(cols) && cols.some(c => c.name === 'forma_pagamento');
      if (!hasForma) {
        db.run(`ALTER TABLE inscritos ADD COLUMN forma_pagamento TEXT`, (err2) => {
          if (err2) {
            console.warn('[MIGRATION] ADD forma_pagamento (talvez já exista):', err2.message);
          } else {
            console.log('✅ MIGRATION: coluna forma_pagamento adicionada em inscritos');
          }
        });
      }
    });
  });
}

/* ======================================================================
   UTIL
====================================================================== */
function normalizarCPF(cpf) {
  return (cpf || '').replace(/\D/g, '');
}

async function getOrCreateCustomer(nome, email, cpf) {
  const find = await asaas(`/customers?cpfCnpj=${cpf}`);
  if (find.data.length) return find.data[0];

  return asaas(`/customers`, {
    method: 'POST',
    body: { name: nome, email, cpfCnpj: cpf }
  });
}

/* ======================================================================
   HOME
====================================================================== */
app.get('/', (_req, res) => {
  res.send('🔥 Backend Retiro rodando');
});

/* ======================================================================
   INSCRIÇÃO (manual: sem disparar pagamentos)
====================================================================== */
app.post('/inscricao', async (req, res) => {
  try {
    const {
      nome, cpf, nascimento, email, telefone, frequentaPV, campus, formaPagamento
    } = req.body;

    const cpfNorm = normalizarCPF(cpf);
    const qr = await QRCode.toDataURL(cpfNorm + '-' + Date.now());

    db.run(`
      INSERT INTO inscritos
      (nome, cpf, cpf_norm, nascimento, email, telefone, frequentaPV, campus, qrcode, status, forma_pagamento)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `,
    [
      nome,
      cpf,
      cpfNorm,
      nascimento,
      email,
      telefone,
      frequentaPV,
      campus,
      qr,
      'pendente_pagamento',       // status inicial no fluxo manual
      formaPagamento || null      // pix | boleto | cartao
    ],
    function(err) {
      if (err) return res.status(500).json({ erro: err.message });
      res.json({ id: this.lastID });
    });

  } catch (e) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

/* ======================================================================
   PIX (mantido para futura automação)
====================================================================== */
app.post('/pagamentos/asaas/pix/:id', async (req, res) => {
  try {
    const inscritoId = req.params.id;

    db.get(`SELECT * FROM inscritos WHERE id=?`, [inscritoId], async (err, i) => {
      if (err) return res.status(500).json({ erro: 'DB get error' });
      if (!i) return res.status(404).json({ erro: 'Inscrito não encontrado' });

      const customer = await getOrCreateCustomer(i.nome, i.email, i.cpf_norm);

      const pay = await asaas(`/payments`, {
        method: 'POST',
        body: {
          customer: customer.id,
          billingType: 'PIX',
          value: 320
        }
      });

      db.run(`
        INSERT INTO parcelas
        (inscrito_id, parcela, valor_cents, status, asaas_payment_id)
        VALUES (?,?,?,?,?)
      `,
      [inscritoId, 1, 32000, 'pending', pay.id]);

      res.json({
        ok: true,
        qrPayload: pay.pixQrCode.payload,
        qrImageBase64: pay.pixQrCode.encodedImage
      });
    });

  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* ======================================================================
   BOLETO (mantido para futura automação)
====================================================================== */
app.post('/pagamentos/asaas/boletos/:id', async (req, res) => {
  try {
    const inscritoId = req.params.id;
    const parcelas = Number(req.body.parcelas || 3);
    const valorTotal = 320;

    console.log('[BOLETO] init', { inscritoId, parcelas, valorTotal, parcelasDatas: req.body.parcelasDatas });

    db.get(`SELECT * FROM inscritos WHERE id=?`, [inscritoId], async (err, i) => {
      try {
        if (err) {
          console.error('[BOLETO] sqlite get err', err);
          return res.status(500).json({ ok: false, erro: 'DB get error' });
        }
        if (!i) {
          console.warn('[BOLETO] inscrito não encontrado', { inscritoId });
          return res.status(404).json({ ok: false, erro: 'Inscrito não encontrado' });
        }

        console.log('[BOLETO] cliente', { nome: i.nome, email: i.email, cpf: i.cpf_norm });

        let customer;
        try {
          customer = await getOrCreateCustomer(i.nome, i.email, i.cpf_norm);
        } catch (e) {
          console.error('[BOLETO] getOrCreateCustomer erro', e?.message || e);
          return res.status(502).json({
            ok: false, etapa: 'customer', erro: String(e?.message || e).slice(0, 800)
          });
        }

        const valorParcela = Number((valorTotal / parcelas).toFixed(2));
        const toCents = v => Math.round(Number(v) * 100);

        // Datas: anteriores escolhidas pelo usuário (req.body.parcelasDatas),
        // última fixa 01/04/2026
        const HOJE = new Date(); HOJE.setHours(0,0,0,0);
        const MIN = new Date(HOJE); MIN.setDate(MIN.getDate() + 2); // D+2
        const LIMITE = new Date(2026, 3, 1); LIMITE.setHours(0,0,0,0); // 01/04/2026

        const escolhidas = Array.isArray(req.body.parcelasDatas) ? req.body.parcelasDatas : [];
        const vencimentos = [];
        const anteriores = Math.max(0, parcelas - 1);

        for (let idx = 0; idx < anteriores; idx++) {
          const iso = (escolhidas[idx] || '').slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
            return res.status(400).json({
              ok: false, etapa: 'datas', erro: `Data da parcela ${idx + 1} inválida. Use AAAA-MM-DD.`
            });
          }
          const d = new Date(iso + 'T00:00:00');
          if (d < MIN) {
            return res.status(400).json({
              ok: false, etapa: 'datas', erro: `Data da parcela ${idx + 1} não pode ser no passado (mínimo D+2).`
            });
          }
          if (d > LIMITE) {
            return res.status(400).json({
              ok: false, etapa: 'datas', erro: `Data da parcela ${idx + 1} deve ser até 01/04/2026.`
            });
          }
          vencimentos.push(iso);
        }

        // Última parcela fixa
        vencimentos.push(LIMITE.toISOString().slice(0, 10));

        vencimentos.sort((a, b) => a.localeCompare(b));
        for (let j = 1; j < vencimentos.length; j++) {
          if (vencimentos[j] === vencimentos[j - 1]) {
            return res.status(400).json({
              ok: false, etapa: 'datas', erro: 'Datas de parcelas duplicadas.'
            });
          }
        }

        const lista = [];

        for (let p = 1; p <= parcelas; p++) {
          const dueDate = vencimentos[p - 1];

          try {
            console.log('[BOLETO] criando parcela', { p, valorParcela, dueDate });

            const pay = await asaas('/payments', {
              method: 'POST',
              body: {
                customer: customer.id,
                billingType: 'BOLETO',
                value: valorParcela,
                dueDate
              }
            });

            console.log('[BOLETO] ok parcela', { p, paymentId: pay.id, url: pay.bankSlipUrl });

            db.run(`
              INSERT INTO parcelas
              (inscrito_id, parcela, valor_cents, vencimento, status, boleto_url, asaas_payment_id)
              VALUES (?,?,?,?,?,?,?)
            `,
            [inscritoId, p, toCents(valorParcela), new Date(dueDate).toISOString(), 'PENDING', pay.bankSlipUrl, pay.id]);

            lista.push({ parcela: p, boleto_url: pay.bankSlipUrl, vencimento: dueDate, valor: valorParcela.toFixed(2) });

          } catch (e) {
            console.error('[BOLETO] erro parcela', p, e?.message || e);
            return res.status(502).json({
              ok: false,
              etapa: 'asaas-payments',
              parcela: p,
              erro: String(e?.message || e).slice(0, 800)
            });
          }
        }

        return res.json({ ok: true, parcelas: lista });

      } catch (e) {
        console.error('[BOLETO] erro interno callback', e?.message || e);
        return res.status(500).json({ ok: false, erro: String(e?.message || e).slice(0, 800) });
      }
    });

  } catch (e) {
    console.error('[BOLETO] catch externo', e?.message || e);
    return res.status(500).json({ ok: false, erro: String(e?.message || e).slice(0, 800) });
  }
});

/* ======================================================================
   WEBHOOK ASAAS (mantido)
====================================================================== */
app.post('/webhook/asaas', (req, res) => {
  try {
    const expected = process.env.ASAAS_WEBHOOK_TOKEN;
    if (expected) {
      const token = req.headers['asaas-access-token'];
      if (!token || token !== expected) {
        return res.status(401).json({ erro: 'Token inválido' });
      }
    }

    const payment = req.body && req.body.payment;
    if (!payment) {
      return res.json({ ok: true, skip: 'payload sem payment' });
    }

    const statusOriginal = String(payment.status || '');
    const statusUpper = statusOriginal.toUpperCase();

    db.run(`
      UPDATE parcelas
      SET status=?
      WHERE asaas_payment_id=?
    `,
    [statusOriginal, payment.id]);

    if (statusUpper === 'RECEIVED' || statusUpper === 'CONFIRMED') {
      db.run(`
        UPDATE inscritos
        SET status='quitado'
        WHERE id IN (
          SELECT inscrito_id FROM parcelas
          WHERE asaas_payment_id=?
        )
      `, [payment.id]);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[WEBHOOK] erro geral:', e);
    return res.json({ ok: true, erro: 'exception' });
  }
});

/* ======================================================================
   VAGAS
====================================================================== */
app.get('/vagas', (_req, res) => {
  db.get(`SELECT COUNT(*) as total FROM inscritos`, (err, row) => {
    const LIMITE = 115;
    const totalInscritos = row ? row.total : 0;
    res.json({
      total: LIMITE,
      pagos: totalInscritos,                 // mantido como no original
      restantes: LIMITE - totalInscritos
    });
  });
});

/* ======================================================================
   ADMIN
====================================================================== */
app.get('/admin/inscritos', (_req, res) => {
  db.all(`SELECT * FROM inscritos ORDER BY id DESC`, (_err, rows) => res.json(rows || []));
});

app.post('/admin/status/:id', (req, res) => {
  db.run(`UPDATE inscritos SET status=? WHERE id=?`,
    [req.body.status, req.params.id],
    () => res.json({ ok: true })
  );
});

app.post('/admin/checkin/:id', (req, res) => {
  db.run(`UPDATE inscritos SET checkin=? WHERE id=?`,
    [req.body.value, req.params.id],
    () => res.json({ ok: true })
  );
});

app.get('/admin/parcelas/:id', (req, res) => {
  db.all(`
    SELECT parcela, vencimento, valor_cents/100 as valor, status, boleto_url
    FROM parcelas
    WHERE inscrito_id=?
  `,
  [req.params.id],
  (_e, r) => res.json(r || []));
});

app.post('/admin/cancelar/:id', (req, res) => {
  db.run(`
    UPDATE inscritos
    SET status='cancelado'
    WHERE id=?
  `,
  [req.params.id],
  () => res.json({ ok: true }));
});

app.post('/admin/editar/:id', (req, res) => {
  const { nome, email, telefone, campus } = req.body || {};
  db.run(`
    UPDATE inscritos
    SET nome = COALESCE(?, nome),
        email = COALESCE(?, email),
        telefone = COALESCE(?, telefone),
        campus = COALESCE(?, campus)
    WHERE id=?
  `,
  [nome, email, telefone, campus, req.params.id],
  () => res.json({ ok: true }));
});

/* ======================================================================
   START
====================================================================== */
app.listen(PORT, () => {
  console.log('🔥 Servidor rodando porta', PORT);
});