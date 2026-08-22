import type { Building } from "../../shared/definitions/BuildingDefinitions";
import type { Deposit } from "../../shared/definitions/MaterialDefinitions";
import type { Tech } from "../../shared/definitions/TechDefinitions";
import {
   applyBuildingDefaults,
   exploreTile,
   findSpecialBuilding,
   getBottomRightEmptyTile,
} from "../../shared/logic/BuildingLogic";
import { Config } from "../../shared/logic/Config";
import type { GameState } from "../../shared/logic/GameState";
import { getGameOptions, getGameState, notifyGameStateUpdate } from "../../shared/logic/GameStateLogic";
import { clearIntraTickCache, getGrid } from "../../shared/logic/IntraTickCache";
import {
   getBuildingUnlockTech,
   getScienceAmount,
   getTechUnlockCost,
   getTotalTechUnlockCost,
   RequestResetTile,
   tryDeductScience,
   unlockTech,
} from "../../shared/logic/TechLogic";
import { sortByDistance } from "../../shared/logic/TerrainLogic";
import { makeBuilding, type IBuildingData, type ITileData } from "../../shared/logic/Tile";
import {
   clearTransportSourceCache,
   OnBuildingOrUpgradeComplete,
   OnTechUnlocked,
} from "../../shared/logic/Update";
import { isEmpty, pointToTile, resolveIn, tileToPoint } from "../../shared/utilities/Helper";
import { WorldScene } from "./scenes/WorldScene";
import { Singleton } from "./utilities/Singleton";

const TARGET_LEVEL = 10;
const APARTMENT_BUILDING_LEVEL = 12;
const STRIP_BUILDING_LEVEL = 15;
const HOUSE_COUNT = 20;
const WHEAT_FARM_COUNT = 2;
const APARTMENT_COUNT = 1000;
const CONDO_COUNT = 900;
const STRIP_WIDTH = 15;
const LEFT_STRIP_WIDTH = 30;
const CONDO_BUILDING_LEVEL = 12;
const CONDO_TIER_ONE_BUILDING_COUNT = 8;
const OXFORD_ATOMIUM_BUILDING_LEVEL = 12;
const RESEARCH_CHECK_INTERVAL_SECONDS = 10;
const DEPOSIT_MINE_COUNT = 8;

const DEPOSIT_BUILDINGS: ReadonlyArray<{ deposit: Deposit; type: Building }> = [
   { deposit: "Water", type: "Aqueduct" },
   { deposit: "Wood", type: "LoggingCamp" },
   { deposit: "Stone", type: "StoneQuarry" },
];

const STRIP_BUILDING_REQUESTS: ReadonlyArray<{ type: Building; count: number }> = [
   { type: "Brickworks", count: 10 },
   { type: "LumberMill", count: 10 },
   { type: "CheeseMaker", count: 15 },
   { type: "PoultryFarm", count: 15 },
   { type: "Bakery", count: 15 },
   { type: "FlourMill", count: 3 },
   { type: "DairyFarm", count: 3 },
];

const CONDO_DEPOSIT_BUILDING_REQUESTS: ReadonlyArray<{
   deposit: Deposit;
   type: Building;
}> = [
   { deposit: "Coal", type: "CoalMine" },
   { deposit: "Copper", type: "CopperMiningCamp" },
   { deposit: "Iron", type: "IronMiningCamp" },
];

const CONDO_PRODUCTION_BUILDING_REQUESTS: ReadonlyArray<{ type: Building; count: number }> = [
   { type: "Blacksmith", count: 5 },
   { type: "Brickworks", count: 5 },
   { type: "LumberMill", count: 5 },
   { type: "SteelMill", count: 5 },
   { type: "ConcretePlant", count: 10 },
   { type: "RebarPlant", count: 10 },
   { type: "ReinforcedConcretePlant", count: 20 },
   { type: "DairyFarm", count: 5 },
   { type: "FlourMill", count: 5 },
   { type: "PoultryFarm", count: 5 },
   { type: "CheeseMaker", count: 10 },
   { type: "Pizzeria", count: 50 },
];

