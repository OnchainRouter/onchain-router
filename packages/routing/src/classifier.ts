import { RoutingRejected, type RouteRequest, type RouteTask } from './types.js';

const CODE_SIGNAL =
  /\b(code|coding|debug|function|typescript|javascript|python|sql|regex|compiler|api|sdk)\b/i;
const REASONING_SIGNAL = /\b(reason|proof|derive|analy[sz]e|compare|trade-?off|plan|evaluate)\b/i;
const MAX_CLASSIFIER_TEXT = 16_384;
const MAX_CLASSIFIER_NODES = 20_000;

interface TraversalBudget {
  textLength: number;
  nodes: number;
}

function collectText(value: unknown, output: string[], budget: TraversalBudget, depth = 0): void {
  budget.nodes += 1;
  if (depth > 5 || budget.nodes > MAX_CLASSIFIER_NODES || budget.textLength >= MAX_CLASSIFIER_TEXT)
    return;
  if (typeof value === 'string') {
    const text = value.slice(0, MAX_CLASSIFIER_TEXT - budget.textLength);
    output.push(text);
    budget.textLength += text.length;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectText(item, output, budget, depth + 1);
      if (budget.nodes >= MAX_CLASSIFIER_NODES || budget.textLength >= MAX_CLASSIFIER_TEXT) break;
    }
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'image_url' || key === 'data') continue;
    collectText(item, output, budget, depth + 1);
    if (budget.nodes >= MAX_CLASSIFIER_NODES || budget.textLength >= MAX_CLASSIFIER_TEXT) break;
  }
}

function containsImage(value: unknown, budget: TraversalBudget, depth = 0): boolean {
  budget.nodes += 1;
  if (depth > 6 || budget.nodes > MAX_CLASSIFIER_NODES) return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (containsImage(item, budget, depth + 1)) return true;
      if (budget.nodes >= MAX_CLASSIFIER_NODES) break;
    }
    return false;
  }
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['type'] === 'image_url' || record['type'] === 'image') return true;
  for (const item of Object.values(record)) {
    if (containsImage(item, budget, depth + 1)) return true;
    if (budget.nodes >= MAX_CLASSIFIER_NODES) break;
  }
  return false;
}

export function requiredCapabilities(request: RouteRequest): ReadonlySet<string> {
  const required = new Set<string>(['text']);
  if (Array.isArray(request.body['tools']) && request.body['tools'].length > 0)
    required.add('tools');
  const responseFormat = request.body['response_format'];
  if (
    typeof responseFormat === 'object' &&
    responseFormat !== null &&
    (responseFormat as Record<string, unknown>)['type'] !== 'text'
  )
    required.add('json');
  const imageBudget = { textLength: 0, nodes: 0 };
  if (containsImage(request.body['messages'], imageBudget)) required.add('vision');
  else if (imageBudget.nodes >= MAX_CLASSIFIER_NODES)
    throw new RoutingRejected('routing capability classification exceeded its node limit');
  return required;
}

export function classifyTask(request: RouteRequest): RouteTask {
  const required = requiredCapabilities(request);
  if (required.has('vision')) return 'vision';
  if (required.has('tools')) return 'tool-use';
  const text: string[] = [];
  collectText(request.body['messages'], text, { textLength: 0, nodes: 0 });
  const combined = text.join(' ');
  if (CODE_SIGNAL.test(combined)) return 'code';
  if (REASONING_SIGNAL.test(combined)) return 'reasoning';
  return 'general';
}
