require('dotenv').config();
const mysql=require('mysql2/promise');
(async()=>{
  const m=process.env.DATABASE_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  const c=await mysql.createConnection({host:m[3],port:Number(m[4]),user:decodeURIComponent(m[1]),password:decodeURIComponent(m[2]),database:m[5]});
  const [cd]=await c.query('DESCRIBE dvi_countries');
  const [ae]=await c.query("SELECT * FROM dvi_countries WHERE code='AE' OR country_code='AE' OR name LIKE '%United Arab Emirates%' LIMIT 5");
  const [cities]=await c.query("SELECT c.id,c.name,c.tbo_city_code,s.country_id FROM dvi_cities c JOIN dvi_states s ON s.id=c.state_id WHERE c.deleted=0 AND c.tbo_city_code IS NOT NULL AND c.tbo_city_code<>'' AND s.country_id IN (SELECT id FROM dvi_countries WHERE code='AE' OR country_code='AE') ORDER BY c.name");
  console.log(JSON.stringify({countryDescribe:cd,countryAE:ae,cityCount:cities.length,cities:cities.slice(0,200)},null,2));
  await c.end();
})().catch(e=>{console.error(e);process.exit(1);});