const OXFORD_ATOMIUM_DEPOSIT_BUILDING_REQUESTS: ReadonlyArray<{
   deposit: Deposit;
   type: Building;
}> = [
   { deposit: "Water", type: "Aqueduct" },
   { deposit: "Aluminum", type: "AluminumSmelter" },
   { deposit: "Coal", type: "CoalMine" },
   { deposit: "Copper", type: "CopperMiningCamp" },
   { deposit: "Iron", type: "IronMiningCamp" },
   { deposit: "Wood", type: "LoggingCamp" },
   { deposit: "Stone", type: "StoneQuarry" },
   { deposit: "Uranium", type: "UraniumMine" },
];

const OXFORD_ATOMIUM_NON_ELECTRIFIED_BUILDING_REQUESTS: ReadonlyArray<{
   type: Building;
   count: number;
}> = [
   { type: "Sandpit", count: 1 },
   { type: "WheatFarm", count: 1 },
   { type: "Brewery", count: 1 },
   { type: "Brickworks", count: 1 },
   { type: "GunpowderMill", count: 1 },
   { type: "IronForge", count: 1 },
   { type: "LumberMill", count: 1 },
   { type: "PaperMaker", count: 1 },
   { type: "Stable", count: 1 },
   { type: "SteelMill", count: 1 },
   { type: "ConcretePlant", count: 1 },
   { type: "DynamiteWorkshop", count: 1 },
   { type: "RebarPlant", count: 1 },
   { type: "RifleFactory", count: 1 },
   { type: "Shrine", count: 1 },
   { type: "WritersGuild", count: 1 },
   { type: "GatlingGunFactory", count: 1 },
   { type: "ReinforcedConcretePlant", count: 1 },
   { type: "University", count: 1 },
   { type: "ArtilleryFactory", count: 1 },
];

const OXFORD_ATOMIUM_ELECTRIFIED_BUILDING_REQUESTS: ReadonlyArray<{
   type: Building;
   count: number;
}> = [
   { type: "CoalPowerPlant", count: 1 },
   { type: "UraniumEnrichmentPlant", count: 1 },
   { type: "AtomicFacility", count: 1 },
];

let initialMinesRun: Promise<void> | undefined;
let buildApartmentsRun: Promise<void> | undefined;
let buildCondosRun: Promise<void> | undefined;
let buildCondosRunState: GameState | undefined;
let buildOxfordUniAndAtomiumRun: Promise<void> | undefined;
let buildOxfordUniAndAtomiumRunState: GameState | undefined;
const removedBuildings = new Set<IBuildingData>();

function findDefaultBuilding(buildingType: Building): IBuildingData | undefined {
   for (const tile of getGameState().tiles.values()) {
      if (tile.building?.type === buildingType) {
         return tile.building;
      }
   }
   return undefined;
}

function setBuildingTargetLevel(building: IBuildingData, targetLevel = TARGET_LEVEL): void {
   building.desiredLevel = Math.max(building.desiredLevel, targetLevel);
   building.status = building.level > 0 ? "upgrading" : "building";
}

function upgradeDefaultBuilding(buildingType: Building): IBuildingData {
   const building = findDefaultBuilding(buildingType);
   if (!building) {
      throw new Error(`No ${buildingType} exists in the current game.`);
   }

   setBuildingTargetLevel(building);
   const gameState = getGameState();
   clearIntraTickCache();
   clearTransportSourceCache();
   notifyGameStateUpdate(gameState);
   return building;
}

function waitForBuildingCompletion(building: IBuildingData): Promise<void> {
   if (building.level >= building.desiredLevel || removedBuildings.has(building)) {
      return Promise.resolve();
   }

   return new Promise((resolve) => {
      const checkCompletion = () => {
         if (building.level >= building.desiredLevel || removedBuildings.has(building)) {
            OnBuildingOrUpgradeComplete.off(checkCompletion);
            resolve();
         }
      };
      OnBuildingOrUpgradeComplete.on(checkCompletion);
      checkCompletion();
   });
}

