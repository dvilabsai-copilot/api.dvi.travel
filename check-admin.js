const {PrismaClient} = require('./node_modules/@prisma/client');
const p = new PrismaClient();
p.dvi_users.findFirst({
  where: { user_email: { contains: 'admin' } },
  select: { user_email: true, user_password: true }
}).then(r => { console.log(JSON.stringify(r)); p.$disconnect(); });
