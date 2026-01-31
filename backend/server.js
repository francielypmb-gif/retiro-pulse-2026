// ==========================
// backend/server.js
// Retiro 2026 — Inscrição + Boleto (1x/2x/3x com deadline 2026-04-01) + Pix + Webhook + Admin
// ==========================
require('dotenv').config();

console.log('[ENV] ASAAS_BASE_URL:', process.env.ASAAS_BASE_URL || '(default sandbox)');
console.log('[ENV] ASAAS_API_KEY:', (process.env.ASAAS_API_KEY || '').slice(0, 12) + '...');

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const QRCode = require('qrcode');

// Se quiser usar fetch nativo do Node 18+, comente a linha abaixo.
// (No seu Mac já tem, mas deixo compatível com Node < 18 também.)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = 3333;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================
// UTIL
// ==========================
function normalizarCPF(cpf) {
  return (cpf || '').replace(/\D/g, '');
}

function toISO(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function addDays(base, dias) {
  const d = new Date(base);
  d.setDate(d.getDate() + dias);
  return d;
}

/**
 * Gera cronograma de 'n' parcelas com a ÚLTIMA em 'deadlineISO' (ex.: 2026-04-01).
 * - Primeira parcela nunca antes de D+3 (tempo p/ emissão e pagamento).
 * - Se o intervalo for curto, aproxima as primeiras e respeita o deadline.
 */
function gerarVencimentosAteDeadline(n, deadlineISO) {
  const hoje = new Date();
  const minPrimeira = addDays(hoje, 3); // D+3
  const deadline = new Date(deadlineISO);

  if (n <= 1) {
    const unica = (deadline < minPrimeira) ? minPrimeira : deadline;
    return [ toISO(unica) ];
  }

  const totalDias = Math.max(0, Math.floor((deadline - minPrimeira) / (24*3600*1000)));
  const datas = [];

  if (totalDias <= 0) {
    for (let i = 0; i < n - 1; i++) datas.push(toISO(addDays(minPrimeira, i)));
    datas.push(toISO(deadline));
    return datas;
  }

  const step = Math.floor(totalDias / (n - 1));
  for (let i = 0; i < n - 1; i++) {
    const di = addDays(minPrimeira, i * step);
    datas.push(toISO(di));
  }
  datas.push(toISO(deadline));
  return datas;
}

// Divide valor em n parcelas (centavos). A última absorve os centavos de diferença.
function dividirValor(totalCents, n) {
  const base = Math.floor(totalCents / n);
  const arr = Array(n).fill(base);
  const soma = base * n;
  const resto = totalCents - soma;
  arr[n - 1] += resto;
  return arr;
}

// ==========================
// ASAAS
// ==========================
const ASAAS = {
  baseUrl: process.env.ASAAS_BASE_URL || 'https://sandbox.asaas.com/api/v3',
  key: process.env.ASAAS_API_KEY || ''
};

async function asaas(path, opts = {}) {
  if (!ASAAS.key) throw new Error('ASAAS_API_KEY não configurada (.env)');

  const url = `${ASAAS.baseUrl}${path}`;
  console.log('[ASAAS] >>', opts.method || 'GET', url);
  if (opts.body) console.log('[ASAAS] body:', opts.body);

  const res  = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'access_token': ASAAS.key },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });

  const text = await res.text(); // lê sempre
  if (!res.ok) {
    console.error('[ASAAS] ERROR', res.status, text);
    // Propaga o detalhe do erro para o front enxergar (Network/alerta)
    throw new Error(`ASAAS ${res.status}: ${text}`);
  }
  console.log('[ASAAS] <<', text.slice(0, 140) + (text.length > 140 ? '...' : ''));
  return JSON.parse(text);
}

async function getOrCreateCustomer({ nome, email, cpf }) {
  const find = await asaas(`/customers?cpfCnpj=${cpf}`);
  if (find?.data?.length) return find.data[0];
  return asaas(`/customers`, { method: 'POST', body: { name: nome, email, cpfCnpj: cpf } });
}

