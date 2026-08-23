import type { Building } from "../../shared/definitions/BuildingDefinitions";
import type { Deposit } from "../../shared/definitions/MaterialDefinitions";
import type { Tech } from "../../shared/definitions/TechDefinitions";
import {
    applyBuildingDefaults,
    findSpecialBuilding,
    getBottomRightEmptyTile,
} from "../../shared/logic/BuildingLogic";
import { getGameOptions, getGameState, notifyGameStateUpdate } from "../../shared/logic/GameStateLogic";
import { clearIntraTickCache, getGrid } from "../../shared/logic/IntraTickCache";
import { getTotalTechUnlockCost, tryDeductScience, unlockTech } from "../../shared/logic/TechLogic";
import { sortByDistance } from "../../shared/logic/TerrainLogic";
import { makeBuilding, type IBuildingData } from "../../shared/logic/Tile";
import { clearTransportSourceCache, OnBuildingOrUpgradeComplete } from "../../shared/logic/Update";
import { isEmpty, tileToPoint, type Tile } from "../../shared/utilities/Helper";

const AUTOMATED_BUILDING_LEVEL = 12;
const PHASE_FOUR_DEPOSIT_MINE_COUNT = 7;
const PHASE_FOUR_DEPOSIT_MINE_REQUESTS = [
   { deposit: "Stone", type: "StoneQuarry" },
   { deposit: "Wood", type: "LoggingCamp" },
   { deposit: "Water", type: "Aqueduct" },
] as const;
const PHASE_FIVE_BUILDING_REQUESTS = [
   { type: "WheatFarm", count: 2 },
   { type: "House", count: 20 },
] as const;
const PHASE_SIX_BUILDING_LEVEL = 15;
const PHASE_SIX_STRIP_WIDTH = 15;
const PHASE_SIX_BUILDING_REQUESTS = [
   { type: "Brickworks", count: 10 },
   { type: "LumberMill", count: 10 },
   { type: "CheeseMaker", count: 15 },
   { type: "PoultryFarm", count: 15 },
   { type: "Bakery", count: 15 },
   { type: "DairyFarm", count: 5 },
   { type: "FlourMill", count: 5 },
   { type: "WheatFarm", count: 2 },
] as const;
const AUTOMATED_RESEARCH_INTERVAL_MS = 10_000;
const PHASE_EIGHT_BUILDING_LEVEL = 12;
const PHASE_EIGHT_STRIP_WIDTH = 30;
const PHASE_EIGHT_APARTMENT_COUNT = 900;
const PHASE_TEN_MISSING_TIER_ONE_COUNT = 8;
const PHASE_TEN_MISSING_TIER_ONE_LEVEL = 12;
type PhaseTenBuildingRequest = {
   type: Building;
   count: number;
   desiredLevel: number;
   deposit?: Deposit;
};
type PhaseTenPlacedBuilding = {
   building: IBuildingData;
   desiredLevel: number;
};
const PHASE_TEN_BUILDING_REQUESTS: ReadonlyArray<PhaseTenBuildingRequest> = [
   { type: "WheatFarm", count: 1, desiredLevel: 12 },
   { type: "StoneQuarry", count: 1, desiredLevel: 12, deposit: "Stone" },
   { type: "LoggingCamp", count: 1, desiredLevel: 12, deposit: "Wood" },
   { type: "Aqueduct", count: 1, desiredLevel: 12, deposit: "Water" },
   { type: "IronMiningCamp", count: 1, desiredLevel: 12, deposit: "Iron" },
   { type: "CopperMiningCamp", count: 1, desiredLevel: 12, deposit: "Copper" },
   { type: "CottonPlantation", count: 1, desiredLevel: 12 },
   { type: "Stable", count: 1, desiredLevel: 12 },
   { type: "Brewery", count: 2, desiredLevel: 12 },
   { type: "PaperMaker", count: 2, desiredLevel: 12 },
   { type: "LumberMill", count: 2, desiredLevel: 12 },
   { type: "IronForge", count: 2, desiredLevel: 12 },
   { type: "CottonMill", count: 2, desiredLevel: 12 },
   { type: "Shrine", count: 10, desiredLevel: 15 },
   { type: "Marbleworks", count: 2, desiredLevel: 12 },
   { type: "Armory", count: 2, desiredLevel: 12 },
   { type: "SwordForge", count: 2, desiredLevel: 12 },
   { type: "FurnitureWorkshop", count: 2, desiredLevel: 12 },
   { type: "MusiciansGuild", count: 2, desiredLevel: 12 },
   { type: "PaintersGuild", count: 2, desiredLevel: 12 },
   { type: "PoetrySchool", count: 10, desiredLevel: 15 },
   { type: "KnightCamp", count: 2, desiredLevel: 12 },
   { type: "University", count: 2, desiredLevel: 12 },
   { type: "Museum", count: 2, desiredLevel: 12 },
   { type: "Courthouse", count: 5, desiredLevel: 12 },
   { type: "Parliament", count: 10, desiredLevel: 15 },
];
const PHASE_TEN_TIER_ONE_BUILDINGS: ReadonlySet<Building> = new Set([
   "WheatFarm",
   "StoneQuarry",
   "LoggingCamp",
   "Aqueduct",
   "IronMiningCamp",
   "CopperMiningCamp",
   "CottonPlantation",
]);
const PHASE_ELEVEN_BUILDING_LEVEL = 1;
const PHASE_ELEVEN_BUILDING_TYPES: ReadonlyArray<Building> = ["BigBen", "LuxorTemple", "HagiaSophia"];
let automateBuildRun: Promise<void> | undefined;

