// backend/server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
// Node 18+ tem fetch nativo
const fetch = (...args) => global.fetch(...args);
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3333;

/* ======================================================================
   CORS INFALÍVEL (dev e prod) + PRE-FLIGHT 204 + OPTIONS EXPLÍCITO
====================================================================== */
function setCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  // res.setHeader('Access-Control-Allow-Credentials', 'true');
}
app.use((req, res, next) => {
  setCors(res, req.headers.origin);
  if (req.method === 'OPTIONS') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    return res.sendStatus(204);
  }
  return next();
});
app.options('*', (req, res) => {
  setCors(res, req.headers.origin);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return res.sendStatus(204);
});
console.log('[BOOT] CORS infalível carregado');

app.use(cors());
app.use(express.json());

/* ======================================================================
   CONEXÃO POSTGRES (Render)
====================================================================== */
if (!process.env.DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL não definida. Configure no Render.');
}
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render usa SSL
});

/* ======================================================================
   CRIAÇÃO/MIGRAÇÃO DE TABELAS NO POSTGRES
   - Mantém nomes/colunas compatíveis com o SQLite original
====================================================================== */
async function ensureTables() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS public.inscritos (
      id              BIGSERIAL PRIMARY KEY,
      nome            TEXT,
      cpf             TEXT,
      cpf_norm        TEXT,
      nascimento      TEXT,
      email           TEXT,
      telefone        TEXT,
      frequentaPV     TEXT,
      campus          TEXT,
      status          TEXT DEFAULT 'pendente',
      qrcode          TEXT,
      checkin         INTEGER DEFAULT 0,
      criado_em       TIMESTAMPTZ DEFAULT NOW(),
      forma_pagamento TEXT
    );
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS public.parcelas (
      id               BIGSERIAL PRIMARY KEY,
      inscrito_id      BIGINT REFERENCES public.inscritos(id) ON DELETE CASCADE,
      parcela          INTEGER,
      valor_cents      INTEGER,
      vencimento       TEXT,
      status           TEXT,
      boleto_url       TEXT,
      asaas_payment_id TEXT
    );
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS public.leads (
      id         BIGSERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL UNIQUE,
      phone      TEXT,
      source     TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('✅ [DB] Tabelas prontas (inscritos, parcelas, leads)');
}
ensureTables().catch(err => {
  console.error('❌ [DB] Erro ao garantir tabelas:', err?.message || err);
  process.exit(1);
});

