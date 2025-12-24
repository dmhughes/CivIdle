import type { Building } from "../../../shared/definitions/BuildingDefinitions";
import type { Deposit } from "../../../shared/definitions/MaterialDefinitions";
import { getBuildingThatExtract, isWorldOrNaturalWonder } from "../../../shared/logic/BuildingLogic";
import { Config } from "../../../shared/logic/Config";
import { getGameState, notifyGameStateUpdate } from "../../../shared/logic/GameStateLogic";
import { makeBuilding } from "../../../shared/logic/Tile";
import { clearTransportSourceCache } from "../../../shared/logic/Update";
import { pointToTile, tileToPoint } from "../../../shared/utilities/Helper";

/**
 * Load a plan file (JSON). Try require/import/fetch and return parsed object.
 */
async function loadPlanFile(path: string): Promise<unknown> {
	// try Node/Electron require
	try {
		const req = (globalThis as unknown as { require?: (p: string) => unknown }).require;
		if (typeof req === "function") return req(path);
	} catch (e) {
		// fallthrough
	}

	// try dynamic import (bundler-aware)
	try {
		// @ts-ignore - runtime dynamic import
		const mod = await import(/* @vite-ignore */ path);
		return (mod && (mod.default ?? mod));
	} catch (e) {
		// fallthrough
	}

	// try fetch
	if (typeof fetch !== "undefined") {
		const res = await fetch(path);
		if (!res.ok) throw new Error(`Failed to fetch plan file ${path}: ${res.statusText}`);
		return await res.json();
	}

	throw new Error(`Unable to load plan file: ${path}`);
}

function buildDisplayMap(): Map<string, Building> {
	const map = new Map<string, Building>();
	for (const key of Object.keys(Config.Building)) {
		try {
			const def = (Config.Building as unknown as Record<string, { name?: () => string }>)[key];
			if (!def) continue;
			const dn = typeof def.name === "function" ? String(def.name()) : String(key);
			map.set(dn, key as Building);
			map.set(dn.toLowerCase(), key as Building);
		} catch (e) {
			// ignore malformed defs
		}
	}
	return map;
}

function resolveSpecType(spec: unknown, displayMap: Map<string, Building>): Building | undefined {
	if (!spec) return undefined;
	const s = spec as Record<string, unknown>;
	if (typeof s.type === "string") return s.type as Building;
	if (typeof s.name === "string") {
		const raw = s.name as string;
		return displayMap.get(raw) ?? displayMap.get(raw.toLowerCase());
	}
	return undefined;
}

function ensureVisualRefreshLocal() {
	try {
		try { notifyGameStateUpdate(); } catch (e) { /* ignore */ }
		if (typeof requestAnimationFrame !== "undefined") {
			requestAnimationFrame(() => {
				try { notifyGameStateUpdate(); } catch (e) { /* ignore */ }
			});
		}
	} catch (e) {
		// swallow
	}
}

/**
 * Clear a rectangular region. Returns cleared counts and preserved counts.
 */
export function clearRegion(minX: number, maxX: number, minY: number, maxY: number, opts?: { preserveWonders?: boolean; preserveExtractors?: boolean }) {
	const gs = getGameState();
	const preserveWonders = opts?.preserveWonders ?? true;
	const preserveExtractors = opts?.preserveExtractors ?? true;
	let cleared = 0;
	const preservedWonders = new Set<number>();
	const preservedMines = new Set<number>();

	for (let y = minY; y <= maxY; y++) {
		for (let x = minX; x <= maxX; x++) {
			const xy = pointToTile({ x, y });
			const td = gs.tiles.get(xy);
			if (!td || !td.building) continue;
			if (preserveWonders && isWorldOrNaturalWonder(td.building.type)) { preservedWonders.add(xy); continue; }
			if (preserveExtractors) {
				let hasProtectedDeposit = false;
				let isExtractorPresent = false;
				for (const depositKey of Object.keys(td.deposit) as Deposit[]) {
					if (!td.deposit[depositKey]) continue;
					const extractor = getBuildingThatExtract(depositKey);
					if (extractor) {
						hasProtectedDeposit = true;
						if (td.building && td.building.type === extractor) isExtractorPresent = true;
						break;
					}
				}
				if (hasProtectedDeposit && isExtractorPresent) { preservedMines.add(xy); continue; }
			}
			td.building = undefined;
			cleared++;
		}
	}

	if (cleared > 0) {
		try { clearTransportSourceCache(); } catch (e) { /* swallow */ }
		ensureVisualRefreshLocal();
	}

	return { cleared, preservedWonders: preservedWonders.size, preservedMines: preservedMines.size };
}