/**
 * Finds the first building of the requested type in the current game state.
 *
 * This routine only reads the current tiles. It returns the matching building immediately, or throws
 * when the current game has no building of that type.
 */
function findInitialBuilding(buildingType: Building): IBuildingData {
   for (const tile of getGameState().tiles.values()) {
      if (tile.building?.type === buildingType) {
         return tile.building;
      }
   }

   throw new Error(`No initial ${buildingType} exists in the current game.`);
}

/**
 * Requests that one building reach the supplied target level, defaulting to `AUTOMATED_BUILDING_LEVEL`.
 *
 * It raises the building's desired level without lowering an existing higher target, updates its status,
 * clears the two game caches affected by construction, and notifies the game state. It does not wait for
 * construction and returns nothing.
 */
function requestAutomatedBuildLevel(building: IBuildingData, targetLevel = AUTOMATED_BUILDING_LEVEL): void {
   building.desiredLevel = Math.max(building.desiredLevel, targetLevel);
   building.status =
      building.level >= building.desiredLevel ? "completed" : building.level > 0 ? "upgrading" : "building";
   clearIntraTickCache();
   clearTransportSourceCache();
   notifyGameStateUpdate(getGameState());
}

/**
 * Waits until the supplied building reaches the supplied target level, defaulting to
 * `AUTOMATED_BUILDING_LEVEL`.
 *
 * If the building is already at or above that level, the returned Promise resolves immediately. Otherwise
 * it listens for building or upgrade completion events, checks the level after each event, removes its
 * listener when the target is reached, and then resolves. It does not start or modify construction.
 */
function waitForAutomatedBuildCompletion(
   building: IBuildingData,
   targetLevel = AUTOMATED_BUILDING_LEVEL,
): Promise<void> {
   if (building.level >= targetLevel) {
      return Promise.resolve();
   }

   return new Promise((resolve) => {
      const checkCompletion = () => {
         if (building.level >= targetLevel) {
            OnBuildingOrUpgradeComplete.off(checkCompletion);
            resolve();
         }
      };

      OnBuildingOrUpgradeComplete.on(checkCompletion);
      checkCompletion();
   });
}

/**
 * Places the Phase 4 mines on the seven closest unused deposits of each requested resource from the
 * bottom-right side of the map. It validates every request before changing any tile and returns the
 * placed buildings for level-12 construction.
 */
