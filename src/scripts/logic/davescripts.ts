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
import type { Deposit } from "../../../shared/definitions/MaterialDefinitions";
import { findSpecialBuilding, getBuildingThatExtract, isWorldOrNaturalWonder } from "../../../shared/logic/BuildingLogic";
import { Config } from "../../../shared/logic/Config";
import { getGameState, notifyGameStateUpdate } from "../../../shared/logic/GameStateLogic";
import { getGrid } from "../../../shared/logic/IntraTickCache";
import { BuildingInputMode, makeBuilding, STOCKPILE_CAPACITY_MAX, STOCKPILE_MAX_MAX } from "../../../shared/logic/Tile";
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

	let clearedTotal = 0;
	// use sets to avoid double-counting preserved tiles across passes
	const preservedWondersSet = new Set<number>();
	const preservedMinesSet = new Set<number>();

	const MAX_PASSES = 10;

	for (let pass = 0; pass < MAX_PASSES; pass++) {
		let passCleared = 0;

		for (let x = minX; x <= maxX; x++) {
			for (let y = minY; y <= maxY; y++) {
				const xy = pointToTile({ x, y });
				const td = gs.tiles.get(xy);
				if (!td || !td.building) continue;

				const type = td.building.type;

				// Never remove Wonders
				if (isWorldOrNaturalWonder(type)) {
					preservedWondersSet.add(xy);
					continue;
				}

				// Never remove a tile that sits on an important deposit that has a corresponding
				// extractor building defined in the game config, unless that extractor
				// is not actually present on this tile (we only preserve true extractor)
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

				// Safe to delete (either no protected deposit, or the deposit's
				// extractor isn't present here and we want to allow deletion)
				td.building = undefined;
				passCleared++;
			}
		}

		// If nothing was deleted this pass we're done; otherwise update totals
		if (passCleared === 0) break;
		clearedTotal += passCleared;
		clearTransportSourceCache();
		// allow visuals to catch up between passes
		ensureVisualRefresh();
	}

	return { cleared: clearedTotal, preservedWonders: preservedWondersSet.size, preservedMines: preservedMinesSet.size };
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
			// Apply 'highest' stockpile and input/priority settings so construction
			// and resource intake are maximized and the building is ready to accept
			// resources immediately.
			b.stockpileCapacity = STOCKPILE_CAPACITY_MAX;
			b.stockpileMax = STOCKPILE_MAX_MAX;
			b.inputMode = BuildingInputMode.StoragePercentage;
			b.maxInputDistance = Number.POSITIVE_INFINITY;
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
 * 003 - Build Big Ben Materials
 *
 * Place a large set of material/support buildings in the extreme right-hand
 * 10-tile band at row index 14 (clamped to map height). The user-supplied
 * base quantities are multiplied by 4 before placement. All buildings are
 * requested at target level 15 and the function returns the per-type
 * requested/placed counts.
 */
