const GEMINI_MODEL = 'gemini-2.5-flash';

function geminiErrorMessage(status, errorText) {
  if (status === 400 || status === 401 || status === 403) {
    return 'Gemini rejected the server API key. Check GEMINI_API_KEY.';
  }
  if (status === 429) {
    return 'Gemini rate limit reached. Try again shortly.';
  }
  return `Gemini request failed (${status}): ${errorText.slice(0, 180)}`;
}

async function callGeminiWithRetry(promptText, apiKey) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: { temperature: 0.35, responseMimeType: 'application/json' }
  };

  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body)
      });
    } catch (_networkError) {
      lastError = new Error('Could not reach Gemini.');
      response = null;
    }

    if (response?.ok) return response.json();

    if (response) {
      const errorText = await response.text();
      lastError = new Error(geminiErrorMessage(response.status, errorText));
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) throw lastError;
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }

  throw lastError || new Error('Gemini request failed.');
}

function extractJsonObject(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (_e) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI response was not valid JSON.');
    return JSON.parse(match[0]);
  }
}

function outputTextFrom(data) {
  return (data.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || '')
    .join('\n');
}

function buildTailoringPrompt(resume, job) {
  return [
    [
      'You are an expert resume strategist and ATS-aware editor.',
      'Study the full job listing before editing. Infer the role type, seniority, core responsibilities, required qualifications, preferred qualifications, tools/platforms, soft skills, and employer priorities.',
      'Then match the resume to that role by emphasizing the candidate experience that is already supported by the original resume.',
      'Do not extract, list, or paste keywords. Do not keyword-stuff. Rewrite naturally so the resume reads as if it was originally written for this target role.',
      'Preserve the candidate resume structure: same section order, same major headings, same jobs, same dates, and similar bullet/list organization.',
      'Make conservative edits only where the original resume provides support. Do not invent employers, dates, credentials, tools, metrics, certifications, education, or responsibilities.',
      'Update the resume across all relevant parts, including Summary/Profile, Skills, and relevant experience bullets when supported.',
      'Do not add generic notes or explanation sections to the resume.',
      'Return only JSON with keys "resume_text" and "change_summary".'
    ].join(' '),
    '',
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

function buildRevisionPrompt(currentText, instruction) {
  return [
    'You are editing an already-tailored resume based on the user\'s follow-up instruction.',
    'Apply only the requested change. Do not invent employers, dates, credentials, tools, metrics, certifications, education, or responsibilities.',
    'Keep the rest of the resume text intact unless the instruction implies a broader change.',
    'Return only JSON with keys "resume_text" and "change_summary".',
    '',
    'Current resume:',
    currentText,
    '',
    'User instruction:',
    instruction
  ].join('\n');
}

export async function tailorResume(resume, job, apiKey) {
  const data = await callGeminiWithRetry(buildTailoringPrompt(resume, job), apiKey);
  const result = extractJsonObject(outputTextFrom(data));
  if (!result.resume_text || typeof result.resume_text !== 'string') {
    throw new Error('AI did not return resume_text.');
  }
  return {
    text: result.resume_text.trim(),
    summary: result.change_summary || 'Tailored the resume to the job listing.'
  };
}

export async function reviseResume(currentText, instruction, apiKey) {
  const data = await callGeminiWithRetry(buildRevisionPrompt(currentText, instruction), apiKey);
  const result = extractJsonObject(outputTextFrom(data));
  if (!result.resume_text || typeof result.resume_text !== 'string') {
    throw new Error('AI did not return resume_text.');
  }
  return {
    text: result.resume_text.trim(),
    summary: result.change_summary || 'Applied the requested change.'
  };
}
