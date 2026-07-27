import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertVehicleAgentCreatePolicy,
  assertVehicleAgentPlanAccess,
  assertVehicleAgentUpdatePolicy,
} from '../src/modules/itineraries/policies/vehicle-agent.policy';

const vehicleAgent = { roleID: 9, agentId: 42 };

test('vehicle agent may create only vehicle-only plans', () => {
  assert.doesNotThrow(() => assertVehicleAgentCreatePolicy(vehicleAgent, { itinerary_preference: 2 }));
  assert.throws(() => assertVehicleAgentCreatePolicy(vehicleAgent, { itinerary_preference: 1 }));
  assert.throws(() => assertVehicleAgentCreatePolicy(vehicleAgent, { itinerary_preference: 3 }));
  assert.throws(() => assertVehicleAgentCreatePolicy(vehicleAgent, { itinerary_preference: 2, agent_id: 99 }));
});

test('vehicle agent may view and update only its own vehicle-only plan', () => {
  assert.doesNotThrow(() => assertVehicleAgentPlanAccess(vehicleAgent, { agent_id: 42, itinerary_preference: 2 }));
  assert.throws(() => assertVehicleAgentPlanAccess(vehicleAgent, { agent_id: 99, itinerary_preference: 2 }));
  assert.throws(() => assertVehicleAgentPlanAccess(vehicleAgent, { agent_id: 42, itinerary_preference: 3 }));
  assert.doesNotThrow(() => assertVehicleAgentUpdatePolicy(vehicleAgent, { agent_id: 42, itinerary_preference: 2 }, { itinerary_preference: 2 }));
  assert.throws(() => assertVehicleAgentUpdatePolicy(vehicleAgent, { agent_id: 42, itinerary_preference: 1 }, { itinerary_preference: 2 }));
  assert.throws(() => assertVehicleAgentUpdatePolicy(vehicleAgent, { agent_id: 42, itinerary_preference: 2 }, { itinerary_preference: 1 }));
});
