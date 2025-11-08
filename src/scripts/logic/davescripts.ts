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

import type { ICloneBuildingData } from "../../../shared/logic/Tile";
import { BuildingInputMode, makeBuilding, STOCKPILE_CAPACITY_MAX, STOCKPILE_MAX_MAX } from "../../../shared/logic/Tile";
import { clearTransportSourceCache } from "../../../shared/logic/Update";
import { pointToTile, tileToPoint } from "../../../shared/utilities/Helper";
import { showToast } from "../ui/GlobalModal";

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
				td.building = undefined; // Clear the building
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

	// Ensure visuals are refreshed after all plans have run
	try {
		ensureVisualRefresh();
	} catch (e) {
		console.error("ensureVisualRefresh failed in buildInitialMines:", e);
	}
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

	// Immediate refresh after placement so UI shows newly placed buildings
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

	// Place coal mines needed for bottom materials — use the helper so we only
	// place mines on valid deposit tiles and never overwrite existing mines.
	const coalPlaced = buildMines("CoalMine" as Building, 15, 2);

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

	// Ensure a CoalPowerPlant exists in the left-hand strip so CloneLabs
	// will be able to be powered. We will not overwrite existing buildings
	// or wonders — only place on the first empty tile scanning top->bottom,
	// left->right. If a CoalPowerPlant already exists in the strip, do nothing.
	let coalExists = false;
	for (const [xy, td] of gs.tiles.entries()) {
		if (!td || !td.building) continue;
		const p = tileToPoint(xy);
		if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
		if (td.building.type === ("CoalPowerPlant" as Building)) { coalExists = true; break; }
	}
	if (!coalExists) {
		let placedCoal = false;
		for (let y = minY; y <= maxY && !placedCoal; y++) {
			for (let x = minX; x <= maxX && !placedCoal; x++) {
				const xy = pointToTile({ x, y });
				const td = gs.tiles.get(xy);
				if (!td) continue;
				// Only place on empty tiles; do not overwrite wonders/mines/other buildings
				if (!td.building) {
					const b = makeBuilding({ type: "CoalPowerPlant" as Building, level: 0, desiredLevel: 15 });
					td.building = b;
					placedCoal = true;
				}
			}
		}
		if (placedCoal) {
			clearTransportSourceCache();
			ensureVisualRefresh();
		}
	}

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


/**
 * Replace all Apartments with Condos.
 *
 * - Deletes every `Apartment` building found on the map (count returned).
 * - Clears visuals and transport caches.
 * - Builds `total` Condos in the top-left 20-tile-wide strip starting at y=0
 *   in chunks of `chunkSize` (100) using `buildBuildingsInRange`.
 * - Condos are created at level 0 with desiredLevel=10; buildBuildingsInRange
 *   already sets stockpile/input to maximum for new buildings.
 *
 * Returns a summary similar to `deployApartments` plus `removedApartments`.
 */
