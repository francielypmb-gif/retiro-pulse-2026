require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const QRCode = require('qrcode');

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3333;

app.use(cors());
app.use(express.json());


// ==========================
// CONFIG ASAAS
// ==========================

const ASAAS = {
  baseUrl: process.env.ASAAS_BASE_URL || "https://sandbox.asaas.com/api/v3",
  key: process.env.ASAAS_API_KEY
};

async function asaas(path, opts = {}) {

  const res = await fetch(`${ASAAS.baseUrl}${path}`, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "access_token": ASAAS.key
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });

  const text = await res.text();

  if (!res.ok) throw new Error(text);

  return JSON.parse(text);
}


// ==========================
// BANCO
// ==========================

const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error("Erro banco:", err);
  else {
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

  });

}


// ==========================
// UTIL
// ==========================

function normalizarCPF(cpf){
  return (cpf || '').replace(/\D/g,'');
}

async function getOrCreateCustomer(nome,email,cpf){

  const find = await asaas(`/customers?cpfCnpj=${cpf}`);

  if(find.data.length) return find.data[0];

  return asaas(`/customers`,{
    method:"POST",
    body:{
      name:nome,
      email,
      cpfCnpj:cpf
    }
  });

}


// ==========================
// HOME
// ==========================

app.get('/', (req,res)=>{
  res.send("🔥 Backend Retiro rodando");
});


// ==========================
// INSCRIÇÃO
// ==========================

app.post('/inscricao', async (req,res)=>{

  try{

    const {nome, cpf, nascimento, email, telefone, frequentaPV, campus} = req.body;

    const cpfNorm = normalizarCPF(cpf);

    const qr = await QRCode.toDataURL(cpfNorm + "-" + Date.now());

    db.run(`
      INSERT INTO inscritos
      (nome, cpf, cpf_norm, nascimento, email, telefone, frequentaPV, campus, qrcode)
      VALUES (?,?,?,?,?,?,?,?,?)
    `,
    [nome, cpf, cpfNorm, nascimento, email, telefone, frequentaPV, campus, qr],
    function(err){

      if(err) return res.status(500).json({erro:err.message});

      res.json({id:this.lastID});

    });

  }catch(e){
    res.status(500).json({erro:"Erro interno"});
  }

});


// ==========================
// PIX
// ==========================

app.post('/pagamentos/asaas/pix/:id', async (req,res)=>{

  try{

    const inscritoId = req.params.id;

    db.get(`SELECT * FROM inscritos WHERE id=?`,[inscritoId], async (err,i)=>{

      if(!i) return res.status(404).json({erro:"Inscrito não encontrado"});

      const customer = await getOrCreateCustomer(i.nome,i.email,i.cpf_norm);

      const pay = await asaas(`/payments`,{
        method:"POST",
        body:{
          customer:customer.id,
          billingType:"PIX",
          value:320
        }
      });

      // ✅ ADIÇÃO: registrar a cobrança PIX na tabela de parcelas (sem remover nada)
      db.run(`
        INSERT INTO parcelas
        (inscrito_id, parcela, valor_cents, status, asaas_payment_id)
        VALUES (?,?,?,?,?)
      `,
      [inscritoId, 1, 32000, "pending", pay.id]);

      res.json({
        ok:true,
        qrPayload: pay.pixQrCode.payload,
        qrImageBase64: pay.pixQrCode.encodedImage
      });

    });

  }catch(e){
    res.status(500).json({erro:e.message});
  }

});


// ==========================
// BOLETO
// ==========================