function buildPhaseFourDepositMines(): IBuildingData[] {
   const gameState = getGameState();
   const bottomRightTile = getBottomRightEmptyTile(gameState)?.[0];
   if (!bottomRightTile) {
      throw new Error("No empty bottom-right reference tile exists for Phase 4.");
   }

   const reservedTiles = new Set<Tile>();
   const selectedMines = PHASE_FOUR_DEPOSIT_MINE_REQUESTS.map((request) => {
      const tiles = sortByDistance(
         (tile) => !!tile.deposit[request.deposit] && !tile.building && !reservedTiles.has(tile.tile),
         bottomRightTile,
         gameState,
      ).slice(0, PHASE_FOUR_DEPOSIT_MINE_COUNT);

      if (tiles.length < PHASE_FOUR_DEPOSIT_MINE_COUNT) {
         throw new Error(`Phase 4 requires seven unused ${request.deposit} deposits.`);
      }

      tiles.forEach((tile) => reservedTiles.add(tile.tile));
      return { request, tiles };
   });

   const options = getGameOptions();
   const buildings: IBuildingData[] = [];
   for (const { request, tiles } of selectedMines) {
      for (const tile of tiles) {
         const building = applyBuildingDefaults(makeBuilding({ type: request.type }), options);
         tile.building = building;
         buildings.push(building);
      }
   }

   clearIntraTickCache();
   clearTransportSourceCache();
   notifyGameStateUpdate(gameState);
   return buildings;
}

/**
 * Places the Phase 5 farms and houses on the closest available non-deposit tiles to the HQ. It validates
 * all 22 placements before changing any tile and returns the placed buildings for level-12 construction.
 */
function buildPhaseFiveBuildings(): IBuildingData[] {
   const gameState = getGameState();
   const headquarters = findSpecialBuilding("Headquarter", gameState);
   if (!headquarters) {
      throw new Error("No Headquarter exists for Phase 5.");
   }

   const reservedTiles = new Set<Tile>();
   const selectedBuildings = PHASE_FIVE_BUILDING_REQUESTS.map((request) => {
      const tiles = sortByDistance(
         (tile) => !tile.building && isEmpty(tile.deposit) && !reservedTiles.has(tile.tile),
         headquarters.tile,
         gameState,
      ).slice(0, request.count);

      if (tiles.length < request.count) {
         throw new Error(`Phase 5 requires ${request.count} empty tiles for ${request.type} buildings.`);
      }
      tiles.forEach((tile) => reservedTiles.add(tile.tile));
      return { request, tiles };
   });

   const options = getGameOptions();
   const buildings: IBuildingData[] = [];
   for (const { request, tiles } of selectedBuildings) {
      for (const tile of tiles) {
         const building = applyBuildingDefaults(makeBuilding({ type: request.type }), options);
         tile.building = building;
         buildings.push(building);
      }
   }

   clearIntraTickCache();
   clearTransportSourceCache();
   notifyGameStateUpdate(gameState);
   return buildings;
}

/**
 * Places the Phase 6 buildings in the rightmost 15 columns, ordered from the top row left to right. It
 * leaves deposit tiles and occupied tiles empty, validates all requested placements first, and returns the
 * placed buildings for level-15 construction.
 */
function buildPhaseSixBuildings(): IBuildingData[] {
   const gameState = getGameState();
   const grid = getGrid(gameState);
   const rightStripStart = Math.max(0, grid.maxX - PHASE_SIX_STRIP_WIDTH);
   const availableTiles = Array.from(gameState.tiles.values())
      .filter((tile) => {
         if (tile.building || !isEmpty(tile.deposit)) {
            return false;
         }

         const point = tileToPoint(tile.tile);
         return point.x >= rightStripStart && point.x < grid.maxX;
      })
      .sort((left, right) => {
         const leftPoint = tileToPoint(left.tile);
         const rightPoint = tileToPoint(right.tile);
         return leftPoint.y - rightPoint.y || leftPoint.x - rightPoint.x;
      });

   const requiredTileCount = PHASE_SIX_BUILDING_REQUESTS.reduce((total, request) => total + request.count, 0);
   if (availableTiles.length < requiredTileCount) {
      throw new Error(`Phase 6 requires ${requiredTileCount} empty tiles in the right-side strip.`);
   }

   const options = getGameOptions();
   const buildings: IBuildingData[] = [];
   let tileIndex = 0;
   for (const request of PHASE_SIX_BUILDING_REQUESTS) {
      for (let count = 0; count < request.count; count++) {
         const tile = availableTiles[tileIndex++];
         const building = applyBuildingDefaults(makeBuilding({ type: request.type }), options);
         tile.building = building;
         buildings.push(building);
      }
   }

   clearIntraTickCache();
   clearTransportSourceCache();
   notifyGameStateUpdate(gameState);
   return buildings;
}