function createTargetBuilding(buildingType: Building, targetLevel = TARGET_LEVEL): IBuildingData {
   const building = applyBuildingDefaults(makeBuilding({ type: buildingType }), getGameOptions());
   setBuildingTargetLevel(building, targetLevel);
   return building;
}

function revealTileIfNeeded(tile: ITileData, gameState: GameState): void {
   if (!tile.explored) {
      exploreTile(tile.tile, gameState);
      Singleton().sceneManager.enqueue(WorldScene, (scene) => scene.revealTile(tile.tile));
   }
}

function placeBuildings(
   buildingTypes: ReadonlyArray<Building>,
   tiles: ReadonlyArray<ITileData>,
   targetLevel: number,
   allowDeposits = false,
): IBuildingData[] {
   if (buildingTypes.length !== tiles.length) {
      throw new Error("The number of buildings and target tiles must match.");
   }

   const gameState = getGameState();
   const buildings = buildingTypes.map((buildingType, index) => {
      const tile = tiles[index];
      const buildingDeposits = Config.Building[buildingType].deposit;
      const canUseDeposit =
         allowDeposits &&
         buildingDeposits &&
         Object.keys(buildingDeposits).some((deposit) => Boolean(tile.deposit[deposit as Deposit]));
      if (tile.building || (!isEmpty(tile.deposit) && !canUseDeposit)) {
         throw new Error("Cannot place a building on an occupied or resource tile.");
      }

      const building = createTargetBuilding(buildingType, targetLevel);
      tile.building = building;
      revealTileIfNeeded(tile, gameState);
      return building;
   });

   clearIntraTickCache();
   clearTransportSourceCache();
   notifyGameStateUpdate(gameState);
   return buildings;
}

function repeatBuilding(buildingType: Building, count: number): Building[] {
   return Array.from({ length: count }, () => buildingType);
}

function hasResourceProducer(gameState: GameState, resource: Deposit): boolean {
   for (const tile of gameState.tiles.values()) {
      const building = tile.building;
      if (building && Config.Building[building.type].output[resource]) {
         return true;
      }
   }
   return false;
}

function getResearchPath(tech: Tech, path: Tech[] = [], visited = new Set<Tech>()): Tech[] {
   if (visited.has(tech)) {
      return path;
   }

   visited.add(tech);
   for (const prerequisite of Config.Tech[tech].requireTech) {
      getResearchPath(prerequisite, path, visited);
   }
   path.push(tech);
   return path;
}

function researchIfAffordable(tech: Tech): boolean {
   const gameState = getGameState();
   if (
      gameState.unlockedTech[tech] ||
      !Config.Tech[tech].requireTech.every((prerequisite) => gameState.unlockedTech[prerequisite])
   ) {
      return gameState.unlockedTech[tech] ?? false;
   }

   const cost = getTechUnlockCost(tech, gameState);
   if (!tryDeductScience(cost, gameState)) {
      return false;
   }

   unlockTech(tech, true, gameState);
   clearIntraTickCache();
   clearTransportSourceCache();
   notifyGameStateUpdate(gameState);
   return true;
}

async function researchWhenAffordable(tech: Tech): Promise<void> {
   const gameState = getGameState();
   while (!gameState.unlockedTech[tech]) {
      const { totalScience, prerequisites } = getTotalTechUnlockCost(tech, gameState);
      if (getScienceAmount(gameState) >= totalScience && tryDeductScience(totalScience, gameState)) {
         for (const prerequisite of prerequisites) {
            unlockTech(prerequisite, true, gameState);
         }
         unlockTech(tech, true, gameState);
         clearIntraTickCache();
         clearTransportSourceCache();
         notifyGameStateUpdate(gameState);
         return;
      }
      await resolveIn(RESEARCH_CHECK_INTERVAL_SECONDS, null);
   }
}

