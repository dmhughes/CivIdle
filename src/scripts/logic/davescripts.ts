/**
 * Dave's small utilities used from the UI for maintenance tasks.
 *
 * This file intentionally keeps very small, well-scoped helpers. The
 * clearRange function below will clear buildings in a rectangular area
 * while honouring two non-negotiable rules:
 *  - Wonders are never deleted
 *  - Tiles that sit on a deposit which has a corresponding extractor (mine)
 *    are never deleted
 */

import type { Building } from "../../../shared/definitions/BuildingDefinitions";
import type { Deposit } from "../../../shared/definitions/ResourceDefinitions";
import { findSpecialBuilding, getBuildingThatExtract, isWorldOrNaturalWonder } from "../../../shared/logic/BuildingLogic";
import { Config } from "../../../shared/logic/Config";
import { getGameState, notifyGameStateUpdate } from "../../../shared/logic/GameStateLogic";
import { getGrid } from "../../../shared/logic/IntraTickCache";
import { makeBuilding } from "../../../shared/logic/Tile";
import { clearTransportSourceCache } from "../../../shared/logic/Update";
import { pointToTile, tileToPoint } from "../../../shared/utilities/Helper";

function ensureVisualRefresh(): void {
	// Notify synchronously and once on the next animation frame so UI listeners
	// (scenes/components) have a chance to pick up the state change and refresh
	// visuals/tiles. This double-notify is lightweight and ensures DOM/Canvas
	// update ordering across different listeners.
	try {
		notifyGameStateUpdate();
		if (typeof requestAnimationFrame !== "undefined") {
			requestAnimationFrame(() => notifyGameStateUpdate());
		}
	} catch (e) {
		// Best-effort: swallow errors to avoid breaking editor tooling
		console.error("ensureVisualRefresh failed:", e);
	}
}

/**
 * Clear buildings in a rectangular region (inclusive coordinates).
 *
 * Behavior rules:
 * - Will set `tile.building = undefined` for tiles inside the rectangle.
 * - Will NOT remove a building if it is a world or natural wonder.
 * - Will NOT remove a building if the tile has a deposit for which there
 *   exists an extractor building (e.g. a coal/iron/ore mine).
 *
 * Returns an object describing how many tiles were cleared and how many
 * were preserved due to wonders or deposits.
 */
export function clearRange(
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
): { cleared: number; preservedWonders: number; preservedMines: number } {
	const gs = getGameState();
	let cleared = 0;
	let preservedWonders = 0;
	let preservedMines = 0;

	for (let x = minX; x <= maxX; x++) {
		for (let y = minY; y <= maxY; y++) {
			const xy = pointToTile({ x, y });
			const td = gs.tiles.get(xy);
			if (!td || !td.building) continue;

			const type = td.building.type;

			// Never remove Wonders
			if (isWorldOrNaturalWonder(type)) {
				preservedWonders++;
				continue;
			}

			// Never remove a tile that sits on an important deposit that has a corresponding
			// extractor building defined in the game config.
				let hasProtectedDeposit = false;
				// Iterate deposit keys and protect tiles that have an extractable deposit
				for (const depositKey of Object.keys(td.deposit) as Deposit[]) {
					if (!td.deposit[depositKey]) continue;
					const extractor = getBuildingThatExtract(depositKey);
					if (extractor) {
						hasProtectedDeposit = true;
						break;
					}
				}

			if (hasProtectedDeposit) {
				preservedMines++;
				continue;
			}

			// Safe to delete
			td.building = undefined;
			cleared++;
		}
	}

	if (cleared > 0) clearTransportSourceCache();
	ensureVisualRefresh();

	return { cleared, preservedWonders, preservedMines };
}

/**
 * Place `count` buildings of type `buildingType` within the inclusive rectangle
 * [minX..maxX] x [minY..maxY]. Scans rows left-to-right, top-to-bottom (y then x).
 *
 * Rules:
 * - Do NOT build over wonders (preserve them).
 * - Do NOT build over tiles that contain a deposit for which an extractor exists.
 * - Other existing buildings in the area will be overwritten.
 * - Newly placed buildings will be completed (status 'completed') at `targetLevel`.
 *
 * Returns counts: how many placed and how many tiles were skipped due to wonders/mines.
 */
