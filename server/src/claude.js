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

const MATCH_TOOL = {
  name: 'submit_match',
  description: 'Submit the job-match score, the full requirements checklist, and a one-sentence verdict.',
  input_schema: {
    type: 'object',
    properties: {
      match_score: {
        type: 'integer', minimum: 0, maximum: 100,
        description: 'Honest estimate (0-100) of how well the resume, as written, matches the job requirements.'
      },
      requirements: {
        type: 'array',
        maxItems: 20,
        description: 'EVERY concrete requirement in the posting (skills, tools, credentials, years of experience, domain), each marked as evidenced or not. This list must never be empty unless the posting truly lists no requirements.',
        items: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: 'The requirement in the employer\'s exact wording, e.g. "Premiere Pro", "3+ years experience", "color grading".' },
            evidenced: { type: 'boolean', description: 'true if the resume clearly evidences this requirement, false if it does not.' }
          },
          required: ['keyword', 'evidenced']
        }
      },
      verdict: {
        type: 'string',
        description: 'One blunt sentence summing up the fit, e.g. \'Strong fit for the core editing requirements, but lacks the required motion-capture experience.\''
      }
    },
    required: ['match_score', 'requirements', 'verdict']
  }
};

const MATCH_RUBRIC = [
  'Score job match like a strict, skeptical recruiter deciding whether to even open this application. Judge primarily against the REQUIRED qualifications: hard skills, tools, years of experience, seniority, domain, and credentials.',
  'Calibration bands - place the score in the right band before fine-tuning it:',
  '0-15 = different occupation entirely (e.g. a video editor applying to a nursing or accounting role); transferable soft skills do NOT lift an unrelated resume out of this band.',
  '16-35 = same broad field but the wrong role, or missing most required hard skills.',
  '36-55 = adjacent role; meets some core requirements but has clear gaps in required skills, seniority, or domain.',
  '56-75 = solid fit; evidences most core requirements with minor gaps.',
  '76-90 = strong fit; clearly evidences nearly all required and several preferred qualifications.',
  '91-95 = exceptional, rare fit. Never score above 95.',
  'If more than half of the required qualifications are not evidenced in the resume, the score MUST be below 40 regardless of wording quality.',
  'Use the SAME rubric for match_before and match_after so the numbers are comparable.',
  'Rewording cannot create missing qualifications: match_after may only exceed match_before modestly (typically 5-20 points), and for an unrelated job BOTH scores must stay low - tailoring an unrelated resume does not make it a match.',
  'Do not be polite or encouraging in the scores. A low score for a poor match is the correct, useful answer.'
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

async function callClaudeWithRetry(systemPrompt, userText, apiKey, tool = RESUME_TOOL) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name }
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

const OUTPUT_HYGIENE = [
  'Preserve every link, URL, email address, and phone number from the resume exactly as written - never drop, shorten, alter, or invent contact details or links.',
  'Output clean plain text only: no markdown syntax (no asterisks, hashes, or backticks), no decorative separator lines, no notes or commentary - only the resume content itself.'
].join(' ');

const INTENSITY_GUIDANCE = {
  minimal: 'Editing intensity: LIGHT. Make the fewest edits possible: tune the summary, reorder emphasis, and adjust the skills list. Keep almost all original sentences as written; only touch bullets where a small wording change clearly helps. Expect a modest match improvement.',
  balanced: 'Editing intensity: MEDIUM. Rewrite where it helps: rework the summary, skills, and the most relevant experience bullets, while leaving already-strong content alone.',
  max: 'Editing intensity: MAXIMUM. Rework wording across every section: reframe all relevant experience toward this role, expand the most relevant bullets, condense or trim less relevant ones, and make the whole resume read as purpose-built for this job. Push the match as high as the candidate\'s real experience allows - but never invent facts.',
  ultra: [
    'Editing intensity: ULTRA - full ground-up rewrite with the most aggressive favorable framing possible.',
    'Rebuild the resume from scratch around this job: restructure and reorder sections freely, retitle roles to the employer\'s terminology whenever the actual work supports it, and lead every section with whatever maps hardest onto the posting\'s requirements.',
    'Use the strongest defensible phrasing everywhere: present real experience at the very top of its plausible range, claim "working knowledge of" or "familiarity with" tools and skills genuinely adjacent to ones the candidate demonstrably used, and convert modest bullets into confident, outcome-focused ones.',
    'Stretch framing to the edge of what the underlying experience can support - but do not cross into fabrication: never invent employers, job titles with no basis, dates, degrees, certifications, licenses, or specific tools/metrics the resume gives no basis for. An exaggeration the candidate cannot back up in an interview hurts them.',
    'Because this is a full rewrite of undersold experience, the honest match lift may exceed the typical range - larger gains are acceptable when the rewrite genuinely surfaces buried relevant experience.'
  ].join(' ')
};