function buildNearestDepositMines(): void {
   const gameState = getGameState();
   const bottomRightTile = getBottomRightEmptyTile(gameState);
   if (!bottomRightTile) {
      throw new Error("No empty bottom-right map tile exists in the current game.");
   }

   for (const { deposit, type } of DEPOSIT_BUILDINGS) {
      const deposits = sortByDistance(
         (tile) => Boolean(tile.deposit[deposit]) && !tile.building,
         bottomRightTile[0],
         gameState,
      ).slice(0, DEPOSIT_MINE_COUNT);

      for (const tile of deposits) {
         tile.building = createTargetBuilding(type);
         revealTileIfNeeded(tile, gameState);
      }
   }

   clearIntraTickCache();
   clearTransportSourceCache();
   notifyGameStateUpdate(gameState);
}

async function executeInitialMines(): Promise<void> {
   const stoneQuarry = upgradeDefaultBuilding("StoneQuarry");
   await waitForBuildingCompletion(stoneQuarry);
   await resolveIn(5, null);
   const loggingCamp = upgradeDefaultBuilding("LoggingCamp");
   await waitForBuildingCompletion(loggingCamp);
   await resolveIn(5, null);
   const aqueduct = upgradeDefaultBuilding("Aqueduct");
   await waitForBuildingCompletion(aqueduct);
   buildNearestDepositMines();
}

function getEmptyTilesNearHeadquarters(gameState: GameState, count: number): ITileData[] {
   const hq = findSpecialBuilding("Headquarter", gameState);
   if (!hq) {
      throw new Error("No Headquarter exists in the current game.");
   }

   const tiles = sortByDistance((tile) => !tile.building && isEmpty(tile.deposit), hq.tile, gameState);
   if (tiles.length < count) {
      throw new Error(`Not enough empty tiles are available near the Headquarter for ${count} buildings.`);
   }
   return tiles.slice(0, count);
}

function getEmptyTilesInRightStrip(gameState: GameState): ITileData[] {
   const firstColumn = Math.max(0, getGrid(gameState).maxX - STRIP_WIDTH);
   return Array.from(gameState.tiles.values())
      .filter((tile) => !tile.building && isEmpty(tile.deposit) && tileToPoint(tile.tile).x >= firstColumn)
      .sort((firstTile, secondTile) => {
         const firstPoint = tileToPoint(firstTile.tile);
         const secondPoint = tileToPoint(secondTile.tile);
         return firstPoint.y - secondPoint.y || firstPoint.x - secondPoint.x;
      });
}

function getEmptyContiguousTilesInRightStrip(gameState: GameState, count: number): ITileData[] {
   const candidates = getEmptyTilesInRightStrip(gameState);
   const candidateByTile = new Map(candidates.map((tile) => [tile.tile, tile]));
   const rejectedTiles = new Set<ITileData["tile"]>();
   const grid = getGrid(gameState);

   for (const startTile of candidates) {
      if (rejectedTiles.has(startTile.tile)) {
         continue;
      }

      const component: ITileData[] = [];
      const visitedTiles = new Set<ITileData["tile"]>([startTile.tile]);
      const queue = [startTile];
      for (let index = 0; index < queue.length; index++) {
         const tile = queue[index];
         component.push(tile);
         if (component.length >= count) {
            return component;
         }

         for (const point of grid.getNeighbors(tileToPoint(tile.tile))) {
            const neighbor = candidateByTile.get(pointToTile(point));
            if (neighbor && !visitedTiles.has(neighbor.tile)) {
               visitedTiles.add(neighbor.tile);
               queue.push(neighbor);
            }
         }
      }

      component.forEach((tile) => rejectedTiles.add(tile.tile));
   }

   throw new Error(
      `Not enough contiguous empty cells exist in the right ${STRIP_WIDTH}-tile strip for the requested block.`,
   );
}