/**
 * Place a set of specs onto an explicit coords list (scan-order provided).
 */
async function placeOnCoords(coords: Array<{ x: number; y: number }>, rawSpecs: unknown[], options?: { intervalMs?: number }, displayMap?: Map<string, Building>) {
	const gs = getGameState();
	const display = displayMap ?? buildDisplayMap();
	const mappedSpecs: Array<{ type: Building; count: number; level?: number }> = [];
	for (const s of Array.isArray(rawSpecs) ? rawSpecs : []) {
		const resolved = resolveSpecType(s, display);
		if (!resolved) continue;
		const sRec = s as Record<string, unknown>;
		const count = Number(sRec.count ?? 0);
		if (Number.isNaN(count) || count <= 0) continue;
		const level = typeof sRec.level === 'number' ? sRec.level as number : undefined;
		mappedSpecs.push({ type: resolved, count, level });
	}

	// Place buildings one-at-a-time: iterate coords cyclically and attempt to place a single building
	// at a time (one building placement per loop iteration). This prevents placing entire blocks
	// of the same building type in a batch and ensures deterministic single-step progression.
	mappedSpecs.sort((a, b) => ((Config.BuildingTier as unknown as Record<string, number>)[a.type] ?? 0) - ((Config.BuildingTier as unknown as Record<string, number>)[b.type] ?? 0));

	const results: Array<{ type: string; requested: number; placed: number }> = [];
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const intervalMs = options?.intervalMs ?? 0;

	// Track remaining counts and placed counts per spec
	const specState = mappedSpecs.map(s => ({ type: s.type, remaining: s.count, requested: s.count, level: s.level ?? 10, placed: 0 }));
	let remainingTotal = specState.reduce((a, b) => a + b.remaining, 0);
	if (remainingTotal <= 0) return [];

	// If no coords, nothing to do
	if (!coords || coords.length === 0) return specState.map(s => ({ type: s.type, requested: s.requested, placed: 0 }));

	let idx = 0;
	// To avoid infinite loops when no progress is possible (all coords blocked), count consecutive skips
	let consecutiveNoPlace = 0;
	const maxNoPlace = coords.length;

	while (remainingTotal > 0 && consecutiveNoPlace < maxNoPlace) {
		const { x, y } = coords[idx];
		idx = (idx + 1) % coords.length;
		const xy = pointToTile({ x, y });
		const td = gs.tiles.get(xy);
		if (!td || td.building) {
			consecutiveNoPlace++;
			continue;
		}

		// Try specs in priority order; place the first one that still has remaining count
		let placedThisCoord = false;
		for (const s of specState) {
			if (s.remaining <= 0) continue;
			// place one building of this type here
			const b = makeBuilding({ type: s.type, level: 0, desiredLevel: s.level });
			td.building = b;
			s.remaining -= 1;
			s.placed += 1;
			remainingTotal -= 1;
			placedThisCoord = true;
			consecutiveNoPlace = 0;
			try { clearTransportSourceCache(); } catch (e) { /* swallow */ }
			ensureVisualRefreshLocal();
			if (intervalMs > 0) await sleep(intervalMs);
			break; // move to next coord after placing one building
		}

		if (!placedThisCoord) {
			consecutiveNoPlace++;
		}
	}

	// Build results array
	for (const s of specState) {
		results.push({ type: s.type, requested: s.requested, placed: s.placed });
	}

	if (results.some(r => r.placed > 0)) {
		try { clearTransportSourceCache(); } catch (e) { }
		ensureVisualRefreshLocal();
	}

	return results;
}

