import type { Building, IBuildingDefinition } from "../../../shared/definitions/BuildingDefinitions";
import type { Deposit } from "../../../shared/definitions/MaterialDefinitions";
import { getBuildingThatExtract, isWorldOrNaturalWonder } from "../../../shared/logic/BuildingLogic";
import { Config } from "../../../shared/logic/Config";
import { getGameState, notifyGameStateUpdate } from "../../../shared/logic/GameStateLogic";
import { BuildingInputMode, makeBuilding, STOCKPILE_CAPACITY_MAX, STOCKPILE_MAX_MAX } from "../../../shared/logic/Tile";
import { clearTransportSourceCache } from "../../../shared/logic/Update";
import { pointToTile, tileToPoint } from "../../../shared/utilities/Helper";

export async function getMapSize(): Promise<{ width: number; height: number; }> {
    const gs = getGameState();
    let maxX = 0;
    let maxY = 0;
    for (const xy of gs.tiles.keys()) {
        const p = tileToPoint(xy);
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { width: maxX + 1, height: maxY + 1 };
}

/**
 * Place a sequential plan into an explicit rectangle [minX..maxX] x [minY..maxY].
 * Behavior mirrors `doBuildingPlan` but targets an explicit rectangle instead
 * of a left/right anchored strip. It will only place on empty tiles (no
 * overwriting), and will ensure a CoalPowerPlant exists at the start of the
 * coords when the plan contains electrified buildings.
 */
export async function doBuildingPlanRect(
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    plan: Array<{ type: Building; count: number; level?: number }>,
    intervalMs: number,
): Promise<{ results: Array<{ type: Building; requested: number; placed: number }>; message?: string }> {
    const gs = getGameState();

    // Build linear coords in scan order
    const coords: { x: number; y: number }[] = [];
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            coords.push({ x, y });
        }
    }

    // Sort by building tier ascending
    const sortedPlan = [...plan].sort((a, b) => (Config.BuildingTier[a.type] ?? 0) - (Config.BuildingTier[b.type] ?? 0));

    // If any spec requires power, ensure coal exists in the rectangle
    let containsElectrified = false;
    for (const p of sortedPlan) {
        try {
            if (Config.Building[p.type] && Config.Building[p.type].power === true) { containsElectrified = true; break; }
        } catch (e) {
            // ignore
        }
    }

    if (containsElectrified) {
        let coalExists = false;
        for (const { x, y } of coords) {
            const xy = pointToTile({ x, y });
            const td = gs.tiles.get(xy);
            if (!td) continue;
            if (td.building && td.building.type === ("CoalPowerPlant" as Building)) { coalExists = true; break; }
        }
        if (!coalExists) {
            for (let i = 0; i < coords.length; i++) {
                const { x, y } = coords[i];
                const xy = pointToTile({ x, y });
                const td = gs.tiles.get(xy);
                if (!td) continue;
                if (!td.building) {
                    const b = makeBuilding({ type: "CoalPowerPlant" as Building, level: 0, desiredLevel: 10 });
                    b.stockpileCapacity = STOCKPILE_CAPACITY_MAX;
                    b.stockpileMax = STOCKPILE_MAX_MAX;
                    b.inputMode = BuildingInputMode.StoragePercentage ?? undefined;
                    b.maxInputDistance = Number.POSITIVE_INFINITY;
                    td.building = b;
                    // advance cursor past coal if needed by placements
                    break;
                }
            }
            clearTransportSourceCache();
            ensureVisualRefresh();
        }
    }

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const results: Array<{ type: Building; requested: number; placed: number }> = [];
    let cursor = 0;

    for (const spec of sortedPlan) {
        const requested = spec.count;
        const targetLevel = spec.level ?? 10;
        let placed = 0;

        try {
            if (!Config.Building[spec.type]) {
                results.push({ type: spec.type, requested, placed: 0 });
                continue;
            }
        } catch (e) {
            results.push({ type: spec.type, requested, placed: 0 });
            continue;
        }

        while (placed < requested && cursor < coords.length) {
            const { x, y } = coords[cursor++];
            const xy = pointToTile({ x, y });
            const td = gs.tiles.get(xy);
            if (!td) continue;

            // Only place on empty tiles (do not overwrite)
            if (td.building) continue;

            const b = makeBuilding({ type: spec.type, level: 0, desiredLevel: targetLevel });
            b.stockpileCapacity = STOCKPILE_CAPACITY_MAX;
            b.stockpileMax = STOCKPILE_MAX_MAX;
            b.inputMode = BuildingInputMode.StoragePercentage;
            b.maxInputDistance = Number.POSITIVE_INFINITY;
            td.building = b;
            placed++;

            if (intervalMs > 0) await sleep(intervalMs);
        }

        results.push({ type: spec.type, requested, placed });
        if (cursor >= coords.length) break;
    }

    if (results.some((r) => r.placed > 0)) clearTransportSourceCache();
    ensureVisualRefresh();
    return { results };
}

