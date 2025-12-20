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
import { findSpecialBuilding, isWorldOrNaturalWonder } from "../../../shared/logic/BuildingLogic";
import { Config } from "../../../shared/logic/Config";
import { getGameState } from "../../../shared/logic/GameStateLogic";
import { getGrid } from "../../../shared/logic/IntraTickCache";
import type { ICloneBuildingData } from "../../../shared/logic/Tile";
import { makeBuilding } from "../../../shared/logic/Tile";
import { clearTransportSourceCache } from "../../../shared/logic/Update";
import { pointToTile, tileToPoint } from "../../../shared/utilities/Helper";
import { showToast } from "../ui/GlobalModal";
import { clearRange, doBuildingPlan, doBuildingPlanRect, ensureVisualRefresh, getMapSize, removeBuildingsByDisplayNames, splitElectricityBuildings } from "./davescripts2";

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
export async function buildInitialMines(): Promise<{
	houseResult: { requested: number; placed: number } | null;
	aqueductPlaced: number;
	stoneQuarryPlaced: number;
	loggingCampPlaced: number;
	message?: string;
}> {
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

	// Clamp to map extents using shared helper
	const { width, height } = await getMapSize();
	if (!height || height <= 0) {
		// no tiles - nothing to do
		return {
			houseResult: null,
			aqueductPlaced: 0,
			stoneQuarryPlaced: 0,
			loggingCampPlaced: 0,
			message: "No map tiles available",
		};
	}

	maxX = Math.min(maxX, Math.floor(width) - 1);
	maxY = Math.min(maxY, Math.floor(height) - 1);

	// Place 12 Houses at level 15 and 5 WheatFarms in the rectangle
	// Order: Houses first so housePlacement.results[0] corresponds to Houses
	const housePlan = [
		{ type: "WheatFarm" as Building, count: 5, targetLevel: 15 },
	  { type: "House" as Building, count: 12, targetLevel: 15 }
	];

	const housePlacement = await doBuildingPlanRect(minX, maxX, minY, maxY, housePlan, 0);
	const houseEntry = housePlacement.results.find((r) => r.type === ("House" as Building));
	const houseResult = houseEntry ? { requested: houseEntry.requested, placed: houseEntry.placed } : null;

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
 * 003 - Build Big Ben Materials
 *
 * Place a large set of material/support buildings in the extreme right-hand
 * 10-tile band at row index 14 (clamped to map height). The user-supplied
 * base quantities are multiplied by 4 before placement. All buildings are
 * requested at target level 15 and the function returns the per-type
 * requested/placed counts.
 */
export async function buildBigBenMaterials(): Promise<{
	results: Array<{ type: Building; requested: number; placed: number }> | null;
	message?: string;
}> {

	// Base list provided by the user (these will be multiplied by 4)
	const bigBenMaterials: Array<{ type: Building; count: number }> = [
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

	const result = await doBuildingPlan("right", 10, bigBenMaterials.map((b) => ({ type: b.type, count: b.count * 4, targetLevel: 15 })), 14, 200);

	buildMines("CopperMiningCamp" as Building, 15, 2);
	buildMines("IronMiningCamp" as Building, 15, 2);

	// Immediate refresh after placement so UI shows newly placed buildings
	ensureVisualRefresh();

	if (!result || !result.results || result.results.length === 0) {
		return { results: null, message: result?.message };
	}
	return { results: result.results, message: result.message };
}

export async function buildApartments(): Promise<{
	message?: string;
}> {
	try {

		const buildings1 = [
			{ type: "Brickworks" as Building, count: 5, targetLevel: 15 },
			{ type: "LumberMill" as Building, count: 5, targetLevel: 15 },
		];

		const buildings2 = [
			{ type: "Bakery" as Building, count: 15, targetLevel: 15 },
			{ type: "PoultryFarm" as Building, count: 15, targetLevel: 15 },
			{ type: "CheeseMaker" as Building, count: 12, targetLevel: 15 },
			{ type: "FlourMill" as Building, count: 2, targetLevel: 15 },
			{ type: "DairyFarm" as Building, count: 2, targetLevel: 15 }
		];

		const buildings3 = [
			{ type: "Apartment" as Building, count: 750, targetLevel: 10 },
		];

	const build1Result = await doBuildingPlan("right", 10, buildings1, 0, 200);
	const build2Result = await doBuildingPlan("right", 10, buildings2, 6, 200);
	const build3Result = await doBuildingPlan("left", 25, buildings3, 0, 200);

		// Format a single summary string combining the three sub-results.
		const fmt = (r: { results?: Array<{ type: Building; requested: number; placed: number }>; message?: string } | undefined) => {
			if (!r) return "none";
			if (r.message) return r.message;
			if (!r.results || r.results.length === 0) return "none";
			return r.results.map((x) => `${x.type} ${x.placed}/${x.requested}`).join(", ");
		};

		const summary = `materials: ${fmt(build1Result)}; support: ${fmt(build2Result)}; deploy: ${fmt(build3Result)}`;
		return { message: summary };
	} catch (e) {
		return { message: String(e) };
	}
}


export async function prepareCondoMaterials(): Promise<{
	topPlacement: { results: Array<{ type: Building; requested: number; placed: number; }>; } | null;
	cleared: { cleared: number; preservedWonders: number; preservedMines: number; } | null;
	bottomPlacement: { results: Array<{ type: Building; requested: number; placed: number; }>; } | null;
	message?: string;
}> {

	const topSpecs = [
		{ type: "Sandpit" as Building, count: 1, targetLevel: 15 },
		{ type: "SteelMill" as Building, count: 4, targetLevel: 15 },
		{ type: "RebarPlant" as Building, count: 4, targetLevel: 15 },
		{ type: "ConcretePlant" as Building, count: 5, targetLevel: 15 },
		{ type: "ReinforcedConcretePlant" as Building, count: 5, targetLevel: 15 },
		{ type: "IronForge" as Building, count: 5, targetLevel: 15 },
	];

	const topPlacement = await doBuildingPlan("right", 10, topSpecs, 2, 200);

	// Phase 2: clear lower band starting at row index 14 for 15 rows
	const cleared = clearRange("right", 10, 14, 28);

	// Phase 3: build bottom materials starting at row index 14

	const bottomSpecs = [
		{ type: "Pizzeria" as Building, count: 50, targetLevel: 15 },
		{ type: "FlourMill" as Building, count: 5, targetLevel: 15 },
		{ type: "CheeseMaker" as Building, count: 5, targetLevel: 15 },
		{ type: "PoultryFarm" as Building, count: 5, targetLevel: 15 },
		{ type: "DairyFarm" as Building, count: 1, targetLevel: 15 },
	];

	const bottomPlacement =  await doBuildingPlan("right", 10, bottomSpecs, 14, 200);

	// Place coal mines needed for bottom materials — use the helper so we only place mines on valid deposit tiles and never overwrite existing mines.
	const coalPlaced = buildMines("CoalMine" as Building, 15, 2);

	ensureVisualRefresh();

	return { topPlacement: { results: topPlacement.results }, cleared, bottomPlacement: { results: (bottomPlacement).results } };
}

export async function replaceApartmentsWithCondos(): Promise<{
    requested: number;
    placed: number;
    removedApartments: number;
    message?: string;
}> {

	// Use shared helper to determine map size
	const { width, height } = await getMapSize();
	if (!height || height <= 0) {
		return { requested: 850, placed: 0, removedApartments: 0, message: "No map tiles available" };
	}

	// Clear all Apartments from the map
	const cleared = clearRange("left", 25, 0, height - 1);
    const removedApartments = cleared.cleared; // Report total cleared buildings as removedApartments

    // Build Condos into the left 25-strip starting at row 0
    const plan = [{ type: ("Condo" as Building), count: 850, level: 10 }];
    const res = await doBuildingPlan("left", 25, plan, 0, 100);

    const placed = res?.results && res.results.length > 0 ? res.results[0].placed : 0;

    if (placed > 0) clearTransportSourceCache();
    ensureVisualRefresh();
    return { requested: 850, placed, removedApartments };
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
export async function prepareCnTowerMaterials(): 
	Promise<{ nonElectPlacement: 
		{ results: Array<{ type: Building; requested: number; placed: number; }>; } | null; 
			cleared: { cleared: number; preservedWonders: number; preservedMines: number; } | null; 
			electPlacement: { results: Array<{ type: Building; requested: number; placed: number; }>; } | null; 
			message?: string; }> {

	// CN Tower building list (name -> count)
	const cnList: Array<{ type: Building; count: number }> = [
		{ type: "Glassworks" as Building, count: 1 },
		{ type: "GarmentWorkshop" as Building, count: 1 },
		{ type: "LensWorkshop" as Building, count: 1 },
		{ type: "PrintingHouse" as Building, count: 1 },
		{ type: "ActorsGuild" as Building, count: 1 },
		{ type: "PublishingHouse" as Building, count: 4 },
		{ type: "Stadium" as Building, count: 2 },
		{ type: "MovieStudio" as Building, count: 5 },
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
		{ type: "PaintersGuild" as Building, count: 1 },
		{ type: "Museum" as Building, count: 3 },
		{ type: "Courthouse" as Building, count: 3 },
		{ type: "Mosque" as Building, count: 1 },
		{ type: "Parliament" as Building, count: 3 },
		{ type: "CottonPlantation" as Building, count: 1 },
		{ type: "PrintingHouse" as Building, count: 3 },
	];

	// Use shared helper to determine map size
	const { width, height } = await getMapSize();

	const maxX = Math.floor(width) - 1;
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Clear rows 7..10 -> indexes 6..9
	const cleared = clearRange(minX, maxX, 6, 9);

	// Split cnList into electrified vs non-electrified using shared helper
	const { nonElectSpecs, electSpecs } = await splitElectricityBuildings(cnList);

	const nonElectrified = await doBuildingPlan("right", 10, nonElectSpecs, 6, 200);
	const electrified = await doBuildingPlan("right", 10, electSpecs, 24, 200);

	ensureVisualRefresh();
	return { nonElectPlacement: { results: nonElectrified.results }, cleared, electPlacement: { results: electrified.results } };
}


// 007 - Prepare Atomium and Oxford University materials
export async function prepareAtomiumAndOxUni(): Promise<{
	nonElectPlacement: { results: Array<{ type: Building; requested: number; placed: number; }>; } | null;
	clearedTop: { cleared: number; preservedWonders: number; preservedMines: number; } | null;
	clearedBottom: { cleared: number; preservedWonders: number; preservedMines: number; } | null;
	electPlacement: { results: Array<{ type: Building; requested: number; placed: number; }>; } | null;
	message?: string;
}> {

	const gs = getGameState();

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

	// Determine map bounds using shared helper
	const { width, height } = await getMapSize();
	if (!height || height <= 0) {
		return { nonElectPlacement: null, clearedTop: null, clearedBottom: null, electPlacement: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(width) - 1;
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Clear top band rows 7..13 -> indexes 6..12
	const clearedTop = clearRange(minX, maxX, 6, 12);

	// Clear bottom band rows 25..30 -> indexes 24..29
	const clearedBottom = clearRange(minX, maxX, 24, 29);

	buildMines("UraniumMine" as Building, 15, 6);
	buildMines("AluminumSmelter" as Building, 15, 3);

	// Split plan into electrified vs non-electrified using shared helper
	const { nonElectSpecs, electSpecs } = await splitElectricityBuildings(plan);

	const nonElectrified = await doBuildingPlan("right", 10, nonElectSpecs, 6, 200);
	const electPlacement = await doBuildingPlan("right", 10, electSpecs, 24, 200);

	ensureVisualRefresh();
	return { nonElectPlacement: { results: nonElectrified.results }, clearedTop, clearedBottom, electPlacement: { results: electPlacement.results } };
}

// 008 - Prepare Clone Labs
export async function prepareCloneLabs(): 
	Promise<{ nonElectPlacement: { results: Array<{ type: Building; requested: number; placed: number; }>; } | null; 
				clearedTop: { cleared: number; preservedWonders: number; preservedMines: number; } | null; 
				clearedBottom: { cleared: number; preservedWonders: number; preservedMines: number; } | null; 
				electPlacement: { results: Array<{ type: Building; requested: number; placed: number; }>; } | null; 
				message?: string; }> {

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
					
	const gs = getGameState();

	// Determine map bounds using shared helper
	const { width, height } = await getMapSize();
	if (!height || height <= 0) {
		return { nonElectPlacement: null, clearedTop: null, clearedBottom: null, electPlacement: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(width) - 1;
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Clear areas
	const clearedTop = clearRange(minX, maxX, 6, 12);
	const clearedBottom = clearRange(minX, maxX, 24, 29);

	buildMines("OilWell" as Building, 15, 3);

	// Split plan into electrified vs non-electrified using shared helper
	const { nonElectSpecs, electSpecs } = await splitElectricityBuildings(plan);

	const nonElectrified = await doBuildingPlan("right", 10, nonElectSpecs, 6, 200);
	const electrified = await doBuildingPlan("right", 10, electSpecs, 24, 200);
	
	ensureVisualRefresh();
	return { nonElectPlacement: { results: nonElectrified.results }, clearedTop, clearedBottom, electPlacement: { results: electrified.results } };
}


// 009 - Build Clone Labs
export async function buildCloneLabs(): Promise<{
	requested: number;
	placed: number;
	remaining: number;
	chunks: number[];
	removedCondos: number;
	message?: string;
}> {
	const TOTAL = 860;
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

	// Determine left-hand strip bounds using shared helper (assume left origin at x=0)
	const { width, height } = await getMapSize();
	if (width === 0 || height === 0) {
		return { requested: TOTAL, placed: 0, remaining: TOTAL, chunks: [], removedCondos: removed, message: "No map tiles available" };
	}

	// LEFT-hand 20-tile-wide strip anchored at x=0
	const minX = 0;
	const maxX = Math.min(Math.floor(width) - 1, minX + 19);
	const minY = 0;
	const maxY = Math.floor(height) - 1;

	// Use the simple doBuildingPlan to place all CloneLabs sequentially.
	const plan = [{ type: ("CloneLab" as Building), count: TOTAL, level: 10 }];
	const res = await doBuildingPlan("left", 20, plan, 0, 0);

	const placed = res?.results && res.results.length > 0 ? res.results[0].placed : 0;

	// Ensure all CloneLabs in the left strip have inputResource set to "Spacecraft"
	for (const [xy, td] of getGameState().tiles.entries()) {
		if (!td || !td.building) continue;
		const p = tileToPoint(xy);
		if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
		if (td.building.type === ("CloneLab" as Building)) {
			(td.building as ICloneBuildingData).inputResource = "Spacecraft";
			if ((td.building as ICloneBuildingData).transportedAmount === undefined) (td.building as ICloneBuildingData).transportedAmount = 0;
		}
	}

	if (placed > 0) clearTransportSourceCache();
	ensureVisualRefresh();
	return { requested: TOTAL, placed, remaining: Math.max(0, TOTAL - placed), chunks: [], removedCondos: removed };
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
	cleared: { cleared: number; preservedWonders: number; preservedMines: number } | null;
	smallRowPlacement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	nonElectPlacement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	electPlacement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	leftStripPlacement: Array<{ type: Building; requested: number; placed: number; remaining: number }>;
	message?: string;
}> {
	removeBuildingsByDisplayNames(["Clone Lab"]);
	ensureVisualRefresh();

	// Determine rightmost strip bounds using centralized helper
	const { width, height } = await getMapSize();
	if (width === 0 || height === 0) {
		return { cleared: null, smallRowPlacement: null, nonElectPlacement: null, electPlacement: null, leftStripPlacement: [], message: "No map tiles available" };
	}

	const maxX = width - 1;
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Clear rows 7..40 -> indexes 6..39 (extended by 10 rows)
	const clearMinY = 6;
	const clearMaxY = Math.min(height - 1, 39);
	const cleared = clearRange(minX, maxX, clearMinY, clearMaxY);

	// In row 7 (index 6) place small set
	const smallSpecs = [
		{ type: "Pizzeria" as Building, count: 1, targetLevel: 15 },
		{ type: "PoultryFarm" as Building, count: 1, targetLevel: 15 },
		{ type: "FlourMill" as Building, count: 1, targetLevel: 15 },
		{ type: "CheeseMaker" as Building, count: 1, targetLevel: 15 },
		{ type: "DairyFarm" as Building, count: 1, targetLevel: 15 },
	];
	const smallRowPlacement = await doBuildingPlan("right", (maxX - minX) + 1, smallSpecs, 6, 0);

	try {
		ensureVisualRefresh();
	} catch (e) {
		console.error("Immediate refresh failed in dysonBuildPlan1:", e);
	}

	// Present a compact toast summary for the user
	try {
		const smallSummary = smallRowPlacement.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
		showToast(`Dyson Plan 1 complete: removedCloneLabs ; cleared ${cleared?.cleared ?? 0}; smallRow: ${smallSummary}`);
	} catch (e) {
		// swallowing toast errors to avoid breaking game logic
		console.error("showToast failed in dysonBuildPlan1:", e);
	}
	return {
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

	// Determine map bounds via centralized helper
	const { width, height } = await getMapSize();
	if (width === 0 || height === 0) {
		return { placement: null, message: "No map tiles available" };
	}

	const maxX = width - 1;
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Row 9 -> index 8, take 12 rows -> indexes 8..19
	const startY = 8;
	const endY = Math.min(height - 1, startY + 11);

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
		// Use centralized sequential placer to request the full count with 200ms spacing.
		try {
			const dp = await doBuildingPlan("right", 10, [{ type: spec.type, count: spec.count, level: 10 }], startY, 200);
			const placed = dp.results.length > 0 ? dp.results[0].placed : 0;
			const entry = summaryMap.get(spec.type);
			if (entry) entry.placed += placed;
		} catch (e) {
			console.error("dysonBuildPlan2: placement failed for", spec.type, e);
		}
	}

	const results = Array.from(summaryMap.values());
	return { placement: { results } };
}

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

		const { width, height } = await getMapSize();
		if (width === 0 || height === 0) {
			return { removed, leftStripPlacement: [], message: "No map tiles available" };
		}
		const minX = 0;
		const maxX = Math.min(width - 1, minX + 19);
		const minY = 0;
		const maxY = height - 1;

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

			// Place the requested total sequentially using doBuildingPlan in the leftmost 20-tile strip.
			try {
				const dp = await doBuildingPlan("left", 20, [{ type: item.type, count: item.total, level: 10 }], 0, 200);
				const placed = dp.results.length > 0 ? dp.results[0].placed : 0;
				summaryEntry.placed += placed;
				summaryEntry.remaining -= placed;
			} catch (e) {
				console.error("aldersonDisc4: placement failed for", item.type, e);
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
		const { width, height } = await getMapSize();
		if (width === 0 || height === 0) {
			return { removed, cleared: null, message: "No map tiles available" };
		}
		const maxX = Math.floor(width) - 1;
		const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

		const minY = 8; // row 9 -> index 8
		const maxY = Math.min(Math.floor(height) - 1, 38);

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

		// Determine map bounds using shared helper
		const { width, height } = await getMapSize();
		if (width === 0 || height === 0) {
			return { placement: null, message: "No map tiles available" };
		}

		const maxX = Math.floor(width) - 1;
		const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

		const startY = 8; // row 9 -> index 8
		const endY = Math.min(Math.floor(height) - 1, Math.floor(height) - 1);

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
			// Use doBuildingPlan to sequentially place the requested count into the rightmost 10-tile band.
			try {
				const dp = await doBuildingPlan("right", 10, [{ type: spec.type, count: spec.count, level: 10 }], startY, 200);
				const placed = dp.results.length > 0 ? dp.results[0].placed : 0;
				const entry = summaryMap.get(spec.type);
				if (entry) entry.placed += placed;
			} catch (e) {
				console.error("largeHadronCollider2: placement failed for", spec.type, e);
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

		// Determine map bounds via centralized helper
		const { width, height } = await getMapSize();
		if (width === 0 || height === 0) {
			return { placement: null, message: "No map tiles available" };
		}
		const maxX = width - 1;
		const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

		const startY = 24; // row 25 -> index 24
		const endY = height - 1;

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

		// Split to electrified / non-electrified using centralized helper
		const { nonElectSpecs, electSpecs } = await splitElectricityBuildings(Array.from(agg.values()).map((v) => ({ type: v.type, count: v.requested })));
		// Preserve the original targetLevel used by callers (10)
		for (const s of electSpecs) { s.targetLevel = 10; }

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
			// Place the whole requested count sequentially using doBuildingPlan (right 10-band)
			try {
				const dp = await doBuildingPlan("right", 10, [{ type: spec.type, count: spec.count, level: 10 }], startY, 200);
				const placed = dp.results.length > 0 ? dp.results[0].placed : 0;
				const entry = summaryMap.get(spec.type);
				if (entry) entry.placed += placed;
			} catch (e) {
				console.error("largeHadronCollider3: placement failed for", spec.type, e);
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

	// Determine map bounds via centralized helper. Assume left origin at x=0.
	const { width, height } = await getMapSize();
	if (width === 0 || height === 0) {
		return { leftStripPlacement: [], message: "No map tiles available" };
	}
	// LEFT-hand 20-tile-wide strip anchored at x=0
	const minX = 0;
	const maxX = Math.min(width - 1, minX + 19);
	const minY = 0;
	const maxY = height - 1;

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
		// Defensive: skip unknown building types
		try {
			if (!Config.Building[item.type]) {
				console.warn("dysonBuildPlan4: unknown building type, skipping:", item.type);
				results.push(summaryEntry);
				continue;
			}
		} catch (e) {
			console.warn("dysonBuildPlan4: Config check failed for", item.type, e);
			results.push(summaryEntry);
			continue;
		}

		try {
			const dp = await doBuildingPlan("left", 20, [{ type: item.type, count: item.total, level: 10 }], 0, 200);
			const placed = dp.results.length > 0 ? dp.results[0].placed : 0;
			summaryEntry.placed += placed;
			summaryEntry.remaining -= placed;
		} catch (e) {
			console.error("dysonBuildPlan4: placement failed for", item.type, e);
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

	// Determine left-hand strip bounds using centralized helper; assume left-edge at x=0
	const { width, height } = await getMapSize();
	if (width === 0 || height === 0) {
		return { leftStripPlacement: [], removed, message: "No map tiles available" };
	}
	const minX = 0;
	const maxX = Math.min(width - 1, minX + 34); // 35 tiles wide
	const minY = 0;
	const maxY = height - 1;

	const plan: Array<{ type: Building; total: number }> = [
		{ type: "HedgeFund" as Building, total: 400 },
		{ type: "SupercomputerLab" as Building, total: 400 },
		{ type: "CivTok" as Building, total: 550 },
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

		// Place the requested total sequentially using doBuildingPlan (left, 25-wide)
		try {
			const dp = await doBuildingPlan("left", 25, [{ type: item.type, count: item.total, level: 10 }], 0, 200);
			const placed = dp && dp.results.length > 0 ? dp.results[0].placed : 0;
			summaryEntry.placed += placed;
			summaryEntry.remaining -= placed;
		} catch (e) {
			console.error("largeHadronCollider4: placement failed for", item.type, e);
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
	const { width, height } = await getMapSize();
	if (width === 0 || height === 0) {
		return { removed, cleared: null, message: "No map tiles available" };
	}
	const maxX = Math.floor(width) - 1;
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	const minY = 8; // row 9 -> index 8
	const maxY = Math.min(Math.floor(height) - 1, 38);

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

	const res = await doBuildingPlan("right", 10, plan, 8, 200);

	// Map doBuildingPlan result -> original shape
	if (res.message === "No map tiles available") {
	return { placement: null, message: res.message };
	}
	try {
	const summary = res.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
	showToast(`Build Space Center 2 complete: ${summary}`);
	} catch (e) {
	console.error("showToast failed in buildSpaceCenter2_v2:", e);
	}
	return { placement: { results: res.results }, message: res.message };
}


export async function buildSpaceCenter3(): Promise<{
	placement: { results: Array<{ type: Building; requested: number; placed: number }> } | null;
	message?: string;
}> {

	const { width, height } = await getMapSize();
	if (width === 0 || height === 0) {
		return { placement: null, message: "No map tiles available" };
	}

	const startY = 24; // row 25 -> index 24

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

	// Simplify: treat this as a normal building plan and place directly using doBuildingPlan
	const plan = Array.from(candidates).map((v) => ({ type: v.type, count: v.count, level: 10 }));
	const buildingResult = await doBuildingPlan("right", 10, plan, startY, 200);

	try { ensureVisualRefresh(); } catch (e) { console.error("ensureVisualRefresh failed in buildSpaceCenter3:", e); }
	
	try {
		const summary = buildingResult.results.map((r) => `${r.type} ${r.placed}/${r.requested}`).join(", ");
		showToast(`Build Space Center 3 complete: ${summary}`);
	} catch (e) {
		console.error("showToast failed in buildSpaceCenter3:", e);
	}

	return { placement: { results: buildingResult.results } };
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

		// Place requested total sequentially in the left 25-tile strip using doBuildingPlan
		try {
			const dp = await doBuildingPlan("left", 25, [{ type: item.type, count: item.total, level: 10 }], 0, 200);
			const placed = dp && dp.results.length > 0 ? dp.results[0].placed : 0;
			summaryEntry.placed += placed;
			summaryEntry.remaining -= placed;
		} catch (e) {
			console.error("buildSpaceCenter4: placement failed for", item.type, e);
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

	// Determine map bounds via centralized helper
	const { width, height } = await getMapSize();
	if (width === 0 || height === 0) {
		return { placement: null, message: "No map tiles available" };
	}
	const maxX = width - 1;
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Row 25 -> index 24, take 10 rows -> indexes 24..33
	const startY = 24;
	const endY = Math.min(height - 1, startY + 9);

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
		// Use doBuildingPlan to place the full requested count sequentially into the rightmost 10-tile band.
		try {
			const dp = await doBuildingPlan("right", 10, [{ type: spec.type, count: spec.count, level: 10 }], startY, 200);
			const placed = dp.results.length > 0 ? dp.results[0].placed : 0;
			const entry = summaryMap.get(spec.type);
			if (entry) entry.placed += placed;
		} catch (e) {
			console.error("dysonBuildPlan3: placement failed for", spec.type, e);
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

export async function aldersonDisc1(): Promise<{
	cleared: { cleared: number; preservedWonders: number; preservedMines: number } | null;
	message?: string;
}> {
	const gs = getGameState();

	// Determine map bounds using shared helper
	const { width, height } = await getMapSize();
	if (width === 0 || height === 0) {
		return { cleared: null, message: "No map tiles available" };
	}

	const maxX = Math.floor(width) - 1;
	const minX = Math.max(0, maxX - 9); // rightmost 10-tile band

	// Rows 9..39 -> indexes 8..38 (clamped to map height)
	const minY = 8;
	const maxY = Math.min(Math.floor(height) - 1, 38);

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
			// Place the whole requested count sequentially into the rightmost 10-tile band
			try {
				const dp = await doBuildingPlan("right", 10, [{ type: spec.type, count: spec.count, level: 10 }], startY, 200);
				const placed = dp.results.length > 0 ? dp.results[0].placed : 0;
				const entry = summaryMap.get(spec.type);
				if (entry) entry.placed += placed;
			} catch (e) {
				console.error("aldersonDisc2: placement failed for", spec.type, e);
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

	// Split to electrified / non-electrified using centralized helper
	const { nonElectSpecs, electSpecs } = await splitElectricityBuildings(Array.from(agg.values()).map((v) => ({ type: v.type, count: v.requested })));
	for (const s of electSpecs) { s.targetLevel = 10; }

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
		// Place the entire requested count sequentially into the rightmost 10-tile band
		try {
			const dp = await doBuildingPlan("right", 10, [{ type: spec.type, count: spec.count, level: 10 }], startY, 200);
			const placed = dp.results.length > 0 ? dp.results[0].placed : 0;
			const entry = summaryMap.get(spec.type);
			if (entry) entry.placed += placed;
		} catch (e) {
			console.error("aldersonDisc3: placement failed for", spec.type, e);
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


