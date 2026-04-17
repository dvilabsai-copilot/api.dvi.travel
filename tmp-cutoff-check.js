const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const plan = await p.dvi_itinerary_plan_details.findFirst({ where: { itinerary_plan_ID: 268 }, select: { trip_end_date_and_time: true, departure_type: true } });
    const end = plan?.trip_end_date_and_time;
    const depSec = end ? (end.getUTCHours()*3600 + end.getUTCMinutes()*60 + end.getUTCSeconds()) : null;
    const buf = Number(plan?.departure_type||0)===1 ? 7200 : Number(plan?.departure_type||0)===2 ? 3600 : 0;
    const cutoffSec = depSec==null ? null : Math.max(0, depSec-buf);
    const toHms = (s)=>{const h=Math.floor(s/3600)%24,m=Math.floor((s%3600)/60),ss=s%60; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`};
    console.log({ trip_end_date_and_time: end, departure_type: plan?.departure_type, report_cutoff_hms: cutoffSec==null?null:toHms(cutoffSec) });
  } finally {
    await p.$disconnect();
  }
})();
