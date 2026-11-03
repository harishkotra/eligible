/**
 * The rules engine.
 *
 * This is the half of the product that a vector database cannot do. Cosine
 * similarity is excellent at "does this prose sound like my life" and hopeless
 * at "is 2,40,000 more than 2,00,000". So the numbers are checked here, in
 * plain arithmetic, against columns that were extracted once and stored.
 *
 * Design rule: a scheme is only rejected on a field the scheme actually states.
 * Missing data never denies anybody.
 */

import type { SchemeFacts } from './extract.js';

export type SchemeRow = SchemeFacts & {
  slug: string;
  eligibility?: string;
  documentsCount?: number;
  name: string;
  issuer: string;
  appMode: string;
  tags: string[];
  officialLink: string;
};

export type Profile = {
  age: number | null;
  income: number | null;
  state: string | null;
  gender: string | null;
  category: string | null;
  occupations: string[];
  text?: string;
};

export type Blocker = {
  field: 'state' | 'age' | 'income' | 'gender' | 'category';
  detail: string;
  /** How far outside the rule the person is, in the rule's own units. */
  gap: string;
};

export type Verdict = {
  ok: boolean;
  blockers: Blocker[];
  reasons: string[];
  score: number;
};

// Same money language the chips use, so ₹2.4 lakh on the profile is not
// ₹2,40,000 in the reason right below it.
const m = (n: number): string => {
  const trim = (v: number) => v.toFixed(2).replace(/\.?0+$/, '');
  if (n >= 1e7) return `₹${trim(n / 1e7)} crore`;
  if (n >= 1e5) return `₹${trim(n / 1e5)} lakh`;
  return `₹${n.toLocaleString('en-IN')}`;
};

export function evaluate(scheme: SchemeRow, profile: Profile): Verdict {
  const blockers: Blocker[] = [];
  const reasons: string[] = [];
  let score = 0;

  // Jurisdiction. "All India" schemes apply everywhere; a state scheme only
  // applies to people in that state.
  // Central schemes apply everywhere, however the row spells it: a table that
  // stores `level = central` must not be judged by the string in jurisdiction.
  const everywhere =
    scheme.level === 'central' || scheme.jurisdiction === 'All India' || scheme.jurisdiction === 'Central' || !scheme.jurisdiction;
  if (!everywhere && profile.state) {
    if (scheme.jurisdiction === profile.state) {
      reasons.push(`${scheme.jurisdiction} scheme`);
      score += 0.2;
    } else {
      blockers.push({
        field: 'state',
        detail: `Only for people in ${scheme.jurisdiction}`,
        gap: `${profile.state} is not ${scheme.jurisdiction}`,
      });
    }
  } else if (everywhere) {
    // Every central scheme says this, so it is a pill on the card, not a reason.
    score += 0.1;
  }

  // Age band, only when the scheme states one.
  if (scheme.hasAgeRule && profile.age !== null) {
    if (profile.age < scheme.minAge) {
      blockers.push({
        field: 'age',
        detail: `Needs age ${scheme.minAge} or above`,
        gap: `${scheme.minAge - profile.age} year${scheme.minAge - profile.age === 1 ? '' : 's'} short`,
      });
    } else if (profile.age > scheme.maxAge) {
      blockers.push({
        field: 'age',
        detail: scheme.maxAge < 120 ? `Age limit is ${scheme.maxAge}` : `Needs age ${scheme.minAge}+`,
        gap: `${profile.age - scheme.maxAge} year${profile.age - scheme.maxAge === 1 ? '' : 's'} over`,
      });
    } else {
      const band =
        scheme.maxAge >= 120
          ? `${scheme.minAge} and older`
          : scheme.minAge <= 0
            ? `up to ${scheme.maxAge}`
            : `${scheme.minAge} to ${scheme.maxAge}`;
      reasons.push(`Your age, ${profile.age}, is inside the ${band} window`);
      score += 0.2;
    }
  }

  // Income ceiling, only when stated.
  if (scheme.hasIncomeRule && profile.income !== null) {
    if (profile.income > scheme.incomeCeiling) {
      blockers.push({
        field: 'income',
        detail: `Income limit ${m(scheme.incomeCeiling)} a year`,
        gap: `${m(profile.income - scheme.incomeCeiling)} over the limit`,
      });
    } else {
      reasons.push(
        profile.income > 0
          ? `Your ${m(profile.income)} sits under the ${m(scheme.incomeCeiling)} ceiling`
          : `Income under the ${m(scheme.incomeCeiling)} limit`,
      );
      score += 0.25;
    }
  }

  // Gender, only when the scheme's own prose says it is for women only.
  // Anything softer than that is a nudge, because a wrong rejection costs
  // somebody money they were owed.
  if (scheme.womenOnly && profile.gender === 'male') {
    blockers.push({ field: 'gender', detail: 'Only for women', gap: 'you said male' });
  } else if (scheme.womenOnly && profile.gender === 'female') {
    reasons.push('Scheme is for women');
    score += 0.1;
  }

  // A scheme written for disabled people is not a match for someone who never
  // said they have a certificate. This is not a judgement about need; it is
  // what the scheme's own text requires.
  if (scheme.disabilityOnly) {
    const stated = profile.occupations.includes('disabled') || profile.category === 'disability';
    if (!stated) {
      blockers.push({
        field: 'category',
        detail: 'Needs a disability certificate',
        gap: 'you did not say you have one',
      });
    }
  }

  // Occupation overlap is a nudge, never a rejection: our tag vocabulary is
  // lossier than the scheme's own prose, so a miss does not mean ineligible.
  // A row that came from a table with a null column must behave like a row
  // that never had one, not crash the request.
  const occup = scheme.occupations ?? [];
  const cats = (scheme as SchemeRow & { categories?: string[] }).categories ?? [];
  const overlap = occup.filter((o) => (profile.occupations ?? []).includes(o));
  if (overlap.length) {
    reasons.push(overlap.length === 1 ? `Scheme names ${overlap[0]}s` : `Scheme names ${overlap.join(', ')}`);
    score += 0.25 + Math.min(0.15, overlap.length * 0.05);
  }
  // A scheme written for a different trade is more likely a near miss than a
  // match. Nudge only; never a rejection.
  if (occup.length && (profile.occupations ?? []).length && overlap.length === 0) {
    score -= 0.1;
  }
  if (cats.length && profile.category && cats.includes(profile.category)) {
    reasons.push(`Mentions ${profile.category.toUpperCase()}`);
    score += 0.1;
  }

  return { ok: blockers.length === 0, blockers, reasons, score: Math.max(0, Math.min(1, score)) };
}

/**
 * Blend of meaning and arithmetic. Meaning decides what is worth looking at;
 * the rules decide what is actually true.
 */
export function blend(ruleScore: number, similarity: number | null): number {
  if (similarity === null) return ruleScore;
  return 0.55 * similarity + 0.45 * ruleScore;
}
