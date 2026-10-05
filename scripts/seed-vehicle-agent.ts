import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import {
  generateUniqueAgentCode,
  withAgentCodeGenerationLock,
} from '../src/common/utils/agent-code.util';

const prisma = new PrismaClient();
const EMAIL = 'demo@dvi.travel';
const PASSWORD = 'demodvi123!';
const ROLE_ID = 9;
const DISPLAY_NAME = 'DVI Demo Itinerary Agent';

function normalized(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

async function main() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production' &&
      String(process.env.ALLOW_DEMO_USER_SEED || '').toLowerCase() !== 'true') {
    throw new Error('Refusing demo vehicle-agent seed in production. Set ALLOW_DEMO_USER_SEED=true to opt in.');
  }

  const now = new Date();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const result = await prisma.$transaction(async (tx) => withAgentCodeGenerationLock(tx as any, async () => {
    const agentRows =
  await tx.$queryRaw<
    Array<{
      agent_ID: number;
      agent_code:
        string | null;
    }>
  >`
    SELECT
      agent_ID,
      agent_code
    FROM dvi_agent
    WHERE LOWER(TRIM(agent_email_id)) = ${EMAIL}
      AND deleted = 0
    ORDER BY agent_ID ASC
  `;

if (agentRows.length > 1) {
  throw new Error(
    `Duplicate active agents found for ${EMAIL}.`,
  );
}

/*
 * agent_code exists in the DB flow but
 * is not currently exposed by the
 * generated Prisma dvi_agent type.
 *
 * Read it through SQL instead.
 */
const existingAgentCode =
  String(
    agentRows[0]
      ?.agent_code ??
      '',
  )
    .trim()
    .toUpperCase();

const agentCode =
  existingAgentCode ||
  await generateUniqueAgentCode(
    tx as any,
    DISPLAY_NAME,
  );

/*
 * Do not send agent_code through the
 * Prisma dvi_agent model while the
 * generated client does not expose it.
 */
const agent =
  agentRows[0]
    ? await tx.dvi_agent.update({
        where: {
          agent_ID:
            Number(
              agentRows[0].agent_ID,
            ),
        },

        data: {
          agent_name:
            DISPLAY_NAME,

          agent_email_id:
            EMAIL,

          status: 1,
          deleted: 0,
          updatedon: now,
        },
      })
    : await tx.dvi_agent.create({
        data: {
          agent_name:
            DISPLAY_NAME,

          agent_ref_no:
            'DEMO-VEHICLE-AGENT',

          agent_email_id:
            EMAIL,

          status: 1,
          deleted: 0,
          createdon: now,
          updatedon: now,
        },
      });

/*
 * Persist agent_code directly because
 * the database column is being used by
 * the existing Agent-code flow while
 * Prisma's generated type is currently
 * missing it.
 */
await tx.$executeRaw`
  UPDATE dvi_agent
  SET agent_code = ${agentCode}
  WHERE agent_ID = ${agent.agent_ID}
`;

    const userRows = await tx.$queryRaw<Array<{ userID: bigint }>>`
      SELECT userID FROM dvi_users
      WHERE LOWER(TRIM(useremail)) = ${EMAIL}
      ORDER BY userID ASC
    `;
    if (userRows.length > 1) throw new Error(`Duplicate users found for ${EMAIL}.`);

    const user = userRows[0]
      ? await tx.dvi_users.update({
          where: { userID: userRows[0].userID },
          data: {
            agent_id: agent.agent_ID,
            username: DISPLAY_NAME,
            useremail: EMAIL,
            password: passwordHash,
            roleID: ROLE_ID,
            userapproved: 1,
            userbanned: 0,
            status: 1,
            deleted: 0,
            updatedon: now,
          },
        })
      : await tx.dvi_users.create({
          data: {
            agent_id: agent.agent_ID,
            username: DISPLAY_NAME,
            useremail: EMAIL,
            password: passwordHash,
            roleID: ROLE_ID,
            userapproved: 1,
            userbanned: 0,
            status: 1,
            deleted: 0,
            createdby: 0n,
            createdon: now,
            updatedon: now,
          },
        });

    return { agentId: agent.agent_ID, userId: String(user.userID) };
  }));

  console.log(JSON.stringify({ email: EMAIL, roleId: ROLE_ID, ...result }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