function getEmptyTilesInLeftStrip(gameState: GameState): ITileData[] {
   return Array.from(gameState.tiles.values())
      .filter(
         (tile) => !tile.building && isEmpty(tile.deposit) && tileToPoint(tile.tile).x < LEFT_STRIP_WIDTH,
      )
      .sort((firstTile, secondTile) => {
         const firstPoint = tileToPoint(firstTile.tile);
         const secondPoint = tileToPoint(secondTile.tile);
         return firstPoint.y - secondPoint.y || firstPoint.x - secondPoint.x;
      });
}

function removeApartmentsAndNonTierOneRightStripBuildings(): void {
   const gameState = getGameState();
   const firstColumn = Math.max(0, getGrid(gameState).maxX - STRIP_WIDTH);
   let changed = false;

   for (const tile of gameState.tiles.values()) {
      const building = tile.building;
      if (!building) {
         continue;
      }

      const point = tileToPoint(tile.tile);
      const buildingDefinition = Config.Building[building.type];
      const isWonder = buildingDefinition.special !== undefined;
      const isTierOne = Config.BuildingTier[building.type] === 1;
      const shouldRemove =
         building.type === "Apartment" || (point.x >= firstColumn && !isWonder && !isTierOne);
      if (shouldRemove) {
         removedBuildings.add(building);
         tile.building = undefined;
         OnBuildingOrUpgradeComplete.emit(tile.tile);
         RequestResetTile.emit(tile.tile);
         changed = true;
      }
   }

   if (changed) {
      clearIntraTickCache();
      clearTransportSourceCache();
      notifyGameStateUpdate(gameState);
   }
}

async function buildInitialHousing(): Promise<void> {
   const buildingTypes = repeatBuilding("House", HOUSE_COUNT).concat(
      repeatBuilding("WheatFarm", WHEAT_FARM_COUNT),
   );
   const tiles = getEmptyTilesNearHeadquarters(getGameState(), buildingTypes.length);
   const buildings = placeBuildings(buildingTypes, tiles, APARTMENT_BUILDING_LEVEL);
   await Promise.all(buildings.map((building) => waitForBuildingCompletion(building)));
}

function getStripBuildingRequests(): Array<{ type: Building; count: number }> {
   return STRIP_BUILDING_REQUESTS.map((request, index) => ({ ...request, index }))
      .sort((firstRequest, secondRequest) => {
         const tierDifference =
            (Config.BuildingTier[firstRequest.type] ?? 0) - (Config.BuildingTier[secondRequest.type] ?? 0);
         if (tierDifference !== 0) {
            return tierDifference;
         }
         return firstRequest.index - secondRequest.index;
      })
      .map(({ type, count }) => ({ type, count }));
}

async function buildRightStrip(): Promise<void> {
   const requests = getStripBuildingRequests();
   const totalBuildings = requests.reduce((total, request) => total + request.count, 0);
   const stripTiles = getEmptyTilesInRightStrip(getGameState());
   if (stripTiles.length < totalBuildings) {
      throw new Error(`Not enough empty cells exist in the right ${STRIP_WIDTH}-tile strip.`);
   }

   let tileIndex = 0;
   for (const request of requests) {
      await researchWhenAffordable(getBuildingUnlockTech(request.type));
      const targetTiles = stripTiles.slice(tileIndex, tileIndex + request.count);
      tileIndex += request.count;
      const buildings = placeBuildings(
         repeatBuilding(request.type, request.count),
         targetTiles,
         STRIP_BUILDING_LEVEL,
      );
      await Promise.all(buildings.map((building) => waitForBuildingCompletion(building)));
   }
}