export function buildBuildingsInRange(
	minX: number,
	maxX: number,
	minY: number,
	maxY: number,
	specs: Array<{ type: Building; count: number; targetLevel?: number }>,
): {
	results: Array<{ type: Building; requested: number; placed: number }>;
	skippedWonders: number;
	skippedMines: number;
} {
	const gs = getGameState();
	let skippedWonders = 0;
	const skippedMines = 0;

	// Build a linear list of tile coordinates in scan order (rows top->bottom, left->right)
	const coords: { x: number; y: number }[] = [];
	for (let y = minY; y <= maxY; y++) {
		for (let x = minX; x <= maxX; x++) {
			coords.push({ x, y });
		}
	}

	// Sort specs by building tier (ascending) so lower-tier buildings with fewer
	// dependencies are started first. We operate on a shallow copy so the
	// caller's array is not mutated.
	const sortedSpecs = [...specs].sort((a, b) => (Config.BuildingTier[a.type] ?? 0) - (Config.BuildingTier[b.type] ?? 0));

	const results: Array<{ type: Building; requested: number; placed: number }> = [];
	let cursor = 0; // index into coords

	for (const spec of sortedSpecs) {
		const requested = spec.count;
		const targetLevel = spec.targetLevel ?? 1;
		let placed = 0;

		while (placed < requested && cursor < coords.length) {
			const { x, y } = coords[cursor++];
			const xy = pointToTile({ x, y });
			const td = gs.tiles.get(xy);
			if (!td) continue;

			// Only build on empty tiles. If occupied, skip it. Count wonders separately.
			if (td.building) {
				if (isWorldOrNaturalWonder(td.building.type)) {
					skippedWonders++;
				}
				// occupied (non-wonder) tiles are skipped silently
				continue;
			}

			// Create building at level 0 and set desiredLevel so the game's
			// construction logic applies (resources reserved, building set to 'building').
			const b = makeBuilding({ type: spec.type, level: 0, desiredLevel: targetLevel });
			td.building = b;
			placed++;
		}

		results.push({ type: spec.type, requested, placed });
		// If we ran out of tiles, stop processing further specs
		if (cursor >= coords.length) break;
	}

	if (results.some((r) => r.placed > 0)) clearTransportSourceCache();
	ensureVisualRefresh();

	return { results, skippedWonders, skippedMines };
}

/**
 * Build mines of a given type starting from bottom-right of the map.
 *
 * - `mineType`: building type (eg. "CoalMine").
 * - `desiredLevel`: the desired level to set on the mine (the mine will
 *    be created at level 0 and desiredLevel set so construction resources
 *    are immediately reserved/paid by the game mechanics).
 * - `quantity`: how many mines to attempt to place.
 *
 * Returns the number of mines actually placed.
 */
export function buildMines(mineType: Building, desiredLevel: number, quantity: number): number {
	const gs = getGameState();
	const grid = getGrid(gs);

	// Determine required deposit keys for this mine type from config
	const depositReq = Config.Building[mineType].deposit ?? {};
	const requiredDeposits = Object.keys(depositReq) as Deposit[];

	// Find bottom-right coordinate among known tiles
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const xy of gs.tiles.keys()) {
		const p = tileToPoint(xy);
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	const bottomRightTile = pointToTile({ x: Math.max(0, Math.floor(maxX)), y: Math.max(0, Math.floor(maxY)) });

	// Collect candidate tiles that have a required deposit and are empty
	const candidates: number[] = [];
	for (const [xy, td] of gs.tiles.entries()) {
		if (!td) continue;
		// skip tiles that already have buildings (mines must never be overwritten)
		if (td.building) continue;
		// check deposits
		let ok = false;
		for (const d of requiredDeposits) {
			if (td.deposit[d]) {
				ok = true;
				break;
			}
		}
		if (ok) candidates.push(xy);
	}

	// Sort by distance to bottom-right (closest first)
	candidates.sort((a, b) => grid.distanceTile(a, bottomRightTile) - grid.distanceTile(b, bottomRightTile));

	let placed = 0;
	for (const xy of candidates) {
		if (placed >= quantity) break;
		const td = gs.tiles.get(xy);
		if (!td) continue;
		// Double check: do not overwrite wonders or existing buildings
		if (td.building && isWorldOrNaturalWonder(td.building.type)) continue;
		if (td.building) continue;

		// Create mine at level 0 with desiredLevel set so construction resources are applied
		const b = makeBuilding({ type: mineType, level: 0, desiredLevel });
		// makeBuilding sets status to 'building' when level=0
		td.building = b;
		placed++;
	}

	if (placed > 0) clearTransportSourceCache();
	ensureVisualRefresh();
	return placed;
}


