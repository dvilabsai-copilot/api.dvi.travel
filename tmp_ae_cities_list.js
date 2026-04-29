require('dotenv').config();
const mysql=require('mysql2/promise');
(async()=>{
  const m=process.env.DATABASE_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  const c=await mysql.createConnection({host:m[3],port:Number(m[4]),user:decodeURIComponent(m[1]),password:decodeURIComponent(m[2]),database:m[5]});
  const [ae]=await c.query("SELECT id,shortname,name FROM dvi_countries WHERE shortname='AE' LIMIT 1");
  const id=ae[0]?.id;
  const [cities]=await c.query("SELECT c.name,c.tbo_city_code FROM dvi_cities c JOIN dvi_states s ON s.id=c.state_id WHERE s.country_id=? AND c.deleted=0 AND c.tbo_city_code IS NOT NULL AND c.tbo_city_code<>'' ORDER BY c.name",[id]);
  console.log(JSON.stringify({ae:ae[0], cityCount:cities.length, cities:cities.slice(0,200)},null,2));
  await c.end();
})().catch(e=>{console.error(e);process.exit(1);});
