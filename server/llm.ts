/**
 * Turning a paragraph into a profile.
 *
 * Two parsers, one contract. The rules parser always runs, so the product works
 * with no model and no key. When an OpenAI-compatible endpoint is configured,
 * the model is asked to do the same job and its answer is only accepted if it
 * survives the same validation: a state we know, an age a human can have, an
 * income in rupees rather than lakhs-by-accident.
 *
 * The model never decides eligibility. It only reads the sentence.
 */

import { STATES, parseProfileRules, type ParsedProfile } from './extract.js';

const OCCUPATIONS = ['farmer', 'artisan', 'worker', 'student', 'teacher', 'entrepreneur', 'fisher', 'driver', 'vendor', 'homemaker', 'senior', 'disabled', 'widow'];

const SYSTEM = `You read one sentence a person wrote about their life and return JSON. Nothing else.

Return exactly these keys:
{"age": number|null, "income": number|null, "state": string|null, "gender": "male"|"female"|"other"|null, "category": "sc"|"st"|"obc"|"general"|"minority"|null, "occupations": string[], "children": number|null}

Rules:
- income is the ANNUAL household income in rupees. "2.4 lakh" = 240000. "25k a month" = 300000.
- state must be an Indian state or UT, spelled normally, inferred from a city if a city is named.
- occupations only from: ${OCCUPATIONS.join(', ')}. A tailor is an artisan. A farm labourer is a worker.
- If the sentence does not say it, use null (or [] for occupations). Never guess.
- Output JSON only, no prose, no code fences.`;

export type ParseOutcome = { profile: ParsedProfile; parsedBy: string };

function sanitise(raw: unknown, fallback: ParsedProfile): ParsedProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number): number | null => {
    const n = typeof v === 'string' ? Number(v.replace(/[^0-9.]/g, '')) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null;
  };
  const stateRaw = typeof o.state === 'string' ? o.state.trim() : '';
  const state = STATES.find((s) => s.toLowerCase() === stateRaw.toLowerCase()) ?? fallback.state;
  const occupations = Array.isArray(o.occupations)
    ? o.occupations.map((x) => String(x).toLowerCase().trim()).filter((x) => OCCUPATIONS.includes(x)).slice(0, 4)
    : fallback.occupations;
  const gender = ['male', 'female', 'other'].includes(String(o.gender)) ? String(o.gender) : fallback.gender;
  const category = ['sc', 'st', 'obc', 'general', 'minority'].includes(String(o.category)) ? String(o.category) : fallback.category;
  const age = num(o.age, 0, 110) ?? fallback.age;
  const income = num(o.income, 0, 1_000_000_000) ?? fallback.income;
  const children = num(o.children, 0, 20) ?? fallback.children ?? null;
  return { ...fallback, age, income, state, gender, category, occupations, children };
}

export async function parseProfile(text: string): Promise<ParseOutcome> {
  const fallback = parseProfileRules(text);
  const base = process.env.OPENAI_BASE_URL;
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  if (!base || !key) return { profile: fallback, parsedBy: 'rules' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 2000,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: text.slice(0, 1200) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { profile: fallback, parsedBy: 'rules' };
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content ?? '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { profile: fallback, parsedBy: 'rules' };
    const cleaned = sanitise(JSON.parse(match[0]), fallback);
    if (!cleaned) return { profile: fallback, parsedBy: 'rules' };
    return { profile: { ...cleaned, text }, parsedBy: `${model}` };
  } catch {
    return { profile: fallback, parsedBy: 'rules' };
  } finally {
    clearTimeout(timer);
  }
}
