// backend/server.js
require('dotenv').config();

const express = require('express');
// const cors = require('cors'); // Desnecessário: CORS custom abaixo
const QRCode = require('qrcode');
const path = require('path');
const fetch = globalThis.fetch; // Node 18+ tem fetch nativo
const { Pool } = require('pg');
const { EventEmitter } = require('events');
const { google } = require('googleapis');

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

app.use(express.json());

// 🔹 Servir a pasta "admin" do repositório em /admin-ui
//    Ex.: https://.../admin-ui/painel.html
app.use('/admin-ui', express.static(path.join(process.cwd(), 'admin')));

/* ======================================================================
   CONEXÃO POSTGRES
====================================================================== */
if (!process.env.DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL não definida. Configure no Render.');
}
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render usa SSL
});

/* ======================================================================
   EVENTOS (tempo real p/ Admin via SSE)
====================================================================== */
const events = new EventEmitter();
events.setMaxListeners(50);
function emitEvent(type, payload) {
  events.emit('evt', { type, payload, at: new Date().toISOString() });
}

/* ======================================================================
   GOOGLE SHEETS BACKUP (robusto: aceita JSON puro OU JSON em base64)
   - Compartilhe a planilha com:
     backup-retiro@inscricoesretiro2026.iam.gserviceaccount.com (Editor)
   - A aba deve se chamar exatamente: inscritos
====================================================================== */
const SHEET_ID = '1EpvUxWruk7aIEx9ZMWMdysXbvHJWewGLeR90Ri1ytsg';
const SHEET_TAB = 'inscritos';

let sheets = null;
(function initSheets() {
  try {
    // Preferimos a variável em Base64, se existir
    const rawB64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
    const rawJSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    if (!rawB64 && !rawJSON) {
      console.warn('⚠️ GOOGLE_SERVICE_ACCOUNT_JSON(_B64) ausente – backup no Sheets desabilitado.');
      return;
    }

    let creds;
    if (rawB64) {
      const decoded = Buffer.from(rawB64, 'base64').toString('utf8');
      creds = JSON.parse(decoded);
      console.log('🔐 Sheets: usando GOOGLE_SERVICE_ACCOUNT_JSON_B64');
    } else {
      // Tenta JSON puro com normalizações usuais
      let fixed = (rawJSON || '').trim();

      // remove aspas externas, caso alguém tenha colocado o JSON inteiro como string
      if ((fixed.startsWith('"') && fixed.endsWith('"')) || (fixed.startsWith("'") && fixed.endsWith("'"))) {
        fixed = fixed.slice(1, -1);
      }

      // tentativa direta
      try {
        creds = JSON.parse(fixed);
        console.log('🔐 Sheets: usando GOOGLE_SERVICE_ACCOUNT_JSON (parse direto)');
      } catch {
        // tenta converter \\n -> \n
        try {
          const fixed1 = fixed.replace(/\\n/g, '\n');
          creds = JSON.parse(fixed1);
          console.log('🔐 Sheets: usando GOOGLE_SERVICE_ACCOUNT_JSON (\\n normalizado)');
        } catch {
          // por fim, se colaram quebras de linha literais, escapa para \n
          const fixed2 = fixed.replace(/\r?\n/g, '\\n');
          creds = JSON.parse(fixed2);
          console.log('🔐 Sheets: usando GOOGLE_SERVICE_ACCOUNT_JSON (newlines escapados)');
        }
      }
    }

    const googleAuth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    sheets = google.sheets({ version: 'v4', auth: googleAuth });
    console.log('✅ Google Sheets pronto');
  } catch (e) {
    console.error('❌ Falha ao inicializar Google Sheets:', e?.message || e);
  }
})();