function buildTailoringSystemPrompt(intensity, anchoredBefore) {
  const anchor = anchoredBefore != null
    ? `The original resume's match score has already been measured as ${anchoredBefore}% under this exact rubric. Set match_before to exactly ${anchoredBefore}. Score match_after with the same rubric, treating ${anchoredBefore}% as the honest starting point.`
    : '';
  const structureRule = intensity === 'ultra'
    ? 'You may restructure freely: change section order, headings, and bullet organization to whatever presents the candidate best for this job. Keep every real job, employer, and date.'
    : 'Preserve the candidate resume structure: same section order, same major headings, same jobs, same dates, and similar bullet/list organization.';
  return [
    'You are an expert resume strategist and ATS-aware editor.',
    INTENSITY_GUIDANCE[intensity] || INTENSITY_GUIDANCE.balanced,
    anchor,
    'Study the full job listing before editing. Infer the role type, seniority, core responsibilities, required qualifications, preferred qualifications, tools/platforms, soft skills, and employer priorities.',
    'Then match the resume to that role by emphasizing the candidate experience that is already supported by the original resume.',
    'Mirror the job posting\'s exact terminology: when the resume describes the same skill, tool, role, or activity using a synonym, switch to the employer\'s wording. For example, if the posting says "cinematographer" and the resume says "videographer", write "cinematographer"; if the posting says "stakeholders" and the resume says "clients", prefer "stakeholders". Apply this to titles, skills, and bullet wording - but only when the two terms genuinely describe the same experience. Never relabel experience as something it is not.',
    'Do not extract, list, or paste keywords. Do not keyword-stuff. Rewrite naturally so the resume reads as if it was originally written for this target role.',
    structureRule,
    intensity === 'ultra'
      ? 'Do not invent employers, dates, credentials, tools, metrics, certifications, education, or responsibilities.'
      : 'Make conservative edits only where the original resume provides support. Do not invent employers, dates, credentials, tools, metrics, certifications, education, or responsibilities.',
    'Update the resume across all relevant parts, including Summary/Profile, Skills, and relevant experience bullets when supported.',
    'Do not add generic notes or explanation sections to the resume.',
    OUTPUT_HYGIENE,
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
    OUTPUT_HYGIENE,
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

function buildMatchSystemPrompt() {
  return [
    'You are a strict, skeptical recruiter screening an application.',
    'Score the resume AS IT IS against the job posting. Do not rewrite it, and do not assume any tailoring or edits will happen.',
    MATCH_RUBRIC,
    'Fill the requirements checklist completely: go through the posting and add EVERY concrete requirement (skills, tools, credentials, years of experience, domain) as its own entry, marking evidenced true when the resume clearly shows it and false when it does not. An empty checklist is wrong unless the posting genuinely lists no requirements.',
    'Use the employer\'s exact wording from the job posting for every keyword (e.g. "Premiere Pro", "3+ years experience", "color grading").',
    'Call the submit_match tool with the result. Do not respond with plain text.'
  ].join(' ');
}

function buildMatchUserText(resume, job) {
  return [
    'Original resume:',
    resume,
    '',
    'Job page title:',
    job.title || '',
    '',
    'Job posting text:',
    (job.text || '').slice(0, 16000)
  ].join('\n');
}

function coerceKeywords(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 12);
}

function clampScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num)));
}

export async function tailorResume(resume, job, apiKey, intensity = 'balanced', anchoredBefore = null) {
  const data = await callClaudeWithRetry(buildTailoringSystemPrompt(intensity, anchoredBefore), buildTailoringUserText(resume, job), apiKey);
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

function buildBoostSystemPrompt(currentScore) {
  return [
    'You are an expert resume strategist and ATS-aware editor.',
    `The resume below was ALREADY tailored to the job posting and currently scores ${currentScore != null ? `${currentScore}%` : 'an unknown match'}.`,
    INTENSITY_GUIDANCE.max,
    'Your goal is to push the honest match score higher than the current score by reworking wording, emphasis, and ordering of the candidate\'s real experience.',
    'Do not invent employers, dates, credentials, tools, metrics, certifications, education, or responsibilities.',
    'If nothing more can honestly be improved, return the resume nearly unchanged with the same score and say so in change_summary.',
    OUTPUT_HYGIENE,
    MATCH_RUBRIC,
    'match_before is the incoming resume\'s current score; match_after is the score after your boost.',
    'Call the submit_resume tool with the result. Do not respond with plain text.'
  ].join(' ');
}

function buildBoostUserText(currentText, jobText) {
  return [
    'Current tailored resume:',
    currentText,
    '',
    'Job posting text:',
    (jobText || '').slice(0, 16000)
  ].join('\n');
}

export async function boostResume(currentText, jobText, currentScore, apiKey) {
  const data = await callClaudeWithRetry(buildBoostSystemPrompt(currentScore), buildBoostUserText(currentText, jobText), apiKey);
  const result = extractToolInput(data);
  if (!result.resume_text || typeof result.resume_text !== 'string') {
    throw new Error('Claude did not return resume_text.');
  }
  return {
    text: result.resume_text.trim(),
    summary: result.change_summary || 'Boosted the resume toward the job requirements.',
    matchBefore: clampScore(result.match_before),
    matchAfter: clampScore(result.match_after)
  };
}

export async function scoreMatch(resume, job, apiKey) {
  const data = await callClaudeWithRetry(buildMatchSystemPrompt(), buildMatchUserText(resume, job), apiKey, MATCH_TOOL);
  const result = extractToolInput(data);
  const verdict = typeof result.verdict === 'string' ? result.verdict.trim() : '';

  const requirements = Array.isArray(result.requirements) ? result.requirements : [];
  const matched = requirements.filter((item) => item && item.evidenced === true).map((item) => item.keyword);
  const missing = requirements.filter((item) => item && item.evidenced !== true).map((item) => item.keyword);

  return {
    match: clampScore(result.match_score),
    matchedKeywords: coerceKeywords(matched),
    missingKeywords: coerceKeywords(missing),
    verdict: verdict || 'No verdict returned.'
  };
}