export async function splitElectricityBuildings(plan: Array<{ type: Building; count: number }>) : Promise<{
    nonElectSpecs: Array<{ type: Building; count: number; targetLevel?: number }>;
    electSpecs: Array<{ type: Building; count: number; targetLevel?: number }>;
}> {
    const nonElectSpecs: Array<{ type: Building; count: number; targetLevel?: number }> = [];
    const electSpecs: Array<{ type: Building; count: number; targetLevel?: number }> = [];

    for (const item of plan) {
        try {
            const def = Config.Building[item.type as Building];
            const requiresPower = !!(def && def.power === true);
            if (requiresPower) electSpecs.push({ type: item.type, count: item.count, targetLevel: 15 });
            else nonElectSpecs.push({ type: item.type, count: item.count, targetLevel: 15 });
        } catch (e) {
            // Conservative fallback
            nonElectSpecs.push({ type: item.type, count: item.count, targetLevel: 15 });
        }
    }

    return { nonElectSpecs, electSpecs };
}

// Local visual refresh helper (double-notify like main scripts)
export function ensureVisualRefresh(): void {
    try {
        notifyGameStateUpdate();
        if (typeof requestAnimationFrame !== "undefined") {
            requestAnimationFrame(() => notifyGameStateUpdate());
        }
    } catch (e) {
        console.error("ensureVisualRefresh failed:", e);
    }
}

/**
 * Remove all buildings whose type string appears in `names` across the whole map.
 * Preserves wonders and tiles that contain an extractor for an underlying deposit.
 * Returns the number of buildings removed.
 */
export function removeBuildingsByNames(names: string[]): number {
    const gs = getGameState();
    if (!names || names.length === 0) return 0;

    const nameSet = new Set<string>(names);
    let removed = 0;
    const preservedWonders = new Set<number>();
    const preservedMines = new Set<number>();

    for (const [xy, td] of gs.tiles.entries()) {
        if (!td || !td.building) continue;

        try {
            const btype = td.building.type as string;
            if (!nameSet.has(btype)) continue;

            // Never remove wonders
            if (isWorldOrNaturalWonder(td.building.type)) {
                preservedWonders.add(xy);
                continue;
            }

            // If this tile has a deposit that maps to an extractor and that extractor
            // is present on this tile, preserve it.
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

            if (hasProtectedDeposit && isExtractorPresent) {
                preservedMines.add(xy);
                continue;
            }

            // Safe to delete
            td.building = undefined;
            removed++;

        } catch (e) {
            // ignore malformed entries
        }
    }

    if (removed > 0) {
        try { clearTransportSourceCache(); } catch (e) { /* swallow */ }
        ensureVisualRefresh();
    }

    return removed;
}

/**
 * Convenience: accept user-facing/display building names (what Config.Building[...].name() returns)
 * and remove all instances of those buildings.
 *
 * Notes:
 * - `Config.Building[key].name()` may be localized; pass the exact displayed string or set
 *   caseInsensitive = true to match case-insensitively.
 * - This function maps display names back to internal building keys and calls
 *   `removeBuildingsByNames`.
 */
export function removeBuildingsByDisplayNames(displayNames: string[], caseInsensitive = false): number {
    if (!displayNames || displayNames.length === 0) return 0;

    const lookup = new Map<string, string>(); // map normalized displayName -> internalKey
    for (const key of Object.keys(Config.Building)) {
        try {
            const def = (Config.Building as unknown as Record<string, IBuildingDefinition>)[key];
            if (!def) continue;
            const dn = def.name();
            const norm = caseInsensitive ? dn.toLowerCase() : dn;
            if (!lookup.has(norm)) lookup.set(norm, key);
        } catch (e) {
            // ignore malformed defs
        }
    }

    const internalNames: string[] = [];
    for (const dn of displayNames) {
        const norm = caseInsensitive ? dn.toLowerCase() : dn;
        const key = lookup.get(norm);
        if (key) internalNames.push(key);
    }

    // If none of the display names mapped to internal keys, return 0
    if (internalNames.length === 0) return 0;

    return removeBuildingsByNames(internalNames);
}
    
