/**
 * DAFTAR Phase 12 — provenance channels and the injection classifier.
 *
 * P12-S0-ARCHITECTURE-CONTRACT §6. The real threat is not a user typing a jailbreak — the user
 * already has their own authority and gains nothing. It is TENANT DATA containing instructions: a
 * customer name, a product description, an imported CSV cell, a filename.
 *
 * Layering, in descending order of what actually holds:
 *   1. Structural (§6.2): the model emits a typed intent; it has no verb that causes an effect.
 *   2. Channel separation (§6.3, this file): tenant data never occupies instruction position.
 *   3. Egress closed (§6.4): no tool sends anything outward, so reading cannot become moving.
 *   4. Detection (§6.5, this file): AUDITED, ADVISORY, and never load-bearing.
 *
 * Layer 4 is deliberately the weakest and is documented as such. A classifier presented as a
 * defense invites a future worker to relax a structural rule because "the filter catches that".
 *
 * STATUS: PREPARED / NOT PROMOTED.
 */

/**
 * `system` is the trusted contract. `user` is the member's own utterance. `tenant_data` is anything
 * a tool returned — untrusted, whoever typed it.
 */
export type Provenance = 'system' | 'user' | 'tenant_data';

export interface Segment {
  readonly provenance: Provenance;
  readonly text: string;
}

/** Only `system` carries instruction authority. Nothing promotes a segment to it. */
export function isInstructionChannel(provenance: Provenance): boolean {
  return provenance === 'system';
}

/**
 * Assemble the model input with channels kept separate.
 *
 * Tenant data is fenced and labelled, and the function returns the segments rather than one
 * concatenated string: a caller cannot accidentally splice tenant text into the instruction channel
 * because the instruction channel is a different element of the result. Proof plan S2 plants a
 * concatenation and must red.
 */
export function assembleChannels(segments: readonly Segment[]): {
  readonly system: readonly string[];
  readonly user: readonly string[];
  readonly tenantData: readonly string[];
} {
  return {
    system: segments.filter((s) => s.provenance === 'system').map((s) => s.text),
    user: segments.filter((s) => s.provenance === 'user').map((s) => s.text),
    tenantData: segments.filter((s) => s.provenance === 'tenant_data').map((s) => s.text),
  };
}

export type InjectionSignal = 'instruction_override' | 'authority_claim' | 'tool_invocation_attempt' | 'egress_request' | 'identity_switch';

export interface ClassifierVerdict {
  /** Signals found. ADVISORY: this never grants and never blocks on its own. */
  readonly signals: readonly InjectionSignal[];
  readonly suspected: boolean;
}

/**
 * Patterns, Arabic and English, each tied to the signal it indicates.
 *
 * The corpus that exercises these lives in the test suite and plants payloads in TENANT DATA fields,
 * not in the prompt (proof plan §3.7). A miss here is not a vulnerability: layers 1–3 hold
 * regardless, which is the whole reason this function may be imperfect.
 */
const PATTERNS: readonly (readonly [InjectionSignal, RegExp])[] = [
  ['instruction_override', /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i],
  ['instruction_override', /disregard\s+(the\s+)?(system|previous)/i],
  ['instruction_override', /تجاهل\s+(كل\s+)?(التعليمات|الأوامر)/],
  ['authority_claim', /\b(system|developer|admin)\s*(message|mode|override)\b/i],
  ['authority_claim', /(أنا|انا)\s*(المدير|النظام|المطور)/],
  // A first-person claim of privileged identity ("I am the administrator"), which the
  // keyword-pair form above does not reach.
  ['authority_claim', /\b(i\s+am|this\s+is)\s+(the\s+)?(system|developer|admin(istrator)?|owner|support)\b/i],
  ['tool_invocation_attempt', /\b(call|invoke|run|execute)\s+(the\s+)?tool\b/i],
  ['tool_invocation_attempt', /\b(sale|payment|refund|stock)\.(draft|create|execute)\s*\(/i],
  // The object between the verb and `to` may be several words ("send this balance to ..."), so the
  // noun phrase is bounded rather than single-token. A single-token form missed exactly that case.
  ['egress_request', /\b(send|forward|email|whatsapp|post)\s+(this|it|that|the\s+\w+)(\s+\w+){0,4}\s+to\b/i],
  ['egress_request', /(أرسل|ارسل)\s+.{0,20}(إلى|الى|على)\s/],
  ['identity_switch', /\byou\s+are\s+now\b/i],
  ['identity_switch', /\bact\s+as\b/i],
];

/**
 * Classify one piece of content. Call it on `tenant_data` segments and on transcripts.
 *
 * The result is recorded in `ai_tool_calls` / `ai_interactions` so that attacks are VISIBLE. It is
 * not consulted to decide whether anything may happen.
 */
export function classify(text: string): ClassifierVerdict {
  const signals: InjectionSignal[] = [];
  for (const [signal, pattern] of PATTERNS) {
    if (pattern.test(text) && !signals.includes(signal)) signals.push(signal);
  }
  return { signals, suspected: signals.length > 0 };
}

/**
 * Classify every tenant-data segment of an assembled turn.
 *
 * Returns per-segment verdicts rather than one boolean, because "something in this turn looked
 * suspicious" is not an auditable record — which segment, and which signal, is.
 */
export function classifyTenantData(segments: readonly Segment[]): readonly { readonly index: number; readonly verdict: ClassifierVerdict }[] {
  const out: { index: number; verdict: ClassifierVerdict }[] = [];
  segments.forEach((segment, index) => {
    if (segment.provenance !== 'tenant_data') return;
    const verdict = classify(segment.text);
    if (verdict.suspected) out.push({ index, verdict });
  });
  return out;
}
