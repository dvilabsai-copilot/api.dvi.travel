const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
console.log(Object.keys(db).filter(k => !k.startsWith("$")).slice(0, 200).join("\n"));