// Overload: numeric rectangle or side-based strip signature
export function clearRange(minX: number, maxX: number, minY: number, maxY: number): { cleared: number; preservedWonders: number; preservedMines: number };
export function clearRange(side: "left" | "right", width: number, startRow: number, endRow: number): { cleared: number; preservedWonders: number; preservedMines: number };
export function clearRange(a: number | "left" | "right", b: number, c: number, d: number) {
    const gs = getGameState();

    // Resolve args into rectangle bounds
    let minX: number;
    let maxX: number;
    let minY: number;
    let maxY: number;

    if (a === "left" || a === "right") {
        const side = a as "left" | "right";
        const width = b;
        const startRow = c;
        const endRow = d;

        // Determine map bounds
        let mapMaxX = Number.NEGATIVE_INFINITY;
        let mapMinX = Number.POSITIVE_INFINITY;
        let mapMaxY = Number.NEGATIVE_INFINITY;
        for (const xy of gs.tiles.keys()) {
            const p = tileToPoint(xy);
            if (p.x > mapMaxX) mapMaxX = p.x;
            if (p.x < mapMinX) mapMinX = p.x;
            if (p.y > mapMaxY) mapMaxY = p.y;
        }
        if (mapMaxX === Number.NEGATIVE_INFINITY || mapMinX === Number.POSITIVE_INFINITY) {
            return { cleared: 0, preservedWonders: 0, preservedMines: 0 };
        }

        if (side === "left") {
            minX = Math.max(0, Math.floor(mapMinX));
            maxX = Math.min(Math.floor(mapMaxX), minX + width - 1);
        } else {
            maxX = Math.floor(mapMaxX);
            minX = Math.max(0, maxX - (width - 1));
        }
        minY = startRow;
        maxY = Math.min(Math.floor(mapMaxY), endRow);
    } else {
        minX = a as number;
        maxX = b;
        minY = c;
        maxY = d;
    }

    let clearedTotal = 0;
    const preservedWondersSet = new Set<number>();
    const preservedMinesSet = new Set<number>();

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const xy = pointToTile({ x, y });
            const td = gs.tiles.get(xy);
            if (!td || !td.building) continue;

            // Never remove wonders
            if (isWorldOrNaturalWonder(td.building.type)) {
                preservedWondersSet.add(xy);
                continue;
            }

            // If the tile has a deposit that has an extractor type defined in config,
            // and that extractor is present on this tile, preserve it.
            let hasProtectedDeposit = false;
            let isExtractorBuildingPresent = false;
            for (const depositKey of Object.keys(td.deposit) as Deposit[]) {
                if (!td.deposit[depositKey]) continue;
                const extractor = getBuildingThatExtract(depositKey);
                if (extractor) {
                    hasProtectedDeposit = true;
                    if (td.building.type === extractor) {
                        isExtractorBuildingPresent = true;
                    }
                    break;
                }
            }
            if (hasProtectedDeposit && isExtractorBuildingPresent) {
                preservedMinesSet.add(xy);
                continue;
            }

            // Safe to delete
            td.building = undefined;
            clearedTotal++;
        }
    }

    if (clearedTotal > 0) clearTransportSourceCache();
    ensureVisualRefresh();
    return { cleared: clearedTotal, preservedWonders: preservedWondersSet.size, preservedMines: preservedMinesSet.size };
}

