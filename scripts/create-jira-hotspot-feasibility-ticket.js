const JIRA_CONFIG = {
  siteUrl: 'https://dvilabsai.atlassian.net',
  email: 'dvilabs.ai@gmail.com',
  apiToken: process.env.JIRA_API_TOKEN,
  projectKey: 'SCRUM',
  issueType: 'Task',
  boardId: 1,
  sprintName: 'SCRUM Sprint 9',
};

const ISSUE_DETAILS = {
  summary: 'Add Hotspot Feasibility Panel Before Applying Hotspot',
  description:
    'When a user adds a hotspot, show a preview panel before applying it. The panel should show revised timeline, additional travel time, extra kilometres, expected hotel return time, closing-time conflicts, and cost impact if available. User should be able to optimize route, replace hotspot, add dinner break, or proceed with additional charges.',
  acceptanceCriteria: [
    'Hotspot is not applied immediately.',
    'User sees feasibility impact first.',
    'Timeline is updated only after confirmation.',
    'Existing manual hotspot preview/apply flow should be reused.',
  ],
};

function buildAuthHeader(email, apiToken) {
  if (!apiToken) {
    throw new Error('JIRA_API_TOKEN is required');
  }

  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
}

function buildAtlassianDocument(issue) {
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: issue.description }],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Acceptance Criteria:',
            marks: [{ type: 'strong' }],
          },
        ],
      },
      {
        type: 'bulletList',
        content: issue.acceptanceCriteria.map((item) => ({
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: item }],
            },
          ],
        })),
      },
    ],
  };
}

async function jiraRequest(path, options = {}) {
  const response = await fetch(`${JIRA_CONFIG.siteUrl}${path}`, {
    ...options,
    headers: {
      Authorization: buildAuthHeader(JIRA_CONFIG.email, JIRA_CONFIG.apiToken),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Jira request failed (${response.status}): ${errorText}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function createIssue() {
  const payload = {
    fields: {
      project: { key: JIRA_CONFIG.projectKey },
      summary: ISSUE_DETAILS.summary,
      description: buildAtlassianDocument(ISSUE_DETAILS),
      issuetype: { name: JIRA_CONFIG.issueType },
    },
  };

  return jiraRequest('/rest/api/3/issue', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function findSprintByName() {
  if (!JIRA_CONFIG.sprintName) {
    return null;
  }

  const sprintResponse = await jiraRequest(
    `/rest/agile/1.0/board/${JIRA_CONFIG.boardId}/sprint?state=active,future`,
    { method: 'GET' },
  );

  return sprintResponse.values.find(
    (sprint) => sprint.name === JIRA_CONFIG.sprintName,
  );
}

async function addIssueToSprint(issueKey, sprintId) {
  await jiraRequest(`/rest/agile/1.0/sprint/${sprintId}/issue`, {
    method: 'POST',
    body: JSON.stringify({ issues: [issueKey] }),
  });
}

async function main() {
  const createdIssue = await createIssue();
  console.log(`Created Jira issue: ${createdIssue.key}`);
  console.log(`${JIRA_CONFIG.siteUrl}/browse/${createdIssue.key}`);

  const sprint = await findSprintByName();
  if (!sprint) {
    console.log(
      `Sprint "${JIRA_CONFIG.sprintName}" was not found on board ${JIRA_CONFIG.boardId}. Issue was created without sprint assignment.`,
    );
    return;
  }

  await addIssueToSprint(createdIssue.key, sprint.id);
  console.log(`Moved ${createdIssue.key} to sprint: ${sprint.name}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