/* ======================================================================
   CONFIG ASAAS
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
  res.send('🔥 Backend Retiro rodando (PostgreSQL)');
});

/* ======================================================================
   INSCRIÇÃO (manual: sem disparar pagamentos)
   → Agora 100% em Postgres
====================================================================== */
app.post('/inscricao', async (req, res) => {
  try {
    const {
      nome, cpf, nascimento, email, telefone, frequentaPV, campus, formaPagamento
    } = req.body || {};

    const cpfNorm = normalizarCPF(cpf);
    const qr = await QRCode.toDataURL(cpfNorm + '-' + Date.now());

    const insertSQL = `
      INSERT INTO public.inscritos
      (nome, cpf, cpf_norm, nascimento, email, telefone, frequentaPV, campus, qrcode, status, forma_pagamento)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id;
    `;
    const { rows } = await pgPool.query(insertSQL, [
      nome || null,
      cpf || null,
      cpfNorm || null,
      nascimento || null,
      email || null,
      telefone || null,
      frequentaPV || null,
      campus || null,
      qr,
      'pendente_pagamento',
      formaPagamento || null
    ]);

    res.json({ id: rows[0].id });
  } catch (e) {
    console.error('[INSCRICAO] erro:', e?.message || e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

/* ======================================================================
   PIX (mantido p/ futura automação)
====================================================================== */
app.post('/pagamentos/asaas/pix/:id', async (req, res) => {
  try {
    const inscritoId = Number(req.params.id);
    const { rows } = await pgPool.query(`SELECT * FROM public.inscritos WHERE id=$1`, [inscritoId]);
    const i = rows[0];
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

    await pgPool.query(`
      INSERT INTO public.parcelas
      (inscrito_id, parcela, valor_cents, status, asaas_payment_id)
      VALUES ($1,$2,$3,$4,$5)
    `, [inscritoId, 1, 32000, 'pending', pay.id]);

    res.json({
      ok: true,
      qrPayload: pay.pixQrCode?.payload,
      qrImageBase64: pay.pixQrCode?.encodedImage
    });
  } catch (e) {
    console.error('[PIX] erro:', e?.message || e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

/* ======================================================================
   BOLETO (mantido p/ futura automação)
====================================================================== */
app.post('/pagamentos/asaas/boletos/:id', async (req, res) => {
  try {
    const inscritoId = Number(req.params.id);
    const parcelas = Number(req.body.parcelas || 3);
    const valorTotal = 320;

    const { rows } = await pgPool.query(`SELECT * FROM public.inscritos WHERE id=$1`, [inscritoId]);
    const i = rows[0];
    if (!i) return res.status(404).json({ ok: false, erro: 'Inscrito não encontrado' });

    let customer;
    try {
      customer = await getOrCreateCustomer(i.nome, i.email, i.cpf_norm);
    } catch (e) {
      return res.status(502).json({ ok: false, etapa: 'customer', erro: String(e?.message || e).slice(0, 800) });
    }

    const valorParcela = Number((valorTotal / parcelas).toFixed(2));
    const toCents = v => Math.round(Number(v) * 100);

    const HOJE = new Date(); HOJE.setHours(0,0,0,0);
    const MIN = new Date(HOJE); MIN.setDate(MIN.getDate() + 2); // D+2
    const LIMITE = new Date(2026, 3, 1); LIMITE.setHours(0,0,0,0); // 01/04/2026

    const escolhidas = Array.isArray(req.body.parcelasDatas) ? req.body.parcelasDatas : [];
    const vencimentos = [];
    const anteriores = Math.max(0, parcelas - 1);

    for (let idx = 0; idx < anteriores; idx++) {
      const iso = (escolhidas[idx] || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
        return res.status(400).json({ ok: false, etapa: 'datas', erro: `Data da parcela ${idx + 1} inválida. Use AAAA-MM-DD.` });
      }
      const d = new Date(iso + 'T00:00:00');
      if (d < MIN) {
        return res.status(400).json({ ok: false, etapa: 'datas', erro: `Data da parcela ${idx + 1} não pode ser no passado (mínimo D+2).` });
      }
      if (d > LIMITE) {
        return res.status(400).json({ ok: false, etapa: 'datas', erro: `Data da parcela ${idx + 1} deve ser até 01/04/2026.` });
      }
      vencimentos.push(iso);
    }
    vencimentos.push(LIMITE.toISOString().slice(0, 10));
    vencimentos.sort((a, b) => a.localeCompare(b));
    for (let j = 1; j < vencimentos.length; j++) {
      if (vencimentos[j] === vencimentos[j - 1]) {
        return res.status(400).json({ ok: false, etapa: 'datas', erro: 'Datas de parcelas duplicadas.' });
      }
    }

    const lista = [];
    for (let p = 1; p <= parcelas; p++) {
      const dueDate = vencimentos[p - 1];
      try {
        const pay = await asaas('/payments', {
          method: 'POST',
          body: {
            customer: customer.id,
            billingType: 'BOLETO',
            value: valorParcela,
            dueDate
          }
        });

        await pgPool.query(`
          INSERT INTO public.parcelas
          (inscrito_id, parcela, valor_cents, vencimento, status, boleto_url, asaas_payment_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [inscritoId, p, toCents(valorParcela), new Date(dueDate).toISOString(), 'PENDING', pay.bankSlipUrl, pay.id]);

        lista.push({ parcela: p, boleto_url: pay.bankSlipUrl, vencimento: dueDate, valor: valorParcela.toFixed(2) });
      } catch (e) {
        return res.status(502).json({
          ok: false, etapa: 'asaas-payments', parcela: p, erro: String(e?.message || e).slice(0, 800)
        });
      }
    }

    return res.json({ ok: true, parcelas: lista });
  } catch (e) {
    console.error('[BOLETO] erro geral:', e?.message || e);
    return res.status(500).json({ ok: false, erro: String(e?.message || e).slice(0, 800) });
  }
});

/* ======================================================================
   WEBHOOK ASAAS
====================================================================== */
app.post('/webhook/asaas', async (req, res) => {
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

    await pgPool.query(`
      UPDATE public.parcelas
      SET status=$1
      WHERE asaas_payment_id=$2
    `, [statusOriginal, payment.id]);

    if (statusUpper === 'RECEIVED' || statusUpper === 'CONFIRMED') {
      await pgPool.query(`
        UPDATE public.inscritos
        SET status='quitado'
        WHERE id IN (
          SELECT inscrito_id FROM public.parcelas WHERE asaas_payment_id=$1
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
app.get('/vagas', async (_req, res) => {
  try {
    const { rows } = await pgPool.query(`SELECT COUNT(*)::int as total FROM public.inscritos`);
    const LIMITE = 115;
    const totalInscritos = rows?.[0]?.total || 0;
    res.json({
      total: LIMITE,
      pagos: totalInscritos,
      restantes: LIMITE - totalInscritos
    });
  } catch (e) {
    res.status(500).json({ erro: 'Falha ao consultar vagas' });
  }
});

/* ======================================================================
   ADMIN
====================================================================== */
app.get('/admin/inscritos', async (_req, res) => {
  try {
    const { rows } = await pgPool.query(`SELECT * FROM public.inscritos ORDER BY id DESC`);
    res.json(rows || []);
  } catch {
    res.json([]);
  }
});

app.post('/admin/status/:id', async (req, res) => {
  await pgPool.query(`UPDATE public.inscritos SET status=COALESCE($1,status) WHERE id=$2`, [req.body.status, req.params.id]);
  res.json({ ok: true });
});

app.post('/admin/checkin/:id', async (req, res) => {
  await pgPool.query(`UPDATE public.inscritos SET checkin=COALESCE($1,checkin) WHERE id=$2`, [req.body.value, req.params.id]);
  res.json({ ok: true });
});

app.get('/admin/parcelas/:id', async (req, res) => {
  const { rows } = await pgPool.query(`
    SELECT parcela, vencimento, valor_cents/100.0 as valor, status, boleto_url
    FROM public.parcelas
    WHERE inscrito_id=$1
    ORDER BY parcela ASC
  `, [req.params.id]);
  res.json(rows || []);
});

app.post('/admin/cancelar/:id', async (req, res) => {
  await pgPool.query(`UPDATE public.inscritos SET status='cancelado' WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

app.post('/admin/editar/:id', async (req, res) => {
  const { nome, email, telefone, campus } = req.body || {};
  await pgPool.query(`
    UPDATE public.inscritos
    SET nome = COALESCE($1, nome),
        email = COALESCE($2, email),
        telefone = COALESCE($3, telefone),
        campus = COALESCE($4, campus)
    WHERE id=$5
  `, [nome, email, telefone, campus, req.params.id]);
  res.json({ ok: true });
});

/* ======================================================================
   LEADS (PostgreSQL) + E-MAIL IMEDIATO PARA VOCÊ E PARA O INSCRITO
====================================================================== */
async function enviarEmailsDeLead(lead) {
  try {
    if (!process.env.RESEND_API_KEY || !process.env.EMAIL_NOTIFICAR) {
      console.warn('⚠️ RESEND_API_KEY/EMAIL_NOTIFICAR não configurados – pulando envio de email.');
      return;
    }
    const fromAddr = process.env.EMAIL_FROM || 'retirorpulse@resend.dev';

    // Email para você
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: fromAddr,
        to: process.env.EMAIL_NOTIFICAR,
        subject: "Nova inscrição na landing!",
        html: `
          <h2>Nova inscrição</h2>
          <p><b>Nome:</b> ${lead.name}</p>
          <p><b>E-mail:</b> ${lead.email}</p>
          <p><b>Telefone:</b> ${lead.phone || "Não informado"}</p>
          <p><b>Origem:</b> ${lead.source || "landing"}</p>
          <hr>
          <p>Recebido em: ${lead.created_at}</p>
        `
      })
    });

    // Email para o inscrito
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: fromAddr,
        to: lead.email,
        subject: "Sua inscrição foi recebida! 🙌",
        html: `
          <h2>Inscrição confirmada!</h2>
          <p>Olá, <b>${lead.name}</b>! 🎉</p>
          <p>Sua inscrição no Retiro Pulse 2026 foi recebida com sucesso.</p>
          <p>Em breve nossa equipe entrará em contato com mais informações.</p>
          <br>
          <p>Abraços,<br>Equipe Retiro Pulse</p>
        `
      })
    });

    console.log('📧 Emails enviados com sucesso!');
  } catch (e) {
    console.error('Erro ao enviar emails:', e?.message || e);
  }
}

// Criação/atualização de lead (idempotência por email)
app.post('/api/leads', async (req, res) => {
  try {
    const { name, email, phone, source } = req.body || {};
    if (!name || !email) {
      return res.status(400).json({ ok: false, error: 'Nome e e-mail são obrigatórios.' });
    }

    const sql = `
      INSERT INTO public.leads (name, email, phone, source)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email)
      DO UPDATE SET name = EXCLUDED.name,
                    phone = EXCLUDED.phone,
                    source = EXCLUDED.source
      RETURNING id, name, email, phone, source, created_at;
    `;
    const { rows } = await pgPool.query(sql, [name, email, phone || null, source || null]);
    const lead = rows[0];

    // Envia e‑mails sem travar resposta
    enviarEmailsDeLead(lead).catch(console.error);

    res.status(201).json({ ok: true, lead });
  } catch (err) {
    console.error('[LEADS] POST /api/leads erro:', err?.message || err);
    res.status(500).json({ ok: false, error: 'Erro interno' });
  }
});

// Contagem de leads
app.get('/api/leads/count', async (_req, res) => {
  try {
    const { rows } = await pgPool.query('SELECT COUNT(*)::int AS count FROM public.leads;');
    res.json({ count: rows[0].count });
  } catch (err) {
    console.error('[LEADS] GET /api/leads/count erro:', err?.message || err);
    res.status(500).json({ ok: false, error: 'Falha ao contar' });
  }
});

// Listagem de leads
app.get('/api/leads', async (_req, res) => {
  try {
    const { rows } = await pgPool.query('SELECT id, name, email, phone, source, created_at FROM public.leads ORDER BY created_at DESC;');
    res.json({ leads: rows });
  } catch (err) {
    console.error('[LEADS] GET /api/leads erro:', err?.message || err);
    res.status(500).json({ ok: false, error: 'Falha ao listar' });
  }
});

/* ======================================================================
   START
====================================================================== */
app.listen(PORT, () => {
  console.log('🔥 Servidor rodando porta', PORT);
});