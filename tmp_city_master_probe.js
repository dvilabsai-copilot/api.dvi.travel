require('dotenv').config();
const mysql=require('mysql2/promise');
(async()=>{
  const m=process.env.DATABASE_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  const c=await mysql.createConnection({host:m[3],port:Number(m[4]),user:decodeURIComponent(m[1]),password:decodeURIComponent(m[2]),database:m[5]});
  const [d]=await c.query('DESCRIBE tbo_city_master');
  const [r]=await c.query('SELECT * FROM tbo_city_master LIMIT 3');
  console.log(JSON.stringify({describe:d,sample:r},null,2));
  await c.end();
})().catch(e=>{console.error(e);process.exit(1);});