// Hardening: evita que Sheets “interprete” CPF/telefone; usa RAW + força texto
async function salvarBackupSheets(dados, attempt = 1) {
  if (!sheets) return; // silencioso se desabilitado
  try {
    const asText = v => (v == null ? '' : String(v));
    const forceText = v => (v == null ? '' : "'" + String(v)); // força texto no Sheets

    const criadoLocal = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).format(new Date());

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A2`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          asText(dados.id),
          asText(dados.nome),
          forceText(dados.cpf),
          asText(dados.nascimento),
          asText(dados.email),
          forceText(dados.telefone),
          asText(dados.frequentaPV),
          asText(dados.campus),
          asText(dados.formaPagamento),
          asText(dados.status),
          criadoLocal
        ]]
      }
    });
    console.log('✅ Backup Google Sheets salvo');
  } catch (e) {
    const status = e?.response?.status || 0;
    if (attempt < 3 && (status === 429 || status >= 500)) {
      const wait = 300 * attempt;
      console.warn(`⚠️ Sheets retry ${attempt} em ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      return salvarBackupSheets(dados, attempt + 1);
    }
    console.error('❌ Backup Sheets falhou:', e?.message || e);
  }
}

/* ======================================================================
   CRIAÇÃO/MIGRAÇÃO DE TABELAS + ÍNDICES
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

  // Índices úteis (performance)
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_inscritos_email ON public.inscritos (LOWER(email));`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_inscritos_cpf   ON public.inscritos (cpf_norm);`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_parcelas_ins    ON public.parcelas (inscrito_id);`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_leads_email     ON public.leads (LOWER(email));`);
  await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_leads_created   ON public.leads (created_at DESC);`);

  console.log('✅ [DB] Tabelas prontas (inscritos, parcelas, leads)');
}
ensureTables().catch(err => {
  console.error('❌ [DB] Erro ao garantir tabelas:', err?.message || err);
  process.exit(1);
});

// ❇️ Migrações extras (idempotentes) — autonomia no painel
(async function alterTablesSoftly() {
  try {
    await pgPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_schema='public' AND table_name='inscritos' AND column_name='canceled_at') THEN
          ALTER TABLE public.inscritos ADD COLUMN canceled_at TIMESTAMPTZ;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_schema='public' AND table_name='inscritos' AND column_name='cancel_reason') THEN
          ALTER TABLE public.inscritos ADD COLUMN cancel_reason TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_schema='public' AND table_name='inscritos' AND column_name='updated_at') THEN
          ALTER TABLE public.inscritos ADD COLUMN updated_at TIMESTAMPTZ;
        END IF;
      END$$;
    `);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_inscritos_status ON public.inscritos (status);`);
    console.log('✅ [DB] Colunas extras aplicadas (canceled_at, cancel_reason, updated_at)');
  } catch (e) {
    console.warn('⚠️ [DB] alterTablesSoftly:', e?.message || e);
  }
})();

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
  res.send('🔥 Backend Retiro rodando (PostgreSQL + Sheets backup)');
});

/* ======================================================================
   HEALTHCHECK (DB + Sheets)
====================================================================== */
app.get('/health', async (_req, res) => {
  const out = { ok: true, db: false, sheets: !!sheets };
  try {
    await pgPool.query('SELECT 1');
    out.db = true;
  } catch {
    out.ok = false;
  }
  res.json(out);
});