function buildCondoTierOneBuildings(): IBuildingData[] {
   const gameState = getGameState();
   const bottomRightTile = getBottomRightEmptyTile(gameState);
   if (!bottomRightTile) {
      throw new Error("No empty bottom-right map tile exists in the current game.");
   }

   const depositBuildingTypes: Building[] = [];
   const depositTiles: ITileData[] = [];
   const reservedTiles = new Set<ITileData["tile"]>();
   for (const request of CONDO_DEPOSIT_BUILDING_REQUESTS) {
      const tiles = sortByDistance(
         (tile) => Boolean(tile.deposit[request.deposit]) && !tile.building && !reservedTiles.has(tile.tile),
         bottomRightTile[0],
         gameState,
      ).slice(0, CONDO_TIER_ONE_BUILDING_COUNT);
      if (tiles.length < CONDO_TIER_ONE_BUILDING_COUNT) {
         throw new Error(`Not enough ${request.deposit} deposits are available for Condo production.`);
      }
      depositBuildingTypes.push(...repeatBuilding(request.type, CONDO_TIER_ONE_BUILDING_COUNT));
      depositTiles.push(...tiles);
      tiles.forEach((tile) => reservedTiles.add(tile.tile));
   }

   const sandpitTiles = sortByDistance(
      (tile) => !tile.building && isEmpty(tile.deposit),
      bottomRightTile[0],
      gameState,
   ).slice(0, CONDO_TIER_ONE_BUILDING_COUNT);
   if (sandpitTiles.length < CONDO_TIER_ONE_BUILDING_COUNT) {
      throw new Error("Not enough empty cells are available for Condo Sandpits.");
   }

   const buildings = placeBuildings(
      depositBuildingTypes.concat(repeatBuilding("Sandpit", CONDO_TIER_ONE_BUILDING_COUNT)),
      depositTiles.concat(sandpitTiles),
      CONDO_BUILDING_LEVEL,
      true,
   );

   const wheatTiles = getEmptyTilesInRightStrip(gameState).slice(0, CONDO_TIER_ONE_BUILDING_COUNT);
   if (wheatTiles.length < CONDO_TIER_ONE_BUILDING_COUNT) {
      throw new Error("Not enough empty cells are available in the top-right strip for Condo Wheat Farms.");
   }
   buildings.push(
      ...placeBuildings(
         repeatBuilding("WheatFarm", CONDO_TIER_ONE_BUILDING_COUNT),
         wheatTiles,
         CONDO_BUILDING_LEVEL,
      ),
   );

   return buildings;
}

function buildCondoProductionBuildings(): IBuildingData[] {
   const requests = CONDO_PRODUCTION_BUILDING_REQUESTS;
   const totalBuildings = requests.reduce((total, request) => total + request.count, 0);
   const stripTiles = getEmptyTilesInRightStrip(getGameState());
   if (stripTiles.length < totalBuildings) {
      throw new Error(
         `Not enough empty cells exist in the right ${STRIP_WIDTH}-tile strip for Condo production.`,
      );
   }

   const buildingTypes = requests.flatMap((request) => repeatBuilding(request.type, request.count));
   const buildings = placeBuildings(buildingTypes, stripTiles.slice(0, totalBuildings), CONDO_BUILDING_LEVEL);
   return buildings;
}

async function researchBuildingRequests(requests: ReadonlyArray<{ type: Building }>): Promise<void> {
   for (const request of requests) {
      await researchWhenAffordable(getBuildingUnlockTech(request.type));
   }
}