/**
 * 001 - Build Initial Mines
 *
 * Find the Headquarter tile and build a 5x4 grid immediately to its right.
 * - Place up to 12 Houses at level 15 inside that grid.
 * - Build 6 Aqueducts, 6 StoneQuarries and 6 LoggingCamps using buildMines().
 *
 * Returns a summary object describing placements.
 */
export function buildInitialMines(): {
	houseResult: { requested: number; placed: number } | null;
	aqueductPlaced: number;
	stoneQuarryPlaced: number;
	loggingCampPlaced: number;
	message?: string;
} {
	const gs = getGameState();

	const hq = findSpecialBuilding("Headquarter", gs);
	if (!hq) {
		return {
			houseResult: null,
			aqueductPlaced: 0,
			stoneQuarryPlaced: 0,
			loggingCampPlaced: 0,
			message: "Headquarter not found",
		};
	}

	// HQ.tile is the numeric tile index
	const hqTile = hq.tile;
	const hqPoint = tileToPoint(hqTile);

	// grid immediately to the right: 6 wide (x+1..x+6), 4 tall (y..y+3)
	const minX = hqPoint.x + 1;
	const minY = hqPoint.y;
	let maxX = minX + 5;
	let maxY = minY + 3;

	// Clamp to map extents (scan tiles to find map bounds)
	let mapMaxX = Number.NEGATIVE_INFINITY;
	let mapMaxY = Number.NEGATIVE_INFINITY;
	for (const xy of gs.tiles.keys()) {
		const p = tileToPoint(xy);
		if (p.x > mapMaxX) mapMaxX = p.x;
		if (p.y > mapMaxY) mapMaxY = p.y;
	}
	if (mapMaxX === Number.NEGATIVE_INFINITY) {
		// no tiles - nothing to do
		return {
			houseResult: null,
			aqueductPlaced: 0,
			stoneQuarryPlaced: 0,
			loggingCampPlaced: 0,
			message: "No map tiles available",
		};
	}

	maxX = Math.min(maxX, Math.floor(mapMaxX));
	maxY = Math.min(maxY, Math.floor(mapMaxY));

	// Place 12 Houses at level 15 and 5 WheatFarms in the rectangle
	// Order: Houses first so housePlacement.results[0] corresponds to Houses
	const housePlan = [
		{ type: "WheatFarm" as Building, count: 5, targetLevel: 15 },
	  { type: "House" as Building, count: 12, targetLevel: 15 }
	];

	const housePlacement = buildBuildingsInRange(minX, maxX, minY, maxY, housePlan);
	const houseResult = housePlacement.results.length > 0 ? { requested: housePlacement.results[0].requested, placed: housePlacement.results[0].placed } : null;

	// Build mines: aqueducts, stone quarries, logging camps (6 each)
	const aqueductPlaced = buildMines("Aqueduct" as Building, 15, 6);
	const stoneQuarryPlaced = buildMines("StoneQuarry" as Building, 15, 6);
	const loggingCampPlaced = buildMines("LoggingCamp" as Building, 15, 6);

	ensureVisualRefresh();

	return {
		houseResult,
		aqueductPlaced,
		stoneQuarryPlaced,
		loggingCampPlaced,
	};
}


/**
 * 002 - Build Apartment Materials
 *
 * Build in a band of 10 tiles on the extreme right-hand side of the map.
 * In row 1 (index 0) place:
 *  - 5 x Brickworks (target level 15)
 *  - 5 x LumberMill (target level 15)
 *
 * Uses buildBuildingsInRange to perform the placements and returns a small
 * summary object with per-type requested/placed counts.
 */