/* ======================================================================
   EMAILS — LEAD (admin + inscrito, consolidado) e INSCRIÇÃO
====================================================================== */
async function enviarEmailsDeLead(lead) {
  const results = [];
  try {
    const apiKey   = (process.env.RESEND_API_KEY || '').trim();
    const fromAddr = (process.env.EMAIL_FROM || 'retirorpulse@resend.dev').trim();
    const admins = (process.env.EMAIL_NOTIFICAR || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    if (!apiKey || admins.length === 0) {
      console.warn('⚠️ RESEND_API_KEY/EMAIL_NOTIFICAR ausentes – pulando envio de email (lead).');
      return;
    }

    // 1 único envio: admin(s) + inscrito
    const destinatarios = [...admins, (lead.email || '').trim()].filter(Boolean);

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromAddr,
        to: destinatarios,
        subject: 'Sua inscrição foi recebida! 🙌',
        html: `
          <h2>Inscrição recebida</h2>
          <p><b>Nome:</b> ${lead.name}</p>
          <p><b>E-mail:</b> ${lead.email}</p>
          <p><b>Telefone:</b> ${lead.phone || '—'}</p>
          <p><b>Origem:</b> ${lead.source || 'landing'}</p>
          <hr/>
          <p>Registrado em: ${lead.created_at}</p>
        `
      })
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    results.push({ to: destinatarios, ok: r.ok, status: r.status, body });
    if (!r.ok) throw new Error(`Resend falhou (lead) status ${r.status}`);
    console.log('📧 Emails (lead) enviados:', JSON.stringify(results));
  } catch (e) {
    console.error('❌ Erro ao enviar emails (lead):', e?.message || e);
    if (results.length) console.error('Detalhes (lead):', JSON.stringify(results));
  }
}

async function enviarEmailInscricao({ nome, email, telefone, formaPagamento }) {
  const results = [];
  try {
    const apiKey   = (process.env.RESEND_API_KEY || '').trim();
    const fromAddr = (process.env.EMAIL_FROM || 'retirorpulse@resend.dev').trim();
    const admins = (process.env.EMAIL_NOTIFICAR || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    if (!apiKey || admins.length === 0) {
      console.warn('⚠️ RESEND_API_KEY/EMAIL_NOTIFICAR ausentes – pulando envio de email (inscrição).');
      return;
    }

    const destinatarios = [...admins, (email || '').trim()].filter(Boolean);

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromAddr,
        to: destinatarios,
        subject: 'Inscrição confirmada (Retiro 2026)',
        html: `
          <h2>Nova inscrição</h2>
          <p><b>Nome:</b> ${nome}</p>
          <p><b>E-mail:</b> ${email || '—'}</p>
          <p><b>Telefone:</b> ${telefone || '—'}</p>
          <p><b>Forma de pagamento:</b> ${(formaPagamento || '—').toUpperCase()}</p>
          <hr/>
          <p>Registrado em: ${new Date().toISOString()}</p>
        `
      })
    });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    results.push({ to: destinatarios, ok: r.ok, status: r.status, body });
    if (!r.ok) throw new Error(`Resend falhou (inscrição) status ${r.status}`);
    console.log('📧 Emails (inscrição) enviados:', JSON.stringify(results));
  } catch (e) {
    console.error('❌ Erro ao enviar emails (inscrição):', e?.message || e);
  }
}

/* ======================================================================
   INSCRIÇÃO (manual: sem disparar pagamentos) — envia e-mail e evento
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

    const id = rows[0].id;

    // e-mail admin + inscrito (não bloqueante)
    enviarEmailInscricao({ nome, email, telefone, formaPagamento }).catch(console.error);
    // tempo real no painel
    emitEvent('inscrito:new', { id, nome, email, formaPagamento });

    // backup best-effort (não bloqueia resposta)
    salvarBackupSheets({
      id,
      nome,
      cpf,
      nascimento,
      email,
      telefone,
      frequentaPV,
      campus,
      formaPagamento,
      status: 'pendente_pagamento'
    }).catch(() => {});

    res.json({ id });
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
      emitEvent('inscrito:update', { asaas_payment_id: payment.id, status: 'quitado' });
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
   ADMIN — Rotas seguras por token + SSE + CSV + listas
====================================================================== */
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN) return res.status(503).json({ ok:false, error:'ADMIN_TOKEN não configurado' });
  if (token !== process.env.ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
}

// SSE de eventos (novos leads/inscrições)
app.get('/api/admin/events', adminAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': req.headers.origin || '*'
  });
  const onEvt = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  events.on('evt', onEvt);
  const ping = setInterval(() => res.write(':\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); events.removeListener('evt', onEvt); });
});