async function buildOxfordAtomiumDepositBuildings(): Promise<IBuildingData[]> {
   const initialGameState = getGameState();
   const requestsToBuild = OXFORD_ATOMIUM_DEPOSIT_BUILDING_REQUESTS.filter(
      (request) => !hasResourceProducer(initialGameState, request.deposit),
   );
   if (requestsToBuild.length === 0) {
      return [];
   }

   await researchBuildingRequests(requestsToBuild);

   const gameState = getGameState();
   const missingRequests = requestsToBuild.filter((request) => !hasResourceProducer(gameState, request.deposit));
   if (missingRequests.length === 0) {
      return [];
   }

   const bottomRightTile = getBottomRightEmptyTile(gameState);
   if (!bottomRightTile) {
      throw new Error("No empty bottom-right map tile exists in the current game.");
   }

   const depositBuildingTypes: Building[] = [];
   const depositTiles: ITileData[] = [];
   const reservedTiles = new Set<ITileData["tile"]>();
   for (const request of missingRequests) {
      const tiles = sortByDistance(
         (tile) => Boolean(tile.deposit[request.deposit]) && !tile.building && !reservedTiles.has(tile.tile),
         bottomRightTile[0],
         gameState,
      ).slice(0, DEPOSIT_MINE_COUNT);
      if (tiles.length < DEPOSIT_MINE_COUNT) {
         throw new Error(`Not enough ${request.deposit} deposits are available for Oxford and Atomium.`);
      }
      depositBuildingTypes.push(...repeatBuilding(request.type, DEPOSIT_MINE_COUNT));
      depositTiles.push(...tiles);
      tiles.forEach((tile) => reservedTiles.add(tile.tile));
   }

   return placeBuildings(depositBuildingTypes, depositTiles, OXFORD_ATOMIUM_BUILDING_LEVEL, true);
}

async function buildOxfordAtomiumNonElectrifiedBuildings(): Promise<IBuildingData[]> {
   await researchBuildingRequests(OXFORD_ATOMIUM_NON_ELECTRIFIED_BUILDING_REQUESTS);

   const buildingTypes = OXFORD_ATOMIUM_NON_ELECTRIFIED_BUILDING_REQUESTS.flatMap((request) =>
      repeatBuilding(request.type, request.count),
   );
   const tiles = getEmptyContiguousTilesInRightStrip(getGameState(), buildingTypes.length);
   return placeBuildings(buildingTypes, tiles, OXFORD_ATOMIUM_BUILDING_LEVEL);
}

async function buildOxfordAtomiumElectrifiedBuildings(): Promise<IBuildingData[]> {
   await researchBuildingRequests(OXFORD_ATOMIUM_ELECTRIFIED_BUILDING_REQUESTS);

   const buildingTypes = OXFORD_ATOMIUM_ELECTRIFIED_BUILDING_REQUESTS.flatMap((request) =>
      repeatBuilding(request.type, request.count),
   );
   const tiles = getEmptyContiguousTilesInRightStrip(getGameState(), buildingTypes.length);
   return placeBuildings(buildingTypes, tiles, OXFORD_ATOMIUM_BUILDING_LEVEL);
}

async function executeBuildOxfordUniAndAtomium(): Promise<void> {
   const buildings = [
      ...(await buildOxfordAtomiumDepositBuildings()),
      ...(await buildOxfordAtomiumNonElectrifiedBuildings()),
      ...(await buildOxfordAtomiumElectrifiedBuildings()),
   ];
   await Promise.all(buildings.map((building) => waitForBuildingCompletion(building)));
   await researchWhenAffordable("SpaceProgram");
   await researchWhenAffordable("MutualAssuredDestruction");
}

async function buildCondos(): Promise<void> {
   const condoTiles = getEmptyTilesInLeftStrip(getGameState());
   if (condoTiles.length < CONDO_COUNT) {
      throw new Error(`Not enough empty cells exist in the left ${LEFT_STRIP_WIDTH}-tile strip for Condos.`);
   }

   const condos = placeBuildings(
      repeatBuilding("Condo", CONDO_COUNT),
      condoTiles.slice(0, CONDO_COUNT),
      CONDO_BUILDING_LEVEL,
   );
   await Promise.all(condos.map((building) => waitForBuildingCompletion(building)));
}

async function waitForTechUnlock(tech: Tech): Promise<void> {
   while (!getGameState().unlockedTech[tech]) {
      await resolveIn(1, null);
   }
}

async function executeBuildCondos(): Promise<void> {
   await waitForTechUnlock("Skyscraper");
   removeApartmentsAndNonTierOneRightStripBuildings();
   const tierOneBuildings = buildCondoTierOneBuildings();
   const productionBuildings = buildCondoProductionBuildings();
   await Promise.all([
      Promise.all(tierOneBuildings.map((building) => waitForBuildingCompletion(building))),
      Promise.all(productionBuildings.map((building) => waitForBuildingCompletion(building))),
   ]);
   await buildCondos();
}