// ==========================
// DATABASE
// ==========================
const db = new sqlite3.Database('./database.db');

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

db.run(`CREATE INDEX IF NOT EXISTS idx_inscritos_cpf_norm ON inscritos(cpf_norm)`);

// ==========================
// CONFIG EVENTO
// ==========================
const TOTAL_VAGAS = 115;

// ==========================
// ROTAS BÁSICAS
// ==========================
app.get('/', (_, res) => {
  res.send('🔥 Backend Retiro 2026 rodando!');
});

app.get('/vagas', (req, res) => {
  db.get("SELECT COUNT(*) AS pagos FROM inscritos WHERE status = 'quitado'", (err, row) => {
    if (err) return res.status(500).json({ erro: true });
    const pagos = row?.pagos || 0;
    res.json({ total: TOTAL_VAGAS, pagos, restantes: Math.max(TOTAL_VAGAS - pagos, 0) });
  });
});

// ==========================
// INSCRIÇÃO
// ==========================
app.post('/inscricao', async (req, res) => {
  try {
    const { nome, cpf, nascimento, email, telefone, frequentaPV, campus } = req.body;

    if (!nome || !cpf || !nascimento || !email || !telefone || !frequentaPV) {
      return res.status(400).json({ erro: 'Campos obrigatórios.' });
    }

    const cpfNorm = normalizarCPF(cpf);
    if (!/^\d{11}$/.test(cpfNorm)) {
      return res.status(400).json({ erro: 'CPF inválido.' });
    }
    if (frequentaPV === 'Sim' && !campus) {
      return res.status(400).json({ erro: 'Selecione o campus.' });
    }

    // Bloqueio por duplicidade (pendente/parcial/quitado)
    db.get(
      `SELECT id FROM inscritos 
        WHERE cpf_norm = ? 
          AND status IN ('pendente','parcial','quitado')
        LIMIT 1`,
      [cpfNorm],
      (errDup, dup) => {
        if (errDup) return res.status(500).json({ erro: 'Erro interno.' });
        if (dup)   return res.status(409).json({ erro: 'Já existe inscrição para este CPF.' });

        // Checar vagas (com base em quitados)
        db.get("SELECT COUNT(*) AS pagos FROM inscritos WHERE status = 'quitado'", async (errV, rowV) => {
          if (errV) return res.status(500).json({ erro: 'Erro interno.' });

          const restantes = Math.max(TOTAL_VAGAS - (rowV?.pagos || 0), 0);
          if (restantes <= 0) return res.status(403).json({ erro: 'Inscrições encerradas.' });

          // Gerar QR único
          const qr = await QRCode.toDataURL(cpfNorm + '-' + Date.now());

          // Inserir
          db.run(
            `INSERT INTO inscritos 
              (nome, cpf, cpf_norm, nascimento, email, telefone, frequentaPV, campus, status, qrcode)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?)`,
            [nome, cpf, cpfNorm, nascimento, email, telefone, frequentaPV, campus || null, qr],
            function (eIns) {
              if (eIns) {
                if (String(eIns.message || '').toUpperCase().includes('UNIQUE') ||
                    String(eIns.message || '').toUpperCase().includes('CONSTRAINT')) {
                  return res.status(409).json({ erro: 'Já existe inscrição para este CPF.' });
                }
                return res.status(500).json({ erro: 'Erro ao salvar inscrição.' });
              }
              res.json({ id: this.lastID, mensagem: 'Inscrição criada com sucesso!' });
            }
          );
        });
      }
    );
  } catch (e) {
    console.error('[/inscricao] erro:', e);
    res.status(500).json({ erro: 'Erro ao criar inscrição.' });
  }
});