/**
 * Starts a ten-second science check for the supplied technology. Once it and any missing prerequisites can
 * be paid for, it unlocks them and resolves the phase.
 */
function waitForAutomatedResearch(tech: Tech): Promise<void> {
   const gameState = getGameState();
   if (gameState.unlockedTech[tech]) {
      return Promise.resolve();
   }

   return new Promise((resolve, reject) => {
      const timer = window.setInterval(() => {
         try {
            if (gameState.unlockedTech[tech]) {
               window.clearInterval(timer);
               resolve();
               return;
            }

            const { totalScience, prerequisites } = getTotalTechUnlockCost(tech, gameState);
            if (!tryDeductScience(totalScience, gameState)) {
               return;
            }

            prerequisites.push(tech);
            prerequisites.forEach((tech) => unlockTech(tech, true, gameState));
            notifyGameStateUpdate(gameState);
            window.clearInterval(timer);
            resolve();
         } catch (error) {
            window.clearInterval(timer);
            reject(error);
         }
      }, AUTOMATED_RESEARCH_INTERVAL_MS);
   });
}

/**
 * Starts Phase 7's ten-second science check for Democracy.
 */
function waitForPhaseSevenResearch(): Promise<void> {
   return waitForAutomatedResearch("Democracy");
}

/**
 * Starts Phase 9's ten-second science check for Capitalism.
 */
function waitForPhaseNineResearch(): Promise<void> {
   return waitForAutomatedResearch("Capitalism");
}

/**
 * Places Phase 8's Apartments in the leftmost 30 columns, ordered from the top row left to right. It
 * allows deposits but skips every tile that already contains a building and validates all placements first.
 */
function buildPhaseEightApartments(): IBuildingData[] {
   const gameState = getGameState();
   const grid = getGrid(gameState);
   const availableTiles = Array.from(gameState.tiles.values())
      .filter((tile) => {
         if (tile.building) {
            return false;
         }

         return tileToPoint(tile.tile).x < Math.min(PHASE_EIGHT_STRIP_WIDTH, grid.maxX);
      })
      .sort((left, right) => {
         const leftPoint = tileToPoint(left.tile);
         const rightPoint = tileToPoint(right.tile);
         return leftPoint.y - rightPoint.y || leftPoint.x - rightPoint.x;
      });

   if (availableTiles.length < PHASE_EIGHT_APARTMENT_COUNT) {
      throw new Error(
         `Phase 8 requires ${PHASE_EIGHT_APARTMENT_COUNT} available tiles in the left-side strip.`,
      );
   }

   const options = getGameOptions();
   const buildings: IBuildingData[] = [];
   for (const tile of availableTiles.slice(0, PHASE_EIGHT_APARTMENT_COUNT)) {
      const building = applyBuildingDefaults(makeBuilding({ type: "Apartment" }), options);
      tile.building = building;
      buildings.push(building);
   }

   clearIntraTickCache();
   clearTransportSourceCache();
   notifyGameStateUpdate(gameState);
   return buildings;
}