// KPIs
app.get('/api/admin/overview', adminAuth, async (_req, res) => {
  try {
    const [{ rows: r1 }, { rows: r2 }, { rows: r3 }, { rows: r4 }, { rows: r5 }, { rows: r6 }] = await Promise.all([
      pgPool.query('SELECT COUNT(*)::int AS total FROM public.inscritos'),
      pgPool.query("SELECT COUNT(*)::int AS quitados FROM public.inscritos WHERE status='quitado'"),
      pgPool.query('SELECT COUNT(*)::int AS leads_total FROM public.leads'),
      pgPool.query("SELECT COUNT(*)::int AS leads_hoje FROM public.leads WHERE created_at::date = now()::date"),
      pgPool.query('SELECT id, nome, email, status, criado_em FROM public.inscritos ORDER BY id DESC LIMIT 5'),
      pgPool.query('SELECT id, name, email, created_at FROM public.leads ORDER BY created_at DESC LIMIT 5')
    ]);
    res.json({
      inscritos_total: r1[0].total,
      inscritos_quitados: r2[0].quitados,
      inscritos_pendentes: r1[0].total - r2[0].quitados,
      leads_total: r3[0].leads_total,
      leads_hoje: r4[0].leads_hoje,
      ultimos_inscritos: r5,
      ultimos_leads: r6
    });
  } catch (e) {
    console.error('[overview] err:', e?.message || e);
    res.status(500).json({ ok:false, error:'overview failed' });
  }
});

// Lista Inscritos (filtro/paginação)
app.get('/api/admin/inscritos/list', adminAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page || '1'));
    const size  = Math.min(100, Math.max(10, parseInt(req.query.size || '20')));
    const q     = (req.query.q || '').trim();
    const status = (req.query.status || '').trim();

    const where = [];
    const args = [];
    let argi = 1;

    if (q) {
      where.push(`(LOWER(nome) LIKE LOWER($${argi}) OR LOWER(email) LIKE LOWER($${argi}) OR cpf_norm LIKE $${argi})`);
      args.push(`%${q}%`);
      argi++;
    }
    if (status) {
      where.push(`status = $${argi}`); args.push(status); argi++;
    }
    const sqlWhere = where.length ? ("WHERE " + where.join(" AND ")) : "";
    args.push(size); args.push((page-1)*size);

    const sql = `
      SELECT id, nome, email, telefone, status, criado_em, forma_pagamento
      FROM public.inscritos
      ${sqlWhere}
      ORDER BY id DESC
      LIMIT $${argi} OFFSET $${argi+1};
    `;
    const { rows } = await pgPool.query(sql, args);

    res.json({ page, size, items: rows });
  } catch (e) {
    console.error('[inscritos list] err:', e?.message || e);
    res.status(500).json({ ok:false, error:'list failed' });
  }
});

// Lista Leads (filtro/paginação)
app.get('/api/admin/leads/list', adminAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page || '1'));
    const size  = Math.min(100, Math.max(10, parseInt(req.query.size || '20')));
    const q     = (req.query.q || '').trim();

    const where = [];
    const args = [];
    let argi = 1;

    if (q) {
      where.push("(LOWER(name) LIKE LOWER($1) OR LOWER(email) LIKE LOWER($1))");
      args.push(`%${q}%`);
      argi++;
    }
    const sqlWhere = where.length ? ("WHERE " + where.join(" AND ")) : "";

    args.push(size);
    args.push((page-1)*size);

    const sql = `
      SELECT id, name, email, phone, source, created_at
      FROM public.leads
      ${sqlWhere}
      ORDER BY created_at DESC
      LIMIT $${argi} OFFSET $${argi+1};
    `;
    const { rows } = await pgPool.query(sql, args);

    res.json({ page, size, items: rows });
  } catch (e) {
    console.error('[leads list] err:', e?.message || e);
    res.status(500).json({ ok:false, error:'list failed' });
  }
});