// ==========================
// ADMIN (listar / status / check-in / parcelas)
// ==========================
app.get('/admin/inscritos', (req, res) => {
  db.all('SELECT * FROM inscritos ORDER BY id DESC', (err, rows) => {
    if (err) return res.status(500).json({ erro: true });
    res.json(rows);
  });
});

app.post('/admin/status/:id', (req, res) => {
  const { status } = req.body; // pendente | parcial | quitado | cancelado
  if (!status) return res.status(400).json({ erro: 'status obrigatório' });
  db.run('UPDATE inscritos SET status = ? WHERE id = ?', [status, req.params.id], (e) => {
    if (e) return res.status(500).json({ erro: true });
    res.json({ ok: true });
  });
});

app.post('/admin/checkin/:id', (req, res) => {
  const value = typeof req.body?.value === 'number' ? req.body.value : 1;
  db.run('UPDATE inscritos SET checkin = ? WHERE id = ?', [value, req.params.id], (e) => {
    if (e) return res.status(500).json({ erro: true });
    res.json({ ok: true });
  });
});

app.get('/admin/parcelas/:inscritoId', (req, res) => {
  const id = Number(req.params.inscritoId);
  if (!id) return res.status(400).json({ erro: 'inscritoId inválido' });

  db.all(
    `SELECT parcela, valor_cents, vencimento, status, boleto_url, asaas_payment_id
       FROM parcelas
      WHERE inscrito_id = ?
      ORDER BY parcela ASC`,
    [id],
    (err, rows) => {
      if (err) return res.status(500).json({ erro: true });
      const out = (rows || []).map(r => ({
        parcela: r.parcela,
        valor: (r.valor_cents || 0) / 100,
        vencimento: r.vencimento,
        status: (r.status || '').toLowerCase(),
        boleto_url: r.boleto_url || null,
        payment_id: r.asaas_payment_id || null
      }));
      res.json(out);
    }
  );
});

