require('dotenv').config();
const mysql=require('mysql2/promise');
(async()=>{
  const m=process.env.DATABASE_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  const c=await mysql.createConnection({host:m[3],port:Number(m[4]),user:decodeURIComponent(m[1]),password:decodeURIComponent(m[2]),database:m[5]});
  const [d]=await c.query('DESCRIBE dvi_cities');
  const [ae]=await c.query("SELECT id,name,state_id,country_id,tbo_city_code FROM dvi_cities WHERE deleted=0 AND (tbo_city_code IS NOT NULL AND tbo_city_code <> '') LIMIT 30");
  console.log(JSON.stringify({describe:d.slice(0,20), sampleWithTbo:ae},null,2));
  await c.end();
})().catch(e=>{console.error(e);process.exit(1);});
