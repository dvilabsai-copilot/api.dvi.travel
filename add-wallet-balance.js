require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function usage() {
  console.log('Usage: node add-wallet-balance.js --agent <id> --amount <value> [options]');
  console.log('');
  console.log('Required:');
  console.log('  --agent <id>              Agent ID (dvi_agent.agent_ID)');
  console.log('  --amount <value>          Amount to add/subtract');
  console.log('');
  console.log('Optional:');
  console.log('  --wallet <cash|coupon>    Wallet type (default: cash)');
  console.log('  --type <credit|debit>     Transaction type (default: credit)');
  console.log('  --remarks <text>          Remarks text');
  console.log('  --createdby <id>          createdby value (default: 0)');
  console.log('');
  console.log('Examples:');
  console.log('  node add-wallet-balance.js --agent 126 --amount 500000');
  console.log('  node add-wallet-balance.js --agent 126 --amount 1000 --wallet cash --type debit');
  console.log('  node add-wallet-balance.js --agent 126 --amount 2500 --wallet coupon --remarks "Manual topup"');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function normalizeInputs(raw) {
  const agentId = Number(raw.agent);
  const amount = Number(raw.amount);
  const wallet = String(raw.wallet || 'cash').toLowerCase();
  const type = String(raw.type || 'credit').toLowerCase();
  const createdBy = Number(raw.createdby || 0);
  const remarks = raw.remarks ? String(raw.remarks) : null;

  if (!Number.isInteger(agentId) || agentId <= 0) {
    throw new Error('Invalid --agent. It must be a positive integer.');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid --amount. It must be a positive number.');
  }
  if (wallet !== 'cash' && wallet !== 'coupon') {
    throw new Error('Invalid --wallet. Use cash or coupon.');
  }
  if (type !== 'credit' && type !== 'debit') {
    throw new Error('Invalid --type. Use credit or debit.');
  }
  if (!Number.isInteger(createdBy) || createdBy < 0) {
    throw new Error('Invalid --createdby. It must be an integer >= 0.');
  }

  return { agentId, amount, wallet, type, createdBy, remarks };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.agent || !args.amount) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const input = normalizeInputs(args);
  const sign = input.type === 'credit' ? 1 : -1;
  const signedAmount = input.amount * sign;
  const walletTxType = input.type === 'credit' ? 1 : 2;

  const result = await prisma.$transaction(async (tx) => {
    const agent = await tx.dvi_agent.findUnique({
      where: { agent_ID: input.agentId },
      select: {
        agent_ID: true,
        total_cash_wallet: true,
        total_coupon_wallet: true,
      },
    });

    if (!agent) {
      throw new Error(`Agent not found for agent_ID=${input.agentId}`);
    }

    const currentCash = Number(agent.total_cash_wallet || 0);
    const currentCoupon = Number(agent.total_coupon_wallet || 0);

    const nextCash = input.wallet === 'cash' ? currentCash + signedAmount : currentCash;
    const nextCoupon = input.wallet === 'coupon' ? currentCoupon + signedAmount : currentCoupon;

    if (nextCash < 0) {
      throw new Error(`Insufficient cash wallet balance. Current=${currentCash}, requested delta=${signedAmount}`);
    }
    if (nextCoupon < 0) {
      throw new Error(`Insufficient coupon wallet balance. Current=${currentCoupon}, requested delta=${signedAmount}`);
    }

    const updatedAgent = await tx.dvi_agent.update({
      where: { agent_ID: input.agentId },
      data: {
        total_cash_wallet: nextCash,
        total_coupon_wallet: nextCoupon,
        updatedon: new Date(),
      },
      select: {
        agent_ID: true,
        total_cash_wallet: true,
        total_coupon_wallet: true,
      },
    });

    const txnData = {
      agent_id: input.agentId,
      transaction_date: new Date(),
      transaction_amount: Math.abs(input.amount),
      transaction_type: walletTxType,
      remarks:
        input.remarks ||
        `Manual ${input.type} via script (${input.wallet} wallet)` ,
      createdby: input.createdBy,
      createdon: new Date(),
      status: 1,
      deleted: 0,
    };

    if (input.wallet === 'cash') {
      await tx.dvi_cash_wallet.create({ data: txnData });
    } else {
      await tx.dvi_coupon_wallet.create({ data: txnData });
    }

    return {
      before: { cash: currentCash, coupon: currentCoupon },
      after: {
        cash: Number(updatedAgent.total_cash_wallet || 0),
        coupon: Number(updatedAgent.total_coupon_wallet || 0),
      },
      agentId: updatedAgent.agent_ID,
      wallet: input.wallet,
      type: input.type,
      amount: input.amount,
    };
  });

  console.log(JSON.stringify({ success: true, result }, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ success: false, message: error.message }, null, 2));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