app.post('/pagamentos/asaas/boletos/:id', async (req,res)=>{

  try{

    const inscritoId = req.params.id;
    const parcelas = req.body.parcelas || 3;
    const valorTotal = 320;

    db.get(`SELECT * FROM inscritos WHERE id=?`,[inscritoId], async (err,i)=>{

      const customer = await getOrCreateCustomer(i.nome,i.email,i.cpf_norm);

      const valorParcela = valorTotal / parcelas;

      const lista = [];

      for(let p=1;p<=parcelas;p++){

        // ✅ ADIÇÃO: calcular vencimento com última em 01/04/2026
        const venc = new Date(2026,3,1); // (mês 0-based: 3 = abril)
        venc.setMonth(venc.getMonth() - (parcelas - p));
        const dueDate = venc.toISOString().slice(0,10);

        const pay = await asaas(`/payments`,{
          method:"POST",
          body:{
            customer:customer.id,
            billingType:"BOLETO",
            value:valorParcela,
            // ✅ ADIÇÃO: informar o vencimento ao Asaas
            dueDate: dueDate
          }
        });

        db.run(`
          INSERT INTO parcelas
          (inscrito_id, parcela, valor_cents, status, boleto_url, asaas_payment_id)
          VALUES (?,?,?,?,?,?)
        `,
        [inscritoId,p,valorParcela*100,"pending",pay.bankSlipUrl,pay.id]);

        // ✅ ADIÇÃO: garantir que o vencimento fique salvo mesmo sem mudar seu INSERT
        db.run(`
          UPDATE parcelas
          SET vencimento=?
          WHERE asaas_payment_id=?
        `,[venc.toISOString(), pay.id]);

        lista.push({
          parcela:p,
          boleto_url:pay.bankSlipUrl
        });

      }

      res.json({ok:true,parcelas:lista});

    });

  }catch(e){
    res.status(500).json({erro:e.message});
  }

});


// ==========================
// WEBHOOK ASAAS
// ==========================

app.post('/webhook/asaas',(req,res)=>{

  const payment = req.body.payment;

  if(!payment) return res.json({ok:true});

  db.run(`
    UPDATE parcelas
    SET status=?
    WHERE asaas_payment_id=?
  `,
  [payment.status,payment.id]);

  // ✅ ADIÇÃO: ao receber pagamento, quita automaticamente a inscrição
  if (payment.status === 'RECEIVED' || payment.status === 'CONFIRMED') {
    db.run(`
      UPDATE inscritos
      SET status='quitado'
      WHERE id IN (
        SELECT inscrito_id FROM parcelas
        WHERE asaas_payment_id=?
      )
    `,[payment.id]);
  }

  res.json({ok:true});

});


// ==========================
// VAGAS
// ==========================

app.get('/vagas',(req,res)=>{

  db.get(`SELECT COUNT(*) as total FROM inscritos`,(err,row)=>{

    const LIMITE = 115;

    res.json({
      total:LIMITE,
      pagos:row.total,
      restantes:LIMITE - row.total
    });

  });

});


// ==========================
// ADMIN
// ==========================

app.get('/admin/inscritos',(req,res)=>{
  db.all(`SELECT * FROM inscritos ORDER BY id DESC`,(err,rows)=> res.json(rows));
});

app.post('/admin/status/:id',(req,res)=>{
  db.run(`UPDATE inscritos SET status=? WHERE id=?`,
  [req.body.status, req.params.id],
  ()=> res.json({ok:true}));
});

app.post('/admin/checkin/:id',(req,res)=>{
  db.run(`UPDATE inscritos SET checkin=? WHERE id=?`,
  [req.body.value, req.params.id],
  ()=> res.json({ok:true}));
});

app.get('/admin/parcelas/:id',(req,res)=>{
  db.all(`SELECT parcela,vencimento,valor_cents/100 as valor,status,boleto_url
  FROM parcelas WHERE inscrito_id=?`,
  [req.params.id],
  (e,r)=> res.json(r));
});

// ✅ ADIÇÃO: cancelar inscrição (rota nova)
app.post('/admin/cancelar/:id',(req,res)=>{
  db.run(`
    UPDATE inscritos
    SET status='cancelado'
    WHERE id=?
  `,[req.params.id],
  ()=>res.json({ok:true}));
});

// ✅ ADIÇÃO (opcional): editar dados do inscrito (rota nova)
app.post('/admin/editar/:id',(req,res)=>{
  const { nome,email,telefone,campus } = req.body || {};
  db.run(`
    UPDATE inscritos
    SET nome = COALESCE(?, nome),
        email = COALESCE(?, email),
        telefone = COALESCE(?, telefone),
        campus = COALESCE(?, campus)
    WHERE id=?
  `,[nome,email,telefone,campus,req.params.id],
  ()=>res.json({ok:true}));
});


// ==========================
// START
// ==========================

app.listen(PORT,()=>{
  console.log("🔥 Servidor rodando porta",PORT);
});