export async function replaceApartmentsWithCondos(): Promise<{
	requested: number;
	placed: number;
	remaining: number;
	chunks: number[];
	removedApartments: number;
	message?: string;
}> {
	const TOTAL = 750; // same total as apartments
	const CHUNK = 100;
	const gs = getGameState();

	// Delete all Apartment buildings from the map
	let removed = 0;
	for (const [xy, td] of gs.tiles.entries()) {
		if (!td || !td.building) continue;
		if (td.building.type === ("Apartment" as Building)) {
			td.building = undefined;
			removed++;
		}
	}
	if (removed > 0) clearTransportSourceCache();
	ensureVisualRefresh();

	// Find map bounds (we need minX for the left-hand/top-left edge)
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
		return { requested: TOTAL, placed: 0, remaining: TOTAL, chunks: [], removedApartments: removed, message: "No map tiles available" };
	}

	// TOP-LEFT 20-tile-wide strip
	const minX = Math.max(0, Math.floor(mapMinX));
	const maxX = Math.min(Math.floor(mapMaxX), minX + 19);
	const minY = 0;
	const maxY = Math.floor(mapMaxY);

	let remaining = TOTAL;
	let totalPlaced = 0;
	const chunks: number[] = [];

	const countCompleted = (): number => {
		const s = getGameState();
		let c = 0;
		for (const [xy, td] of s.tiles.entries()) {
			if (!td || !td.building) continue;
			const p = tileToPoint(xy);
			if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
			if (td.building.type === ("Condo" as Building) && td.building.status === "completed") c++;
		}
		return c;
	};

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	while (remaining > 0) {
		const chunkSize = Math.min(CHUNK, remaining);

		const res = buildBuildingsInRange(minX, maxX, minY, maxY, [
			{ type: "Condo" as Building, count: chunkSize, targetLevel: 10 },
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
	return { requested: TOTAL, placed: totalPlaced, remaining, chunks, removedApartments: removed };
}


/**
 * 006 - Prepare CN Tower Material
 *
 * Steps:
 * - Use the rightmost 10-tile band as the target strip.
 * - Clear rows 7..10 (indexes 6..9) in that strip using clearRange.
 * - From the provided CN tower building list, split into non-electrified and electrified
 *   groups using `canBeElectrified`.
 * - Place non-electrified buildings into rows 7..13 (indexes 6..12) using buildBuildingsInRange.
 * - Place electrified buildings starting at row 25 (index 24) downwards; ensure a CoalPowerPlant
 *   is placed at the start of the electrified block to provide power.
 */
export function prepareCnTowerMaterials(): {
	nonElectPlacement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	cleared: { cleared: number; preservedWonders: number; preservedMines: number } | null;
	electPlacement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	message?: string;
} {
	const gs = getGameState();

	// CN Tower building list (name -> count). The fourth arg in the user's list is the quantity.
	const cnList: Array<{ type: Building; count: number }> = [
		{ type: "Glassworks" as Building, count: 1 },
		{ type: "GarmentWorkshop" as Building, count: 1 },
		{ type: "LensWorkshop" as Building, count: 1 },
		{ type: "PrintingHouse" as Building, count: 1 },
		{ type: "ActorsGuild" as Building, count: 1 },
		{ type: "PublishingHouse" as Building, count: 4 },
		{ type: "Stadium" as Building, count: 2 },
		{ type: "MovieStudio" as Building, count: 5 },
		{ type: "CoalPowerPlant" as Building, count: 1 },
		{ type: "MagazinePublisher" as Building, count: 4 },
		{ type: "Embassy" as Building, count: 4 },
		{ type: "RadioStation" as Building, count: 8 },
		{ type: "MusiciansGuild" as Building, count: 2 },
		{ type: "PoetrySchool" as Building, count: 2 },
		{ type: "Brewery" as Building, count: 1 },
		{ type: "PaperMaker" as Building, count: 1 },
		{ type: "Sandpit" as Building, count: 1 },
		{ type: "University" as Building, count: 4 },
		{ type: "ActorsGuild" as Building, count: 1 },
		{ type: "CottonMill" as Building, count: 1 },
		{ type: "CoalPowerPlant" as Building, count: 1 },
		{ type: "PaintersGuild" as Building, count: 1 },
		{ type: "Museum" as Building, count: 3 },
		{ type: "Courthouse" as Building, count: 3 },
		{ type: "Mosque" as Building, count: 1 },
		{ type: "Parliament" as Building, count: 3 },
		{ type: "CottonPlantation" as Building, count: 1 },
		{ type: "PrintingHouse" as Building, count: 3 },
	];

	// Determine map bounds
	let mapMaxX = Number.NEGATIVE_INFINITY;
	let mapMaxY = Number.NEGATIVE_INFINITY;
	for (const xy of gs.tiles.keys()) {
		const p = tileToPoint(xy);
		if (p.x > mapMaxX) mapMaxX = p.x;
		if (p.y > mapMaxY) mapMaxY = p.y;
	}

	if (mapMaxX === Number.NEGATIVE_INFINITY) {
		return { nonElectPlacement: null, cleared: null, electPlacement: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Clear rows 7..10 -> indexes 6..9
	const clearMinY = 6;
	const clearMaxY = 9;
	const cleared = clearRange(minX, maxX, clearMinY, clearMaxY);

	// Split cnList into electrified vs non-electrified using the building
	// definition `power` flag: a building with `Config.Building[<type>].power === true`
	// is considered to REQUIRE electricity. This makes classification
	// deterministic and matches the user's "require electrification" intent.
	const nonElectSpecs: Array<{ type: Building; count: number; targetLevel?: number }> = [];
	const electSpecs: Array<{ type: Building; count: number; targetLevel?: number }> = [];
	for (const item of cnList) {
		try {
			const def = Config.Building[item.type];
			const requiresPower = !!(def && def.power === true);
			if (requiresPower) {
				electSpecs.push({ type: item.type, count: item.count, targetLevel: 15 });
			} else {
				nonElectSpecs.push({ type: item.type, count: item.count, targetLevel: 15 });
			}
		} catch (e) {
			// Conservative fallback: treat as non-electrified
			nonElectSpecs.push({ type: item.type, count: item.count, targetLevel: 15 });
		}
	}

	// Place non-electrified in rows 7..13 (indexes 6..12)
	const nonMinY = 6;
	const nonMaxY = Math.min(Math.floor(mapMaxY), 12);
	const nonElectPlacement = buildBuildingsInRange(minX, maxX, nonMinY, nonMaxY, nonElectSpecs);

	// Ensure a coal power plant exists at start of electrified block and then place electrified buildings
	const electStartY = 24; // index 24 == row 25
	const electEndY = Math.floor(mapMaxY);

	// Remove any CoalPowerPlant entries from electSpecs to avoid duplicate and then add one at start
	const filteredElectSpecs = electSpecs.filter((s) => s.type !== ("CoalPowerPlant" as Building));
	const electWithCoal = [{ type: "CoalPowerPlant" as Building, count: 1, targetLevel: 15 }, ...filteredElectSpecs];

	const electPlacement = buildBuildingsInRange(minX, maxX, electStartY, electEndY, electWithCoal);

	ensureVisualRefresh();
	return { nonElectPlacement: { results: nonElectPlacement.results }, cleared, electPlacement: { results: electPlacement.results } };
}


	/**
	 * 007 - Prepare Atomium and Oxford University materials
	 *
	 * - Clear rows 7..13 (indexes 6..12) and rows 25..30 (indexes 24..29)
	 *   in the rightmost 10-tile band.
	 * - From the provided building list, split into those that REQUIRE power
	 *   (Config.Building[...].power === true) and those that do not.
	 * - Place non-powered buildings into rows 7..13 (indexes 6..12).
	 * - Place powered buildings starting at row 25 (index 24) and ensure a
	 *   CoalPowerPlant exists at the start of the powered block.
	 */
	export function prepareAtomiumAndOxUni(): {
		nonElectPlacement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
		clearedTop: { cleared: number; preservedWonders: number; preservedMines: number } | null;
		clearedBottom: { cleared: number; preservedWonders: number; preservedMines: number } | null;
		electPlacement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
		message?: string;
	} {
		const gs = getGameState();

		// Building plan (type -> count)
		const plan: Array<{ type: Building; count: number }> = [
			{ type: "GunpowderMill" as Building, count: 2 },
			{ type: "PoetrySchool" as Building, count: 3 },
			{ type: "PaperMaker" as Building, count: 1 },
			{ type: "Brewery" as Building, count: 1 },
			{ type: "Stable" as Building, count: 1 },
			{ type: "UraniumEnrichmentPlant" as Building, count: 20 },
			{ type: "DynamiteWorkshop" as Building, count: 3 },
			{ type: "RifleFactory" as Building, count: 3 },
			{ type: "Shrine" as Building, count: 2 },
			{ type: "AtomicFacility" as Building, count: 6 },
			{ type: "GatlingGunFactory" as Building, count: 3 },
			{ type: "University" as Building, count: 3 },
			{ type: "ArtilleryFactory" as Building, count: 10 },
		];

		// Determine map bounds
		let mapMaxX = Number.NEGATIVE_INFINITY;
		let mapMaxY = Number.NEGATIVE_INFINITY;
		for (const xy of gs.tiles.keys()) {
			const p = tileToPoint(xy);
			if (p.x > mapMaxX) mapMaxX = p.x;
			if (p.y > mapMaxY) mapMaxY = p.y;
		}

		if (mapMaxX === Number.NEGATIVE_INFINITY) {
			return { nonElectPlacement: null, clearedTop: null, clearedBottom: null, electPlacement: null, message: "No map tiles available" };
		}

		const maxX = Math.floor(mapMaxX);
		const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

		// Clear top band rows 7..13 -> indexes 6..12
		const topMinY = 6;
		const topMaxY = Math.min(Math.floor(mapMaxY), 12);
		const clearedTop = clearRange(minX, maxX, topMinY, topMaxY);

		// Clear bottom band rows 25..30 -> indexes 24..29
		const bottomMinY = 24;
		const bottomMaxY = Math.min(Math.floor(mapMaxY), 29);
		const clearedBottom = clearRange(minX, maxX, bottomMinY, bottomMaxY);

	// After clearing, ensure uranium and aluminium supply by placing
	// mines using the buildMines helper which respects deposits and
	// never overwrites existing mines.
	// Place 6 Uranium mines and 3 Aluminum extractors.
	buildMines("UraniumMine" as Building, 15, 6);
	buildMines("AluminumSmelter" as Building, 15, 3);

		// Split plan by Config.Building[...].power === true
		const nonElectSpecs: Array<{ type: Building; count: number; targetLevel?: number }> = [];
		const electSpecs: Array<{ type: Building; count: number; targetLevel?: number }> = [];
		for (const item of plan) {
			try {
				const def = Config.Building[item.type];
				const requiresPower = !!(def && def.power === true);
				if (requiresPower) electSpecs.push({ type: item.type, count: item.count, targetLevel: 15 });
				else nonElectSpecs.push({ type: item.type, count: item.count, targetLevel: 15 });
			} catch (e) {
				// Conservative fallback
				nonElectSpecs.push({ type: item.type, count: item.count, targetLevel: 15 });
			}
		}

		// Place non-powered in rows 7..13
		const nonPlacement = buildBuildingsInRange(minX, maxX, topMinY, topMaxY, nonElectSpecs);

		// Ensure a CoalPowerPlant at start of electrified block and then place powered buildings
		const electStartY = 24;
		const electEndY = Math.floor(mapMaxY);
		const filteredElect = electSpecs.filter((s) => s.type !== ("CoalPowerPlant" as Building));
		const electWithCoal = [{ type: "CoalPowerPlant" as Building, count: 1, targetLevel: 15 }, ...filteredElect];
		const electPlacement = buildBuildingsInRange(minX, maxX, electStartY, electEndY, electWithCoal);

		ensureVisualRefresh();
		return { nonElectPlacement: { results: nonPlacement.results }, clearedTop, clearedBottom, electPlacement: { results: electPlacement.results } };
	}


/**
 * 008 - Prepare Clone Labs
 *
 * - Clear rows 7..13 (indexes 6..12) and rows 25..30 (indexes 24..29)
 *   in the rightmost 10-tile band.
 * - From the provided building list, split into those that REQUIRE power
 *   (Config.Building[...].power === true) and those that do not.
 * - Place non-powered buildings into rows 7..13 (indexes 6..12).
 * - Place powered buildings starting at row 25 (index 24) and ensure a
 *   CoalPowerPlant exists at the start of the powered block.
 */
export function prepareCloneLabs(): {
	nonElectPlacement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	clearedTop: { cleared: number; preservedWonders: number; preservedMines: number } | null;
	clearedBottom: { cleared: number; preservedWonders: number; preservedMines: number } | null;
	electPlacement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	message?: string;
} {
	const gs = getGameState();

	// Building plan (type -> count) derived from user spec
	const plan: Array<{ type: Building; count: number }> = [
		{ type: "CableFactory" as Building, count: 4 },
		{ type: "Glassworks" as Building, count: 2 },
		{ type: "GunpowderMill" as Building, count: 6 },
		{ type: "OilRefinery" as Building, count: 4 },
		{ type: "PlasticsFactory" as Building, count: 2 },
		{ type: "SteelMill" as Building, count: 4 },
		{ type: "IronForge" as Building, count: 4 },
		{ type: "DynamiteWorkshop" as Building, count: 6 },
		{ type: "Steamworks" as Building, count: 4 },
		{ type: "LensWorkshop" as Building, count: 2 },
		{ type: "RifleFactory" as Building, count: 4 },
		{ type: "BiplaneFactory" as Building, count: 2 },
		{ type: "GatlingGunFactory" as Building, count: 5 },
		{ type: "ArtilleryFactory" as Building, count: 4 },
		{ type: "Sandpit" as Building, count: 1 },
		{ type: "CoalPowerPlant" as Building, count: 1 },
		{ type: "SiliconSmelter" as Building, count: 1 },
		{ type: "SemiconductorFab" as Building, count: 2 },
		{ type: "ComputerFactory" as Building, count: 6 },
		{ type: "RocketFactory" as Building, count: 7 },
		{ type: "AirplaneFactory" as Building, count: 2 },
		{ type: "RocketFactory" as Building, count: 2 },
		{ type: "SatelliteFactory" as Building, count: 2 },
		{ type: "SpacecraftFactory" as Building, count: 8 },
	];

	// Determine map bounds
	let mapMaxX = Number.NEGATIVE_INFINITY;
	let mapMaxY = Number.NEGATIVE_INFINITY;
	for (const xy of gs.tiles.keys()) {
		const p = tileToPoint(xy);
		if (p.x > mapMaxX) mapMaxX = p.x;
		if (p.y > mapMaxY) mapMaxY = p.y;
	}

	if (mapMaxX === Number.NEGATIVE_INFINITY) {
		return { nonElectPlacement: null, clearedTop: null, clearedBottom: null, electPlacement: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Clear top band rows 7..13 -> indexes 6..12
	const topMinY = 6;
	const topMaxY = Math.min(Math.floor(mapMaxY), 12);
	const clearedTop = clearRange(minX, maxX, topMinY, topMaxY);

		// Clear bottom band rows 25..30 -> indexes 24..29
		const bottomMinY = 24;
		const bottomMaxY = Math.min(Math.floor(mapMaxY), 29);
		const clearedBottom = clearRange(minX, maxX, bottomMinY, bottomMaxY);

		// After clearing, ensure oil supply by placing oil wells using buildMines helper
		// buildMines respects deposits and never overwrites existing mines.
		// Place 3 OilWell mines.
		buildMines("OilWell" as Building, 15, 3);

	// Split plan by Config.Building[...].power === true
	const nonElectSpecs: Array<{ type: Building; count: number; targetLevel?: number }> = [];
	const electSpecs: Array<{ type: Building; count: number; targetLevel?: number }> = [];
	for (const item of plan) {
		try {
			const def = Config.Building[item.type];
			const requiresPower = !!(def && def.power === true);
			if (requiresPower) electSpecs.push({ type: item.type, count: item.count, targetLevel: 15 });
			else nonElectSpecs.push({ type: item.type, count: item.count, targetLevel: 15 });
		} catch (e) {
			// Conservative fallback
			nonElectSpecs.push({ type: item.type, count: item.count, targetLevel: 15 });
		}
	}

	// Place non-powered in rows 7..13
	const nonPlacement = buildBuildingsInRange(minX, maxX, topMinY, topMaxY, nonElectSpecs);

	// Ensure a CoalPowerPlant at start of electrified block and then place powered buildings
	const electStartY = 24;
	const electEndY = Math.floor(mapMaxY);
	const filteredElect = electSpecs.filter((s) => s.type !== ("CoalPowerPlant" as Building));
	const electWithCoal = [{ type: "CoalPowerPlant" as Building, count: 1, targetLevel: 15 }, ...filteredElect];
	const electPlacement = buildBuildingsInRange(minX, maxX, electStartY, electEndY, electWithCoal);

	ensureVisualRefresh();
	return { nonElectPlacement: { results: nonPlacement.results }, clearedTop, clearedBottom, electPlacement: { results: electPlacement.results } };
}


/**
 * Build Clone Labs
 *
 * - Delete Condo buildings but leave 20 Condos in place (do not create new Condos).
 * - Build 860 CloneLab buildings in the left-hand 20-tile-wide strip starting at y=0.
 * - Build in batches of 100 (chunks) and wait for each chunk to complete like
 *   deployApartments/replaceApartmentsWithCondos.
 * - After placing CloneLab buildings, set their cloning input resource to
 *   "Spacecraft" (the default is "Computer").
 */
export async function buildCloneLabs(): Promise<{
	requested: number;
	placed: number;
	remaining: number;
	chunks: number[];
	removedCondos: number;
	message?: string;
}> {
	const TOTAL = 860;
	const CHUNK = 100;
	const gs = getGameState();

	// Remove Condo buildings but ensure the 20 that remain are from the
	// top row (y === 0) when possible. Behavior:
	//  - Prefer to keep up to 20 Condos on the top row (left-to-right).
	//  - If there are fewer than 20 on the top row, keep those and then
	//    preserve additional Condos (top-to-bottom, left-to-right) until
	//    a total of 20 remain.
	const allCondos: number[] = [];
	const topRowCondos: Array<{ xy: number; x: number; y: number }> = [];
	for (const [xy, td] of gs.tiles.entries()) {
		if (!td || !td.building) continue;
		if (td.building.type === ("Condo" as Building)) {
			const p = tileToPoint(xy);
			allCondos.push(xy);
			if (p.y === 0) topRowCondos.push({ xy, x: p.x, y: p.y });
		}
	}

	// sort top-row condos left-to-right
	topRowCondos.sort((a, b) => a.x - b.x);

	const keepSet = new Set<number>();
	// keep up to 20 from the top row
	for (let i = 0; i < Math.min(20, topRowCondos.length); i++) keepSet.add(topRowCondos[i].xy);

	// if we still need more to reach 20, pick from the remaining condos
	if (keepSet.size < 20) {
		// build a list of remaining condos with coordinates, sorted top-to-bottom then left-to-right
		const remaining: Array<{ xy: number; x: number; y: number }> = [];
		for (const xy of allCondos) {
			if (keepSet.has(xy)) continue;
			const p = tileToPoint(xy);
			remaining.push({ xy, x: p.x, y: p.y });
		}
		remaining.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));
		for (let i = 0; i < remaining.length && keepSet.size < 20; i++) keepSet.add(remaining[i].xy);
	}

	let removed = 0;
	for (const xy of allCondos) {
		if (keepSet.has(xy)) continue;
		const td = gs.tiles.get(xy);
		if (!td || !td.building) continue;
		td.building = undefined;
		removed++;
	}
	if (removed > 0) clearTransportSourceCache();
	ensureVisualRefresh();

	// Determine map bounds (need minX for left-hand edge and maxY for height)
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
		return { requested: TOTAL, placed: 0, remaining: TOTAL, chunks: [], removedCondos: removed, message: "No map tiles available" };
	}

	// LEFT-hand 20-tile-wide strip
	const minX = Math.max(0, Math.floor(mapMinX));
	const maxX = Math.min(Math.floor(mapMaxX), minX + 19);
	const minY = 0;
	const maxY = Math.floor(mapMaxY);

	let remaining = TOTAL;
	let totalPlaced = 0;
	const chunks: number[] = [];

	const countCompleted = (): number => {
		const s = getGameState();
		let c = 0;
		for (const [xy, td] of s.tiles.entries()) {
			if (!td || !td.building) continue;
			const p = tileToPoint(xy);
			if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
			if (td.building.type === ("CloneLab" as Building) && td.building.status === "completed") c++;
		}
		return c;
	};

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	while (remaining > 0) {
		const chunkSize = Math.min(CHUNK, remaining);

		const res = buildBuildingsInRange(minX, maxX, minY, maxY, [
			{ type: "CloneLab" as Building, count: chunkSize, targetLevel: 10 },
		]);

		const placed = res.results.length > 0 ? res.results[0].placed : 0;
		chunks.push(placed);
		totalPlaced += placed;
		remaining -= placed;

		if (placed > 0) {
			// Immediately set CloneLab inputResource to "Spacecraft" for any newly
			// placed CloneLabs inside the strip so they default to cloning
			// Spacecraft instead of Computer.
			for (const [xy, td] of getGameState().tiles.entries()) {
				if (!td || !td.building) continue;
				const p = tileToPoint(xy);
				if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
				if (td.building.type === ("CloneLab" as Building)) {
					// ICloneBuildingData has inputResource and transportedAmount
					(td.building as ICloneBuildingData).inputResource = "Spacecraft";
					if ((td.building as ICloneBuildingData).transportedAmount === undefined) (td.building as ICloneBuildingData).transportedAmount = 0;
				}
			}
			clearTransportSourceCache();
			ensureVisualRefresh();
		}

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
	return { requested: TOTAL, placed: totalPlaced, remaining, chunks, removedCondos: removed };
}


/**
 * Build Dyson Materials (simplified)
 *
 * - Delete ALL CloneLab buildings
 * - Clear the rightmost building strip from row 7 to row 30 (indexes 6..29)
 * - In row 7 (index 6) place small set: Pizzeria, PoultryFarm, FlourMill, DairyFarm
 * - Return placement results; other plans will be added separately.
 */
export async function dysonBuildPlan1(): Promise<{
	removedCloneLabs: number;
	cleared: { cleared: number; preservedWonders: number; preservedMines: number } | null;
	smallRowPlacement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	nonElectPlacement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	electPlacement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	leftStripPlacement: Array<{ type: Building; requested: number; placed: number; remaining: number }>;
	message?: string;
}> {
	const gs = getGameState();

	// Remove ALL CloneLabs
	let removed = 0;
	for (const [xy, td] of gs.tiles.entries()) {
		if (!td || !td.building) continue;
		if (td.building.type === ("CloneLab" as Building)) {
			td.building = undefined;
			removed++;
		}
	}
	if (removed > 0) clearTransportSourceCache();
	ensureVisualRefresh();

	// Determine rightmost strip bounds
	let mapMaxX = Number.NEGATIVE_INFINITY;
	let mapMaxY = Number.NEGATIVE_INFINITY;
	for (const xy of gs.tiles.keys()) {
		const p = tileToPoint(xy);
		if (p.x > mapMaxX) mapMaxX = p.x;
		if (p.y > mapMaxY) mapMaxY = p.y;
	}
	if (mapMaxX === Number.NEGATIVE_INFINITY) {
		return { removedCloneLabs: removed, cleared: null, smallRowPlacement: null, nonElectPlacement: null, electPlacement: null, leftStripPlacement: [], message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Clear rows 7..40 -> indexes 6..39 (extended by 10 rows)
	const clearMinY = 6;
	const clearMaxY = Math.min(Math.floor(mapMaxY), 39);
	const cleared = clearRange(minX, maxX, clearMinY, clearMaxY);

	// In row 7 (index 6) place small set
	const smallSpecs = [
		{ type: "Pizzeria" as Building, count: 1, targetLevel: 15 },
		{ type: "PoultryFarm" as Building, count: 1, targetLevel: 15 },
		{ type: "FlourMill" as Building, count: 1, targetLevel: 15 },
		{ type: "CheeseMaker" as Building, count: 1, targetLevel: 15 },
		{ type: "DairyFarm" as Building, count: 1, targetLevel: 15 },
	];
	const smallRowPlacement = buildBuildingsInRange(minX, maxX, 6, 6, smallSpecs);

	// Immediate refresh after placement so UI shows newly placed buildings
	// then a short tick and another refresh as a sanity-check so the
	// 'building' state is visible immediately in the UI.
	try {
		ensureVisualRefresh();
		await new Promise((r) => setTimeout(r, 50));
		ensureVisualRefresh();
	} catch (e) {
		console.error("Immediate refresh failed in dysonBuildPlan1:", e);
	}

	// Wait until the small row placements complete (or timeout)
	const smallTypes = new Set(smallSpecs.map((s) => s.type));
	const smallPlacedTotal = smallRowPlacement.results.reduce((acc, r) => acc + (r.placed ?? 0), 0);
	if (smallPlacedTotal > 0) {
		const countCompletedSmall = (): number => {
			const s = getGameState();
			let c = 0;
			for (const [xy, td] of s.tiles.entries()) {
				if (!td || !td.building) continue;
				if (td.building.status !== "completed") continue;
				if (smallTypes.has(td.building.type)) c++;
			}
			return c;
		};
		const MAX_WAIT_MS = 5 * 60 * 1000;
		const POLL_MS = 1000;
		let waited = 0;
		const beforeSmall = countCompletedSmall();
		while (true) {
			await new Promise((r) => setTimeout(r, POLL_MS));
			waited += POLL_MS;
			const after = countCompletedSmall();
			if (after - beforeSmall >= smallPlacedTotal) break;
			if (waited >= MAX_WAIT_MS) break;
		}
	}

	ensureVisualRefresh();
	// Present a compact toast summary for the user
	try {
		const smallSummary = smallRowPlacement.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
		showToast(`Dyson Plan 1 complete: removedCloneLabs ${removed}; cleared ${cleared?.cleared ?? 0}; smallRow: ${smallSummary}`);
	} catch (e) {
		// swallowing toast errors to avoid breaking game logic
		console.error("showToast failed in dysonBuildPlan1:", e);
	}
	return {
		removedCloneLabs: removed,
		cleared,
		smallRowPlacement: { results: smallRowPlacement.results },
		nonElectPlacement: null,
		electPlacement: null,
		leftStripPlacement: [],
	};
}

/**
 * dysonBuildPlan2
 *
 * - Place the provided postPizzeriaPlan into the rightmost 10-tile band
 *   starting at row 9 (index 8) and spanning 12 rows (indexes 8..19 or
 *   clamped to map height).
 */
export async function dysonBuildPlan2(): Promise<{
	placement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	message?: string;
}> {
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
		return { placement: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Row 9 -> index 8, take 12 rows -> indexes 8..19
	const startY = 8;
	const endY = Math.min(Math.floor(mapMaxY), startY + 11);

	const postPizzeriaPlan: Array<{ type: Building; count: number }> = [
		{ type: ("Sandpit" as Building), count: 1 },
		{ type: ("Brewery" as Building), count: 1 },
		{ type: ("CableFactory" as Building), count: 3 },
		{ type: ("DairyFarm" as Building), count: 1 },
		{ type: ("FlourMill" as Building), count: 1 },
		{ type: ("Glassworks" as Building), count: 2 },
		{ type: ("GunpowderMill" as Building), count: 1 },
		{ type: ("IronForge" as Building), count: 1 },
		{ type: ("OilRefinery" as Building), count: 8 },
		{ type: ("PaperMaker" as Building), count: 1 },
		{ type: ("PlasticsFactory" as Building), count: 3 },
		{ type: ("PoetrySchool" as Building), count: 1 },
		{ type: ("PoultryFarm" as Building), count: 1 },
		{ type: ("Stable" as Building), count: 1 },
		{ type: ("SteelMill" as Building), count: 3 },
		{ type: ("DynamiteWorkshop" as Building), count: 3 },
		{ type: ("FurnitureWorkshop" as Building), count: 1 },
		{ type: ("LensWorkshop" as Building), count: 1 },
		{ type: ("MusiciansGuild" as Building), count: 1 },
		{ type: ("RifleFactory" as Building), count: 1 },
		{ type: ("Shrine" as Building), count: 1 },
		{ type: ("Steamworks" as Building), count: 1 },
		{ type: ("PaintersGuild" as Building), count: 1 },
		{ type: ("ActorsGuild" as Building), count: 5 },
		{ type: ("BiplaneFactory" as Building), count: 1 },
		{ type: ("GatlingGunFactory" as Building), count: 2 },
		{ type: ("LocomotiveFactory" as Building), count: 8 },
		{ type: ("Museum" as Building), count: 3 },
		{ type: ("Pizzeria" as Building), count: 1 },
		{ type: ("University" as Building), count: 4 },
		{ type: ("Parliament" as Building), count: 3 },
		{ type: ("PrintingHouse" as Building), count: 7 },
		{ type: ("ArtilleryFactory" as Building), count: 2 },
		{ type: ("Courthouse" as Building), count: 3 },
		{ type: ("PublishingHouse" as Building), count: 5 },
		{ type: ("Stadium" as Building), count: 5 },
		{ type: ("MagazinePublisher" as Building), count: 8 },
		{ type: ("Embassy" as Building), count: 4 },
	];

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	// Aggregate requested counts and track placed counts
	const summaryMap = new Map<string, { type: Building; requested: number; placed: number }>();
	for (const p of postPizzeriaPlan) summaryMap.set(p.type, { type: p.type, requested: p.count, placed: 0 });

	// Filter out any unknown building types to avoid runtime errors when
	// other code attempts to read building definitions (e.g. Config.Building[...].special).
	const validPlan = postPizzeriaPlan.filter((p) => {
		try {
			return !!Config.Building[p.type];
		} catch (e) {
			return false;
		}
	});

	// Place one building at a time with a 200ms gap between placements.
	for (const spec of validPlan) {
		for (let i = 0; i < spec.count; i++) {
			let res: { results: Array<{ type: Building; requested: number; placed: number }>; skippedWonders: number; skippedMines: number } | undefined;
			try {
				res = buildBuildingsInRange(minX, maxX, startY, endY, [
					{ type: spec.type, count: 1, targetLevel: 10 },
				]);
			} catch (e) {
				console.error("dysonBuildPlan2: placement failed for", spec.type, e);
				break; // stop trying this type
			}
			const placed = res.results.length > 0 ? res.results[0].placed : 0;
			const entry = summaryMap.get(spec.type);
			if (entry) entry.placed += placed;
			// If nothing could be placed, abort remaining placements for this type
			if (placed === 0) break;
			// Wait 200ms between placements so the UI has time to show incremental progress
			await sleep(200);
		}
	}

	const results = Array.from(summaryMap.values());
	return { placement: { results } };
}


	/**
	 * Alderson Disc 4
	 *
	 * - Delete ALL CivGPT, Peacekeeper and SpaceCenter buildings on the map.
	 * - Clear transport caches and force visual refresh to remove artefacts.
	 * - In the LEFT-most 20-tile-wide strip (starting at the map's left edge),
	 *   starting at row 0, build:
	 *     270 x CivOasis, 270 x RobocarFactory, 270 x BitcoinFactory
	 *   Each building is created at level 0 with desiredLevel=10 and placed
	 *   one-by-one with a 200ms wait between placements so the player can
	 *   observe incremental progress.
	 */
	export async function aldersonDisc4(): Promise<{
		removed: number;
		leftStripPlacement: Array<{ type: Building; requested: number; placed: number; remaining: number }>;
		message?: string;
	}> {
		const gs = getGameState();

		// Delete all CivGPT, Peacekeeper, SpaceCenter
		const toRemove = new Set<string>(["CivGPT", "Peacekeeper", "SpaceCenter"]);
		let removed = 0;
		for (const [xy, td] of gs.tiles.entries()) {
			if (!td || !td.building) continue;
			try {
				if (toRemove.has(td.building.type as string)) {
					td.building = undefined;
					removed++;
				}
			} catch (e) {
				// ignore malformed entries
			}
		}
		if (removed > 0) {
			try { clearTransportSourceCache(); } catch (e) { /* swallow */ }
			try { ensureVisualRefresh(); } catch (e) { /* swallow */ }
		}

		// Determine left-hand 20-tile strip bounds
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
			return { removed, leftStripPlacement: [], message: "No map tiles available" };
		}

		const minX = Math.max(0, Math.floor(mapMinX));
		const maxX = Math.min(Math.floor(mapMaxX), minX + 19);
		const minY = 0;
		const maxY = Math.floor(mapMaxY);

		const plan: Array<{ type: Building; total: number }> = [
			{ type: "CivOasis" as Building, total: 270 },
			{ type: "RobocarFactory" as Building, total: 270 },
			{ type: "BitcoinMiner" as Building, total: 270 },
		];

		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

		const results: Array<{ type: Building; requested: number; placed: number; remaining: number }> = [];

		for (const item of plan) {
			const summaryEntry = { type: item.type, requested: item.total, placed: 0, remaining: item.total };

			// Defensive check: ensure building type exists
			try {
				if (!Config.Building[item.type]) {
					console.warn("aldersonDisc4: unknown building type, skipping:", item.type);
					results.push(summaryEntry);
					continue;
				}
			} catch (e) {
				console.warn("aldersonDisc4: Config check failed for", item.type, e);
				results.push(summaryEntry);
				continue;
			}

			for (let i = 0; i < item.total; i++) {
				let res: { results: Array<{ type: Building; requested: number; placed: number }>; skippedWonders: number; skippedMines: number } | undefined;
				try {
					res = buildBuildingsInRange(minX, maxX, minY, maxY, [ { type: item.type, count: 1, targetLevel: 10 } ]);
				} catch (e) {
					console.error("aldersonDisc4: placement failed for", item.type, e);
					break;
				}

				const placed = res && res.results.length > 0 ? res.results[0].placed : 0;
				summaryEntry.placed += placed;
				summaryEntry.remaining -= placed;
				if (placed === 0) break; // no space left
				// small delay so UI shows incremental progress
				await sleep(200);
			}

			results.push(summaryEntry);
		}

		try { ensureVisualRefresh(); } catch (e) { console.error("ensureVisualRefresh failed in aldersonDisc4:", e); }
		try {
			const summary = results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
			showToast(`Alderson Disc 4 complete: removed ${removed}; ${summary}`);
		} catch (e) {
			console.error("showToast failed in aldersonDisc4:", e);
		}

		return { removed, leftStripPlacement: results };
	}

	/**
	 * Large Hadron Collider - Part 1
	 *
	 * - Delete ALL CivOasis, RobocarFactory and BitcoinMiner across the map.
	 * - Clear the right-hand 10-tile-wide strip rows 9..39 (indexes 8..38),
	 *   preserving wonders and protected mines via clearRange.
	 */
	export async function largeHadronCollider1(): Promise<{
		removed: number;
		cleared: { cleared: number; preservedWonders: number; preservedMines: number } | null;
		message?: string;
	}> {
		const gs = getGameState();

		// Delete all CivOasis, RobocarFactory, BitcoinMiner across the map
		const toRemove = new Set<string>(["CivOasis", "RobocarFactory", "BitcoinMiner"]);
		let removed = 0;
		for (const [xy, td] of gs.tiles.entries()) {
			if (!td || !td.building) continue;
			try {
				if (toRemove.has(td.building.type as string)) {
					td.building = undefined;
					removed++;
				}
			} catch (e) {
				// ignore malformed entries
			}
		}
		if (removed > 0) {
			try { clearTransportSourceCache(); } catch (e) { /* swallow */ }
			try { ensureVisualRefresh(); } catch (e) { /* swallow */ }
		}

		// Determine right-hand 10-tile band bounds and row range 9..39 -> indexes 8..38
		let mapMaxX = Number.NEGATIVE_INFINITY;
		let mapMaxY = Number.NEGATIVE_INFINITY;
		for (const xy of gs.tiles.keys()) {
			const p = tileToPoint(xy);
			if (p.x > mapMaxX) mapMaxX = p.x;
			if (p.y > mapMaxY) mapMaxY = p.y;
		}
		if (mapMaxX === Number.NEGATIVE_INFINITY) {
			return { removed, cleared: null, message: "No map tiles available" };
		}

		const maxX = Math.floor(mapMaxX);
		const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

		const minY = 8; // row 9 -> index 8
		const maxY = Math.min(Math.floor(mapMaxY), 38);

		const cleared = clearRange(minX, maxX, minY, maxY);

		// Best-effort clear transport cache and force a double visual refresh
		try { clearTransportSourceCache(); } catch (e) { /* swallow */ }
		try {
			ensureVisualRefresh();
			await new Promise((r) => setTimeout(r, 50));
			ensureVisualRefresh();
		} catch (e) {
			console.error("ensureVisualRefresh failed in largeHadronCollider1:", e);
		}

		try {
			showToast(`Large Hadron Collider 1: removed ${removed}; cleared ${cleared.cleared}; preservedWonders ${cleared.preservedWonders}; preservedMines ${cleared.preservedMines}`);
		} catch (e) {
			console.error("showToast failed in largeHadronCollider1:", e);
		}

		return { removed, cleared };
	}

	/**
	 * Large Hadron Collider - Part 2
	 *
	 * - Build the set of buildings from the user-supplied list which DO NOT
	 *   REQUIRE electrification into the right-hand 10-tile strip starting
	 *   at row 9 (index 8).
	 * - Places buildings one-by-one with a 200ms delay so the player can
	 *   observe incremental placements. Unknown building types are skipped.
	 */
	export async function largeHadronCollider2(): Promise<{
		placement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
		message?: string;
	}> {
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
			return { placement: null, message: "No map tiles available" };
		}

		const maxX = Math.floor(mapMaxX);
		const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

		const startY = 8; // row 9 -> index 8
		const endY = Math.min(Math.floor(mapMaxY), Math.floor(mapMaxY));

		// Non-electrified building plan extracted from the user's construct_building list
		const plan: Array<{ type: Building; count: number }> = [
			{ type: "HedgeFund" as Building, count: 40 },
			{ type: "CoalPowerPlant" as Building, count: 1 },
			{ type: "Parliament" as Building, count: 10 },
			{ type: "MutualFund" as Building, count: 10 },
			{ type: "StockExchange" as Building, count: 5 },
			{ type: "ForexMarket" as Building, count: 5 },
			{ type: "BondMarket" as Building, count: 5 },
			{ type: "Bank" as Building, count: 5 },
			{ type: "CoinMint" as Building, count: 3 },
			{ type: "University" as Building, count: 10 },
			{ type: "Museum" as Building, count: 3 },
			{ type: "PaintersGuild" as Building, count: 3 },
			{ type: "MusiciansGuild" as Building, count: 3 },
			{ type: "Shrine" as Building, count: 2 },
			{ type: "PoetrySchool" as Building, count: 2 },
			{ type: "PlasticsFactory" as Building, count: 4 },
			{ type: "PaperMaker" as Building, count: 1 },
			{ type: "Stable" as Building, count: 1 },
			{ type: "Glassworks" as Building, count: 3 },
			{ type: "CableFactory" as Building, count: 3 },
			{ type: "Brewery" as Building, count: 1 },
			{ type: "Sandpit" as Building, count: 1 },
			{ type: "Courthouse" as Building, count: 1 },
		];

		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

		// summary map
		const summaryMap = new Map<string, { type: Building; requested: number; placed: number }>();
		for (const p of plan) summaryMap.set(p.type, { type: p.type, requested: p.count, placed: 0 });

		// Filter unknown building types and sort by tier ascending
		const validPlan = plan.filter((p) => {
			try { return !!Config.Building[p.type]; } catch (e) { return false; }
		});
		const sortedPlan = [...validPlan].sort((a, b) => (Config.BuildingTier[a.type] ?? 0) - (Config.BuildingTier[b.type] ?? 0));

		for (const spec of sortedPlan) {
			for (let i = 0; i < spec.count; i++) {
				try {
					const res = buildBuildingsInRange(minX, maxX, startY, endY, [{ type: spec.type, count: 1, targetLevel: 10 }]);
					const placed = res.results.length > 0 ? res.results[0].placed : 0;
					const entry = summaryMap.get(spec.type);
					if (entry) entry.placed += placed;
					if (placed === 0) break; // no more space for this type
					await sleep(200);
				} catch (e) {
					console.error("largeHadronCollider2: placement failed for", spec.type, e);
					break;
				}
			}
		}

		const results = Array.from(summaryMap.values());
		try { ensureVisualRefresh(); } catch (e) { console.error("ensureVisualRefresh failed in largeHadronCollider2:", e); }
		try {
			const summary = results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
			showToast(`Large Hadron Collider 2 complete: ${summary}`);
		} catch (e) {
			console.error("showToast failed in largeHadronCollider2:", e);
		}

		return { placement: { results } };
	}

	/**
	 * Large Hadron Collider - Part 3
	 *
	 * - Build the set of buildings from the user-supplied list which DO
	 *   REQUIRE electrification into the right-hand 10-tile strip starting
	 *   at row 25 (index 24).
	 * - Ensure the first building in the block is a CoalPowerPlant.
	 * - Place buildings one-by-one with a 200ms delay so the player can
	 *   observe incremental placements. Unknown building types are skipped.
	 */
	export async function largeHadronCollider3(): Promise<{
		placement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
		message?: string;
	}> {
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
			return { placement: null, message: "No map tiles available" };
		}

		const maxX = Math.floor(mapMaxX);
		const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

		const startY = 24; // row 25 -> index 24
		const endY = Math.floor(mapMaxY);

		// Electrified building plan from the user's construct_building list
		const candidates: Array<{ type: Building; count: number }> = [
			{ type: "SupercomputerLab" as Building, count: 40 },
			{ type: "CivTok" as Building, count: 40 },
			{ type: "SoftwareCompany" as Building, count: 10 },
			{ type: "SemiconductorFab" as Building, count: 5 },
			{ type: "OpticalFiberPlant" as Building, count: 5 },
			{ type: "SiliconSmelter" as Building, count: 2 },
			{ type: "InternetServiceProvider" as Building, count: 5 },
			{ type: "ComputerFactory" as Building, count: 19 },
		];

		// Aggregate counts by type
		const agg = new Map<string, { type: Building; requested: number }>();
		for (const it of candidates) {
			const key = it.type as string;
			const prev = agg.get(key);
			if (prev) prev.requested += it.count;
			else agg.set(key, { type: it.type, requested: it.count });
		}

		// Filter to electrified buildings using Config.Building[...].power === true
		const electSpecs: Array<{ type: Building; count: number; targetLevel?: number }> = [];
		for (const v of agg.values()) {
			try {
				const def = Config.Building[v.type];
				if (def && def.power === true) electSpecs.push({ type: v.type, count: v.requested, targetLevel: 10 });
			} catch (e) {
				// ignore unknown types
			}
		}

		// Ensure CoalPowerPlant exists at start of block
		let coalExists = false;
		for (const [xy, td] of gs.tiles.entries()) {
			if (!td || !td.building) continue;
			const pt = tileToPoint(xy);
			if (pt.x < minX || pt.x > maxX || pt.y < startY || pt.y > endY) continue;
			if (td.building.type === ("CoalPowerPlant" as Building)) { coalExists = true; break; }
		}
		if (!coalExists) {
			let placedCoal = false;
			for (let y = startY; y <= endY && !placedCoal; y++) {
				for (let x = minX; x <= maxX && !placedCoal; x++) {
					const xy = pointToTile({ x, y });
					const td = gs.tiles.get(xy);
					if (!td) continue;
					if (!td.building) {
						const b = makeBuilding({ type: "CoalPowerPlant" as Building, level: 0, desiredLevel: 10 });
						td.building = b;
						placedCoal = true;
					}
				}
			}
			if (placedCoal) { clearTransportSourceCache(); ensureVisualRefresh(); }
		}

		// Prepare summary map
		const summaryMap = new Map<string, { type: Building; requested: number; placed: number }>();
		for (const s of electSpecs) summaryMap.set(s.type, { type: s.type, requested: s.count, placed: 0 });

		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

		// Filter unknown defs and sort by tier ascending
		const validPlan = electSpecs.filter((p) => {
			try { return !!Config.Building[p.type]; } catch (e) { return false; }
		});
		const sortedPlan = [...validPlan].sort((a, b) => (Config.BuildingTier[a.type] ?? 0) - (Config.BuildingTier[b.type] ?? 0));

		for (const spec of sortedPlan) {
			for (let i = 0; i < spec.count; i++) {
				try {
					const res = buildBuildingsInRange(minX, maxX, startY, endY, [{ type: spec.type, count: 1, targetLevel: 10 }]);
					const placed = res.results.length > 0 ? res.results[0].placed : 0;
					const entry = summaryMap.get(spec.type);
					if (entry) entry.placed += placed;
					if (placed === 0) break;
					await sleep(200);
				} catch (e) {
					console.error("largeHadronCollider3: placement failed for", spec.type, e);
					break;
				}
			}
		}

		const results = Array.from(summaryMap.values());
		try { ensureVisualRefresh(); } catch (e) { console.error("ensureVisualRefresh failed in largeHadronCollider3:", e); }
		try {
			const summary = results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
			showToast(`Large Hadron Collider 3 complete: ${summary}`);
		} catch (e) {
			console.error("showToast failed in largeHadronCollider3:", e);
		}

		return { placement: { results } };
	}

/**
 * dysonBuildPlan4
 *
 * - Build the leftPlan in the LEFT-most 20-tile-wide strip starting at the
 *   top row (y=0). Large totals are placed in chunks and we wait for each
 *   chunk to complete like other bulk builders.
 */
export async function dysonBuildPlan4(): Promise<{
	leftStripPlacement: Array<{ type: Building; requested: number; placed: number; remaining: number }>;
	message?: string;
}> {
	const gs = getGameState();

	// Determine map bounds (we need minX for left-hand edge and maxY)
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
		return { leftStripPlacement: [], message: "No map tiles available" };
	}

	// LEFT-hand 20-tile-wide strip
	const minX = Math.max(0, Math.floor(mapMinX));
	const maxX = Math.min(Math.floor(mapMaxX), minX + 19);
	const minY = 0;
	const maxY = Math.floor(mapMaxY);

	const leftPlan: Array<{ type: Building; total: number }> = [
		{ type: ("CivGPT" as Building), total: 300 },
		{ type: ("Peacekeeper" as Building), total: 300 },
		{ type: ("SpaceCenter" as Building), total: 200 },
	];

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const results: Array<{ type: Building; requested: number; placed: number; remaining: number }> = [];

	// Build one-by-one with 200ms gap between placements (matches dysonBuildPlan2/3)
	for (const item of leftPlan) {
		const summaryEntry = { type: item.type, requested: item.total, placed: 0, remaining: item.total };
		for (let i = 0; i < item.total; i++) {
			// Defensive: skip unknown building types
			try {
				if (!Config.Building[item.type]) {
					console.warn("dysonBuildPlan4: unknown building type, skipping:", item.type);
					break;
				}
			} catch (e) {
				console.warn("dysonBuildPlan4: Config check failed for", item.type, e);
				break;
			}

			let res: { results: Array<{ type: Building; requested: number; placed: number }>; skippedWonders: number; skippedMines: number } | undefined;
			try {
				res = buildBuildingsInRange(minX, maxX, minY, maxY, [ { type: item.type, count: 1, targetLevel: 10 } ]);
			} catch (e) {
				console.error("dysonBuildPlan4: placement failed for", item.type, e);
				break;
			}

			const placed = res.results.length > 0 ? res.results[0].placed : 0;
			summaryEntry.placed += placed;
			summaryEntry.remaining -= placed;
			if (placed === 0) break; // no progress

			// small delay so the UI shows incremental progress
			await sleep(200);
		}

		results.push(summaryEntry);
	}

	ensureVisualRefresh();
	try {
		const summary = results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
		showToast(`Dyson Plan 4 complete: ${summary}`);
	} catch (e) {
		console.error("showToast failed in dysonBuildPlan4:", e);
	}
	return { leftStripPlacement: results };
}

/**
 * Large Hadron Collider - Part 4
 *
 * - Mirrors `aldersonDisc4` but uses the leftmost 25-tile-wide strip and
 *   the user's plan:
 *     HedgeFund x250, SupercomputerLab x250, CivTok x70
 * - Places one-by-one with a 200ms delay so the player can observe progress.
 * - Ensures a CoalPowerPlant is placed AFTER the CivTok placements.
 */
export async function largeHadronCollider4(): Promise<{
	leftStripPlacement: Array<{ type: Building; requested: number; placed: number; remaining: number }>;
	removed?: number;
	message?: string;
}> {
	const gs = getGameState();

	// Delete the same set as aldersonDisc4 (CivGPT, Peacekeeper, SpaceCenter)
	const toRemove = new Set<string>(["CivGPT", "Peacekeeper", "SpaceCenter"]);
	let removed = 0;
	for (const [xy, td] of gs.tiles.entries()) {
		if (!td || !td.building) continue;
		try {
			if (toRemove.has(td.building.type as string)) {
				td.building = undefined;
				removed++;
			}
		} catch (e) {
			// ignore malformed entries
		}
	}
	if (removed > 0) {
		try { clearTransportSourceCache(); } catch (e) { /* swallow */ }
		try { ensureVisualRefresh(); } catch (e) { /* swallow */ }
	}

	// Determine left-hand strip bounds; extend to 25 tiles wide
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
		return { leftStripPlacement: [], removed, message: "No map tiles available" };
	}

	const minX = Math.max(0, Math.floor(mapMinX));
	const maxX = Math.min(Math.floor(mapMaxX), minX + 24); // 25 tiles wide
	const minY = 0;
	const maxY = Math.floor(mapMaxY);

	const plan: Array<{ type: Building; total: number }> = [
		{ type: "HedgeFund" as Building, total: 250 },
		{ type: "SupercomputerLab" as Building, total: 250 },
		{ type: "CivTok" as Building, total: 400 },
	];

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const results: Array<{ type: Building; requested: number; placed: number; remaining: number }> = [];

	for (const item of plan) {
		const summaryEntry = { type: item.type, requested: item.total, placed: 0, remaining: item.total };

		// Defensive check: ensure building type exists
		try {
			if (!Config.Building[item.type]) {
				console.warn("largeHadronCollider4: unknown building type, skipping:", item.type);
				results.push(summaryEntry);
				continue;
			}
		} catch (e) {
			console.warn("largeHadronCollider4: Config check failed for", item.type, e);
			results.push(summaryEntry);
			continue;
		}

		for (let i = 0; i < item.total; i++) {
			let res: { results: Array<{ type: Building; requested: number; placed: number }>; skippedWonders: number; skippedMines: number } | undefined;
			try {
				res = buildBuildingsInRange(minX, maxX, minY, maxY, [{ type: item.type, count: 1, targetLevel: 10 }]);
			} catch (e) {
				console.error("largeHadronCollider4: placement failed for", item.type, e);
				break;
			}

			const placed = res && res.results.length > 0 ? res.results[0].placed : 0;
			summaryEntry.placed += placed;
			summaryEntry.remaining -= placed;
			if (placed === 0) break; // no space left
			await sleep(200);
		}

		results.push(summaryEntry);
	}

	// After all CivTok placements (and others), ensure a CoalPowerPlant exists in the left strip.
	// Place one on the first empty tile scanning top->bottom, left->right.
	let coalPlaced = false;
	for (let y = minY; y <= maxY && !coalPlaced; y++) {
		for (let x = minX; x <= maxX && !coalPlaced; x++) {
			const xy = pointToTile({ x, y });
			const td = gs.tiles.get(xy);
			if (!td) continue;
			if (!td.building) {
				const b = makeBuilding({ type: "CoalPowerPlant" as Building, level: 0, desiredLevel: 10 });
				td.building = b;
				coalPlaced = true;
			}
		}
	}
	if (coalPlaced) { clearTransportSourceCache(); ensureVisualRefresh(); }

	try { ensureVisualRefresh(); } catch (e) { console.error("ensureVisualRefresh failed in largeHadronCollider4:", e); }
	try {
		const summary = results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
		showToast(`LHC 4 complete: removed ${removed}; ${summary}; coalPlaced ${coalPlaced}`);
	} catch (e) {
		console.error("showToast failed in largeHadronCollider4:", e);
	}

	return { leftStripPlacement: results, removed };
}

/**
 * Build Space Center - Part 1
 *
 * - Delete ALL CivTok, HedgeFund, SupercomputerLab across the map.
 * - Clear the right-hand 10-tile-wide strip rows 9..39 (indexes 8..38).
 */
export async function buildSpaceCenter1(): Promise<{
	removed: number;
	cleared: { cleared: number; preservedWonders: number; preservedMines: number } | null;
	message?: string;
}> {
	const gs = getGameState();

	// Delete all CivTok, HedgeFund, SupercomputerLab across the map
	const toRemove = new Set<string>(["CivTok", "HedgeFund", "SupercomputerLab"]);
	let removed = 0;
	for (const [xy, td] of gs.tiles.entries()) {
		if (!td || !td.building) continue;
		try {
			if (toRemove.has(td.building.type as string)) {
				td.building = undefined;
				removed++;
			}
		} catch (e) {
			// ignore malformed entries
		}
	}
	if (removed > 0) {
		try { clearTransportSourceCache(); } catch (e) { /* swallow */ }
		try { ensureVisualRefresh(); } catch (e) { /* swallow */ }
	}

	// Determine right-hand 10-tile band bounds and row range 9..39 -> indexes 8..38
	let mapMaxX = Number.NEGATIVE_INFINITY;
	let mapMaxY = Number.NEGATIVE_INFINITY;
	for (const xy of gs.tiles.keys()) {
		const p = tileToPoint(xy);
		if (p.x > mapMaxX) mapMaxX = p.x;
		if (p.y > mapMaxY) mapMaxY = p.y;
	}
	if (mapMaxX === Number.NEGATIVE_INFINITY) {
		return { removed, cleared: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	const minY = 8; // row 9 -> index 8
	const maxY = Math.min(Math.floor(mapMaxY), 38);

	const cleared = clearRange(minX, maxX, minY, maxY);

	// Best-effort clear transport cache and force a double visual refresh
	try { clearTransportSourceCache(); } catch (e) { /* swallow */ }
	try {
		ensureVisualRefresh();
		await new Promise((r) => setTimeout(r, 50));
		ensureVisualRefresh();
	} catch (e) {
		console.error("ensureVisualRefresh failed in buildSpaceCenter1:", e);
	}

	try {
		showToast(`Build Space Center 1: removed ${removed}; cleared ${cleared.cleared}; preservedWonders ${cleared.preservedWonders}; preservedMines ${cleared.preservedMines}`);
	} catch (e) {
		console.error("showToast failed in buildSpaceCenter1:", e);
	}

	return { removed, cleared };
}

// Stubs for Space Center 2..4 (implemented later as needed)
export async function buildSpaceCenter2(): Promise<{
	placement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	message?: string;
}> {
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
		return { placement: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	const startY = 8; // row 9 -> index 8
	const endY = Math.floor(mapMaxY);

	// Non-electrified building plan (using the 4th-argument quantities from the supplied list; duplicates aggregated)
	const plan: Array<{ type: Building; count: number }> = [
		{ type: "MagazinePublisher" as Building, count: 8 },
		{ type: "Stadium" as Building, count: 5 },
		{ type: "PublishingHouse" as Building, count: 5 },
		{ type: "BiplaneFactory" as Building, count: 1 },
		{ type: "Museum" as Building, count: 5 },
		{ type: "ActorsGuild" as Building, count: 3 },
		{ type: "University" as Building, count: 10 },
		{ type: "LocomotiveFactory" as Building, count: 8 },
		{ type: "OilRefinery" as Building, count: 8 },
		{ type: "PrintingHouse" as Building, count: 7 },
		{ type: "DynamiteWorkshop" as Building, count: 3 },
		{ type: "Steamworks" as Building, count: 1 },
		{ type: "Shrine" as Building, count: 1 },
		{ type: "FurnitureWorkshop" as Building, count: 1 },
		{ type: "LensWorkshop" as Building, count: 1 },
		{ type: "MusiciansGuild" as Building, count: 1 },
		{ type: "PaintersGuild" as Building, count: 1 },
		{ type: "RifleFactory" as Building, count: 1 },
		{ type: "GatlingGunFactory" as Building, count: 1 },
		{ type: "CableFactory" as Building, count: 3 },
		{ type: "Glassworks" as Building, count: 2 },
		{ type: "GunpowderMill" as Building, count: 1 },
		{ type: "Stable" as Building, count: 1 },
		{ type: "PaperMaker" as Building, count: 1 },
		{ type: "PlasticsFactory" as Building, count: 3 },
		{ type: "PoetrySchool" as Building, count: 1 },
		{ type: "SteelMill" as Building, count: 3 },
		{ type: "IronForge" as Building, count: 1 },
		{ type: "Sandpit" as Building, count: 1 },
		{ type: "Brewery" as Building, count: 1 },
	];

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	// summary map
	const summaryMap = new Map<string, { type: Building; requested: number; placed: number }>();
	for (const p of plan) summaryMap.set(p.type, { type: p.type, requested: p.count, placed: 0 });

	// Filter unknown building types and sort by tier ascending
	const validPlan = plan.filter((p) => {
		try { return !!Config.Building[p.type]; } catch (e) { return false; }
	});
	const sortedPlan = [...validPlan].sort((a, b) => (Config.BuildingTier[a.type] ?? 0) - (Config.BuildingTier[b.type] ?? 0));

	for (const spec of sortedPlan) {
		for (let i = 0; i < spec.count; i++) {
			try {
				const res = buildBuildingsInRange(minX, maxX, startY, endY, [{ type: spec.type, count: 1, targetLevel: 10 }]);
				const placed = res.results.length > 0 ? res.results[0].placed : 0;
				const entry = summaryMap.get(spec.type);
				if (entry) entry.placed += placed;
				if (placed === 0) break; // no more space for this type
				await sleep(200);
			} catch (e) {
				console.error("buildSpaceCenter2: placement failed for", spec.type, e);
				break;
			}
		}
	}

	const results = Array.from(summaryMap.values());
	try { ensureVisualRefresh(); } catch (e) { console.error("ensureVisualRefresh failed in buildSpaceCenter2:", e); }
	try {
		const summary = results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
		showToast(`Build Space Center 2 complete: ${summary}`);
	} catch (e) {
		console.error("showToast failed in buildSpaceCenter2:", e);
	}

	return { placement: { results } };
}

export async function buildSpaceCenter3(): Promise<{
	placement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	message?: string;
}> {
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
		return { placement: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	const startY = 24; // row 25 -> index 24
	const endY = Math.floor(mapMaxY);

	// Electrified building plan (using the 4th-argument quantities from the supplied list)
	const candidates: Array<{ type: Building; count: number }> = [
		{ type: "RadioStation" as Building, count: 20 },
		{ type: "SupercomputerLab" as Building, count: 20 },
		{ type: "MaglevFactory" as Building, count: 6 },
		{ type: "SoftwareCompany" as Building, count: 5 },
		{ type: "AirplaneFactory" as Building, count: 6 },
		{ type: "CarFactory" as Building, count: 4 },
		{ type: "ComputerFactory" as Building, count: 6 },
		{ type: "SemiconductorFab" as Building, count: 2 },
		{ type: "SiliconSmelter" as Building, count: 1 },
	];

	// Aggregate counts by type
	const agg = new Map<string, { type: Building; requested: number }>();
	for (const it of candidates) {
		const key = it.type as string;
		const prev = agg.get(key);
		if (prev) prev.requested += it.count;
		else agg.set(key, { type: it.type, requested: it.count });
	}

	// Filter to electrified buildings using Config.Building[...].power === true
	const electSpecs: Array<{ type: Building; count: number; targetLevel?: number }> = [];
	for (const v of agg.values()) {
		try {
			const def = Config.Building[v.type];
			if (def && def.power === true) electSpecs.push({ type: v.type, count: v.requested, targetLevel: 10 });
		} catch (e) {
			// ignore unknown types
		}
	}

	// Ensure CoalPowerPlant exists at start of block
	let coalExists = false;
	for (const [xy, td] of gs.tiles.entries()) {
		if (!td || !td.building) continue;
		const pt = tileToPoint(xy);
		if (pt.x < minX || pt.x > maxX || pt.y < startY || pt.y > endY) continue;
		if (td.building.type === ("CoalPowerPlant" as Building)) { coalExists = true; break; }
	}
	if (!coalExists) {
		let placedCoal = false;
		for (let y = startY; y <= endY && !placedCoal; y++) {
			for (let x = minX; x <= maxX && !placedCoal; x++) {
				const xy = pointToTile({ x, y });
				const td = gs.tiles.get(xy);
				if (!td) continue;
				if (!td.building) {
					const b = makeBuilding({ type: "CoalPowerPlant" as Building, level: 0, desiredLevel: 10 });
					td.building = b;
					placedCoal = true;
				}
			}
		}
		if (placedCoal) { clearTransportSourceCache(); ensureVisualRefresh(); }
	}

	// Prepare summary map
	const summaryMap = new Map<string, { type: Building; requested: number; placed: number }>();
	for (const s of electSpecs) summaryMap.set(s.type, { type: s.type, requested: s.count, placed: 0 });

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	// Filter unknown defs and sort by tier ascending
	const validPlan = electSpecs.filter((p) => {
		try { return !!Config.Building[p.type]; } catch (e) { return false; }
	});
	const sortedPlan = [...validPlan].sort((a, b) => (Config.BuildingTier[a.type] ?? 0) - (Config.BuildingTier[b.type] ?? 0));

	for (const spec of sortedPlan) {
		for (let i = 0; i < spec.count; i++) {
			try {
				const res = buildBuildingsInRange(minX, maxX, startY, endY, [{ type: spec.type, count: 1, targetLevel: 10 }]);
				const placed = res.results.length > 0 ? res.results[0].placed : 0;
				const entry = summaryMap.get(spec.type);
				if (entry) entry.placed += placed;
				if (placed === 0) break;
				await sleep(200);
			} catch (e) {
				console.error("buildSpaceCenter3: placement failed for", spec.type, e);
				break;
			}
		}
	}

	const results = Array.from(summaryMap.values());
	try { ensureVisualRefresh(); } catch (e) { console.error("ensureVisualRefresh failed in buildSpaceCenter3:", e); }
	try {
		const summary = results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
		showToast(`Build Space Center 3 complete: ${summary}`);
	} catch (e) {
		console.error("showToast failed in buildSpaceCenter3:", e);
	}

	return { placement: { results } };
}

export async function buildSpaceCenter4(): Promise<{
	leftStripPlacement: Array<{ type: Building; requested: number; placed: number; remaining: number }>;
	removed?: number;
	message?: string;
}> {
	const gs = getGameState();

	// Delete the same set as aldersonDisc4 (CivGPT, Peacekeeper, SpaceCenter)
	const toRemove = new Set<string>(["CivGPT", "Peacekeeper", "SpaceCenter"]);
	let removed = 0;
	for (const [xy, td] of gs.tiles.entries()) {
		if (!td || !td.building) continue;
		try {
			if (toRemove.has(td.building.type as string)) {
				td.building = undefined;
				removed++;
			}
		} catch (e) {
			// ignore malformed entries
		}
	}
	if (removed > 0) {
		try { clearTransportSourceCache(); } catch (e) { /* swallow */ }
		try { ensureVisualRefresh(); } catch (e) { /* swallow */ }
	}

	// Determine left-hand strip bounds; extend to 25 tiles wide
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
		return { leftStripPlacement: [], removed, message: "No map tiles available" };
	}

	const minX = Math.max(0, Math.floor(mapMinX));
	const maxX = Math.min(Math.floor(mapMaxX), minX + 24); // 25 tiles wide
	const minY = 0;
	const maxY = Math.floor(mapMaxY);

	const plan: Array<{ type: Building; total: number }> = [
		{ type: "SpaceCenter" as Building, total: 1000 },
	];

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const results: Array<{ type: Building; requested: number; placed: number; remaining: number }> = [];

	for (const item of plan) {
		const summaryEntry = { type: item.type, requested: item.total, placed: 0, remaining: item.total };

		// Defensive check: ensure building type exists
		try {
			if (!Config.Building[item.type]) {
				console.warn("buildSpaceCenter4: unknown building type, skipping:", item.type);
				results.push(summaryEntry);
				continue;
			}
		} catch (e) {
			console.warn("buildSpaceCenter4: Config check failed for", item.type, e);
			results.push(summaryEntry);
			continue;
		}

		for (let i = 0; i < item.total; i++) {
			let res: { results: Array<{ type: Building; requested: number; placed: number }>; skippedWonders: number; skippedMines: number } | undefined;
			try {
				res = buildBuildingsInRange(minX, maxX, minY, maxY, [{ type: item.type, count: 1, targetLevel: 10 }]);
			} catch (e) {
				console.error("buildSpaceCenter4: placement failed for", item.type, e);
				break;
			}

			const placed = res && res.results.length > 0 ? res.results[0].placed : 0;
			summaryEntry.placed += placed;
			summaryEntry.remaining -= placed;
			if (placed === 0) break; // no space left
			await sleep(200);
		}

		results.push(summaryEntry);
	}

	// After placements, ensure a CoalPowerPlant exists in the left strip.
	let coalPlaced = false;
	for (let y = minY; y <= maxY && !coalPlaced; y++) {
		for (let x = minX; x <= maxX && !coalPlaced; x++) {
			const xy = pointToTile({ x, y });
			const td = gs.tiles.get(xy);
			if (!td) continue;
			if (!td.building) {
				const b = makeBuilding({ type: "CoalPowerPlant" as Building, level: 0, desiredLevel: 10 });
				td.building = b;
				coalPlaced = true;
			}
		}
	}
	if (coalPlaced) { clearTransportSourceCache(); ensureVisualRefresh(); }

	try { ensureVisualRefresh(); } catch (e) { console.error("ensureVisualRefresh failed in buildSpaceCenter4:", e); }
	try {
		const summary = results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
		showToast(`Build Space Center 4 complete: removed ${removed}; ${summary}; coalPlaced ${coalPlaced}`);
	} catch (e) {
		console.error("showToast failed in buildSpaceCenter4:", e);
	}

	return { leftStripPlacement: results, removed };
}

/**
 * dysonBuildPlan3
 *
 * - Place the provided high-tech / electrified `plan` into the rightmost
 *   10-tile band starting at row 25 (index 24) and spanning 10 rows
 *   (indexes 24..33 clamped to map height).
 */
export async function dysonBuildPlan3(): Promise<{
	placement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	message?: string;
}> {
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
		return { placement: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Row 25 -> index 24, take 10 rows -> indexes 24..33
	const startY = 24;
	const endY = Math.min(Math.floor(mapMaxY), startY + 9);

	const plan: Array<{ type: Building; count: number }> = [
		{ type: ("SiliconSmelter" as Building), count: 1 },
		{ type: ("OpticalFiberFactory" as Building), count: 6 },
		{ type: ("SemiconductorFab" as Building), count: 2 },
		{ type: ("AtomicFacility" as Building), count: 3 },
		{ type: ("CarFactory" as Building), count: 4 },
		{ type: ("ComputerFactory" as Building), count: 6 },
		{ type: ("AirplaneFactory" as Building), count: 6 },
		{ type: ("InternetServiceProvider" as Building), count: 10 },
		{ type: ("SoftwareCompany" as Building), count: 5 },
		{ type: ("SupercomputerLab" as Building), count: 10 },
		{ type: ("MaglevFactory" as Building), count: 6 },
		{ type: ("RocketFactory" as Building), count: 5 },
		{ type: ("NuclearMissileSilo" as Building), count: 12 },
		{ type: ("RadioStation" as Building), count: 18 },
	];

	// We'll place buildings one-by-one with a small delay so the user
	// can observe them being created. This mirrors dysonBuildPlan2.
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	// Ensure a CoalPowerPlant exists at the start of the electrified block
	let coalExists = false;
	for (const [xy, td] of gs.tiles.entries()) {
		if (!td || !td.building) continue;
		const pt = tileToPoint(xy);
		if (pt.x < minX || pt.x > maxX || pt.y < startY || pt.y > endY) continue;
		if (td.building.type === ("CoalPowerPlant" as Building)) { coalExists = true; break; }
	}
	if (!coalExists) {
		// place coal at first empty tile in the block
		let placedCoal = false;
		for (let y = startY; y <= endY && !placedCoal; y++) {
			for (let x = minX; x <= maxX && !placedCoal; x++) {
				const xy = pointToTile({ x, y });
				const td = gs.tiles.get(xy);
				if (!td) continue;
				if (!td.building) {
					const b = makeBuilding({ type: "CoalPowerPlant" as Building, level: 0, desiredLevel: 10 });
					td.building = b;
					placedCoal = true;
				}
			}
		}
		if (placedCoal) { clearTransportSourceCache(); ensureVisualRefresh(); }
	}

	// Build one-by-one with 200ms gap; collect summary like plan2
	const summaryMap = new Map<string, { type: Building; requested: number; placed: number }>();
	for (const p of plan) summaryMap.set(p.type, { type: p.type, requested: p.count, placed: 0 });

	const validPlan = plan.filter((p) => {
		try { return !!Config.Building[p.type]; } catch (e) { return false; }
	});

	for (const spec of validPlan) {
		for (let i = 0; i < spec.count; i++) {
			let res: { results: Array<{ type: Building; requested: number; placed: number }>; skippedWonders: number; skippedMines: number } | undefined;
			try {
				res = buildBuildingsInRange(minX, maxX, startY, endY, [ { type: spec.type, count: 1, targetLevel: 10 } ]);
			} catch (e) {
				console.error("dysonBuildPlan3: placement failed for", spec.type, e);
				break;
			}
			const placed = res.results.length > 0 ? res.results[0].placed : 0;
			const entry = summaryMap.get(spec.type);
			if (entry) entry.placed += placed;
			if (placed === 0) break;
			// small delay so the UI shows incremental progress
			await sleep(200);
		}
	}

	const results = Array.from(summaryMap.values());
	ensureVisualRefresh();
	// Final summary toast (best-effort)
	try {
		const totalPlaced = results.reduce((acc, r) => acc + (r.placed ?? 0), 0);
		const summary = results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
		showToast(`Dyson Plan 3 complete: placed ${totalPlaced}; ${summary}`);
	} catch (e) {
		console.error("showToast failed in dysonBuildPlan3:", e);
	}
	return { placement: { results } };
}

// buildDysonMaterials wrapper removed - callers should invoke individual
// dysonBuildPlan1..4 functions directly. The menu was updated to expose
// each part separately.

/**
 * Alderson Disc 1
 *
 * - In the right-hand 10-tile strip, clear everything from row 9 to 39
 *   (user-facing row numbers; indexes 8..38) while preserving wonders and
 *   protected mines via clearRange.
 * - Force visual refreshes (double notify + short tick) so no visual
 *   artefacts remain.
 */
export async function aldersonDisc1(): Promise<{
	cleared: { cleared: number; preservedWonders: number; preservedMines: number } | null;
	message?: string;
}> {
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
		return { cleared: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Rows 9..39 -> indexes 8..38 (clamped to map height)
	const minY = 8;
	const maxY = Math.min(Math.floor(mapMaxY), 38);

	const cleared = clearRange(minX, maxX, minY, maxY);

	// Best-effort clear transport cache and force a double visual refresh
	try {
		clearTransportSourceCache();
	} catch (e) {
		// swallow
	}
	try {
		ensureVisualRefresh();
		// small tick and another refresh to avoid rendering artefacts
		await new Promise((r) => setTimeout(r, 50));
		ensureVisualRefresh();
		} catch (e) {
			console.error("ensureVisualRefresh failed in aldersonDisc1:", e);
	}

	try {
		showToast(`Alderson Disc 1: cleared ${cleared.cleared}; preservedWonders ${cleared.preservedWonders}; preservedMines ${cleared.preservedMines}`);
		} catch (e) {
			console.error("showToast failed in aldersonDisc1:", e);
	}

		return { cleared };
}

/**
 * Alderson Disc 2
 *
 * - Build the set of buildings which DO NOT REQUIRE electrification
 *   into the right-hand 10-tile strip starting at row 9 (index 8).
 * - Place buildings one-by-one with a 200ms delay so the player can
 *   observe incremental placements. Filter unknown building types.
 */
export async function aldersonDisc2(): Promise<{
	placement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	message?: string;
}> {
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
		return { placement: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	const startY = 8; // row 9 -> index 8
	const endY = Math.min(Math.floor(mapMaxY), Math.floor(mapMaxY));

	// Building plan: aggregated counts from the provided list for non-electrified buildings
	const plan: Array<{ type: Building; count: number }> = [
		{ type: "Embassy" as Building, count: 10 },
		{ type: "HedgeFund" as Building, count: 10 },
		{ type: "Parliament" as Building, count: 8 },
		{ type: "MutualFund" as Building, count: 16 },
		{ type: "StockExchange" as Building, count: 4 },
		{ type: "Courthouse" as Building, count: 6 },
		{ type: "ForexMarket" as Building, count: 4 },
		{ type: "ArtilleryFactory" as Building, count: 4 },
		{ type: "University" as Building, count: 8 },
		{ type: "GatlingGunFactory" as Building, count: 2 },
		{ type: "Museum" as Building, count: 2 },
		{ type: "BondMarket" as Building, count: 2 },
		{ type: "RifleFactory" as Building, count: 2 },
		{ type: "PaintersGuild" as Building, count: 2 },
		{ type: "MusiciansGuild" as Building, count: 2 },
		{ type: "FurnitureWorkshop" as Building, count: 2 },
		{ type: "Shrine" as Building, count: 2 },
		{ type: "Steamworks" as Building, count: 2 },
		{ type: "DynamiteWorkshop" as Building, count: 2 },
		{ type: "Bank" as Building, count: 2 },
		{ type: "IronForge" as Building, count: 1 },
		{ type: "SteelMill" as Building, count: 2 },
		{ type: "PoetrySchool" as Building, count: 1 },
		{ type: "PlasticsFactory" as Building, count: 3 },
		{ type: "OilRefinery" as Building, count: 5 },
		{ type: "PaperMaker" as Building, count: 1 },
		{ type: "LumberMill" as Building, count: 1 },
		{ type: "Stable" as Building, count: 1 },
		{ type: "GunpowderMill" as Building, count: 3 },
		{ type: "Glassworks" as Building, count: 4 },
		{ type: "BiplaneFactory" as Building, count: 1 },
		{ type: "LocomotiveFactory" as Building, count: 1 },
		{ type: "CoinMint" as Building, count: 1 },
		{ type: "PrintingHouse" as Building, count: 2 },
		{ type: "PublishingHouse" as Building, count: 2 },
		{ type: "MagazinePublisher" as Building, count: 2 },
		{ type: "Stadium" as Building, count: 1 },
		{ type: "ActorsGuild" as Building, count: 1 },
		{ type: "CableFactory" as Building, count: 3 },
		{ type: "Brewery" as Building, count: 1 },
		{ type: "Sandpit" as Building, count: 1 },
	];

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	// summary
	const summaryMap = new Map<string, { type: Building; requested: number; placed: number }>();
	for (const p of plan) summaryMap.set(p.type, { type: p.type, requested: p.count, placed: 0 });

		const validPlan = plan.filter((p) => {
			try {
				return !!Config.Building[p.type];
			} catch (e) {
				return false;
			}
		});

		// Sort by building tier ascending so lower-tier buildings are placed first.
		// This mirrors the behavior used in buildBuildingsInRange elsewhere.
		const sortedPlan = [...validPlan].sort((a, b) => (Config.BuildingTier[a.type] ?? 0) - (Config.BuildingTier[b.type] ?? 0));

		for (const spec of sortedPlan) {
		for (let i = 0; i < spec.count; i++) {
			try {
				const res = buildBuildingsInRange(minX, maxX, startY, endY, [ { type: spec.type, count: 1, targetLevel: 10 } ]);
				const placed = res.results.length > 0 ? res.results[0].placed : 0;
				const entry = summaryMap.get(spec.type);
				if (entry) entry.placed += placed;
				if (placed === 0) break; // no more space for this type
				await sleep(200);
			} catch (e) {
				console.error("aldersonDisc2: placement failed for", spec.type, e);
				break;
			}
		}
	}

	const results = Array.from(summaryMap.values());
	try {
		ensureVisualRefresh();
	} catch (e) {
		console.error("ensureVisualRefresh failed in aldersonDisc2:", e);
	}
	try {
		const summary = results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
		showToast(`Alderson Disc 2 complete: ${summary}`);
	} catch (e) {
		console.error("showToast failed in aldersonDisc2:", e);
	}

	return { placement: { results } };
}

// Provide alias for the possibly-typo'd name the user used earlier
export const aldersonDice2 = aldersonDisc2;

/**
 * Alderson Disc 3
 *
 * - Build the set of buildings which REQUIRE electrification from the
 *   candidate list into the right-hand 10-tile strip starting at row 25
 *   (index 24) and continuing to the bottom of the map.
 * - Ensure the first building in the electrified block is a CoalPowerPlant.
 * - Place buildings one-by-one with a 200ms delay, sorted by ascending
 *   Config.BuildingTier so lower-tier buildings are placed first.
 */
export async function aldersonDisc3(): Promise<{
	placement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	message?: string;
}> {
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
		return { placement: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(mapMaxX);
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	const startY = 24; // row 25 -> index 24
	const endY = Math.floor(mapMaxY);

		// Candidate master list: only include known high-tech / electrified
		// building types (derived from dysonBuildPlan3). We deliberately DO NOT
		// include the non-electrified items — this plan must build only those
		// buildings that require electrification.
		const candidates: Array<{ type: Building; count: number }> = [
			{ type: "SiliconSmelter" as Building, count: 1 },
			{ type: "OpticalFiberFactory" as Building, count: 7 },
			{ type: "SemiconductorFab" as Building, count: 2 },
			{ type: "AtomicFacility" as Building, count: 3 },
			{ type: "CarFactory" as Building, count: 20 },
			{ type: "ComputerFactory" as Building, count: 6 },
			{ type: "AirplaneFactory" as Building, count: 6 },
			{ type: "InternetServiceProvider" as Building, count: 10 },
			{ type: "SoftwareCompany" as Building, count: 5 },
			{ type: "SupercomputerLab" as Building, count: 10 },
			{ type: "MaglevFactory" as Building, count: 6 },
			{ type: "RocketFactory" as Building, count: 5 },
			{ type: "SatelliteFactory" as Building, count: 5 },
			{ type: "CivTok" as Building, count: 10 },
			];

	// Aggregate counts by type
	const agg = new Map<string, { type: Building; requested: number }>();
	for (const it of candidates) {
		const key = it.type as string;
		const prev = agg.get(key);
		if (prev) prev.requested += it.count;
		else agg.set(key, { type: it.type, requested: it.count });
	}

	// Filter to electrified buildings using Config.Building[...].power === true
	const electSpecs: Array<{ type: Building; count: number; targetLevel?: number }> = [];
	for (const v of agg.values()) {
		try {
			const def = Config.Building[v.type];
			if (def && def.power === true) electSpecs.push({ type: v.type, count: v.requested, targetLevel: 10 });
		} catch (e) {
			// ignore unknown types
		}
	}

	// Ensure CoalPowerPlant exists at start of block
	let coalExists = false;
	for (const [xy, td] of gs.tiles.entries()) {
		if (!td || !td.building) continue;
		const pt = tileToPoint(xy);
		if (pt.x < minX || pt.x > maxX || pt.y < startY || pt.y > endY) continue;
		if (td.building.type === ("CoalPowerPlant" as Building)) { coalExists = true; break; }
	}
	if (!coalExists) {
		let placedCoal = false;
		for (let y = startY; y <= endY && !placedCoal; y++) {
			for (let x = minX; x <= maxX && !placedCoal; x++) {
				const xy = pointToTile({ x, y });
				const td = gs.tiles.get(xy);
				if (!td) continue;
				if (!td.building) {
					const b = makeBuilding({ type: "CoalPowerPlant" as Building, level: 0, desiredLevel: 10 });
					td.building = b;
					placedCoal = true;
				}
			}
		}
		if (placedCoal) { clearTransportSourceCache(); ensureVisualRefresh(); }
	}

	// Prepare summary map
	const summaryMap = new Map<string, { type: Building; requested: number; placed: number }>();
	for (const s of electSpecs) summaryMap.set(s.type, { type: s.type, requested: s.count, placed: 0 });

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	// Filter unknown defs and sort by tier ascending
	const validPlan = electSpecs.filter((p) => {
		try { return !!Config.Building[p.type]; } catch (e) { return false; }
	});
	const sortedPlan = [...validPlan].sort((a, b) => (Config.BuildingTier[a.type] ?? 0) - (Config.BuildingTier[b.type] ?? 0));

	for (const spec of sortedPlan) {
		for (let i = 0; i < spec.count; i++) {
			try {
				const res = buildBuildingsInRange(minX, maxX, startY, endY, [{ type: spec.type, count: 1, targetLevel: 10 }]);
				const placed = res.results.length > 0 ? res.results[0].placed : 0;
				const entry = summaryMap.get(spec.type);
				if (entry) entry.placed += placed;
				if (placed === 0) break;
				await sleep(200);
			} catch (e) {
				console.error("aldersonDisc3: placement failed for", spec.type, e);
				break;
			}
		}
	}

	const results = Array.from(summaryMap.values());
	try { ensureVisualRefresh(); } catch (e) { console.error("ensureVisualRefresh failed in aldersonDisc3:", e); }
	try {
		const summary = results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
		showToast(`Alderson Disc 3 complete: ${summary}`);
	} catch (e) {
		console.error("showToast failed in aldersonDisc3:", e);
	}

	return { placement: { results } };
}

/**
 * Generic builder: place a plan one-by-one into a left/right strip.
 *
 * - side: "left" | "right" selects which horizontal edge the strip is anchored to.
 * - width: number of tiles wide for the strip.
 * - plan: Array of { type: Building; count: number; level?: number } to place (will be placed one at a time).
 * - startRow: which row (y index) to start placing on.
 * - intervalMs: milliseconds to wait between individual placements.
 *
 * Behavior:
 * - Computes the requested strip based on the map extents.
 * - Places buildings one at a time directly onto tiles and waits intervalMs
 *   between placements so UI can show progress.
 * - Stops attempting a given building type if a placement returns 0 (no space).
 *
 * Returns an array of per-type summaries: requested and placed counts.
 */
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

			// Pause between placements so UI shows incremental progress
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











