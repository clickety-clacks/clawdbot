export type SalienceKind = "decision" | "answer" | "fact" | "action";
export type SalienceTier = "primary" | "secondary";

export type SalienceCandidate = {
  text: string;
  kind: SalienceKind;
  tier: SalienceTier;
  confidence?: number;
};

export type ServerSalience = {
  version: 1;
  algorithmVersion: number;
  generatedAt: number;
  source: "heuristic" | "model" | "hybrid";
  candidates: SalienceCandidate[];
};

const ALGORITHM_VERSION = 1;
const MAX_CANDIDATE_WORDS = 14;
const MAX_SELECTED_CANDIDATES = 2;
const MIN_PHRASE_WORDS = 2;

const ACTION_MARKER_RE = /^(?:next\s+step|action(?:\s+item)?|todo)\s*[:\-]\s*(.+)$/i;
const DECISION_MARKER_RE = /^decision\s*[:\-]\s*(.+)$/i;
const ANSWER_MARKER_RE = /^answer\s*[:\-]\s*(.+)$/i;
const FACT_MARKER_RE = /^fact\s*[:\-]\s*(.+)$/i;

const LEADING_FILLER_RE =
  /^(?:so|also|just|basically|note\s+that|importantly|in\s+short|summary)\s*[:,]?\s+/i;