// Export CSVs
app.get('/api/admin/export/inscritos.csv', adminAuth, async (_req, res) => {
  const { rows } = await pgPool.query(`
    SELECT id, nome, email, telefone, cpf_norm, nascimento,
           frequentaPV AS frequentapv,
           campus, status, forma_pagamento, criado_em
    FROM public.inscritos ORDER BY id DESC
  `);
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="inscritos.csv"');
  const head = 'id;nome;email;telefone;cpf;nascimento;frequentaPV;campus;status;forma_pagamento;criado_em\n';
  const body = rows.map(r => [
    r.id, r.nome, r.email, r.telefone, r.cpf_norm, r.nascimento, r.frequentapv, r.campus, r.status, r.forma_pagamento, r.criado_em?.toISOString?.() || r.criado_em
  ].map(v => (v==null?'':String(v).replaceAll(';',',').replaceAll('\n',' '))).join(';')).join('\n');
  res.send(head + body);
});

app.get('/api/admin/export/leads.csv', adminAuth, async (_req, res) => {
  const { rows } = await pgPool.query(`
    SELECT id, name, email, phone, source, created_at
    FROM public.leads ORDER BY created_at DESC
  `);
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="leads.csv"');
  const head = 'id;name;email;phone;source;created_at\n';
  const body = rows.map(r => [
    r.id, r.name, r.email, r.phone, r.source, r.created_at?.toISOString?.() || r.created_at
  ].map(v => (v==null?'':String(v).replaceAll(';',',').replaceAll('\n',' '))).join(';')).join('\n');
  res.send(head + body);
});

/* ======================================================================
   ADMIN — Inscritos: detalhes, editar, cancelar, restaurar, check-in
====================================================================== */

// Detalhe
app.get('/api/admin/inscritos/:id', adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pgPool.query(`
      SELECT id, nome, cpf, cpf_norm, nascimento, email, telefone, frequentaPV, campus, status, forma_pagamento,
             qrcode, checkin, criado_em, updated_at, canceled_at, cancel_reason
      FROM public.inscritos WHERE id=$1
    `, [id]);
    if (!rows.length) return res.status(404).json({ ok:false, error:'not found' });
    res.json({ ok:true, item: rows[0] });
  } catch (e) {
    res.status(500).json({ ok:false, error:'detail failed' });
  }
});

// Editar (parcial)
app.put('/api/admin/inscritos/:id', adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const fields = {
      nome: req.body?.nome,
      email: req.body?.email,
      telefone: req.body?.telefone,
      frequentaPV: req.body?.frequentaPV,
      campus: req.body?.campus,
      forma_pagamento: req.body?.forma_pagamento,
      nascimento: req.body?.nascimento
    };
    const sets = [];
    const args = [];
    let i = 1;
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v !== 'undefined') {
        sets.push(`${k}=$${i++}`);
        args.push(v === '' ? null : v);
      }
    }
    sets.push(`updated_at=NOW()`);
    args.push(id);

    if (sets.length === 1) return res.json({ ok:true, updated:0 }); // só updated_at

    const sql = `UPDATE public.inscritos SET ${sets.join(',')} WHERE id=$${i} RETURNING id`;
    const { rows } = await pgPool.query(sql, args);
    if (!rows.length) return res.status(404).json({ ok:false, error:'not found' });

    emitEvent('inscrito:update', { id, type:'edit' });
    res.json({ ok:true, id });
  } catch (e) {
    console.error('[admin edit] err:', e?.message || e);
    res.status(500).json({ ok:false, error:'edit failed' });
  }
});

