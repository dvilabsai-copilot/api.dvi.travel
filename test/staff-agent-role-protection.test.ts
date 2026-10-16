import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { AgentController } from '../src/modules/agent/agent.controller';
import { StaffController } from '../src/modules/staff/staff.controller';
import { SystemRole } from '../src/modules/auth/constants/system-role.constants';

test('agent-created staff receives the Staff role while retaining the agent link', async () => {
  let createdInput: any;
  const staffController = new StaffController({
    create: async (input: any) => {
      createdInput = input;
      return { ok: true };
    },
  } as any);

  await staffController.create(
    {
      user: {
        userId: 10,
        role: SystemRole.AGENT,
        agentId: 248,
      },
    },
    {
      agentId: 999,
      staffName: 'Pranamika Malhotra',
      staffMobile: '9000000000',
      staffEmail: 'pranamika@example.com',
      status: 1,
    },
  );

  assert.equal(createdInput.agentId, 248);
  assert.equal(createdInput.roleId, SystemRole.STAFF);
});

test('staff accounts cannot update the parent agent profile', async () => {
  const agentService = {
    updateSelfProfile: async () => {
      throw new Error('must not be called');
    },
  };
  const agentController = new AgentController(agentService as any, {} as any);

  assert.throws(
    () =>
      agentController.updateOwnProfile(
        {
          user: {
            role: SystemRole.AGENT,
            agentId: 248,
            staffId: 116,
          },
        },
        { firstName: 'Pranamika', lastName: 'Malhotra' } as any,
        {},
      ),
    (error: unknown) =>
      error instanceof ForbiddenException &&
      error.message === 'Only agents can update their own profile',
  );
});

test('the actual agent account can still update its own profile', async () => {
  let updateArgs: any;
  const agentService = {
    updateSelfProfile: async (...args: any[]) => {
      updateArgs = args;
      return { agent_ID: 248 };
    },
  };
  const agentController = new AgentController(agentService as any, {} as any);

  await agentController.updateOwnProfile(
    {
      user: {
        role: SystemRole.AGENT,
        agentId: 248,
        staffId: 0,
      },
    },
    { firstName: 'Aman', lastName: 'Verma' } as any,
    {},
  );

  assert.equal(updateArgs[0], 248);
  assert.equal(updateArgs[1].firstName, 'Aman');
  assert.equal(updateArgs[1].lastName, 'Verma');
});
