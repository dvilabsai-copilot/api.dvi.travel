require('dotenv').config();
const mysql=require('mysql2/promise');
(async()=>{
  const m=process.env.DATABASE_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  const c=await mysql.createConnection({host:m[3],port:Number(m[4]),user:decodeURIComponent(m[1]),password:decodeURIComponent(m[2]),database:m[5]});
  const [cnt]=await c.query("SELECT COUNT(*) c FROM dvi_cities WHERE deleted=0 AND tbo_city_code IS NOT NULL AND tbo_city_code<>''");
  const [sample]=await c.query("SELECT id,name,state_id,tbo_city_code FROM dvi_cities WHERE deleted=0 AND tbo_city_code IS NOT NULL AND tbo_city_code<>'' ORDER BY id DESC LIMIT 50");
  const [stateDesc]=await c.query('DESCRIBE dvi_states');
  const [countryDesc]=await c.query('DESCRIBE dvi_country');
  console.log(JSON.stringify({count:cnt[0].c,sample,stateDesc,countryDesc},null,2));
  await c.end();
})().catch(e=>{console.error(e);process.exit(1);});