/**
 * Place buildings in a rectangle [minX..maxX] x [minY..maxY]
 */
export async function buildRect(minX: number, maxX: number, minY: number, maxY: number, specs: unknown[], options?: { intervalMs?: number }, displayMap?: Map<string, Building>) {
	const coords: Array<{ x: number; y: number }> = [];
	for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) coords.push({ x, y });
	return await placeOnCoords(coords, specs, options, displayMap);
}

/**
 * Place buildings into a vertical strip anchored to left or right.
 */
export async function buildStrip(side: 'left' | 'right', width: number, specs: unknown[], startRow: number, options?: { intervalMs?: number }, displayMap?: Map<string, Building>) {
	const gs = getGameState();
	let mapMaxX = Number.NEGATIVE_INFINITY;
	let mapMinX = Number.POSITIVE_INFINITY;
	let mapMaxY = Number.NEGATIVE_INFINITY;
	for (const xy of gs.tiles.keys()) {
		const p = tileToPoint(xy);
		if (p.x > mapMaxX) mapMaxX = p.x;
		if (p.x < mapMinX) mapMinX = p.x;
		if (p.y > mapMaxY) mapMaxY = p.y;
	}
	if (mapMaxX === Number.NEGATIVE_INFINITY || mapMinX === Number.POSITIVE_INFINITY) return [];
	const floorMaxX = Math.floor(mapMaxX);
	const floorMinX = Math.max(0, Math.floor(mapMinX));
	const floorMaxY = Math.floor(mapMaxY);

	let minX: number; let maxX: number;
	if (side === 'right') { maxX = floorMaxX; minX = Math.max(0, maxX - Math.max(0, width - 1)); }
	else { minX = floorMinX; maxX = Math.min(floorMaxX, minX + Math.max(0, width - 1)); }
	const minY = Math.max(0, Math.floor(startRow));
	const maxY = floorMaxY;
	if (minY > maxY) return [];

	const coords: Array<{ x: number; y: number }> = [];
	for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) coords.push({ x, y });
	return await placeOnCoords(coords, specs, options, displayMap);
}

/**
 * PerformBuildingPlan(filePath)
 * - Loads the JSON plan at `filePath` and executes tasks in order.
 * - Supported modes: "strip", "rect", "clear".
 * - Specs may use `name` (friendly display name) or `type` (internal key).
 * - Returns placed counts per spec as { type, requested, placed } entries.
 */
