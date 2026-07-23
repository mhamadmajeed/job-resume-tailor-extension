const CLAUDE_MODEL = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';

const RESUME_TOOL = {
  name: 'submit_resume',
  description: 'Submit the tailored resume text, a short summary of the changes made, and job-match scores.',
  input_schema: {
    type: 'object',
    properties: {
      resume_text: { type: 'string', description: 'The full tailored resume text.' },
      change_summary: { type: 'string', description: 'One or two sentences describing what changed.' },
      match_before: {
        type: 'integer', minimum: 0, maximum: 100,
        description: 'Honest estimate (0-100) of how well the INPUT resume matches the job requirements before your edits.'
      },
      match_after: {
        type: 'integer', minimum: 0, maximum: 100,
        description: 'Honest estimate (0-100) of how well the SUBMITTED resume matches the job requirements after your edits, using the same rubric as match_before.'
      }
    },
    required: ['resume_text', 'change_summary', 'match_before', 'match_after']
  }
};

const MATCH_RUBRIC = [
  'Score job match like a strict ATS/recruiter screen: weigh required skills and tools, seniority, domain experience, and role responsibilities that the resume genuinely evidences.',
  'Use the SAME rubric for match_before and match_after so the two numbers are comparable.',
  'Be honest: tailoring wording cannot add missing qualifications, so match_after should only exceed match_before by what better framing of real experience justifies. Never report 100 unless the fit is truly exceptional.'
].join(' ');

function claudeErrorMessage(status, errorText) {
  if (status === 401 || status === 403) {
    return 'Claude rejected the server API key. Check ANTHROPIC_API_KEY.';
  }
  if (status === 429) {
    return 'Claude rate limit reached. Try again shortly.';
  }
  if (status === 529) {
    return 'Claude is temporarily overloaded. Try again shortly.';
  }
  return `Claude request failed (${status}): ${errorText.slice(0, 180)}`;
}

async function callClaudeWithRetry(systemPrompt, userText, apiKey) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    tools: [RESUME_TOOL],
    tool_choice: { type: 'tool', name: RESUME_TOOL.name }
  };

  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION
        },
        body: JSON.stringify(body)
      });
    } catch (_networkError) {
      lastError = new Error('Could not reach Claude.');
      response = null;
    }

    if (response?.ok) return response.json();

    if (response) {
      const errorText = await response.text();
      lastError = new Error(claudeErrorMessage(response.status, errorText));
      const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
      if (!retryable) throw lastError;
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }

  throw lastError || new Error('Claude request failed.');
}

function extractToolInput(data) {
  const toolUse = (data.content || []).find((block) => block.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not return a tool call.');
  return toolUse.input;
}

const INTENSITY_GUIDANCE = {
  minimal: 'Editing intensity: LIGHT. Make the fewest edits possible: tune the summary, reorder emphasis, and adjust the skills list. Keep almost all original sentences as written; only touch bullets where a small wording change clearly helps. Expect a modest match improvement.',
  balanced: 'Editing intensity: MEDIUM. Rewrite where it helps: rework the summary, skills, and the most relevant experience bullets, while leaving already-strong content alone.',
  max: 'Editing intensity: MAXIMUM. Rework wording across every section: reframe all relevant experience toward this role, expand the most relevant bullets, condense or trim less relevant ones, and make the whole resume read as purpose-built for this job. Push the match as high as the candidate\'s real experience allows - but never invent facts.'
};

function buildTailoringSystemPrompt(intensity) {
  return [
    'You are an expert resume strategist and ATS-aware editor.',
    INTENSITY_GUIDANCE[intensity] || INTENSITY_GUIDANCE.balanced,
    'Study the full job listing before editing. Infer the role type, seniority, core responsibilities, required qualifications, preferred qualifications, tools/platforms, soft skills, and employer priorities.',
    'Then match the resume to that role by emphasizing the candidate experience that is already supported by the original resume.',
    'Do not extract, list, or paste keywords. Do not keyword-stuff. Rewrite naturally so the resume reads as if it was originally written for this target role.',
    'Preserve the candidate resume structure: same section order, same major headings, same jobs, same dates, and similar bullet/list organization.',
    'Make conservative edits only where the original resume provides support. Do not invent employers, dates, credentials, tools, metrics, certifications, education, or responsibilities.',
    'Update the resume across all relevant parts, including Summary/Profile, Skills, and relevant experience bullets when supported.',
    'Do not add generic notes or explanation sections to the resume.',
    MATCH_RUBRIC,
    'Call the submit_resume tool with the result. Do not respond with plain text.'
  ].join(' ');
}

function buildTailoringUserText(resume, job) {
  return [
    'Original resume:',
    resume,
    '',
    'Job page title:',
    job.title || '',
    '',
    'Job posting text:',
    (job.text || '').slice(0, 16000),
    '',
    'Task:',
    '1. Analyze the job listing as a complete hiring brief.',
    '2. Identify what the employer is really selecting for.',
    '3. Compare those needs with the original resume.',
    '4. Produce a matched resume that keeps the original style but foregrounds the most relevant supported experience.',
    '5. Keep the resume concise and applicant-ready.'
  ].join('\n');
}

function buildRevisionSystemPrompt() {
  return [
    'You are editing an already-tailored resume based on the user\'s follow-up instruction.',
    'Apply only the requested change. Do not invent employers, dates, credentials, tools, metrics, certifications, education, or responsibilities.',
    'Keep the rest of the resume text intact unless the instruction implies a broader change.',
    MATCH_RUBRIC,
    'match_before is the incoming resume\'s match to the job; match_after is the match after your edit. If no job posting is provided, score against the role the resume is clearly targeting.',
    'Call the submit_resume tool with the result. Do not respond with plain text.'
  ].join(' ');
}

function buildRevisionUserText(currentText, instruction, jobText) {
  const parts = [
    'Current resume:',
    currentText,
    ''
  ];
  if (jobText) {
    parts.push('Job posting text:', jobText.slice(0, 16000), '');
  }
  parts.push('User instruction:', instruction);
  return parts.join('\n');
}

function clampScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num)));
}

export async function tailorResume(resume, job, apiKey, intensity = 'balanced') {
  const data = await callClaudeWithRetry(buildTailoringSystemPrompt(intensity), buildTailoringUserText(resume, job), apiKey);
  const result = extractToolInput(data);
  if (!result.resume_text || typeof result.resume_text !== 'string') {
    throw new Error('Claude did not return resume_text.');
  }
  return {
    text: result.resume_text.trim(),
    summary: result.change_summary || 'Tailored the resume to the job listing.',
    matchBefore: clampScore(result.match_before),
    matchAfter: clampScore(result.match_after)
  };
}

export async function reviseResume(currentText, instruction, jobText, apiKey) {
  const data = await callClaudeWithRetry(buildRevisionSystemPrompt(), buildRevisionUserText(currentText, instruction, jobText), apiKey);
  const result = extractToolInput(data);
  if (!result.resume_text || typeof result.resume_text !== 'string') {
    throw new Error('Claude did not return resume_text.');
  }
  return {
    text: result.resume_text.trim(),
    summary: result.change_summary || 'Applied the requested change.',
    matchAfter: clampScore(result.match_after)
  };
}