function buildPhaseTenBuildings(): PhaseTenPlacedBuilding[] {
   const gameState = getGameState();
   const missingTierOneRequests = PHASE_TEN_BUILDING_REQUESTS.filter(
      (request) =>
         PHASE_TEN_TIER_ONE_BUILDINGS.has(request.type) &&
         !Array.from(gameState.tiles.values()).some((tile) => tile.building?.type === request.type),
   );
   const missingTierOneBuildingTypes = new Set(missingTierOneRequests.map((request) => request.type));
   const options = getGameOptions();
   const missingTierOneBuildings: PhaseTenPlacedBuilding[] = [];
   if (missingTierOneRequests.length > 0) {
      const bottomRightTile = getBottomRightEmptyTile(gameState)?.[0];
      if (!bottomRightTile) {
         throw new Error("No empty bottom-right reference tile exists for Phase 10.");
      }

      const reservedTiles = new Set<Tile>();
      for (const request of missingTierOneRequests) {
         const tiles = sortByDistance(
            (tile) =>
               !tile.building &&
               !reservedTiles.has(tile.tile) &&
               (request.deposit ? !!tile.deposit[request.deposit] : isEmpty(tile.deposit)),
            bottomRightTile,
            gameState,
         ).slice(0, PHASE_TEN_MISSING_TIER_ONE_COUNT);
         if (tiles.length < PHASE_TEN_MISSING_TIER_ONE_COUNT) {
            const requirement = request.deposit ? `${request.deposit} deposits` : "empty non-deposit tiles";
            throw new Error(
               `Phase 10 requires ${PHASE_TEN_MISSING_TIER_ONE_COUNT} ${request.type} buildings on ${requirement}.`,
            );
         }

         for (const tile of tiles) {
            reservedTiles.add(tile.tile);
            const building = applyBuildingDefaults(makeBuilding({ type: request.type }), options);
            tile.building = building;
            missingTierOneBuildings.push({
               building,
               desiredLevel: PHASE_TEN_MISSING_TIER_ONE_LEVEL,
            });
         }
      }
   }

   const grid = getGrid(gameState);
   const rightStripStart = Math.max(0, grid.maxX - PHASE_SIX_STRIP_WIDTH);
   const availableTiles = Array.from(gameState.tiles.values())
      .filter((tile) => {
         if (tile.building) {
            return false;
         }

         const point = tileToPoint(tile.tile);
         return point.x >= rightStripStart && point.x < grid.maxX;
      })
      .sort((left, right) => {
         const leftPoint = tileToPoint(left.tile);
         const rightPoint = tileToPoint(right.tile);
         return leftPoint.y - rightPoint.y || leftPoint.x - rightPoint.x;
      });

   const buildings: PhaseTenPlacedBuilding[] = [...missingTierOneBuildings];
   for (const request of PHASE_TEN_BUILDING_REQUESTS) {
      if (missingTierOneBuildingTypes.has(request.type)) {
         continue;
      }

      for (let count = 0; count < request.count; count++) {
         const tileIndex = availableTiles.findIndex((tile) =>
            request.deposit ? !!tile.deposit[request.deposit] : true,
         );
         if (tileIndex < 0) {
            const requirement = request.deposit ? `${request.deposit} deposit` : "empty tile";
            throw new Error(
               `Phase 10 requires ${request.count} ${request.type} building(s) on an ${requirement}.`,
            );
         }

         const tile = availableTiles.splice(tileIndex, 1)[0];
         const building = applyBuildingDefaults(makeBuilding({ type: request.type }), options);
         tile.building = building;
         buildings.push({ building, desiredLevel: request.desiredLevel });
      }
   }

   clearIntraTickCache();
   clearTransportSourceCache();
   notifyGameStateUpdate(gameState);
   return buildings;
}

/**
 * Runs Phase 6's level-15 construction and resolves when every Phase 6 building reaches level 15.
 */
async function executePhaseSix(): Promise<void> {
   const phaseSixBuildings = buildPhaseSixBuildings();
   phaseSixBuildings.forEach((building) => requestAutomatedBuildLevel(building, PHASE_SIX_BUILDING_LEVEL));
   await Promise.all(
      phaseSixBuildings.map((building) =>
         waitForAutomatedBuildCompletion(building, PHASE_SIX_BUILDING_LEVEL),
      ),
   );
}