export function buildApartmentMaterials(): {
	brickworksResult: { requested: number; placed: number } | null;
	lumberMillResult: { requested: number; placed: number } | null;
	message?: string;
} {
	const gs = getGameState();

	// Determine map bounds (same approach used elsewhere)
	let mapMaxX = Number.NEGATIVE_INFINITY;
	for (const xy of gs.tiles.keys()) {
		const p = tileToPoint(xy);
		if (p.x > mapMaxX) mapMaxX = p.x;
	}

	if (mapMaxX === Number.NEGATIVE_INFINITY) {
		return { brickworksResult: null, lumberMillResult: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // extreme-right 10-tile band
	const minY = 0;
	const maxY = 0; // row index 0

	const specs = [
		{ type: "Brickworks" as Building, count: 5, targetLevel: 15 },
		{ type: "LumberMill" as Building, count: 5, targetLevel: 15 },
	];

	const placement = buildBuildingsInRange(minX, maxX, minY, maxY, specs);

	const findResult = (t: Building) => {
		const r = placement.results.find((x) => x.type === t);
		return r ? { requested: r.requested, placed: r.placed } : null;
	};

	const brickworksResult = findResult("Brickworks" as Building);
	const lumberMillResult = findResult("LumberMill" as Building);

	ensureVisualRefresh();

	return { brickworksResult, lumberMillResult };
}


/**
 * Build apartment support buildings in the same right-hand 10-tile band.
 * Starts at row 3 (index = 2) and covers 4 rows (y = 2..5).
 * Places:
 *  - 15 x Bakery (targetLevel 15)
 *  - 15 x PoultryFarm (targetLevel 15)
 *  - 12 x CheeseMaker (targetLevel 15)
 *  - 2 x FlourMill (targetLevel 15)
 *  - 2 x DairyFarm (targetLevel 15)
 */
export function buildApartmentSupport(): {
	bakery: { requested: number; placed: number } | null;
	poultryFarm: { requested: number; placed: number } | null;
	cheeseMaker: { requested: number; placed: number } | null;
	flourMill: { requested: number; placed: number } | null;
	dairyFarm: { requested: number; placed: number } | null;
	message?: string;
} {
	const gs = getGameState();

	// Determine map bounds
	let mapMaxX = Number.NEGATIVE_INFINITY;
	let mapMaxY = Number.NEGATIVE_INFINITY;
	for (const xy of gs.tiles.keys()) {
		const p = tileToPoint(xy);
		if (p.x > mapMaxX) mapMaxX = p.x;
		if (p.y > mapMaxY) mapMaxY = p.y;
	}

	if (mapMaxX === Number.NEGATIVE_INFINITY) {
		return { bakery: null, poultryFarm: null, cheeseMaker: null, flourMill: null, dairyFarm: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	const minY = 2;
	let maxY = minY + 3; // 4 rows
	if (mapMaxY !== Number.NEGATIVE_INFINITY) {
		maxY = Math.min(maxY, Math.floor(mapMaxY));
	}

	const specs = [
		{ type: "Bakery" as Building, count: 15, targetLevel: 15 },
		{ type: "PoultryFarm" as Building, count: 15, targetLevel: 15 },
		{ type: "CheeseMaker" as Building, count: 12, targetLevel: 15 },
		{ type: "FlourMill" as Building, count: 2, targetLevel: 15 },
		{ type: "DairyFarm" as Building, count: 2, targetLevel: 15 },
	];

	const placement = buildBuildingsInRange(minX, maxX, minY, maxY, specs);

	const find = (t: Building) => {
		const r = placement.results.find((x) => x.type === t);
		return r ? { requested: r.requested, placed: r.placed } : null;
	};

	const bakery = find("Bakery" as Building);
	const poultryFarm = find("PoultryFarm" as Building);
	const cheeseMaker = find("CheeseMaker" as Building);
	const flourMill = find("FlourMill" as Building);
	const dairyFarm = find("DairyFarm" as Building);

	ensureVisualRefresh();

	return { bakery, poultryFarm, cheeseMaker, flourMill, dairyFarm };
}