const ACTION_VERB_PHRASE_RE =
  /\b(?:we|i|you|they|it|let's|lets)?\s*(?:need\s+to|needs\s+to|must|should|will|plan\s+to|recommend(?:ed)?|decide(?:d)?\s+to|choose(?:s|n)?\s+to|run|restart|deploy|ship|merge|revert|fix|update|set|add|remove|create|delete|enable|disable|use|avoid|check|verify|test|monitor|send|review|implement|document)\b[^.!?\n;:]*/i;
const DECISION_CUE_RE =
  /\b(?:decision|decided|choose|chosen|go with|going with|selected|prefer|recommend)\b/i;
const ANSWER_CUE_RE = /^(?:yes|no)\b|(?:^|\b)(?:the answer is|short answer)\b/i;
const FACT_CUE_RE =
  /\b(?:is|are|was|were|has|have|requires?|supports?|returns?|fails?|takes?)\b.*(?:\d|%|\bms\b|\bsec(?:ond)?s?\b|\bmin(?:ute)?s?\b|\bhours?\b)/i;

const ACTION_INTENT_VERB_RE =
  /\b(?:need|needs|must|should|will|plan|recommend|decide|choose|run|restart|deploy|ship|merge|revert|fix|update|set|add|remove|create|delete|enable|disable|use|avoid|check|verify|test|monitor|send|review|implement|document)\b/i;

type CandidateDraft = {
  text: string;
  kind: SalienceKind;
  score: number;
};

function wordCount(input: string): number {
  return input.trim().split(/\s+/).filter(Boolean).length;
}

function truncateToWordLimit(raw: string, maxWords: number): string {
  if (maxWords <= 0) {
    return "";
  }
  const matches = Array.from(raw.matchAll(/\S+/g));
  if (matches.length <= maxWords) {
    return raw;
  }
  const keep = matches[maxWords - 1];
  if (!keep) {
    return raw;
  }
  const end = keep.index + keep[0].length;
  return raw.slice(0, end);
}

function trimBoundaryPunctuation(text: string): string {
  return text.replace(/^[\s"'([{]+/, "").replace(/[\s"'.,;:!?)\]}]+$/, "");
}

function normalizeCandidateText(raw: string): string {
  let next = raw.trim();
  next = next.replace(LEADING_FILLER_RE, "");
  next = truncateToWordLimit(next, MAX_CANDIDATE_WORDS).trim();
  next = trimBoundaryPunctuation(next);
  return next;
}

function splitClauses(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const clauses: string[] = [];
  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    // Keep clauses coarse so we can preserve concise verb-object phrases.
    const parts = trimmed.split(/(?<=[.!?;:])\s+/);
    for (const part of parts) {
      const candidate = part.trim();
      if (!candidate) {
        continue;
      }
      clauses.push(candidate);
    }
  }
  return clauses;
}

function inferKind(clause: string, explicit: SalienceKind | null): SalienceKind {
  if (explicit) {
    return explicit;
  }
  if (ANSWER_CUE_RE.test(clause)) {
    return "answer";
  }
  if (DECISION_CUE_RE.test(clause)) {
    return "decision";
  }
  if (ACTION_INTENT_VERB_RE.test(clause)) {
    return "action";
  }
  return "fact";
}

function scoreCandidate(text: string, kind: SalienceKind, sourceClause: string): number {
  let score = 0;
  const words = wordCount(text);
  if (words >= MIN_PHRASE_WORDS && words <= 10) {
    score += 20;
  } else if (words <= MAX_CANDIDATE_WORDS) {
    score += 8;
  }
  if (ACTION_INTENT_VERB_RE.test(text)) {
    score += 28;
  } else {
    score -= 18;
  }
  if (kind === "action") {
    score += 14;
  } else if (kind === "decision") {
    score += 12;
  } else if (kind === "answer") {
    score += 10;
  } else {
    score += 6;
  }
  if (ANSWER_CUE_RE.test(sourceClause)) {
    score += 7;
  }
  if (DECISION_CUE_RE.test(sourceClause)) {
    score += 8;
  }
  if (FACT_CUE_RE.test(sourceClause)) {
    score += 6;
  }
  // Favor compact snippets over broad topic spans.
  if (words > 12) {
    score -= 12;
  }
  return score;
}

function buildCandidate(clause: string): CandidateDraft | null {
  let explicitKind: SalienceKind | null = null;
  let phrase = clause;

  const actionMarked = clause.match(ACTION_MARKER_RE);
  if (actionMarked?.[1]) {
    explicitKind = "action";
    phrase = actionMarked[1];
  } else {
    const decisionMarked = clause.match(DECISION_MARKER_RE);
    if (decisionMarked?.[1]) {
      explicitKind = "decision";
      phrase = decisionMarked[1];
    } else {
      const answerMarked = clause.match(ANSWER_MARKER_RE);
      if (answerMarked?.[1]) {
        explicitKind = "answer";
        phrase = answerMarked[1];
      } else {
        const factMarked = clause.match(FACT_MARKER_RE);
        if (factMarked?.[1]) {
          explicitKind = "fact";
          phrase = factMarked[1];
        } else {
          const clauseForAction = clause.replace(/^(?:yes|no)\s*[,.-]?\s*/i, "");
          const actionMatch = clauseForAction.match(ACTION_VERB_PHRASE_RE);
          if (actionMatch?.[0]) {
            phrase = actionMatch[0];
          } else if (ANSWER_CUE_RE.test(clause)) {
            phrase = clause;
          } else if (FACT_CUE_RE.test(clause)) {
            phrase = clause;
          } else {
            return null;
          }
        }
      }
    }
  }

  const candidateText = normalizeCandidateText(phrase);
  const words = wordCount(candidateText);
  if (words < MIN_PHRASE_WORDS) {
    return null;
  }
  const kind = inferKind(clause, explicitKind);
  const score = scoreCandidate(candidateText, kind, clause);
  if (score < 20) {
    return null;
  }
  return { text: candidateText, kind, score };
}

function dedupeCandidates(candidates: CandidateDraft[]): CandidateDraft[] {
  const seen = new Set<string>();
  const deduped: CandidateDraft[] = [];
  for (const item of candidates) {
    const key = item.text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function selectCoreCandidates(candidates: CandidateDraft[]): SalienceCandidate[] {
  if (candidates.length === 0) {
    return [];
  }
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  const selected: CandidateDraft[] = [];
  for (const candidate of sorted) {
    if (selected.length >= MAX_SELECTED_CANDIDATES) {
      break;
    }
    if (selected.length === 0) {
      selected.push(candidate);
      continue;
    }
    // Highlight as little as possible: include a second phrase only when it is also strongly salient.
    if (candidate.score >= 42) {
      selected.push(candidate);
    }
  }
  return selected.map((item, index) => ({
    text: item.text,
    kind: item.kind,
    tier: index === 0 ? "primary" : "secondary",
    confidence: Number(Math.min(1, Math.max(0.4, item.score / 100)).toFixed(2)),
  }));
}

export function extractAssistantSalience(
  text: string,
  now = Date.now(),
): ServerSalience | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const clauses = splitClauses(trimmed);
  if (clauses.length === 0) {
    return undefined;
  }
  const drafts = dedupeCandidates(
    clauses
      .map((clause) => buildCandidate(clause))
      .filter((candidate): candidate is CandidateDraft => Boolean(candidate)),
  );
  const candidates = selectCoreCandidates(drafts);
  if (candidates.length === 0) {
    return undefined;
  }
  return {
    version: 1,
    algorithmVersion: ALGORITHM_VERSION,
    generatedAt: now,
    source: "heuristic",
    candidates,
  };
}