async function executePhaseTen(): Promise<void> {
   const phaseTenBuildings = buildPhaseTenBuildings();
   phaseTenBuildings.forEach(({ building, desiredLevel }) =>
      requestAutomatedBuildLevel(building, desiredLevel),
   );
   await Promise.all(
      phaseTenBuildings.map(({ building, desiredLevel }) =>
         waitForAutomatedBuildCompletion(building, desiredLevel),
      ),
   );
}

function buildPhaseElevenWonders(): IBuildingData[] {
   const gameState = getGameState();
   const missingWonders = PHASE_ELEVEN_BUILDING_TYPES.filter(
      (buildingType) =>
         !Array.from(gameState.tiles.values()).some((tile) => tile.building?.type === buildingType),
   );
   if (missingWonders.length === 0) {
      return [];
   }

   const bottomRightTile = getBottomRightEmptyTile(gameState)?.[0];
   if (!bottomRightTile) {
      throw new Error("No empty bottom-right reference tile exists for Phase 11.");
   }

   const availableTiles = sortByDistance(
      (tile) => !tile.building && isEmpty(tile.deposit),
      bottomRightTile,
      gameState,
   ).slice(0, missingWonders.length);
   if (availableTiles.length < missingWonders.length) {
      throw new Error(`Phase 11 requires ${missingWonders.length} empty tiles near the bottom right.`);
   }

   const options = getGameOptions();
   const buildings: IBuildingData[] = [];
   for (const [index, tile] of availableTiles.entries()) {
      const building = applyBuildingDefaults(makeBuilding({ type: missingWonders[index] }), options);
      tile.building = building;
      buildings.push(building);
   }

   clearIntraTickCache();
   clearTransportSourceCache();
   notifyGameStateUpdate(gameState);
   return buildings;
}

async function executePhaseEleven(): Promise<void> {
   const phaseElevenBuildings = buildPhaseElevenWonders();
   phaseElevenBuildings.forEach((building) =>
      requestAutomatedBuildLevel(building, PHASE_ELEVEN_BUILDING_LEVEL),
   );
   await Promise.all(
      phaseElevenBuildings.map((building) =>
         waitForAutomatedBuildCompletion(building, PHASE_ELEVEN_BUILDING_LEVEL),
      ),
   );
}

/**
 * Executes the eleven automation phases, with Phase 7 running alongside Phase 6, Phase 9 running alongside
 * Phase 8, and Phase 10 and Phase 11 starting after Phases 9 and 10 complete respectively.
 *
 * Phase 1 requests the initial Stone Quarry to level 12 and waits for completion. Phase 2 then requests
 * the initial Logging Camp to level 12 and waits for completion. Phase 3 finally requests the initial
 * Aqueduct to level 12 and waits for completion. Phase 4 places seven new mines on each of the three
 * matching deposit types from the bottom-right side of the map, requests each mine to level 12, and waits
 * for all of them. Phase 5 places two Wheat Farms and twenty Houses as close to the Headquarter as
 * possible, requests each to level 12, and waits for all of them. Phase 6 places ten Brickworks, ten
 * Lumber Mills, fifteen Cheese Makers, fifteen Poultry Farms, fifteen Bakeries, five Dairy Farms, five
 * Flour Mills, and two Wheat Farms in the rightmost 15 columns from the top row left to right. It requests
 * each Phase 6 building to level 15 and waits for all of them. Phase 7 starts immediately after Phase 5,
 * checks every ten seconds for enough science to research Democracy, and resolves when that research is
 * complete. Phase 8 then waits for Phases 6 and 7, places 900 Apartments in the leftmost 30 columns, and
 * requests each to level 12 before waiting for all of them. Phase 9 starts alongside Phase 8, checks every
 * ten seconds for enough science to research Capitalism, and resolves when that research is complete. Phase
 * 10 starts immediately after Phase 9, first places eight level-12 copies of each absent tier-one producer
 * on the nearest suitable tiles to the bottom right, then places the configured quantity and desired level
 * for each remaining production-chain entry in the rightmost 15 columns from the first available cell
 * scanning rows left to right. Phase 11 starts only after every Phase 10 building reaches its target level,
 * places Big Ben, Luxor Temple, and Hagia Sophia as close to the bottom right as possible, and waits for all
 * three to finish construction. The returned Promise rejects if a required building, deposit, or empty tile
 * is missing or an operation throws.
 */