export function buildBigBenMaterials(): {
	results: Array<{ type: Building; requested: number; placed: number }> | null;
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
		return { results: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Row index 14 (clamped to map height). Use a strip starting at y=14 and
	// extend to the bottom of the map (mapMaxY) so materials fill the band as
	// far down as needed.
	const startY = Math.min(Math.floor(mapMaxY), 14);
	const endY = Math.floor(mapMaxY);

	// Base list provided by the user (these will be multiplied by 4)
	const baseSpecs: Array<{ type: Building; count: number }> = [
		{ type: "CottonPlantation" as Building, count: 1 },
		{ type: "CottonMill" as Building, count: 2 },
		{ type: "IronForge" as Building, count: 6 },
		{ type: "Marbleworks" as Building, count: 1 },
		{ type: "PaperMaker" as Building, count: 1 },
		{ type: "Stable" as Building, count: 1 },
		{ type: "Brewery" as Building, count: 1 },
		{ type: "PoetrySchool" as Building, count: 1 },
		{ type: "SwordForge" as Building, count: 1 },
		{ type: "Armory" as Building, count: 1 },
		{ type: "PaintersGuild" as Building, count: 2 },
		{ type: "FurnitureWorkshop" as Building, count: 1 },
		{ type: "Shrine" as Building, count: 4 },
		{ type: "MusiciansGuild" as Building, count: 1 },
		{ type: "KnightCamp" as Building, count: 1 },
		{ type: "University" as Building, count: 2 },
		{ type: "Museum" as Building, count: 2 },
		{ type: "Courthouse" as Building, count: 2 },
		{ type: "Parliament" as Building, count: 4 },
	];

	// Multiply counts by 4 as requested and set targetLevel = 15
	const specs = baseSpecs.map((b) => ({ type: b.type, count: b.count * 4, targetLevel: 15 }));

	// First, attempt to place mines required for materials: 2 x Copper, 2 x Iron.
	// Use buildMines helper which respects deposits and never overwrites existing mines.
	// We do not need to return the exact placed counts here, so discard the return values.
	buildMines("CopperMiningCamp" as Building, 15, 2);
	buildMines("IronMiningCamp" as Building, 15, 2);

	const placement = buildBuildingsInRange(minX, maxX, startY, endY, specs);

	ensureVisualRefresh();

	return { results: placement.results };
}


/**
 * High-level: Build Apartments
 * Calls materials then support routines in sequence and returns a combined summary.
 */
export async function buildApartments(): Promise<{
	materials?: ReturnType<typeof buildApartmentMaterials> | null;
	support?: ReturnType<typeof buildApartmentSupport> | null;
	deploy?: Awaited<ReturnType<typeof deployApartments>> | null;
	message?: string;
}> {
	try {
		const materials = buildApartmentMaterials();
		const support = buildApartmentSupport();
		// After support buildings are placed, deploy apartments in bulk
		const deploy = await deployApartments();
		return { materials, support, deploy };
	} catch (e) {
		return { materials: null, support: null, deploy: null, message: String(e) };
	}
}


/**
 * 004 - Prepare Condo Materials
 *
 * - In the rightmost 10-tile band, starting at row 3 (index 2) place:
 *   1 x Sandpit
 *   4 x SteelMill
 *   4 x RebarPlant
 *   5 x ConcretePlant
 *   5 x ReinforcedConcretePlant
 *   5 x IronForge
 *   (all requested at targetLevel 15)
 *
 * - Then clear everything in that same 10-tile band from row 15 (index 14)
 *   down for a total of 15 rows (rows 14..14+14 clamped to map) using clearRange.
 *
 * - Finally, starting at row 15 (index 14) build:
 *   50 x Pizzeria
 *   5 x FlourMill
 *   5 x CheeseMaker
 *   5 x PoultryFarm
 *   1 x DairyFarm
 *
 * Returns a summary containing placement results for both phases and the
 * number of tiles cleared.
 */
export function prepareCondoMaterials(): {
	topPlacement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	cleared: { cleared: number; preservedWonders: number; preservedMines: number } | null;
	bottomPlacement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
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
		return { topPlacement: null, cleared: null, bottomPlacement: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Phase 1: top materials at row index 2 (row 3)
	const topMinY = 2;
	const topMaxY = Math.min(Math.floor(mapMaxY), topMinY + 3); // cover 4 rows starting at index 2

	const topSpecs = [
		{ type: "Sandpit" as Building, count: 1, targetLevel: 15 },
		{ type: "SteelMill" as Building, count: 4, targetLevel: 15 },
		{ type: "RebarPlant" as Building, count: 4, targetLevel: 15 },
		{ type: "ConcretePlant" as Building, count: 5, targetLevel: 15 },
		{ type: "ReinforcedConcretePlant" as Building, count: 5, targetLevel: 15 },
		{ type: "IronForge" as Building, count: 5, targetLevel: 15 },
	];

	const topPlacement = buildBuildingsInRange(minX, maxX, topMinY, topMaxY, topSpecs);

	// Phase 2: clear lower band starting at row index 14 for 15 rows
	const clearStartY = 14;
	const clearEndY = Math.min(Math.floor(mapMaxY), clearStartY + 14); // total 15 rows
	const cleared = clearRange(minX, maxX, clearStartY, clearEndY);

	// Phase 3: build bottom materials starting at row index 14
	const bottomMinY = clearStartY;
	const bottomMaxY = clearEndY;

	const bottomSpecs = [
		{ type: "Pizzeria" as Building, count: 50, targetLevel: 15 },
		{ type: "FlourMill" as Building, count: 5, targetLevel: 15 },
		{ type: "CheeseMaker" as Building, count: 5, targetLevel: 15 },
		{ type: "PoultryFarm" as Building, count: 5, targetLevel: 15 },
		{ type: "DairyFarm" as Building, count: 1, targetLevel: 15 },
	];

	const bottomPlacement = buildBuildingsInRange(minX, maxX, bottomMinY, bottomMaxY, bottomSpecs);

	ensureVisualRefresh();

	return { topPlacement: { results: topPlacement.results }, cleared, bottomPlacement: { results: bottomPlacement.results } };
}


/**
 * Build apartment support buildings in the same right-hand 10-tile band.
 * Starts at row 7 (index = 6) and covers 4 rows (y = 6..9).
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

	const minY = 6;
	let maxY = minY + 3; // 4 rows
	if (mapMaxY !== Number.NEGATIVE_INFINITY) {
		maxY = Math.min(maxY, Math.floor(mapMaxY));
	}

	const specs = [
		{ type: "Bakery" as Building, count: 15, targetLevel: 15 },
		{ type: "PoultryFarm" as Building, count: 15, targetLevel: 15 },
		{ type: "CheeseMaker" as Building, count: 12, targetLevel: 15 },
		{ type: "FlourMill" as Building, count: 2, targetLevel: 15 },
		{ type: "DairyFarm" as Building, count: 2, targetLevel: 15 }
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


/**
 * Deploy Apartments in bulk.
 *
 * - Builds `total` apartments (750) in the rightmost 20-tile strip starting
 *   at the top of the map (y=0). It places them in chunks of `chunkSize`
 *   (100) using `buildBuildingsInRange` and waits for each chunk to finish
 *   construction before starting the next chunk.
 *
 * Returns a summary with totals and per-chunk placements.
 */
export async function deployApartments(): Promise<{
	requested: number;
	placed: number;
	remaining: number;
	chunks: number[];
	message?: string;
}> {
	const TOTAL = 750;
	const CHUNK = 100;
	const gs = getGameState();

	// Find map bounds (we need minX for the left-hand edge)
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
		return { requested: TOTAL, placed: 0, remaining: TOTAL, chunks: [], message: "No map tiles available" };
	}

	// LEFT-hand 20-tile-wide strip
	const minX = Math.max(0, Math.floor(mapMinX));
	const maxX = Math.min(Math.floor(mapMaxX), minX + 19);
	const minY = 0;
	const maxY = Math.floor(mapMaxY);

	let remaining = TOTAL;
	let totalPlaced = 0;
	const chunks: number[] = [];

	// Helper to count completed apartments in the strip
	const countCompleted = (): number => {
		const s = getGameState();
		let c = 0;
		for (const [xy, td] of s.tiles.entries()) {
			if (!td || !td.building) continue;
			const p = tileToPoint(xy);
			if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
			if (td.building.type === ("Apartment" as Building) && td.building.status === "completed") c++;
		}
		return c;
	};

	// Simple sleep
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	while (remaining > 0) {
		const chunkSize = Math.min(CHUNK, remaining);

		const res = buildBuildingsInRange(minX, maxX, minY, maxY, [
			{ type: "Apartment" as Building, count: chunkSize, targetLevel: 10 },
		]);

		const placed = res.results.length > 0 ? res.results[0].placed : 0;
		chunks.push(placed);
		totalPlaced += placed;
		remaining -= placed;

		if (placed === 0) {
			// nothing could be placed (no empty tiles) — abort to avoid infinite loop
			break;
		}

		// Wait until the newly placed buildings in this chunk are completed.
		const completedBefore = countCompleted();
		const need = placed;
		const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes max per chunk
		const POLL_MS = 1000;
		let waited = 0;
		while (true) {
			await sleep(POLL_MS);
			waited += POLL_MS;
			const completedAfter = countCompleted();
			if (completedAfter - completedBefore >= need) break;
			if (waited >= MAX_WAIT_MS) {
				// give up waiting for this chunk and continue with next (or abort)
				break;
			}
		}
	}

	ensureVisualRefresh();
	return { requested: TOTAL, placed: totalPlaced, remaining, chunks };
}




