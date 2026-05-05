let usageDbModulePromise = null;

function isWorkerRuntime() {
	return (
		typeof WebSocketPair !== "undefined" || typeof EdgeRuntime !== "undefined"
	);
}

async function loadUsageDbModule() {
	if (isWorkerRuntime()) {
		return null;
	}

	if (!usageDbModulePromise) {
		usageDbModulePromise = import("@/lib/usageDb.js").catch(() => null);
	}

	return usageDbModulePromise;
}

export function trackPendingRequest(...args) {
	void args;
	if (isWorkerRuntime()) {
		return;
	}

	void loadUsageDbModule().then((mod) => {
		mod?.trackPendingRequest?.(...args);
	});
}

export async function saveRequestUsage(...args) {
	const mod = await loadUsageDbModule();
	return mod?.saveRequestUsage?.(...args);
}

export async function saveRequestDetail(...args) {
	const mod = await loadUsageDbModule();
	return mod?.saveRequestDetail?.(...args);
}

export async function appendRequestLog(...args) {
	const mod = await loadUsageDbModule();
	return mod?.appendRequestLog?.(...args);
}

export async function getUsageDb(...args) {
	const mod = await loadUsageDbModule();
	if (!mod?.getUsageDb) {
		return { data: { history: [] } };
	}
	return mod.getUsageDb(...args);
}

export async function getUsageHistory(...args) {
	const mod = await loadUsageDbModule();
	return mod?.getUsageHistory?.(...args) || [];
}

export async function getUsageStats(...args) {
	const mod = await loadUsageDbModule();
	return mod?.getUsageStats?.(...args) || {};
}

export async function getRecentLogs(...args) {
	const mod = await loadUsageDbModule();
	return mod?.getRecentLogs?.(...args) || [];
}
