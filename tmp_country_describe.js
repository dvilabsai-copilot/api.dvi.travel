require('dotenv').config();
const mysql=require('mysql2/promise');
(async()=>{
  const m=process.env.DATABASE_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  const c=await mysql.createConnection({host:m[3],port:Number(m[4]),user:decodeURIComponent(m[1]),password:decodeURIComponent(m[2]),database:m[5]});
  const [d]=await c.query('DESCRIBE dvi_countries');
  const [sample]=await c.query('SELECT * FROM dvi_countries LIMIT 10');
  console.log(JSON.stringify({describe:d,sample},null,2));
  await c.end();
})().catch(e=>{console.error(e);process.exit(1);});
