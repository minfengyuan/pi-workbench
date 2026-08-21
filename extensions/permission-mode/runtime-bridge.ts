export interface IntegrationState {
	planMode: boolean;
	sandbox: boolean;
}

type Listener = (state: IntegrationState) => void;

let state: IntegrationState = { planMode: false, sandbox: false };
const listeners = new Set<Listener>();

function update(patch: Partial<IntegrationState>): void {
	state = { ...state, ...patch };
	for (const listener of listeners) listener(state);
}

export function setPlanModeActive(active: boolean): void {
	update({ planMode: active });
}

export function setSandboxActive(active: boolean): void {
	update({ sandbox: active });
}

export function getIntegrationState(): IntegrationState {
	return state;
}

export function subscribeIntegrationState(listener: Listener): () => void {
	listeners.add(listener);
	listener(state);
	return () => listeners.delete(listener);
}