// Cancelar inscrição (best-effort: marca parcelas pendentes como CANCELLED e tenta cancelar no Asaas)
app.post('/api/admin/inscritos/:id/cancel', adminAuth, async (req, res) => {
  const client = await pgPool.connect();
  try {
    const id = Number(req.params.id);
    const reason = (req.body?.reason || '').trim().slice(0, 300) || null;

    await client.query('BEGIN');

    const u = await client.query(`
      UPDATE public.inscritos
      SET status='cancelado', canceled_at=NOW(), cancel_reason=$2, updated_at=NOW()
      WHERE id=$1
      RETURNING id
    `, [id, reason]);
    if (!u.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok:false, error:'not found' });
    }

    const { rows: pendentes } = await client.query(`
      SELECT id, asaas_payment_id FROM public.parcelas
      WHERE inscrito_id=$1 AND COALESCE(status,'') ILIKE 'PEND%'
    `, [id]);

    for (const p of pendentes) {
      if (p.asaas_payment_id) {
        try { await asaas(`/payments/${p.asaas_payment_id}/cancel`, { method: 'POST' }); }
        catch (e) { console.warn('[asaas cancel warn]', String(e?.message || e).slice(0, 160)); }
      }
    }

    await client.query(`
      UPDATE public.parcelas
      SET status='CANCELLED'
      WHERE inscrito_id=$1 AND COALESCE(status,'') ILIKE 'PEND%'
    `, [id]);

    await client.query('COMMIT');

    emitEvent('inscrito:update', { id, status:'cancelado', reason });
    res.json({ ok:true, id });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[admin cancel] err:', e?.message || e);
    res.status(500).json({ ok:false, error:'cancel failed' });
  } finally {
    client.release();
  }
});

// Restaurar inscrição
app.post('/api/admin/inscritos/:id/restore', adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const toStatus = (req.body?.status || 'pendente_pagamento').trim();

    const { rows } = await pgPool.query(`
      UPDATE public.inscritos
      SET status=$1, canceled_at=NULL, cancel_reason=NULL, updated_at=NOW()
      WHERE id=$2
      RETURNING id
    `, [toStatus, id]);

    if (!rows.length) return res.status(404).json({ ok:false, error:'not found' });

    emitEvent('inscrito:update', { id, status: toStatus });
    res.json({ ok:true, id });
  } catch (e) {
    console.error('[admin restore] err:', e?.message || e);
    res.status(500).json({ ok:false, error:'restore failed' });
  }
});

// Check-in toggle/forçado
app.post('/api/admin/inscritos/:id/checkin', adminAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const force = req.body?.value; // 0/1 opcional
    const q = typeof force === 'number'
      ? `UPDATE public.inscritos SET checkin=$2, updated_at=NOW() WHERE id=$1 RETURNING id, checkin`
      : `UPDATE public.inscritos SET checkin=CASE WHEN checkin=1 THEN 0 ELSE 1 END, updated_at=NOW() WHERE id=$1 RETURNING id, checkin`;
    const args = typeof force === 'number' ? [id, force] : [id];
    const { rows } = await pgPool.query(q, args);
    if (!rows.length) return res.status(404).json({ ok:false, error:'not found' });
    emitEvent('inscrito:update', { id, checkin: rows[0].checkin });
    res.json({ ok:true, id, checkin: rows[0].checkin });
  } catch (e) {
    console.error('[admin:checkin] err:', e?.message || e);
    res.status(500).json({ ok:false, error:'checkin failed' });
  }
});

/* ======================================================================
   LEADS — API pública
====================================================================== */
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

    // e‑mail consolidado e evento p/ painel
    enviarEmailsDeLead(lead).catch(console.error);
    emitEvent('lead:new', { id: lead.id, name: lead.name, email: lead.email, at: lead.created_at });

    res.status(201).json({ ok: true, lead });
  } catch (err) {
    console.error('[LEADS] POST /api/leads erro:', err?.message || err);
    res.status(500).json({ ok: false, error: 'Erro interno' });
  }
});

app.get('/api/leads/count', async (_req, res) => {
  try {
    const { rows } = await pgPool.query('SELECT COUNT(*)::int AS count FROM public.leads;');
    res.json({ count: rows[0].count });
  } catch (err) {
    console.error('[LEADS] GET /api/leads/count erro:', err?.message || err);
    res.status(500).json({ ok: false, error: 'Falha ao contar' });
  }
});

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