// ==========================
// BOLETOS 1x/2x/3x (última em 2026-04-01)
// ==========================
app.post('/pagamentos/asaas/boletos/:inscritoId', async (req, res) => {
  console.log('[BOLETOS] criando boletos para inscrito', req.params.inscritoId);
  try {
    const inscritoId = Number(req.params.inscritoId);
    if (!inscritoId) return res.status(400).json({ ok:false, erro: 'inscritoId inválido' });

    const qtd = Math.min(3, Math.max(1, Number(req.body?.parcelas || 3))); // 1..3
    const DEADLINE_ISO = '2026-04-01';
    const TOTAL_CENTS  = 32000; // R$ 320,00

    db.get('SELECT * FROM inscritos WHERE id = ?', [inscritoId], async (err, i) => {
      if (err || !i) return res.status(404).json({ ok:false, erro: 'Inscrito não encontrado' });

      const customer = await getOrCreateCustomer({ nome: i.nome, email: i.email, cpf: i.cpf_norm });

      const vencs   = gerarVencimentosAteDeadline(qtd, DEADLINE_ISO);
      const valores = dividirValor(TOTAL_CENTS, qtd);

      const parcelas = [];
      for (let idx = 0; idx < qtd; idx++) {
        const valorReais = valores[idx] / 100;
        const dueDateISO = vencs[idx];

        const pay = await asaas(`/payments`, {
          method: 'POST',
          body: {
            customer: customer.id,
            billingType: 'BOLETO',
            value: valorReais,
            dueDate: dueDateISO,
            description: `Retiro 2026 — Parcela ${idx + 1}/${qtd}`
          }
        });

        db.run(
          `INSERT INTO parcelas
            (inscrito_id, parcela, valor_cents, vencimento, status, boleto_url, asaas_payment_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [inscritoId, idx + 1, valores[idx], dueDateISO, (pay.status || 'PENDING').toLowerCase(), pay.bankSlipUrl || null, pay.id]
        );

        parcelas.push({
          parcela: idx + 1,
          valor: valorReais.toFixed(2),
          vencimento: dueDateISO,
          boleto_url: pay.bankSlipUrl || null
        });
      }

      db.run('UPDATE inscritos SET status = "parcial" WHERE id = ?', [inscritoId]);
      console.log('[BOLETOS] OK id:', inscritoId, 'parcelas:', parcelas.length);
      res.json({ ok: true, parcelas });
    });
  } catch (e) {
    console.error('[BOLETOS] erro:', e);
    return res.status(502).json({
      ok: false,
      erro: 'Falha ao criar boletos',
      detalhe: String(e.message || e) // aparece no Network/alerta do front
    });
  }
});

// ==========================
// PIX (à vista)
// ==========================
app.post('/pagamentos/asaas/pix/:inscritoId', async (req, res) => {
  console.log('[PIX] criando pix para inscrito', req.params.inscritoId);
  try {
    const inscritoId = Number(req.params.inscritoId);
    if (!inscritoId) return res.status(400).json({ erro: 'inscritoId inválido' });

    db.get('SELECT * FROM inscritos WHERE id = ?', [inscritoId], async (e, i) => {
      if (e || !i) return res.status(404).json({ erro: 'Inscrito não encontrado' });

      const customer = await getOrCreateCustomer({ nome: i.nome, email: i.email, cpf: i.cpf_norm });
      const valorEmReais = 320.00;

      const pay = await asaas(`/payments`, {
        method: 'POST',
        body: {
          customer: customer.id,
          billingType: 'PIX',
          value: valorEmReais,
          description: 'Retiro 2026 - Inscrição (PIX à vista)'
        }
      });

      const qr =
        pay?.pixQrCode?.payload ||
        pay?.pixQrCode?.emv ||
        pay?.qrCode?.payload ||
        pay?.payload ||
        null;

      const qrImage =
        pay?.pixQrCode?.encodedImage ||
        pay?.qrCode?.encodedImage ||
        null;

      const viewUrl = pay?.invoiceUrl || pay?.bankSlipUrl || null;

      db.run('UPDATE inscritos SET status = "parcial" WHERE id = ?', [inscritoId]);

      console.log('[PIX] OK id:', inscritoId, 'paymentId:', pay.id, 'temPayload:', !!qr);
      res.json({
        ok: true,
        paymentId: pay.id,
        valor: valorEmReais,
        qrPayload: qr || '',
        qrImageBase64: qrImage || null,
        viewUrl
      });
    });
  } catch (e) {
    console.error('[PIX] erro:', e);
    res.status(500).json({ erro: 'Falha ao criar Pix.' });
  }
});

// ==========================
// WEBHOOK ASAAS
// ==========================
app.post('/webhook/asaas', (req, res) => {
  try {
    const payment = req.body?.payment;
    if (!payment?.id) return res.json({ ok: true });

    db.get('SELECT * FROM parcelas WHERE asaas_payment_id = ?', [payment.id], (err, parc) => {
      if (err || !parc) return res.json({ ok: true });

      const status = (payment.status || '').toLowerCase();
      db.run('UPDATE parcelas SET status = ? WHERE id = ?', [status, parc.id]);

      db.all('SELECT status FROM parcelas WHERE inscrito_id = ?', [parc.inscrito_id], (e, list) => {
        if (e || !list) return res.json({ ok: true });

        const todasPagas = list.length >= 3 && list.every(p => (p.status || '').toLowerCase() === 'received');
        db.run('UPDATE inscritos SET status = ? WHERE id = ?', [todasPagas ? 'quitado' : 'parcial', parc.inscrito_id]);
        return res.json({ ok: true });
      });
    });
  } catch (e) {
    console.error('[WEBHOOK] erro:', e);
    res.json({ ok: true }); // evita re-tentativas
  }
});

// ==========================
// START
// ==========================
app.listen(PORT, () => {
  console.log(`🔥 Servidor rodando em http://localhost:${PORT}`);
});