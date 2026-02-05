require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3333;

app.use(cors());
app.use(express.json());


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
        boleto_url TEXT
      )
    `);

    console.log("✅ Tabelas criadas/verificadas");

  });

}


// ==========================
// UTIL
// ==========================

function normalizarCPF(cpf){
  return (cpf || '').replace(/\D/g,'');
}


// ==========================
// HOME
// ==========================

app.get('/', (req,res)=>{
  res.send("🔥 Backend Retiro rodando");
});


// ==========================
// CRIAR INSCRIÇÃO
// ==========================

app.post('/inscricao', async (req,res)=>{

  try{

    const {nome, cpf, nascimento, email, telefone, frequentaPV, campus} = req.body;

    if(!nome || !cpf || !email)
      return res.status(400).json({erro:"Campos obrigatórios"});

    const cpfNorm = normalizarCPF(cpf);

    const qr = await QRCode.toDataURL(cpfNorm + "-" + Date.now());

    db.run(`
      INSERT INTO inscritos
      (nome, cpf, cpf_norm, nascimento, email, telefone, frequentaPV, campus, qrcode)
      VALUES (?,?,?,?,?,?,?,?,?)
    `,
    [nome, cpf, cpfNorm, nascimento, email, telefone, frequentaPV, campus, qr],
    function(err){

      if(err){
        console.log(err);
        return res.status(500).json({erro:err.message});
      }

      res.json({id:this.lastID});

    });

  }catch(e){
    console.log(e);
    res.status(500).json({erro:"Erro interno"});
  }

});


// ==========================
// VAGAS
// ==========================

app.get('/vagas',(req,res)=>{

  db.get(`
    SELECT COUNT(*) as total,
    SUM(CASE WHEN status='quitado' THEN 1 ELSE 0 END) as pagos
    FROM inscritos
  `,(err,row)=>{

    if(err) return res.status(500).json({erro:err.message});

    const LIMITE = 115;

    const restantes = LIMITE - (row.total || 0);

    res.json({
      total: row.total || 0,
      pagos: row.pagos || 0,
      restantes
    });

  });

});


// ==========================
// ADMIN LISTA INSCRITOS
// ==========================

app.get('/admin/inscritos',(req,res)=>{

  db.all(`
    SELECT * FROM inscritos
    ORDER BY id DESC
  `,(err,rows)=>{

    if(err) return res.status(500).json({erro:err.message});

    res.json(rows);

  });

});


// ==========================
// ADMIN STATUS
// ==========================

app.post('/admin/status/:id',(req,res)=>{

  const {status} = req.body;

  db.run(`
    UPDATE inscritos
    SET status=?
    WHERE id=?
  `,
  [status, req.params.id],
  function(err){

    if(err) return res.status(500).json({erro:err.message});

    res.json({ok:true});

  });

});


// ==========================
// ADMIN CHECKIN
// ==========================

app.post('/admin/checkin/:id',(req,res)=>{

  const {value} = req.body;

  db.run(`
    UPDATE inscritos
    SET checkin=?
    WHERE id=?
  `,
  [value, req.params.id],
  function(err){

    if(err) return res.status(500).json({erro:err.message});

    res.json({ok:true});

  });

});


// ==========================
// ADMIN PARCELAS
// ==========================

app.get('/admin/parcelas/:id',(req,res)=>{

  db.all(`
    SELECT
      parcela,
      vencimento,
      valor_cents/100.0 as valor,
      status,
      boleto_url
    FROM parcelas
    WHERE inscrito_id=?
  `,
  [req.params.id],
  (err,rows)=>{

    if(err) return res.status(500).json({erro:err.message});

    res.json(rows);

  });

});


// ==========================
// START
// ==========================

app.listen(PORT,()=>{
  console.log("🔥 Servidor rodando porta",PORT);
});