export async function doBuildingPlan(
    side: "left" | "right",
    width: number,
    plan: Array<{ type: Building; count: number; level?: number }>,
    startRow: number,
    intervalMs: number,
): Promise<{ results: Array<{ type: Building; requested: number; placed: number }>; message?: string }> {
	const gs = getGameState();

	// Determine map bounds
	let mapMaxX = Number.NEGATIVE_INFINITY;
	let mapMinX = Number.POSITIVE_INFINITY;
	let mapMaxY = Number.NEGATIVE_INFINITY;
	for (const xy of gs.tiles.keys()) {
		const p = tileToPoint(xy);
		if (p.x > mapMaxX) mapMaxX = p.x;
		if (p.x < mapMinX) mapMinX = p.x;
		if (p.y > mapMaxY) mapMaxY = p.y;
	}

	if (mapMaxX === Number.NEGATIVE_INFINITY || mapMinX === Number.POSITIVE_INFINITY) {
		return { results: [], message: "No map tiles available" };
	}

	const floorMaxX = Math.floor(mapMaxX);
	const floorMinX = Math.max(0, Math.floor(mapMinX));
	const floorMaxY = Math.floor(mapMaxY);

	// Compute strip bounds
	let minX: number;
	let maxX: number;
	if (side === "right") {
		maxX = floorMaxX;
		minX = Math.max(0, maxX - Math.max(0, width - 1));
	} else {
		minX = floorMinX;
		maxX = Math.min(floorMaxX, minX + Math.max(0, width - 1));
	}

	const minY = Math.max(0, Math.floor(startRow));
	const maxY = floorMaxY;

	if (minY > maxY) return { results: [], message: "Start row is below map bounds" };

	// Build a linear list of coordinates in scan order starting at startRow
	const coords: { x: number; y: number }[] = [];
	for (let y = minY; y <= maxY; y++) {
		for (let x = minX; x <= maxX; x++) {
			coords.push({ x, y });
		}
	}

	// Cursor across coords so we fill the strip sequentially and do not
	// repeatedly attempt the same tiles for different building types.
	let cursor = 0;
	let anyPlaced = false;

	// Sort incoming plan by building tier ascending so lower-tier (fewer
	// dependencies) buildings are placed first.
	const sortedPlan = [...plan].sort((a, b) => (Config.BuildingTier[a.type] ?? 0) - (Config.BuildingTier[b.type] ?? 0));

	// If the plan contains any electrified buildings, ensure a CoalPowerPlant
	// exists in the target strip. If none exists, place one on the first empty
	// tile and advance the cursor past it so subsequent placements don't reuse it.
	let containsElectrified = false;
	for (const p of sortedPlan) {
		try {
			if (Config.Building[p.type] && Config.Building[p.type].power === true) { containsElectrified = true; break; }
		} catch (e) {
			// ignore unknown types
		}
	}

	if (containsElectrified) {
		let coalExists = false;
		for (const { x, y } of coords) {
			const xy = pointToTile({ x, y });
			const td = gs.tiles.get(xy);
			if (!td) continue;
			if (td.building && td.building.type === ("CoalPowerPlant" as Building)) { coalExists = true; break; }
		}
		if (!coalExists) {
			for (let i = 0; i < coords.length; i++) {
				const { x, y } = coords[i];
				const xy = pointToTile({ x, y });
				const td = gs.tiles.get(xy);
				if (!td) continue;
				if (!td.building) {
					const b = makeBuilding({ type: "CoalPowerPlant" as Building, level: 0, desiredLevel: 10 });
					// Give power plant max stockpile/input settings by default
					b.stockpileCapacity = STOCKPILE_CAPACITY_MAX;
					b.stockpileMax = STOCKPILE_MAX_MAX;
					b.inputMode = BuildingInputMode.StoragePercentage;
					b.maxInputDistance = Number.POSITIVE_INFINITY;
					td.building = b;
					anyPlaced = true;
					cursor = i + 1;
					break;
				}
			}
		}
	}

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const results: Array<{ type: Building; requested: number; placed: number }> = [];

	for (const spec of sortedPlan) {
		const requested = spec.count;
		// `level` is the desired building level supplied per-plan-item.
		const targetLevel = spec.level ?? 10;
		let placed = 0;

		// Defensive: skip unknown building types
		try {
			if (!Config.Building[spec.type]) {
				results.push({ type: spec.type, requested, placed: 0 });
				continue;
			}
		} catch (e) {
			results.push({ type: spec.type, requested, placed: 0 });
			continue;
		}

		while (placed < requested && cursor < coords.length) {
			const { x, y } = coords[cursor++];
			const xy = pointToTile({ x, y });
			const td = gs.tiles.get(xy);
			if (!td) continue;

			// Only build on empty tiles — DO NOT overwrite any existing building
			// (this intentionally removes prior protections like preserving
			// wonders or deposits; empty-state is the sole placement condition).
			if (td.building) continue;

			// Create building at level 0 and set desiredLevel so the game's
			// construction logic applies (resources reserved, status 'building').
			const b = makeBuilding({ type: spec.type, level: 0, desiredLevel: targetLevel });
			b.stockpileCapacity = STOCKPILE_CAPACITY_MAX;
			b.stockpileMax = STOCKPILE_MAX_MAX;
			b.inputMode = BuildingInputMode.StoragePercentage;
			b.maxInputDistance = Number.POSITIVE_INFINITY;
			td.building = b;
			placed++;
			anyPlaced = true;

			// Wait the configured interval between placements so the UI can
			// show incremental progress. We avoid trying to force an extra
			// visual refresh here; callers should rely on `intervalMs`.
			if (intervalMs > 0) await sleep(intervalMs);
		}

		results.push({ type: spec.type, requested, placed });
		// If we exhausted coords early, stop processing further specs
		if (cursor >= coords.length) break;
	}

	if (anyPlaced) clearTransportSourceCache();
	ensureVisualRefresh();
	return { results };
}
