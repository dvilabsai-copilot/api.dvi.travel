type HoldPlanRecipientFields = {
  agent_id?: number | null;
  staff_id?: number | null;
  createdby?: number | null;
};

export type HoldNotificationRecipient = {
  role: 'Agent' | 'Travel Expert';
  name: string;
  email: string;
};

const emailValue = (value: unknown) => String(value || '').trim();

/** Resolve the itinerary's selected Agent and the Travel Expert assigned to that Agent. */
export async function resolveHotelHoldNotificationRecipients(
  prisma: any,
  plan: HoldPlanRecipientFields | null | undefined,
): Promise<HoldNotificationRecipient[]> {
  const recipients: HoldNotificationRecipient[] = [];
  const agentId = Number(plan?.agent_id || 0);
  let assignedExpertId = Number(plan?.staff_id || 0);

  if (agentId > 0) {
    const agent = await prisma.dvi_agent.findFirst({
      where: { agent_ID: agentId, status: 1, deleted: 0 },
      select: {
        agent_name: true,
        agent_lastname: true,
        agent_email_id: true,
        travel_expert_id: true,
      },
    });
    assignedExpertId = Number(agent?.travel_expert_id || assignedExpertId);
    const agentName = [agent?.agent_name, agent?.agent_lastname].filter(Boolean).join(' ').trim() || `Agent ${agentId}`;
    const agentEmails = String(agent?.agent_email_id || '')
      .split(/[;,\s]+/)
      .map(emailValue)
      .filter((email) => email.includes('@'));

    if (agentEmails.length) {
      for (const email of agentEmails) recipients.push({ role: 'Agent', name: agentName, email });
    } else {
      const linkedUser = await prisma.dvi_users.findFirst({
        where: { agent_id: agentId, status: 1, deleted: 0 },
        orderBy: { userID: 'desc' },
        select: { username: true, useremail: true },
      });
      const email = emailValue(linkedUser?.useremail);
      if (email.includes('@')) recipients.push({ role: 'Agent', name: emailValue(linkedUser?.username) || agentName, email });
    }
  }

  if (assignedExpertId > 0) {
    const expert = await prisma.dvi_staff_details.findFirst({
      where: { staff_id: assignedExpertId, status: 1, deleted: 0 },
      select: { staff_name: true, staff_email: true },
    });
    let email = emailValue(expert?.staff_email);
    let name = emailValue(expert?.staff_name) || `Travel Expert ${assignedExpertId}`;
    if (!email) {
      const linkedUser = await prisma.dvi_users.findFirst({
        where: { staff_id: assignedExpertId, status: 1, deleted: 0 },
        orderBy: { userID: 'desc' },
        select: { username: true, useremail: true },
      });
      email = emailValue(linkedUser?.useremail);
      name = emailValue(linkedUser?.username) || name;
    }
    if (email.includes('@')) recipients.push({ role: 'Travel Expert', name, email });
  }

  return recipients.filter((recipient, index, all) =>
    all.findIndex((candidate) => candidate.role === recipient.role && candidate.email.toLowerCase() === recipient.email.toLowerCase()) === index,
  );
}

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
