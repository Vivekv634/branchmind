import { readConfig, writeConfig } from '../core/config';

/** A single model available on a local provider. */
export interface ProviderModel {
  id: string;
  displayName: string;
}

/** A responding local LLM provider with its discovered models. */
export interface DiscoveredProvider {
  name: 'ollama' | 'lmstudio' | 'jan' | 'llamacpp' | 'custom';
  endpoint: string;
  models: ProviderModel[];
}

/**
 * Result of a probe pass.
 * - `tier`: 'local' when a selected model is active, 'rules' otherwise.
 * - `availableProviders`: all responding providers (not just the selected one).
 * - `selected`: the user-chosen provider+model, present only when tier is 'local'.
 */
export interface RouterResult {
  tier: 'local' | 'rules';
  availableProviders: DiscoveredProvider[];
  selected?: {
    provider: DiscoveredProvider;
    modelId: string;
  };
}

type SelectionLostCallback = (providerName: string) => void;

const PROBE_TIMEOUT_MS = 800;
const REPROBE_INTERVAL_MS = 60_000;

let cachedResult: RouterResult | null = null;
let probeTimer: ReturnType<typeof setInterval> | null = null;
let selectionLostCallback: SelectionLostCallback | null = null;

const STATIC_PROVIDERS: Array<{ name: DiscoveredProvider['name']; endpoint: string }> = [
  { name: 'ollama', endpoint: 'http://localhost:11434' },
  { name: 'lmstudio', endpoint: 'http://localhost:1234' },
  { name: 'jan', endpoint: 'http://localhost:1337' },
  { name: 'llamacpp', endpoint: 'http://localhost:8080' },
];

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function probeOllama(endpoint: string): Promise<ProviderModel[]> {
  try {
    const res = await fetchWithTimeout(`${endpoint}/api/tags`, PROBE_TIMEOUT_MS);
    if (!res.ok) return [];
    const data = await res.json() as { models?: Array<{ name: string }> };
    return (data.models ?? []).map(m => ({ id: m.name, displayName: m.name }));
  } catch {
    return [];
  }
}

async function probeOpenAICompat(endpoint: string): Promise<ProviderModel[] | null> {
  try {
    const res = await fetchWithTimeout(`${endpoint}/v1/models`, PROBE_TIMEOUT_MS);
    if (!res.ok) return null;
    const data = await res.json() as { data?: Array<{ id: string }> };
    if (!data.data) return null;
    return data.data.map(m => ({ id: m.id, displayName: m.id }));
  } catch {
    return null;
  }
}

async function probeProvider(
  name: DiscoveredProvider['name'],
  endpoint: string
): Promise<DiscoveredProvider | null> {
  let models: ProviderModel[] | null = null;

  if (name === 'ollama') {
    models = await probeOllama(endpoint);
    // Ollama returns [] when running but no models — still a valid provider
    if (models !== null) {
      return { name, endpoint, models };
    }
    return null;
  }

  models = await probeOpenAICompat(endpoint);
  if (models !== null) {
    return { name, endpoint, models };
  }
  return null;
}

export async function probe(workspacePath?: string): Promise<RouterResult> {
  const config = readConfig(workspacePath);

  // Build provider list — static + custom if configured
  const providerList = [...STATIC_PROVIDERS];
  if (config.customModelEndpoint) {
    providerList.push({ name: 'custom', endpoint: config.customModelEndpoint });
  }

  // Probe all in parallel
  const settled = await Promise.allSettled(
    providerList.map(p => probeProvider(p.name, p.endpoint))
  );

  const availableProviders: DiscoveredProvider[] = settled
    .map(r => (r.status === 'fulfilled' ? r.value : null))
    .filter((p): p is DiscoveredProvider => p !== null);

  // Validate saved selection
  let selected: RouterResult['selected'] | undefined;
  if (config.selectedProvider && config.selectedModelId && config.selectedEndpoint) {
    const savedProvider = availableProviders.find(
      p => p.name === config.selectedProvider && p.endpoint === config.selectedEndpoint
    );

    if (savedProvider) {
      selected = { provider: savedProvider, modelId: config.selectedModelId };
    } else if (cachedResult?.selected) {
      // Provider was previously selected but now gone
      const lostName = config.selectedProvider;
      writeConfig({ ...config, selectedProvider: null, selectedEndpoint: null, selectedModelId: null }, workspacePath);
      if (selectionLostCallback) selectionLostCallback(lostName);
    }
  }

  // Auto-select only when: exactly one provider with exactly one model and no selection yet
  if (!selected && !config.selectedModelId && availableProviders.length === 1 && availableProviders[0].models.length === 1) {
    const provider = availableProviders[0];
    const modelId = provider.models[0].id;
    writeConfig({ ...config, selectedProvider: provider.name, selectedEndpoint: provider.endpoint, selectedModelId: modelId }, workspacePath);
    selected = { provider, modelId };
  }

  const tier: RouterResult['tier'] = selected ? 'local' : 'rules';

  const result: RouterResult = { tier, availableProviders, selected };
  cachedResult = result;
  return result;
}

/** Returns the last cached RouterResult without re-probing. */
export function getCachedResult(): RouterResult | null {
  return cachedResult;
}

/** Register a callback fired when the previously selected provider disappears on re-probe. */
export function onSelectionLost(cb: SelectionLostCallback): void {
  selectionLostCallback = cb;
}

/**
 * Start a 60-second re-probe loop. Calls `onUpdate` with the new result on each pass.
 * Replaces any existing loop — safe to call multiple times.
 */
export function startReprobeLoop(
  onUpdate: (result: RouterResult) => void,
  workspacePath?: string
): void {
  if (probeTimer) clearInterval(probeTimer);
  probeTimer = setInterval(async () => {
    const result = await probe(workspacePath);
    onUpdate(result);
  }, REPROBE_INTERVAL_MS);
}

/** Stop the re-probe loop. Called on extension deactivation. */
export function stopReprobeLoop(): void {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}
