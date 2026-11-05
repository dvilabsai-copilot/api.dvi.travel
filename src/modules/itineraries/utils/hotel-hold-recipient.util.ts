type HoldPlanRecipientFields = {
  agent_id?: number | null;
  staff_id?: number | null;
  createdby?: number | null;
};

const emailValue = (value: unknown) => String(value || '').trim();

export async function resolveHotelHoldNotificationRecipient(
  prisma: any,
  plan: HoldPlanRecipientFields | null | undefined,
): Promise<string | null> {
  const agentId = Number(plan?.agent_id || 0);
  if (agentId > 0) {
    const agent = await prisma.dvi_agent.findFirst({
      where: { agent_ID: agentId, status: 1, deleted: 0 },
      select: { agent_email_id: true, travel_expert_id: true },
    });
    const agentEmail = emailValue(agent?.agent_email_id);
    if (agentEmail) return agentEmail;

    const linkedUser = await prisma.dvi_users.findFirst({
      where: { agent_id: agentId, status: 1, deleted: 0 },
      select: { useremail: true },
    });
    const linkedEmail = emailValue(linkedUser?.useremail);
    if (linkedEmail) return linkedEmail;

    const expertId = Number(agent?.travel_expert_id || plan?.staff_id || 0);
    if (expertId > 0) {
      const expert = await prisma.dvi_users.findFirst({
        where: { userID: BigInt(expertId), status: 1, deleted: 0 },
        select: { useremail: true },
      });
      const expertEmail = emailValue(expert?.useremail);
      if (expertEmail) return expertEmail;
    }
  }

  const creatorId = Number(plan?.createdby || 0);
  if (creatorId > 0) {
    const creator = await prisma.dvi_users.findFirst({
      where: { userID: BigInt(creatorId), status: 1, deleted: 0 },
      select: { useremail: true },
    });
    const creatorEmail = emailValue(creator?.useremail);
    if (creatorEmail) return creatorEmail;
  }

  return null;
}
