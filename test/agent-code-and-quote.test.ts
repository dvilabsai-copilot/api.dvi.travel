import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateUniqueAgentCode,
  getAgentCodePrefix,
} from '../src/common/utils/agent-code.util';
import { PlanEngineService } from '../src/modules/itineraries/engines/plan-engine.service';

test('agent code prefixes are derived from company/name initials', async () => {
  assert.equal(getAgentCodePrefix('Goibibo'), 'GBB');
  assert.equal(getAgentCodePrefix('Goibibo - India'), 'GI');
  assert.equal(getAgentCodePrefix('Arihant Holidays'), 'AH');
  assert.equal(getAgentCodePrefix('DVI Holidays'), 'DVH');
  assert.equal(getAgentCodePrefix('Dvi Holidays'), 'DVH');

  const tx = {
    dvi_agent: {
      findMany: async () => [],
    },
  };

  const code = await generateUniqueAgentCode(tx as any, 'Goibibo');
  assert.equal(code, 'GBB');
});

test('company initials receive a random third letter when needed', async () => {
  const tx = {
    dvi_agent: {
      findMany: async () => [],
    },
  };

  const code = await generateUniqueAgentCode(tx as any, 'Arihant Holidays');
  assert.match(code, /^AH[A-Z]$/);
});

test('duplicate agent names receive a fourth random letter', async () => {
  const tx = {
    dvi_agent: {
      findMany: async () => [{ agent_name: 'Tripozee', agent_code: 'TRP' }],
    },
  };

  const code = await generateUniqueAgentCode(tx as any, 'Tripozee');
  assert.match(code, /^TRP[A-Z]$/);
  assert.notEqual(code, 'TRP');
});

test('admin quotes retain DVI while non-admin quotes use the agent code', async () => {
  const service = new PlanEngineService();
  const tx = {
    dvi_agent: {
      findUnique: async () => ({ agent_ID: 313, agent_name: 'Goibibo', agent_code: 'GOT' }),
    },
    dvi_agent_configuration: {
      findFirst: async () => ({ company_name: 'Goibibo' }),
    },
  };
  const now = new Date(2026, 8, 24);

  const adminPrefix = await (service as any).resolveQuotePrefix(
    tx,
    now,
    { agent_id: 313 },
    1,
  );
  const agentPrefix = await (service as any).resolveQuotePrefix(
    tx,
    now,
    { agent_id: 313 },
    4,
  );

  assert.equal(adminPrefix, 'DVI202609');
  assert.equal(agentPrefix, 'GOT202609');
});

test('non-admin quotes accept four-letter duplicate-name codes', async () => {
  const service = new PlanEngineService();
  const tx = {
    dvi_agent: {
      findUnique: async () => ({ agent_ID: 310, agent_name: 'Tripozee', agent_code: 'TRPA' }),
    },
    dvi_agent_configuration: {
      findFirst: async () => ({ company_name: 'Tripozee' }),
    },
  };

  const prefix = await (service as any).resolveQuotePrefix(
    tx,
    new Date(2026, 8, 24),
    { agent_id: 310 },
    4,
  );

  assert.equal(prefix, 'TRPA202609');
});

test('non-admin quote IDs keep the date/month and continue the sequence', async () => {
  const service = new PlanEngineService();
  const tx = {
    $queryRawUnsafe: async (query: string) =>
      query.includes('GET_LOCK') ? [{ acquired: 1 }] : [{ released: 1 }],
    dvi_itinerary_plan_details: {
      findMany: async () => [{ itinerary_quote_ID: 'DVDT202609175' }],
      findFirst: async () => null,
    },
  };

  const quoteId = await (service as any).buildSafeQuoteId(
    tx,
    new Date(2026, 8, 24),
    'DVDT202609',
  );

  assert.equal(quoteId, 'DVDT202609176');
});