async function researchSkyscraperDuringApartmentConstruction(): Promise<void> {
   const researchPath = getResearchPath("Skyscraper");
   let nextTechIndex = 0;
   while (nextTechIndex < researchPath.length) {
      const nextTech = researchPath[nextTechIndex];
      if (getGameState().unlockedTech[nextTech]) {
         nextTechIndex++;
         continue;
      }

      if (researchIfAffordable(nextTech)) {
         nextTechIndex++;
      }
      if (nextTechIndex < researchPath.length) {
         await resolveIn(RESEARCH_CHECK_INTERVAL_SECONDS, null);
      }
   }
}

async function buildLeftStripApartments(): Promise<void> {
   const gameState = getGameState();
   const apartmentTiles = getEmptyTilesInLeftStrip(gameState);
   if (apartmentTiles.length < APARTMENT_COUNT) {
      throw new Error(`Not enough empty cells exist in the left ${LEFT_STRIP_WIDTH}-tile strip.`);
   }

   const apartments = placeBuildings(
      repeatBuilding("Apartment", APARTMENT_COUNT),
      apartmentTiles.slice(0, APARTMENT_COUNT),
      APARTMENT_BUILDING_LEVEL,
   );
   await Promise.all([
      Promise.all(apartments.map((building) => waitForBuildingCompletion(building))),
      researchSkyscraperDuringApartmentConstruction(),
   ]);
}

async function executeBuildApartments(): Promise<void> {
   await researchWhenAffordable("Housing");
   await researchWhenAffordable("Farming");
   await buildInitialHousing();
   await researchWhenAffordable("Democracy");
   await buildRightStrip();
   await buildLeftStripApartments();
}

export function runInitialMines(): Promise<void> {
   if (!initialMinesRun) {
      initialMinesRun = executeInitialMines().finally(() => {
         initialMinesRun = undefined;
      });
   }
   return initialMinesRun;
}

export function runBuildApartments(): Promise<void> {
   if (!buildApartmentsRun) {
      buildApartmentsRun = executeBuildApartments().finally(() => {
         buildApartmentsRun = undefined;
      });
   }
   return buildApartmentsRun;
}

export function runBuildOxfordUniAndAtomium(): Promise<void> {
   const gameState = getGameState();
   if (buildOxfordUniAndAtomiumRunState !== gameState) {
      buildOxfordUniAndAtomiumRunState = gameState;
      buildOxfordUniAndAtomiumRun = undefined;
   }

   if (!buildOxfordUniAndAtomiumRun) {
      buildOxfordUniAndAtomiumRun = executeBuildOxfordUniAndAtomium().catch((error: unknown) => {
         if (buildOxfordUniAndAtomiumRunState === gameState) {
            buildOxfordUniAndAtomiumRun = undefined;
         }
         throw error;
      });
   }
   return buildOxfordUniAndAtomiumRun;
}

export function runBuildCondos(): Promise<void> {
   const gameState = getGameState();
   if (buildCondosRunState !== gameState) {
      buildCondosRunState = gameState;
      buildCondosRun = undefined;
   }

   if (!buildCondosRun) {
      buildCondosRun = executeBuildCondos().catch((error: unknown) => {
         if (buildCondosRunState === gameState) {
            buildCondosRun = undefined;
         }
         throw error;
      });
   }
   void runBuildOxfordUniAndAtomium().catch((error: unknown) => {
      console.error("Automatic Oxford Uni and Atomium failed.", error);
   });
   return buildCondosRun;
}

OnTechUnlocked.on((tech) => {
   if (tech === "Skyscraper") {
      void runBuildCondos().catch((error: unknown) => {
         console.error("Automatic Build Condos failed.", error);
      });
   }
});
