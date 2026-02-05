require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const PORT = 3333;

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database('./database.db');

const TOTAL_VAGAS = 115;

db.serialize(()=>{

  db.run(`CREATE TABLE IF NOT EXISTS inscritos(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    cpf TEXT,
    email TEXT,
    campus TEXT,
    status TEXT DEFAULT 'pendente',
    checkin INTEGER DEFAULT 0,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS parcelas(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inscrito_id INTEGER,
    parcela INTEGER,
    valor REAL,
    vencimento TEXT,
    status TEXT,
    boleto_url TEXT
  )`);

});

app.get('/', (_,res)=>res.send("OK"));

app.get('/vagas',(req,res)=>{

  db.get(
    "SELECT COUNT(*) AS pagos FROM inscritos WHERE status='quitado'",
    (e,row)=>{

      const pagos = row?.pagos || 0;

      res.json({
        total:TOTAL_VAGAS,
        pagos,
        restantes:TOTAL_VAGAS-pagos
      });

    });

});

app.get('/admin/inscritos',(req,res)=>{

  db.all("SELECT * FROM inscritos",(e,rows)=>{
    if(e) return res.status(500).json({erro:true});
    res.json(rows);
  });

});

app.post('/admin/status/:id',(req,res)=>{

  db.run(
    "UPDATE inscritos SET status=? WHERE id=?",
    [req.body.status, req.params.id],
    ()=>res.json({ok:true})
  );

});

app.post('/admin/checkin/:id',(req,res)=>{

  db.run(
    "UPDATE inscritos SET checkin=? WHERE id=?",
    [req.body.value, req.params.id],
    ()=>res.json({ok:true})
  );

});

app.get('/admin/parcelas/:id',(req,res)=>{

  db.all(
    "SELECT * FROM parcelas WHERE inscrito_id=?",
    [req.params.id],
    (e,rows)=>res.json(rows)
  );

});

app.listen(PORT,()=>console.log("Servidor rodando"));