export async function PerformBuildingPlan(filePath: string, opts?: { intervalMs?: number }): Promise<{ results: Array<{ type: string; requested: number; placed: number }>; message?: string }> {
	const gs = getGameState();

	const raw = await loadPlanFile(filePath);
	const plan = raw as { tasks?: unknown[] } | undefined;
	if (!plan || !Array.isArray(plan.tasks)) throw new Error("Invalid plan file: tasks array missing");

	const displayMap = buildDisplayMap();
	const results: Array<{ type: string; requested: number; placed: number }> = [];
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const planObj = plan as Record<string, unknown>;
	const tasks = Array.isArray(planObj.tasks) ? planObj.tasks as unknown[] : [];
	for (let ti = 0; ti < tasks.length; ti++) {
		const task = tasks[ti] as Record<string, unknown>;
		if (!task || typeof task.mode !== "string") continue;
		const mode = task.mode as string;
		const options = (task.options as Record<string, unknown>) ?? {};
		const intervalMs = typeof options.intervalMs === "number" ? options.intervalMs : (opts && typeof opts.intervalMs === "number" ? opts.intervalMs : 0);

		if (mode === "clear") {
			const minX = Number(options.minX ?? 0);
			const maxX = Number(options.maxX ?? minX);
			const minY = Number(options.minY ?? 0);
			const maxY = Number(options.maxY ?? minY);
			const cleared = clearRegion(minX, maxX, minY, maxY, { preserveWonders: true, preserveExtractors: true });
			results.push({ type: "clear", requested: 0, placed: cleared.cleared });
		}

		if (mode === "rect") {
			const minX = Number(options.minX ?? 0);
			const maxX = Number(options.maxX ?? minX);
			const minY = Number(options.minY ?? 0);
			const maxY = Number(options.maxY ?? minY);
			const r = await buildRect(minX, maxX, minY, maxY, Array.isArray(task.specs) ? task.specs as unknown[] : [], { intervalMs });
			for (const item of r) results.push(item);
		}

		if (mode === "strip") {
			const side = String(options.side ?? "left") as 'left' | 'right';
			const width = Math.max(1, Number(options.width ?? 10));
			const startRow = typeof options.startRow === 'number' ? options.startRow : 0;
			const r = await buildStrip(side, width, Array.isArray(task.specs) ? task.specs as unknown[] : [], startRow, { intervalMs });
			for (const item of r) results.push(item);
		}
		// unsupported mode -> skip
	}

	return { results };
}

/**
 * Execute a plan that's already loaded as an object (no file loading).
 */
export async function PerformBuildingPlanFromObject(planRaw: unknown, opts?: { intervalMs?: number }): Promise<{ results: Array<{ type: string; requested: number; placed: number }>; message?: string }> {
	const gs = getGameState();

	const plan = planRaw as { tasks?: unknown[] } | undefined;
	if (!plan || !Array.isArray(plan.tasks)) throw new Error("Invalid plan object: tasks array missing");

	const displayMap = buildDisplayMap();
	const results: Array<{ type: string; requested: number; placed: number }> = [];
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const planObj = plan as Record<string, unknown>;
	const tasks = Array.isArray(planObj.tasks) ? planObj.tasks as unknown[] : [];
	for (let ti = 0; ti < tasks.length; ti++) {
		const task = tasks[ti] as Record<string, unknown>;
		if (!task || typeof task.mode !== "string") continue;
		const mode = task.mode as string;
		const options = (task.options as Record<string, unknown>) ?? {};
		const intervalMs = typeof options.intervalMs === "number" ? options.intervalMs : (opts && typeof opts.intervalMs === "number" ? opts.intervalMs : 0);

		if (mode === "clear") {
			const minX = Number(options.minX ?? 0);
			const maxX = Number(options.maxX ?? minX);
			const minY = Number(options.minY ?? 0);
			const maxY = Number(options.maxY ?? minY);
			const cleared = clearRegion(minX, maxX, minY, maxY, { preserveWonders: true, preserveExtractors: true });
			results.push({ type: "clear", requested: 0, placed: cleared.cleared });
		}

		if (mode === "rect") {
			const minX = Number(options.minX ?? 0);
			const maxX = Number(options.maxX ?? minX);
			const minY = Number(options.minY ?? 0);
			const maxY = Number(options.maxY ?? minY);
			const r = await buildRect(minX, maxX, minY, maxY, Array.isArray(task.specs) ? task.specs as unknown[] : [], { intervalMs });
			for (const item of r) results.push(item);
		}

		if (mode === "strip") {
			const side = String(options.side ?? "left") as 'left' | 'right';
			const width = Math.max(1, Number(options.width ?? 10));
			const startRow = typeof options.startRow === 'number' ? options.startRow : 0;
			const r = await buildStrip(side, width, Array.isArray(task.specs) ? task.specs as unknown[] : [], startRow, { intervalMs });
			for (const item of r) results.push(item);
		}
		// unsupported mode -> skip
	}

	return { results };
}