async function executeAutomatedBuild(): Promise<void> {
   // Phase 1: Upgrade the initial Stone Quarry to level 12.
   const stoneQuarry = findInitialBuilding("StoneQuarry");
   requestAutomatedBuildLevel(stoneQuarry);
   await waitForAutomatedBuildCompletion(stoneQuarry);

   // Phase 2: Upgrade the initial Logging Camp to level 12.
   const loggingCamp = findInitialBuilding("LoggingCamp");
   requestAutomatedBuildLevel(loggingCamp);
   await waitForAutomatedBuildCompletion(loggingCamp);

   // Phase 3: Upgrade the initial Aqueduct to level 12.
   const aqueduct = findInitialBuilding("Aqueduct");
   requestAutomatedBuildLevel(aqueduct);
   await waitForAutomatedBuildCompletion(aqueduct);

   // Phase 4: Build seven Stone Quarries, Logging Camps, and Aqueducts on matching deposits to level 12.
   const phaseFourMines = buildPhaseFourDepositMines();
   phaseFourMines.forEach((building) => requestAutomatedBuildLevel(building));
   await Promise.all(phaseFourMines.map((building) => waitForAutomatedBuildCompletion(building)));

   // Phase 5: Build two Wheat Farms and twenty Houses near the Headquarter to level 12.
   const phaseFiveBuildings = buildPhaseFiveBuildings();
   phaseFiveBuildings.forEach((building) => requestAutomatedBuildLevel(building));
   await Promise.all(phaseFiveBuildings.map((building) => waitForAutomatedBuildCompletion(building)));

   // Phase 6: Build the right-side production strip to level 15.
   const phaseSixCompletion = executePhaseSix();

   // Phase 7: Research Democracy as soon as a ten-second science check can pay for it.
   const phaseSevenCompletion = waitForPhaseSevenResearch();
   await Promise.all([phaseSixCompletion, phaseSevenCompletion]);

   // Phase 8: Build 900 Apartments in the left-side strip to level 12.
   const phaseEightBuildings = buildPhaseEightApartments();
   phaseEightBuildings.forEach((building) =>
      requestAutomatedBuildLevel(building, PHASE_EIGHT_BUILDING_LEVEL),
   );
   const phaseEightCompletion = Promise.all(
      phaseEightBuildings.map((building) =>
         waitForAutomatedBuildCompletion(building, PHASE_EIGHT_BUILDING_LEVEL),
      ),
   );

   // Phase 9: Research Capitalism as soon as a ten-second science check can pay for it.
   const phaseNineCompletion = waitForPhaseNineResearch();
   await phaseNineCompletion;

   // Phase 10: Build the wonder production chain in the right-side strip.
   const phaseTenCompletion = executePhaseTen();
   await phaseTenCompletion;

   // Phase 11: Build the three wonders near the bottom-right corner.
   const phaseElevenCompletion = executePhaseEleven();
   await Promise.all([phaseEightCompletion, phaseElevenCompletion]);
}

/**
 * Starts or returns the currently active Dave's Mods automation run.
 *
 * The first caller starts `executeAutomatedBuild`; callers who click while it is active receive the same
 * Promise instead of starting duplicate phases. The shared handle is cleared when the run resolves or
 * rejects, so a later click can start another run. The returned Promise represents completion of all eleven
 * phases.
 */
export function runAutomateBuild(): Promise<void> {
   if (!automateBuildRun) {
      automateBuildRun = executeAutomatedBuild().finally(() => {
         automateBuildRun = undefined;
      });
   }

   return automateBuildRun;
}
